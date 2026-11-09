import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ConfigSchema, validatePatch } from './config.js'
import { addThought, formatDay, noteReflect, pruneDiary, recentDiary, recordEvent, replaceThoughts, todayOf } from './diary.js'
// 2026-11-08：日记改由她自写（当天事件 + 七维状态 → 模型 → 一两句第一人称）。
// 旧的 thoughts 只能靠外层模型主动调工具写，实测永远是空的（见 reflect.js 头注释）。
import { REFLECT_DEFAULTS, buildReflectPrompt, extractThoughts, recentThoughtTexts, shouldReflect } from './reflect.js'
import { EVENTS, applyEvent, recentEvents } from './events.js'
// 2026-11-09：日记的「事实」只来自事件记录（含 detail 原话），不读聊天记录原文。
import { buildBlock, modeOf } from './prompt.js'
import { imageGate, noteImage, noteInitiate, proactiveGate } from './proactive.js'
// 2026-11-06：好奇心 + 自主搜索。心跳只调 tickCurio/shouldSearch（纯算术），
// 真正发请求的只有 searchTopic 一处在 tick 里被 await 一次。
import { CURIO_DEFAULTS, buildQuery, searchTopic, shouldSearch, tickCurio, toTopic } from './curio.js'
import { boundaryLine, deepestUnlocked, nextLocked, unlockedOf } from './unlock.js'
import {
  DIMS,
  STATE_KEYS as CURVE_STATE_KEYS,
  awakeHoursBetween,
  clamp,
  clampFloat,
  effOf,
  inSleepWindow,
  nextState,
  num,
  pressureOf,
  todayKey,
  round2,
} from './curve.js'

export const name = 'dsh-longing'
export const inject = []
export const Config = ConfigSchema

/**
 * 状态键：只存状态文件，绝不出现在「面板配置」里。
 * 1.0.0 把它们也当成可写配置，于是面板「保存设置」会把当时的状态快照写进
 * 欲望面板配置.json，下次启动再反过来覆盖真实状态 —— 重启就丢进度。
 */
const STATE_KEYS = new Set(CURVE_STATE_KEYS)
/** 七个可以调的数值维（scene 是字符串，单独处理）。 */
const VALUE_KEYS = DIMS

// 面板能写的「行为参数」：只有这些。状态键不在此列。
const NUM_KEYS = new Set([
  'peakBonus', 'decayPerHour', 'nightDecayPerHour', 'idleTriggerMin', 'proactiveMaxPerDay',
  'initiateThreshold', 'urgeThink', 'urgeHint', 'urgeSpeak', 'urgeAct', 'urgeRepeatMin',
  'lewdDirect', 'possessJealous', 'fatigueTired', 'shameHiding', 'resistHolding',
  'affectionGain', 'affectionDecay', 'affectionClose', 'affectionDevoted',
  'cooldownMin', 'resistWeight', 'affectionWeight', 'coldLust', 'shyLewd', 'distantPossess', 'numbAffection',
  'explicitThreshold', 'imageThreshold', 'imagesPerDay', 'jealousy', 'rejectionPenalty',
  'comfyProbeSec', 'interactionLust', 'couplingRate', 'eventGain', 'lonelyHours', 'diaryDays',
  // 1.14.0：自写日记的旋钮。同样必须进清单 —— 不进来就是「面板能填、值原地不动」。
  'diaryPerDay', 'diaryMinGapMin', 'diaryMinEvents', 'diaryMaxChars', 'diaryMaxTokens', 'diaryTemperature',
  // 2026-11-06：好奇心的参数必须进这份清单，否则面板保存会被 ALLOWED_KEYS 悄悄丢掉 ——
  // 1.11.0 的 proactivePerHour 就是这么「改不动」的，别再犯一次。
  'curioGainPerHour', 'curioDropOnTalk', 'curioSearchAt', 'curioCooldownMin', 'curioPerDay',
  // 2026-11-07：这两个键当初写了注释却漏进清单 —— 面板保存回 200、值原地不动。
  // 教训不是「记得加键」，而是「测试只验 GET 里有这个键，没验 POST 能改这个键」。
  'proactivePerHour', 'proactiveCooldownMin',
  // 2026-11-09：日记只读今天的事件，不碰聊天记录
])
const BOOL_KEYS = new Set([
  'enabled', 'stealthInjection', 'autoInitiate', 'nsfwEnabled', 'nsfwImages', 'curveEnabled', 'presetsEnabled', 'voiceEnabled',
  'memoryEnabled', 'scheduleEnabled', 'pauseEnabled', 'rememberAfterward', 'ownerOnly', 'comfyEnabled', 'comfyAutoLaunch',
  'couplingEnabled', 'debugMode', 'feedbackThink', 'feedbackHint', 'feedbackSpeak', 'feedbackAct', 'unlocksEnabled',
  'curioEnabled',
  'diaryAutoWrite',
])
const STR_KEYS = new Set([
  'channels', 'peakWindow', 'activeHours', 'quietHours', 'sleepWindow', 'pauseWord', 'personaNote',
  'comfyBaseUrl', 'comfyLaunchScript', 'comfyLaunchAllowDir', 'statePath', 'migrateFrom', 'negBreakpoints',
  'personaName', 'toolName',
  'curioTopics',
  'diaryProvider', 'diaryModel', 'diaryPersona',
  'ownerRef',
])
// 面板能写的键：写死是为了防止任意键落盘。状态键刻意不在里面。
const ALLOWED_KEYS = new Set([...NUM_KEYS, ...BOOL_KEYS, ...STR_KEYS])

function safeEqual(a, b) {
  const x = Buffer.from(String(a))
  const y = Buffer.from(String(b))
  if (x.length !== y.length) return false
  return timingSafeEqual(x, y)
}

const DEFAULTS = { lust: 30, lewd: 35, possess: 55, shame: 45, resist: 50, fatigue: 20, affection: 30 }
const TICK_MS = 60_000
const HISTORY_MAX = 2880
const HISTORY_WRITE_MS = 5 * 60_000 // 历史全量落盘节流：内存里每分钟记，盘上五分钟一次
const STEP_LIMIT = 25 // 面板/工具一次最多跳 25，避免数值跳崖导致 OOC

const PRESETS = {
  calm: { lust: 20, lewd: 20, possess: 40, shame: 55, resist: 60, fatigue: 25 },
  clingy: { lust: 50, lewd: 40, possess: 60, shame: 45, resist: 45, fatigue: 30 },
  heat: { lust: 78, lewd: 70, possess: 80, shame: 25, resist: 30, fatigue: 20 },
  yandere: { lust: 90, lewd: 85, possess: 95, shame: 10, resist: 15, fatigue: 25 },
}

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

// 2026-11-10（审计 F01）：每个文件一个提交序号。
// 以前只用 mtime 比对，还有 50ms 容忍 —— A 写失败、B 在 10ms 内写成功、A 20ms 后重试，
// 20 < 50 判不出过期，A 的旧快照就把 B 盖回去了。mtime 是「别人写的」的线索，
// 不是「我这份是不是最新」的判据；同进程内谁最后提交，只有序号知道。
const writeSeq = new Map()
function nextWriteSeq(file) {
  const n = (writeSeq.get(file) ?? 0) + 1
  writeSeq.set(file, n)
  return n
}

function writeJson(file, data, logger) {
  // 原子写：临时文件 + rename。Windows 上被占用会 EPERM，用 setTimeout 异步重试。
  // 重试前先看目标文件的 mtime：如果在我们写 tmp 之后有人写过，说明对方的数据更新，
  // 我们这份是旧快照 —— 直接放弃，别把别人的更新盖回去（那会静默丢事件增量）。
  const mySeq = nextWriteSeq(file)
  let ok = false
  try {
    mkdirSync(dirname(file), { recursive: true })
    const wroteAt = Date.now()
    const tmp = `${file}.tmp-${process.pid}-${wroteAt}`
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
    const attempt = (n) => {
      try {
        // 同进程里已经有更晚的提交（同一文件）→ 我这份就是旧快照，别覆盖
        if ((writeSeq.get(file) ?? 0) !== mySeq) {
          try {
            unlinkSync(tmp)
          } catch {}
          return
        }
        let stale = false
        try {
          // 2026-11-07：原来直接比 `mtimeMs > wroteAt`，而文件系统时间戳的精度可能比
          // Date.now() 高（或落在同一毫秒的下一格），于是「刚刚才被写过」的文件会被
          // 误判成「别人写了更新的数据」→ 放弃本次写入、删掉 tmp、文件保持旧内容。
          // 症状是间歇性的：同样的测试十次里偶尔红一次（面板配置写完读回还是旧值）。
          // 加 50ms 容忍，仍能拦住真有人在期间写过的情况。
          if (statSync(file).mtimeMs > wroteAt + 50) stale = true
        } catch {}
        if (stale) {
          unlinkSync(tmp)
          return
        }
        renameSync(tmp, file)
        ok = true
      } catch (e) {
        if (n < 4) {
          const t = setTimeout(() => attempt(n + 1), 20 * (n + 1))
          t?.unref?.()
        } else {
          try {
            unlinkSync(tmp)
          } catch {}
          logger?.error?.(`[dsh-longing] 写入失败（文件可能被占用）：${file} ${e?.code ?? ''}`)
        }
      }
    }
    attempt(0)
  } catch (e) {
    logger?.error?.(`[dsh-longing] 写入失败：${file} ${e?.message ?? e}`)
  }
  return ok
}

/** 文本原子写：通道插件每轮同步读这个文件，直接 writeFileSync 会读到半句。</summary> */
function writeTextAtomic(file, text, logger) {
  try {
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
    writeFileSync(tmp, text, 'utf8')
    renameSync(tmp, file)
    return true
  } catch (e) {
    logger?.warn?.(`[dsh-longing] 注入块写入失败：${file} ${e?.message ?? e}`)
    return false
  }
}

/**
 * 状态目录：优先用 DSH 给的插件家目录。
 *
 * 原来默认是 `process.cwd()/workspace` —— 进程从哪个目录启动，状态就落在哪儿。
 * 桌面版从安装目录启动、命令行从项目目录启动、换一个工作目录再跑一次，
 * 同一个人手里就会出现好几份互不相干的状态，看着就是「进度没了」。
 * 这个默认值只在作者的机器上成立（他的 cwd 一直是同一个），所以按开发者视角改掉。
 *
 * dshHomePath 这个服务可能返回函数（按插件名取目录），也可能直接是字符串，两种都认。
 */
function homeDirOf(ctx, logger) {
  let dir = ''
  try {
    const p = ctx?.get?.('dshHomePath')
    if (typeof p === 'function') {
      const v = p(name)
      if (v) dir = String(v)
    } else if (typeof p === 'string' && p) {
      dir = join(p, name)
    }
  } catch (e) {
    logger?.warn?.(`[dsh-longing] 取 dshHomePath 失败，退回 ~/.dsh：${e?.message ?? e}`)
  }
  if (!dir) dir = join(process.env.DSH_HOME || join(homedir(), '.dsh'), name)
  return resolve(dir)
}

export function apply(ctx, configIn) {
  const logger = ctx?.logger ?? console
  // DSH 正常会先把 schema 默认值填好再交给 apply()；但别的插件、脚本、测试直接调 apply()
  // 时只会拿到调用方写的那几个键 —— 这时面板会变成「只有一项配置」，看起来像插件坏了。
  // 自己补一次全量默认值，任何入口进来都得到同一份 84 项。
  const config = (() => {
    try {
      return ConfigSchema({ ...(configIn ?? {}) })
    } catch (e) {
      logger.warn?.(`[dsh-longing] 配置解析失败，按原样使用：${e?.message ?? e}`)
      return { ...(configIn ?? {}) }
    }
  })()
  const statePath = String(config?.statePath ?? '').trim()
  // 目录优先级：显式 statePath > 环境变量 > 插件家目录。
  // 绝对不碰任何具体盘符 —— 这里以前是 cwd/workspace。
  const legacyDir = join(process.cwd(), 'workspace')
  const envDir = String(process.env.DSH_LONGING_DIR ?? '').trim()
  const baseDir = statePath ? dirname(resolve(statePath)) : envDir ? resolve(envDir) : homeDirOf(ctx, logger)
  const stateFile = statePath ? resolve(statePath) : join(baseDir, '欲望状态.json')
  const cfgFile = join(baseDir, '欲望面板配置.json')
  const historyFile = join(baseDir, '欲望历史.json')
  const diaryFile = join(baseDir, '心情日记.json')

  // 换目录不能等于丢进度：老的 cwd/workspace 里有状态而新目录没有，就搬一次。
  if (!statePath && baseDir !== legacyDir && !existsSync(stateFile) && existsSync(join(legacyDir, '欲望状态.json'))) {
    try {
      mkdirSync(baseDir, { recursive: true })
      for (const f of ['欲望状态.json', '欲望面板配置.json', '欲望历史.json', '心情日记.json', '面板令牌.txt']) {
        const src = join(legacyDir, f)
        if (existsSync(src) && !existsSync(join(baseDir, f))) writeFileSync(join(baseDir, f), readFileSync(src))
      }
      logger.info?.(`[dsh-longing] 已把状态从 ${legacyDir} 搬到 ${baseDir}`)
    } catch (e) {
      logger.warn?.(`[dsh-longing] 状态目录迁移失败，继续用旧目录：${e?.message ?? e}`)
    }
  }
  logger.info?.(`[dsh-longing] 状态目录：${baseDir}`)

  // 可选迁移：只有显式配了 migrateFrom 才搬，搬一次就够（不写死任何本机路径）
  const migrateFrom = String(config?.migrateFrom ?? '').trim()
  if (!statePath && migrateFrom) {
    // 2026-11-10（审计 F24）：显式迁移以前漏了日记，搬完只剩数值没有她写过的话
    for (const name of ['欲望状态.json', '欲望面板配置.json', '欲望历史.json', '心情日记.json']) {
      const dest = join(baseDir, name)
      const src = join(migrateFrom, name)
      if (existsSync(dest) || !existsSync(src)) continue
      try {
        mkdirSync(baseDir, { recursive: true })
        writeFileSync(dest, readFileSync(src))
      } catch (e) {
        console.warn(`[dsh-longing] 迁移 ${name} 失败：${e?.message ?? e}`)
      }
    }
  }

  // ── 面板配置：只收行为参数，历史遗留的状态键就地清掉 ──
  const rawPanel = readJson(cfgFile, {}) ?? {}
  const PANEL_KEY_MARK = '__panelKeys'
  // 文件里混着两种东西：启动时从插件配置抄过来的快照，和用户在面板上真改过的键。
  // 分不清的话，用户在 DSH 设置页改的值会被上次启动写下的快照永久盖住 ——
  // 症状是「设置页改了没反应，只有点面板『恢复默认』才动」，这在别人机器上极难自查。
  // 所以从 1.12.0 起用 __panelKeys 记下哪些键是面板改的；旧文件没有这个标记，
  // 就整份当面板改动处理（保持老用户原来的行为）。
  const panelOverrides = {}
  const panelKeys = new Set(
    Array.isArray(rawPanel[PANEL_KEY_MARK]) ? rawPanel[PANEL_KEY_MARK].map(String) : Object.keys(rawPanel),
  )
  for (const [k, v] of Object.entries(rawPanel)) {
    if (k === PANEL_KEY_MARK || STATE_KEYS.has(k) || !panelKeys.has(k)) continue
    // 1.12.0 删掉的死键（ownerIds、配置层的 pausedUntil）不能再复活：旧的面板文件里还留着它们，
    // 不过滤的话每次启动都会把它们写回去，面板上永远清不掉。
    if (!Object.hasOwn(config ?? {}, k)) continue
    panelOverrides[k] = v
  }
  const dropped = Object.keys(rawPanel).filter(
    (k) => STATE_KEYS.has(k) || (k !== PANEL_KEY_MARK && !Object.hasOwn(config ?? {}, k)),
  )
  if (dropped.length) logger.info?.(`[dsh-longing] 面板配置里清掉无效键：${dropped.join(',')}`)

  /** 把「插件配置 + 面板改动」合并后写回文件：只读文件的通道插件（dsh-qq 等）也能看到通道/开关。 */
  const flushPanelFile = () => {
    const snapshot = {}
    for (const [k, v] of Object.entries(config ?? {})) {
      if (STATE_KEYS.has(k) || k.startsWith('__')) continue
      snapshot[k] = v
    }
    // 一定要把 writeJson 的结果带回去：调用方靠它决定回 200 还是 500。
    // 漏了 return 的话「保存设置」永远报失败（面板显示灰色提示），但配置其实写进去了。
    return writeJson(cfgFile, { ...snapshot, ...panelOverrides, [PANEL_KEY_MARK]: Object.keys(panelOverrides) }, logger)
  }
  flushPanelFile()

  // 面板令牌：首次生成后落盘，面板首屏输入一次即可。
  const tokenFile = join(baseDir, '面板令牌.txt')
  let panelToken = ''
  try {
    panelToken = readFileSync(tokenFile, 'utf8').trim()
  } catch {}
  if (!panelToken) {
    panelToken = randomUUID().replace(/-/g, '')
    try {
      mkdirSync(baseDir, { recursive: true })
      writeFileSync(tokenFile, panelToken, 'utf8')
    } catch {}
  }
  logger.info?.(`[dsh-longing] 面板令牌文件：${tokenFile}`)

  // 热重载时要能真正停下来：旧闭包继续跑会重复注册路由和工具、用过期 state 覆盖注入文件
  let disposed = false
  // 2026-11-10（审计 F02）：实例代际。销毁后仍可能有 Promise 在等模型，
  // 等它回来时如果还拿旧闭包写盘，就会把新实例的记录盖掉。
  const myGen = (globalThis.__dshLongingGen = num(globalThis.__dshLongingGen) + 1)
  const stillMine = () => !disposed && num(globalThis.__dshLongingGen) === myGen

  // 初始值只认插件配置（面板配置里的状态键已经被清掉了），状态文件才是真相。
  const base = {
    lust: clamp(num(config?.lust, DEFAULTS.lust)),
    lewd: clamp(num(config?.lewd, DEFAULTS.lewd)),
    possess: clamp(num(config?.possess, DEFAULTS.possess)),
    shame: clamp(num(config?.shame, DEFAULTS.shame)),
    resist: clamp(num(config?.resist, DEFAULTS.resist)),
    fatigue: clamp(num(config?.fatigue, DEFAULTS.fatigue)),
    affection: clamp(num(config?.affection, DEFAULTS.affection)),
    scene: String(config?.scene ?? '').slice(0, 40),
  }

  function settings() {
    return { ...config, ...panelOverrides }
  }

  /** 给面板看的设置：剔除状态键，免得上一次配置里的初始值把滑块盖掉。 */
  function publicSettings() {
    const s = settings()
    const out = {}
    for (const [k, v] of Object.entries(s)) if (!STATE_KEYS.has(k) && !k.startsWith('__')) out[k] = v
    return out
  }

  function normalizeState(s) {
    const out = { ...s }
    for (const k of VALUE_KEYS) out[k] = clampFloat(num(out[k], base[k] ?? DEFAULTS[k] ?? 50))
    // 纯数字的场景是历史脏值（清空输入框时 Number('') === 0），直接扔掉
    const scene = String(out.scene ?? base.scene ?? '').slice(0, 40)
    out.scene = /^\d+$/.test(scene.trim()) ? '' : scene
    out.pausedUntil = num(out.pausedUntil, 0)
    out.lastPeak = String(out.lastPeak ?? '')
    out.lastLonelyAt = num(out.lastLonelyAt, 0)
    out.aftercareUntil = num(out.aftercareUntil, 0)
    out.everContacted = out.everContacted === true
    // 主动开口的账本：谁在什么时候说出口的。「每天最多几次」「每小时几次」
    // 「两次至少隔多久」全靠它算，之前的实现里压根没记过。
    out.proactiveLog = Array.isArray(out.proactiveLog)
      // 2026-11-10（审计 F08）：日配额可以配到 720，账本只留 64 条就永远到不了门槛。
      // 留 1024：够覆盖 720 的日额度，文件也不会大。
      ? out.proactiveLog.map(Number).filter((t) => Number.isFinite(t) && t > 0).sort((a, b) => a - b).slice(-1024)
      : []
    out.lastInitiateAt = num(out.lastInitiateAt, 0)
    out.lastInitiateInfo = out.lastInitiateInfo && typeof out.lastInitiateInfo === 'object' ? out.lastInitiateInfo : null
    // 主动发图的账本（每天几张）
    out.imageLog = Array.isArray(out.imageLog)
      ? out.imageLog.map(Number).filter((t) => Number.isFinite(t) && t > 0).sort((a, b) => a - b).slice(-32)
      : []
    out.lastImageInfo = out.lastImageInfo && typeof out.lastImageInfo === 'object' ? out.lastImageInfo : null
    out.tickedAt = num(out.tickedAt, num(out.updatedAt, Date.now()))
    out.lastContactAt = num(out.lastContactAt, num(out.updatedAt, Date.now()))
    out.events = Array.isArray(out.events) ? out.events.filter((e) => e && Object.hasOwn(EVENTS, String(e.name ?? ''))).slice(-24) : []
    out.grudges = Array.isArray(out.grudges)
      ? out.grudges.filter((g) => g && Object.hasOwn(EVENTS, String(g.name ?? '')) && num(g.t) + num(g.days, 1) * 86_400_000 > Date.now()).slice(-3)
      : []
    out.firsts = out.firsts && typeof out.firsts === 'object' ? out.firsts : {}
    // ── 好奇心（2026-11-06）──
    // curio 是独立的驱动力，不进 curve.js 的七维耦合：那套算的是身体，
    // 好奇心算的是「多久没换过新东西」，混在一起会互相污染。
    out.curio = clampFloat(num(out.curio, CURIO_DEFAULTS.curioStart))
    out.curioAt = num(out.curioAt, Date.now()) // 上次算好奇心的时刻，防止停机后一次性暴涨
    out.curioDropAt = num(out.curioDropAt, 0) // 上次因为「他说了话」扣值的时刻，防一分钟扣一次
    out.lastSearchAt = num(out.lastSearchAt, 0)
    out.searchLog = Array.isArray(out.searchLog)
      ? out.searchLog.map(Number).filter((t) => Number.isFinite(t) && t > 0).sort((a, b) => a - b).slice(-48)
      : []
    // 搜到但还没说出口的那一条；6 小时就过期（prompt.js 那边判）
    out.pendingTopic = out.pendingTopic && typeof out.pendingTopic === 'object' ? out.pendingTopic : null
    // 他最近说的一句原文，用来抠搜索词；只在内存和状态文件里，不外发
    out.lastUserText = String(out.lastUserText ?? '').slice(0, 200)
    out.updatedAt = num(out.updatedAt, Date.now())
    return out
  }

  /** 落盘快照：只在写文件时取两位小数，内存里保持连续值（否则每分钟 0.005 的衰减会被抹平）。 */
  function snapState() {
    const out = { ...state }
    for (const k of VALUE_KEYS) out[k] = round2(out[k])
    return out
  }

  let state = readJson(stateFile, null)
  // state 优先于 base：重启不能把运行时数值换回初始值
  state = normalizeState(
    state && typeof state === 'object'
      ? { ...base, ...state }
      : { ...base, updatedAt: Date.now(), lastPeak: '', pausedUntil: 0 },
  )
  // 停机期间的衰减立刻补上（原来是启动就把 updatedAt 设成 now，离线时长全丢了）
  if (num(state.pausedUntil) <= Date.now()) state = normalizeState(nextState(state, settings(), Date.now()))
  writeJson(stateFile, snapState(), logger)

  const history = readJson(historyFile, [])
  let lastHistoryWriteAt = 0

  // ── 心情日记：只写不推。谁想看就自己来读（面板 / /api/diary / 工具 / 文件）──
  let diary = pruneDiary(readJson(diaryFile, { days: {} }))
  const saveDiary = () => writeJson(diaryFile, diary, logger)
  // 首启就把日记文件落下来：面板那张卡、README 里的文件表都默认它存在，
  // 等第一条事件才出现的话，别人会以为日记功能没装好。
  if (!existsSync(diaryFile)) saveDiary()

  // ── 自写日记：把当天的事 + 此刻的状态交给 llm，取回一两句她自己的话 ──
  // 三条边界：①没东西可写就不写（宁可空着也不编）②失败静默（模型不在/报错时模板继续兜底）
  // ③只写不推（写完不主动发消息）。额度与间隔由 shouldReflect 判。
  let reflecting = false
  let lastReflectAt = 0
  let lastReflectWhy = 'idle'
  // 自动路径的「为什么没写」单独放：以前和 lastWhy 共用一个变量，tick 每分钟
  // 跑一次就会把它覆盖成 gap/quota，于是手动写完再看状态永远是「间隔不够」。
  let lastReflectGate = 'idle'
  // 写空时留的现场（模型原文前 300 字），排查用
  let lastReflectRaw = ''
  // 见过推理流（reasoning-delta）就记住：之后的额度下限抬到 1600，别每轮都先白花一次
  let reasoningModelSeen = false

  // llm 是可选依赖：没装适配器、没配模型时返回 null，插件照常跑。
  const reflectCaller = () => {
    try {
      const llm = ctx?.get?.('llm')
      if (!llm?.stream) return null
      const sel = ctx?.get?.('agentDefaultModel')?.currentSelection?.() ?? {}
      const cfg = settings() ?? {}
      const provider = String(cfg.diaryProvider ?? '').trim() || String(sel.provider ?? '').trim()
      const model = String(cfg.diaryModel ?? '').trim() || String(sel.model ?? '').trim()
      if (!provider || !model) return null
      return { llm, provider, model }
    } catch {
      return null
    }
  }

  /**
   * 写一条日记。force=true 时跳过额度/间隔判断（面板按钮、工具 action=reflect 用）。
   * @returns {Promise<{ok: boolean, why: string, lines?: string[], day?: object}>}
   */
  const reflectNow = async ({ force = false, signal } = {}) => {
    if (reflecting) return { ok: false, why: 'busy' }
    const cfg = settings() ?? {}
    const gate = shouldReflect({ diary, state, cfg, now: Date.now() })
    if (!gate.ok && !force) {
      lastReflectGate = gate.why
      return gate
    }
    if (gate.why === 'off' && !force) {
      lastReflectWhy = 'off'
      return gate
    }
    const caller = reflectCaller()
    if (!caller) {
      lastReflectWhy = 'no-model'
      return { ok: false, why: 'no-model' }
    }
    reflecting = true
    const startedAt = Date.now()
    let raw = ''
    let todayFacts = []
    let finishKind = 'stop'
    let reasonChars = 0
    const chunkTypes = new Set()
    // 2026-11-9：推理型模型（stream 里出现 reasoning-delta）会把 token 全用在思考上，
    // finish=max-tokens 时一个字正文都没有 —— 面板上看着像「她不想写」。
    // 一旦见过推理流，之后的额度直接抬到这个下限。
    const askOnce = async (pmt, tokenBudget, extraUser = '') => {
      raw = ''
      finishKind = 'stop'
      reasonChars = 0
      chunkTypes.clear()
      const stream = caller.llm.stream({
        provider: caller.provider,
        model: caller.model,
        system: pmt.system,
        messages: [{ role: 'user', content: [{ type: 'text', text: pmt.user + extraUser }] }],
        maxTokens: tokenBudget,
        temperature: num(cfg.diaryTemperature, REFLECT_DEFAULTS.diaryTemperature),
        signal,
      })
      for await (const chunk of stream) {
        if (chunk?.type) chunkTypes.add(String(chunk.type))
        const piece = chunk?.textDelta ?? chunk?.text ?? (typeof chunk?.delta === 'string' ? chunk.delta : undefined)
        if (chunk?.type === 'text-delta' && typeof piece === 'string') raw += piece
        else if (chunk?.type === 'reasoning-delta') {
          if (typeof piece === 'string') reasonChars += piece.length
        } else if (chunk?.type === 'finish') {
          const kind = String(chunk?.reason?.kind ?? 'stop')
          finishKind = kind
          if (kind === 'error') break
        }
      }
    }
    try {
      // 2026-11-10（审计 F09）：todayOf 保证拿到的是「今天」（没有就是空壳），
      // 不再拿 recentDiary()[0] —— 今天还没记录时它给的是昨天。
      const day = todayOf(diary, startedAt)
      // 今天的依据：事件原话（detail）优先，没有就退回固定 note
      todayFacts = [...(day?.up ?? []), ...(day?.down ?? [])].map((e) => String(e?.detail || e?.note || '')).filter(Boolean)
      const prompt = buildReflectPrompt({
        day,
        dims: state,
        previous: recentThoughtTexts(day, 3),
        persona: String(cfg.diaryPersona ?? '').trim() || String(cfg.personaName ?? '').trim(),
        maxChars: Math.round(num(cfg.diaryMaxChars, REFLECT_DEFAULTS.diaryMaxChars)),
        owner: String(cfg.ownerRef ?? '').trim() || 'TA',
        now: Date.now(),
      })
      const baseTokens = Math.round(num(cfg.diaryMaxTokens, REFLECT_DEFAULTS.diaryMaxTokens))
      // 2026-11-10（审计 F13）：配置是硬上限。以前把 60 抬到 1600 —— 用户明确给了小预算，
      // 插件不能自己加十倍。要重问可以，但必须还在「用户允许的量级」里。
      const firstBudget = Math.min(baseTokens, 4000)
      await askOnce(prompt, firstBudget)
      if (!raw.trim() && reasonChars > 0) {
        reasoningModelSeen = true
        const canGrow = firstBudget >= 600
        if (!canGrow) {
          logger.warn?.(`[dsh-longing] 只思考没正文，且 diaryMaxTokens=${firstBudget} 太小，按配置不追加预算`)
        } else {
          const retryTokens = Math.min(firstBudget * 3, 4000)
          logger.info?.(`[dsh-longing] 这次只有思考没有正文（finish=${finishKind}，思考 ${reasonChars} 字），用 ${retryTokens} 重问`)
          await askOnce(prompt, retryTokens, '\n\n（不要写推理过程，直接给出那两三句话。）')
        }
      }
    } catch (e) {
      lastReflectWhy = 'error'
      logger.warn?.(`[dsh-longing] 日记没写出来：${e?.message ?? e}`)
      return { ok: false, why: 'error' }
    } finally {
      reflecting = false
    }
    // 2026-11-10（审计 F02）：旧实例（已 dispose）不许落盘 —— 它手里的 diary 是旧的，
    // 写下去会把新实例的记录盖掉。在途请求没法取消，但可以让它「不提交」。
    if (!stillMine()) {
      lastReflectWhy = 'stale'
      logger.info?.('[dsh-longing] 旧实例的写作已作废，不落盘')
      return { ok: false, why: 'stale' }
    }
    // 2026-11-10（审计 F14）：finish=error 表示这一轮出错，正文即使是完整的也不可信
    if (finishKind === 'error') {
      lastReflectWhy = 'model-error'
      lastReflectRaw = String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, 200)
      diary = noteReflect(diary, { now: Date.now(), ok: false })
      saveDiary()
      logger.warn?.('[dsh-longing] 日记这一轮出错（finish=error），不落盘')
      return { ok: false, why: 'model-error' }
    }
    // 写出来对不上今天这些事实的句子进不了日记 —— 不许捏造。
    const lines = extractThoughts(raw, {
      maxChars: Math.round(num(cfg.diaryMaxChars, REFLECT_DEFAULTS.diaryMaxChars)),
      maxCount: 3,
      facts: todayFacts,
    })
    if (!lines.length) {
      // 失败也要记账：否则每 60 秒重试一次，一直烧 token（审计 F05 的退避）
      diary = noteReflect(diary, { now: Date.now(), ok: false })
      saveDiary()
      // 2026-11-9：空了要留证据，否则面板只会说「没写出来」，排查全靠猜。
      const field = raw.replace(/\s+/g, ' ').trim()
      const why = finishKind === 'error'
        ? 'model-error'
        : (!raw.trim() && reasonChars > 0
          ? 'reasoning-only'
          : (todayFacts.length && raw.trim() ? 'no-anchor' : 'empty'))
      lastReflectRaw = field.slice(0, 300)
        || `(没收到正文; finish=${finishKind}; 思考 ${reasonChars} 字; chunk=${[...chunkTypes].join(',') || '无'})`
      lastReflectWhy = why
      logger.warn?.(`[dsh-longing] 日记写出来是空的（finish=${finishKind}）：${lastReflectRaw}`)
      return { ok: false, why, raw: lastReflectRaw }
    }
    // 一天一篇：这次写的替换掉今天她写的部分（手动「记下一句」kind=mine 保留），
    // 以前是逐句 push，一天能堆八句近似的话，看着像复读机。
    diary = replaceThoughts(diary, lines, Date.now())
    // 水位记「开始写作的时间」，不是完成时间：思考期间新发生的事下一轮还能用（F11）
    diary = noteReflect(diary, { now: Date.now(), ok: true, wroteAt: startedAt })
    // 2026-11-10（审计 F23）：落盘失败以前没人管，接口照样回 ok
    if (!saveDiary()) {
      lastReflectWhy = 'write-failed'
      return { ok: false, why: 'write-failed' }
    }
    lastReflectAt = Date.now()
    lastReflectWhy = 'wrote'
    logger.info?.(`[dsh-longing] 日记：${lines.join(' / ')}`)
    return { ok: true, why: 'wrote', lines, day: recentDiary(diary, 1)[0] }
  }
  // 同进程零 IO 的入口（别的插件 / 脚本直接调）
  try {
    globalThis.__dshLongingReflect = reflectNow


  } catch {}

  // ── 生图后端：探测 + 可选自动拉起（失败只降级，不影响聊天）──
  // known=false 表示「没探测过」：这时注入里不许出现任何生图判断句，
  // 否则会像 1.0.0 那样把「还没探测」写成「图床没开」，她从此不敢生图。
  const comfy = { up: false, known: false, checkedAt: 0, url: '', error: '' }
  let lastLaunchAt = 0
  globalThis.__dshComfyUp = null

  const launchComfy = () => {
    const eff = settings()
    const script = String(eff?.comfyLaunchScript ?? '').trim()
    if (!script || !existsSync(script)) return false
    // 只认脚本/可执行文件，并且必须落在白名单目录里。
    // 面板令牌能读 localStorage，等于能被同源脚本拿到；不设这道门，
    // 拿到令牌就能让这台机器跑任意文件。
    if (!/\.(ps1|bat|cmd|exe)$/i.test(script)) {
      logger.warn?.(`[dsh-longing] 拒绝启动：只接受 .ps1/.bat/.cmd/.exe，拿到的是 ${script}`)
      return false
    }
    // 白名单目录默认空 = 不限制（以前默认是作者机器上的一个固定盘符：别人的机器上
    // 根本没有这个盘，于是「填了自己的脚本路径也拉不起来」，日志里只有一句「不在允许目录」）。
    const allowDir = String(eff?.comfyLaunchAllowDir ?? '').trim()
    if (allowDir) {
      const under = resolve(script).toLowerCase().startsWith(resolve(allowDir).toLowerCase() + sep)
      if (!under) {
        logger.warn?.(`[dsh-longing] 拒绝启动：${script} 不在允许目录 ${allowDir} 下`)
        return false
      }
    }
    if (Date.now() - lastLaunchAt < 10 * 60_000) return false
    try {
      // RemoteSigned 而不是 Bypass：本地自己写的脚本照常跑，
      // 从网上下载来的（带下载标记）要求签名 —— 那正是该拦的。
      const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'RemoteSigned', '-File', script], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      })
      child.unref()
      lastLaunchAt = Date.now()
      logger.info?.(`[dsh-longing] 已尝试拉起 ComfyUI：${script}`)
      return true
    } catch (e) {
      logger.warn?.(`[dsh-longing] 拉起 ComfyUI 失败：${e?.message ?? e}`)
      return false
    }
  }

  async function probeComfy() {
    const eff = settings()
    // comfyEnabled 只关「自动探测/拉起」，不代表后端不可用 —— 关掉时按未知处理
    if (eff?.comfyEnabled === false) {
      comfy.known = false
      comfy.checkedAt = Date.now()
      globalThis.__dshComfyUp = null
      return
    }
    const baseUrl = String(eff?.comfyBaseUrl ?? 'http://127.0.0.1:8188').replace(/\/+$/, '')
    comfy.url = baseUrl
    // 只允许本机：这项配置能让服务端代发 GET，
    // 填一个内网地址就变成端口探测器（还能从 error 里读回主机名）。
    let hostOk = false
    try {
      const u = new URL(baseUrl)
      hostOk = (u.protocol === 'http:' || u.protocol === 'https:') && ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(u.hostname)
    } catch {}
    if (!hostOk) {
      comfy.up = false
      comfy.known = true
      comfy.checkedAt = Date.now()
      comfy.error = '只允许本机地址（127.0.0.1 / localhost）'
      globalThis.__dshComfyUp = false
      return
    }
    try {
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(), 1500)
      // 只校验了初始 URL 的回环主机；fetch 默认跟随重定向，本地端点一跳就能把
      // 请求带去外部/内网。redirect:'error' 让重定向直接失败（审计 F21）。
      const res = await fetch(`${baseUrl}/system_stats`, { signal: ac.signal, redirect: 'error' })
      clearTimeout(timer)
      comfy.up = res.ok
      comfy.error = res.ok ? '' : `HTTP ${res.status}`
    } catch (e) {
      comfy.up = false
      comfy.error = String(e?.name === 'AbortError' ? 'timeout' : (e?.message ?? e))
    }
    comfy.known = true
    comfy.checkedAt = Date.now()
    globalThis.__dshComfyUp = comfy.up
    if (!comfy.up && eff?.comfyAutoLaunch) launchComfy()
  }

  // 注入块：每轮 tick / 每次状态变更生成一次，写文件 + 挂到 globalThis，供任何通道插件取用
  const injectFile = join(baseDir, '欲望注入.txt')
  function refreshBlock() {
    const eff = settings()
    // 2026-11-9：把「她自己写下的日记」带进注入块。取今天最后两条，
    // 太多会盖过七维，太少则接不上刚才的心气。
    const todayThoughts = (recentDiary(diary, 1)[0]?.thoughts ?? [])
      .slice(-2)
      .map((x) => String(x?.text ?? ''))
      .filter(Boolean)
    const env = { comfyUp: comfy.known ? comfy.up : null, thoughts: todayThoughts }
    const channels = Array.isArray(eff?.channels) ? eff.channels.map(String) : ['qq']
    const perChannel = {}
    for (const ch of channels) {
      const text = buildBlock(state, eff, { ...env, channel: ch })
      perChannel[ch] = text
      writeTextAtomic(join(baseDir, `欲望注入.${ch}.txt`), text, logger)
    }
    // 主文件是给「不知道自己叫什么名字」的老式通道插件读的，而它们历来都是 QQ：
    // 只有 qq 被勾选时主文件才给欲望块，否则给中性块。其余通道读自己的专属文件。
    const main = channels.includes('qq')
      ? perChannel.qq
      : buildBlock(state, eff, { ...env, channel: '__none__' })
    writeTextAtomic(injectFile, main, logger)
    globalThis.__dshDesireBlock = main
    globalThis.__dshDesireBlocks = perChannel
    return main
  }
  refreshBlock()

  const isPaused = () => num(state.pausedUntil) > Date.now()
  /** 调试模式：关着的时候数值只能靠聊天养，滑块和工具都改不动。 */
  const isDebug = () => settings()?.debugMode === true
  // 2026-11-10（审计 F04）：总开关判据。以前 enabled 只挡 tick。
  const isEnabled = () => settings()?.enabled !== false
  const isNsfw = () => settings()?.nsfwEnabled === true

  const curMode = () => modeOf(state, num(settings()?.resistWeight, 0.5), num(settings()?.affectionWeight, 0.4))

  /** 四档正反馈：0 没有 / 1 心里想 / 2 暗示 / 3 开口 / 4 上手。 */
  const FEEDBACK_LEVEL = ['', 'feedbackThink', 'feedbackHint', 'feedbackSpeak', 'feedbackAct']
  function urgeOf(s, cfg) {
    const eff = effOf(s, num(cfg?.resistWeight, 0.5), num(cfg?.affectionWeight, 0.4))
    if (eff >= num(cfg?.urgeAct, 85)) return 4
    if (eff >= num(cfg?.urgeSpeak, 70)) return 3
    if (eff >= num(cfg?.urgeHint, 55)) return 2
    if (eff >= num(cfg?.urgeThink, 40)) return 1
    return 0
  }

  /**
   * 被晾着了。
   *
   * 两条前提和一条排除：
   *  - 必须曾经联系过（否则换通道、第一天装都会永久「是不是不要我了」）；
   *  - 现在在睡觉时间内，一律不算（人在睡，不是冷落）；
   *  - 计时只算清醒时段：昨晚一点聊完、今早八点起床，中间那七小时不算被晾着。
   */
  function isLonely(cfg) {
    if (isPaused()) return false
    if (state.everContacted !== true) return false
    const sleep = String(cfg?.sleepWindow ?? '23:30-08:00')
    if (inSleepWindow(sleep)) return false
    const last = num(state.lastContactAt, num(state.updatedAt))
    // 超过 48 小时就不用再精确了：肯定已经算孤独，只回溯两天免得白循环
    const from = Math.max(last, Date.now() - 48 * 3_600_000)
    const awake = awakeHoursBetween(from, Date.now(), sleep)
    return awake > num(cfg?.lonelyHours, 6) || last < Date.now() - 48 * 3_600_000
  }

  /**
   * 面板/工具/通道共用的状态载荷：数值 + 模式 + 每个维度的软上限 + 档位与孤独。
   * caps 让面板能把「被谁压着」画出来；urge/feedback/lonely 让通道插件知道现在该不该主动。
   */
  function statePayload() {
    const eff = settings()
    const press = pressureOf(state, eff)
    const caps = {}
    const overBy = {}
    for (const k of VALUE_KEYS) {
      caps[k] = Math.round(press[k].cap)
      if (press[k].by && state[k] > press[k].cap) overBy[k] = press[k].by
    }
    const urge = urgeOf(state, eff)
    // lastUserText 不出去：那是主人最后一条消息原文，面板用不到，
    // 但这个端口一旦被反代出去它就跟着漏。它仍在状态文件里给好奇心取词用。
    const { lastUserText: _omit, ...publicState } = state
    return {
      ...publicState,
      mode: modeOf(state, num(eff?.resistWeight, 0.5), num(eff?.affectionWeight, 0.4)),
      caps,
      overBy,
      recent: recentEvents(state),
      debug: eff?.debugMode === true,
      urge,
      feedback: urge > 0 ? eff?.[FEEDBACK_LEVEL[urge]] !== false : false,
      lonely: isLonely(eff),
      // 现在能不能主动：面板「主动行为」那几个键就是这里的判据，
      // 通道插件（dsh-qq 等）只查这一个字段，不再自己另写一套定时器。
      proactive: proactiveGate({ cfg: eff, state }),
      // 现在能不能主动发一张图（她自己拍/自己画，不是「要图」）
      image: imageGate({ cfg: eff, state }),
      paused: isPaused(),
      // 她能到哪一步：面板和通道插件都靠这个显示进度，而不是靠猜
      unlocked: unlockedOf(state, eff).map((u) => ({ key: u.key, name: u.name, ok: u.ok, gap: Math.round(u.gap) })),
      deepest: deepestUnlocked(state, eff)?.name ?? '',
      nextGate: nextLocked(state, eff)?.name ?? '',
    }
  }

  /** 暂停期间不推进的亲密事件：现实里的「拒绝/冷淡/提别人」照记，但撩拨不算。 */
  const INTIMATE_EVENTS = new Set(['intimate', 'desire', 'tease', 'coax'])

  /** 会留下「第一次」的事件：只记一次，用来给她一个像样的反应。 */
  const FIRST_EVENTS = new Set(['intimate', 'desire', 'leave', 'force', 'reject'])

  /**
   * 施加一次事件（一句话 / 一个举动）并落盘。
   * 递减、封顶、安全词都在 events.js 里，这里只管接进来和回声。
   */
  /** 事件冷却：非调试模式下同一事件 30 秒一次，挡住用 API 当无级滑块刷。 */
  const lastEventAt = new Map()

  function fireEvent(name, { detail = '', src = '' } = {}) {
    const key = String(name ?? '').trim()
    if (!Object.hasOwn(EVENTS, key)) return { ok: false, text: `未知事件：${key || '(空)'}` }
    // 2026-11-10（审计 F04）：总开关要盖住事件入口。安全词（stop）不挡 —— 那是保护入口。
    if (!isEnabled() && key !== 'stop') return { ok: false, text: '插件已关闭（enabled=false）' }
    // 成人总闸关着时亲密事件不接受：否则「关了成人内容」还能靠事件刷出亲密记录
    if (!isNsfw() && INTIMATE_EVENTS.has(key) && key !== 'stop') {
      return { ok: false, text: '成人内容已关，这条不算' }
    }
    if (isPaused() && INTIMATE_EVENTS.has(key)) return { ok: false, text: '已暂停亲密，这条不算' }
    if (!isDebug()) {
      const last = lastEventAt.get(key) ?? 0
      if (Date.now() - last < 30_000) return { ok: false, text: '这一条刚记过，等会儿再说' }
    }
    lastEventAt.set(key, Date.now())
    const r = applyEvent(state, key, settings(), Date.now())
    state = normalizeState(r.state)
    // 有人跟她发生了一件事 = 她不是被晾着。否则同一分钟里会先记「被夸过一句」再记「被晾了一整天」。
    state.lastContactAt = Date.now()
    state.everContacted = true
    // 「第一次」只记一次：第一次被碰、第一次被要、第一次听他说要走……
    if (FIRST_EVENTS.has(key) && !state.firsts[key]) state.firsts = { ...state.firsts, [key]: Date.now() }
    // 顺手记进当天的日记：好的进「让我高兴的」，坏的进「让我难受的」
    diary = recordEvent(diary, { name: key, note: r.note, tone: r.tone, detail, src, now: Date.now() })
    saveDiary()
    writeJson(stateFile, snapState(), logger)
    refreshBlock()
    return {
      ok: true,
      applied: r.applied,
      mult: r.mult,
      text: `${EVENTS[key].note}｜${curMode()}`,
    }
  }
  globalThis.__dshLongingEvent = fireEvent

  // 通道插件收到主人消息时调一下：涨性欲、涨好感（热重载不重复注册）
  // kind 默认 'owner'：别的通道插件通常不会传参数，没传就当主人说话 ——
  // 原来只认字面 'owner'，不传等于「没联系过」，于是主动判据永远停在 never。
  globalThis.__dshLongingNote = (kind = 'owner', text = '') => {
    if (kind !== 'owner' && kind !== 'contact') return
    // 暂停期间不涨 —— 否则「暂停」只是个标签。
    // 2026-11-10（审计 F18）：但「有人来找过她」这件事仍要记下来，
    // 否则暂停期间说的话不算联系，恢复后会被当成被晾了一整天。
    if (isPaused()) {
      state.lastContactAt = Date.now()
      state.everContacted = true
      writeJson(stateFile, snapState(), logger)
      return
    }
    const eff = settings()
    // 2026-11-06：顺手记下他刚说的一句，好奇心搜什么词靠它抠。
    // 第二个参数是可选的，老调用方（不传 text）行为完全不变。
    if (text) state.lastUserText = String(text).slice(0, 200)
    const nextLust = clampFloat(num(state.lust, DEFAULTS.lust) + num(eff?.interactionLust, 0.1))
    const nextAff = clampFloat(num(state.affection, DEFAULTS.affection) + num(eff?.affectionGain, 1))
    // 已经顶满就不重复写盘（连发多条消息时省掉成串的同步 IO）。
    // 但联系时间要落：涨值满了不代表没联系过（审计 F18）。
    if (nextLust === state.lust && nextAff === state.affection && !text) {
      state.lastContactAt = Date.now()
      state.everContacted = true
      state.updatedAt = Date.now()
      writeJson(stateFile, snapState(), logger)
      return
    }
    state.lust = nextLust
    state.affection = nextAff
    state.lastContactAt = Date.now() // 「被晾着多久」从这里算
    state.everContacted = true // 有过一次联系才谈得上「被晾着」
    state.updatedAt = Date.now()
    writeJson(stateFile, snapState(), logger)
    refreshBlock()
  }

  probeComfy()
    .catch(() => {})
    .finally(() => refreshBlock()) // 探测结果出来了再刷一次，别让首帧的「未知」留到下一分钟
  const comfyTimer = setInterval(async () => {
    await probeComfy().catch(() => {})
    refreshBlock()
  }, Math.max(15, num(settings()?.comfyProbeSec, 60)) * 1000)
  comfyTimer?.unref?.()
  ctx?.on?.('dispose', () => {
    disposed = true
    // 只有自己还是当前代际时才退回计数：旧实例销毁不该把新实例的标记清掉
    if (num(globalThis.__dshLongingGen) === myGen) globalThis.__dshLongingGen = myGen - 1
    clearInterval(comfyTimer)
    if (webTimer) clearTimeout(webTimer)
    if (toolTimer) clearTimeout(toolTimer)
    // 全局入口也要摘掉：不然热重载后通道插件还调着旧闭包，用过期 state 覆盖注入文件
    for (const k of ['__dshDesireBlock', '__dshDesireBlocks', '__dshLongingNote', '__dshLongingEvent', '__dshLongingState', '__dshLongingProactive', '__dshLongingMarkInitiate', '__dshLongingPauseWord', '__dshLongingImageGate', '__dshLongingMarkImage', '__dshLongingRefresh', '__dshLongingDiary', '__dshLongingDiaryText', '__dshComfyUp', '__dshQqLastOwnerAt', '__dshLongingInternals']) {
      try {
        delete globalThis[k]
      } catch {}
    }
  })

  // 2026-11-06：好奇心搜索。这是插件里除 ComfyUI 探活之外唯一对外发请求的地方。
  // 失败不重试 —— 冷却到了自然会再来一次，重试只会把额度烧在同一个坏词上。
  let searching = false
  async function runCurioSearch(eff) {
    if (searching) return
    searching = true
    const nowTs = Date.now()
    try {
      const q = buildQuery(state, eff, Math.floor(nowTs / 60_000))
      const results = await searchTopic(q, { limit: 5 })
      const topic = toTopic(results, Math.floor(nowTs / 60_000))
      state = normalizeState({
        ...state,
        // 搜完压到 20，不归零：刚看完就不想再看，太假
        curio: 20,
        lastSearchAt: nowTs,
        searchLog: [...(state.searchLog ?? []), nowTs],
        pendingTopic: topic ?? state.pendingTopic ?? null,
      })
      writeJson(stateFile, snapState(), logger)
      if (topic) logger.info?.(`[dsh-longing] 好奇心：搜了「${q}」→ ${String(topic.title).slice(0, 40)}`)
      // 抓到 0 条有两种可能：真没结果，或者 Bing 改了 HTML 结构。
      // 后者会静默失效（用户只会觉得「她最近不怎么主动了」），所以提到 warn，
      // 让它在日志里留痕，而不是伪装成「她不感兴趣」。
      else logger.warn?.(`[dsh-longing] 好奇心：搜了「${q}」但一条都没解析出来（可能是 Bing 结构变了）`)
    } catch (e) {
      logger.warn?.(`[dsh-longing] 好奇心搜索失败：${e?.message ?? e}`)
    } finally {
      searching = false
    }
  }

  async function tick() {
    const eff = settings()
    if (eff?.enabled === false) return

    // 顺手清理过期的「主人私聊会话」登记，避免 Map 无限增长
    const owners = globalThis.__dshQqOwnerSessions
    if (owners instanceof Map) {
      const nowTs = Date.now()
      for (const [sid, expire] of owners) if (Number(expire) < nowTs) owners.delete(sid)
    }
    // 暂停：冻结数值，只刷新注入（避免恢复后一次性补偿衰减）
    if (num(state.pausedUntil) > Date.now()) {
      // 2026-11-10（审计 F17）：暂停期间也要推进衰减基准，否则恢复后
      // dt 把整段暂停时长算进去，一次性补算 —— 「暂停 30 分钟，恢复后数值凭空掉了」。
      state.tickedAt = Date.now()
      state.curioAt = Date.now()
      state.updatedAt = Date.now()
      writeJson(stateFile, snapState(), logger)
      refreshBlock()
      return
    }
    const disk = readJson(stateFile, null)
    if (disk && num(disk.updatedAt) > num(state.updatedAt)) state = normalizeState({ ...state, ...disk })
    state = normalizeState(nextState(state, eff, Date.now()))

    // ── 好奇心（2026-11-06）──
    // 先算数值（纯算术，不联网），够了再问 shouldSearch（冷却/日上限/暂停），
    // 全过才真发一次请求。心跳本身永远不发请求 —— 这是硬约束。
    {
      const cur = tickCurio(state, eff, Date.now())
      state = normalizeState({ ...state, curio: cur.curio, curioAt: Date.now(), curioDropAt: cur.dropAt ?? num(state.curioDropAt) })
      if (cur.want) {
        const admit = shouldSearch(state, eff, Date.now())
        if (admit.ok) await runCurioSearch(eff)
      }
    }

    // 被晾着：超过 lonelyHours 没有消息 → 一天最多记一次失望。
    // 按「距上次间隔」而不是按日期：23:50 和次日 00:10 不该算两次。
    const lonelyGapOk = Date.now() - num(state.lastLonelyAt) > 12 * 3_600_000
    if (isLonely(eff) && lonelyGapOk) {
      const r = applyEvent(state, 'neglect', eff, Date.now())
      state = normalizeState({ ...r.state, lastLonelyAt: Date.now() })
      diary = recordEvent(diary, { name: 'neglect', note: r.note, tone: r.tone, now: Date.now() })
      saveDiary()
      logger.info?.('[dsh-longing] 一天没说话，记了一次失望')
    }

    writeJson(stateFile, snapState(), logger)
    refreshBlock()

    // 先把今天聊天记录里的事实补进日记（本地读盘 + 正则，零 token），再决定要不要让她写
    try {
      } catch {}
    // 日记：每轮只判断一次「要不要写」，真要写才发一个模型请求（失败静默，不影响心跳）
    void reflectNow().catch(() => {})

    history.push({
      t: state.updatedAt,
      l: Math.round(state.lust),
      d: Math.round(state.lewd),
      p: Math.round(state.possess),
      a: Math.round(state.affection),
    })
    while (history.length > HISTORY_MAX) history.shift()
    if (Date.now() - lastHistoryWriteAt >= HISTORY_WRITE_MS) {
      lastHistoryWriteAt = Date.now()
      writeJson(historyFile, history)
    }
  }

  const timer = setInterval(tick, TICK_MS)
  if (typeof timer?.unref === 'function') timer.unref()
  ctx?.on?.('dispose', () => clearInterval(timer))

  // ── 面板 HTTP 路由（由 DSH 的 webServer 提供，不再依赖 Python）──
  const registerWeb = (web) => {
    const send = (res, code, body, type = 'application/json; charset=utf-8') => {
      const data = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8')
      res.writeHead(code, { 'content-type': type, 'content-length': data.length })
      res.end(data)
    }
    const json = (res, obj) => send(res, 200, JSON.stringify(obj))
    const body = (req) =>
      new Promise((settle) => {
        const chunks = []
        let size = 0
        let done = false
        // 超限时也要 resolve：否则 destroy 之后 end 不触发，这个请求会永远挂住
        const finish = (v) => {
          if (done) return
          done = true
          settle(v)
        }
        req.on('data', (c) => {
          chunks.push(c)
          size += c.length
          if (size > 262144) {
            finish({})
            req.destroy()
          }
        })
        req.on('end', () => {
          try {
            // 必须拼成 Buffer 再解码：raw += c 会让多字节中文在分片边界被截断，
            // JSON.parse 失败后静默返回 {}，面板提交中文日记时就是这样丢的。
            finish(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
          } catch {
            finish({})
          }
        })
        req.on('error', () => finish({}))
      })

    const here = dirname(fileURLToPath(import.meta.url))
    const panelDir = join(here, '..', 'panel')

    web.register({
      kind: 'prefix',
      path: '/dsh-longing',
      handler: async (req, res) => {
        const url = String(req.url ?? '').split('?')[0]
        // 只允许本机回环来源；带 Origin 时必须同源（挡 CSRF）
        const origin = String(req.headers.origin ?? '')
        if (origin) {
          const host = String(req.headers.host ?? '')
          let originHost = ''
          try {
            originHost = new URL(origin).host
          } catch {}
          if (!originHost || originHost !== host) return send(res, 403, 'forbidden origin')
        }
        if (url.startsWith('/dsh-longing/api/')) {
          const tok = String(req.headers['x-desire-token'] ?? '')
          if (!panelToken || !safeEqual(tok, panelToken)) return send(res, 401, 'unauthorized')
        }
        if (url.startsWith('/dsh-longing/api/proactive')) {
          // 面板要能看见「为什么不能主动」，不然那栏数值改完像没反应一样。
          // POST {action:'mark'} 只是手动记一笔，方便调试；正常由通道插件回报。
          if (req.method === 'POST') {
            const p = await body(req)
            if (p?.action === 'mark') {
              state = normalizeState({ ...state, ...noteInitiate({ state, now: Date.now(), info: { channel: 'panel' } }) })
              state.updatedAt = Date.now()
              if (!writeJson(stateFile, snapState(), logger)) {
                return send(res, 500, JSON.stringify({ error: 'write failed', hint: '状态文件可能被占用' }))
              }
              refreshBlock()
            }
          }
          return json(res, proactiveGate({ cfg: settings(), state }))
        }
        if (url.startsWith('/dsh-longing/api/state')) {
          if (req.method === 'POST') {
            if (!isDebug()) {
              return send(res, 403, JSON.stringify({ error: 'debug off', hint: '数值只能靠聊天养。要直接改先开调试模式。' }))
            }
            const p = await body(req)
            for (const k of VALUE_KEYS) {
              if (p[k] === undefined) continue
              state[k] = clampFloat(p[k]) // 面板是用户直接控制，不按 STEP_LIMIT 限幅
            }
            if (p.scene !== undefined) state.scene = String(p.scene ?? '').slice(0, 40)
            if (p.pausedUntil !== undefined) state.pausedUntil = Math.max(0, num(p.pausedUntil, 0))
            state.updatedAt = Date.now()
            if (!writeJson(stateFile, snapState(), logger)) {
              return send(res, 500, JSON.stringify({ error: 'write failed', hint: '状态文件可能被记事本等程序占用' }))
            }
            refreshBlock()
          }
          return json(res, statePayload())
        }
        if (url.startsWith('/dsh-longing/api/resume')) {
          state.pausedUntil = 0
          state.updatedAt = Date.now()
          if (!writeJson(stateFile, snapState(), logger)) {
            return send(res, 500, JSON.stringify({ error: 'write failed', hint: '状态文件可能被占用' }))
          }
          refreshBlock()
          return json(res, statePayload())
        }
        if (url.startsWith('/dsh-longing/api/config/meta')) {
          const overridden = Object.keys(panelOverrides).filter(
            (k) => JSON.stringify(panelOverrides[k]) !== JSON.stringify(config?.[k]),
          )
          return json(res, { overridden })
        }
        if (url.startsWith('/dsh-longing/api/config/reset')) {
          const p = await body(req)
          if (p?.all === true) {
            for (const k of Object.keys(panelOverrides)) delete panelOverrides[k]
          } else {
            for (const k of Array.isArray(p?.keys) ? p.keys : []) delete panelOverrides[k]
          }
          flushPanelFile()
          refreshBlock()
          return json(res, publicSettings())
        }
        if (url.startsWith('/dsh-longing/api/config')) {
          if (req.method === 'POST') {
            const p = await body(req)
            const patch = {}
            for (const [k, v] of Object.entries(p ?? {})) {
              if (!ALLOWED_KEYS.has(k)) continue // 状态键在这里就被挡掉，不会被写进配置
              // 通道名要拼进文件名（欲望注入.<ch>.txt），必须过白名单：
              // 否则 "..\\..\\Users\\x\\pwn" 能穿出状态目录写任意 .txt。
              // 2026-11-10（审计 F03）：不再 Number()/Boolean() 强转。
              // Boolean('false') 是 true —— 用户以为关掉了联网/成人内容，其实开着。
              // 原样交给 validatePatch，由 schema 定类型和范围，不合法就整单拒绝。
              if (k === 'channels') {
                patch.channels = (Array.isArray(v) ? v : []).map((x) => String(x).trim().toLowerCase()).filter((x) => /^[a-z0-9_-]{1,16}$/.test(x)).slice(0, 8)
                continue
              }
              if (NUM_KEYS.has(k)) {
                const n = typeof v === 'number' ? v : Number(String(v ?? '').trim())
                patch[k] = Number.isFinite(n) ? n : NaN
                continue
              }
              if (BOOL_KEYS.has(k)) {
                patch[k] = typeof v === 'boolean' ? v : (v === 'true' ? true : v === 'false' ? false : NaN)
                continue
              }
              patch[k] = typeof v === 'string' ? v.slice(0, 400) : v
            }
            const bad = Object.entries(patch).filter(([, v]) => typeof v === 'number' && Number.isNaN(v)).map(([k]) => k)
            if (bad.length) {
              return send(res, 400, JSON.stringify({ error: 'invalid', keys: bad, hint: '值和键的类型对不上（布尔要 true/false，数字要数值）' }))
            }
            const v = validatePatch(patch)
            if (!v.ok) {
              return send(res, 400, JSON.stringify({ error: 'invalid', details: v.error, keys: Object.keys(patch) }))
            }
            Object.assign(panelOverrides, v.values)
            // 落盘失败要如实回报：以前无论成败都回 200 + 设置，面板显示「已保存」但什么都没写。
            const ok = flushPanelFile()
            refreshBlock()
            if (!ok) return send(res, 500, JSON.stringify({ error: 'write failed', hint: '配置文件可能被占用' }))
          }
          return json(res, publicSettings())
        }
        if (url.startsWith('/dsh-longing/api/history')) return json(res, history.slice(-288))
        if (url.startsWith('/dsh-longing/api/preset')) {
          const p = await body(req)
          if (settings()?.presetsEnabled === false) return json(res, { error: 'presets disabled' })
          if (!isDebug()) return json(res, { error: 'debug off', hint: '先打开调试模式' })
          const preset = PRESETS[String(p?.name ?? '')] ?? null
          if (preset) {
            Object.assign(state, preset)
            state.updatedAt = Date.now()
            if (!writeJson(stateFile, snapState(), logger)) {
              return send(res, 500, JSON.stringify({ error: 'write failed', hint: '状态文件可能被占用' }))
            }
            refreshBlock()
          }
          return json(res, statePayload())
        }
        if (url.startsWith('/dsh-longing/api/diary/reflect')) {
          // 手动写一条（面板「让她写一篇」按钮）。POST 才写，GET 只报状态。
          if (req.method === 'POST') {
            const r = await reflectNow({ force: true })
            return json(res, { ...r, why: r?.why ?? 'unknown', lastWhy: lastReflectWhy })
          }
          return json(res, { lastWhy: lastReflectWhy, lastAt: lastReflectAt, lastGate: lastReflectGate, lastRaw: lastReflectRaw })
        }
        if (url.startsWith('/dsh-longing/api/diary')) {
          if (req.method === 'POST') {
            const p = await body(req)
            const text = String(p?.text ?? '').trim()
            if (!text) return json(res, { error: 'empty' })
            diary = addThought(diary, text, Date.now())
            saveDiary()
            return json(res, { ok: true, day: recentDiary(diary, 1)[0] })
          }
          const q = String(req.url ?? '').split('?')[1] ?? ''
          const wantDays = num(new URLSearchParams(q).get('days'), num(settings()?.diaryDays, 7))
          const list = recentDiary(diary, wantDays)
          return json(res, { days: list, text: list.length ? formatDay(list[0]) : '还没有记录。' })
        }
        if (url.startsWith('/dsh-longing/api/event')) {
          if (req.method === 'POST') {
            const p = await body(req)
            return json(res, fireEvent(p?.name, { detail: p?.detail, src: 'panel' }))
          }
          return json(res, {
            events: Object.fromEntries(Object.entries(EVENTS).map(([k, v]) => [k, { note: v.note, dims: v.dims }])),
            recent: recentEvents(state),
          })
        }
        if (url.startsWith('/dsh-longing/api/pause')) {
          const p = await body(req)
          if (settings()?.pauseEnabled === false) return json(res, { error: 'pause disabled' })
          const minutes = Math.min(1440, Math.max(0, num(p?.minutes, 120)))
          // 0 分钟 = 立刻恢复
          state.pausedUntil = minutes > 0 ? Date.now() + minutes * 60_000 : 0
          state.updatedAt = Date.now()
          if (!writeJson(stateFile, snapState(), logger)) {
            return send(res, 500, JSON.stringify({ error: 'write failed', hint: '状态文件可能被占用' }))
          }
          refreshBlock()
          return json(res, statePayload())
        }
        if (url.startsWith('/dsh-longing/api/activity')) {
          const at = Date.now()
          writeJson(join(baseDir, '活动时间.json'), { at })
          globalThis.__dshQqLastOwnerAt = at
          return json(res, { ok: true, at })
        }
        if (url.startsWith('/dsh-longing/api/comfy/launch')) {
          const launched = launchComfy()
          await probeComfy().catch(() => {})
          refreshBlock()
          return json(res, { launched, ...comfy })
        }
        if (url.startsWith('/dsh-longing/api/comfy')) return json(res, comfy)
        if (url.startsWith('/dsh-longing/wallpaper')) {
          const f = join(panelDir, 'wallpaper.jpg')
          if (!existsSync(f)) return send(res, 404, 'no wallpaper')
          return send(res, 200, readFileSync(f), 'image/jpeg')
        }
        const f = join(panelDir, 'index.html')
        if (!existsSync(f)) return send(res, 404, 'no panel')
        // 把令牌文件的绝对路径塞进页面：换了 sessionStorage 之后每次都要重贴，
        // 至少别让人再去翻目录找那个文件。
        const personaLabel = String(settings()?.personaName ?? '').trim().replace(/[<>&"]/g, '').slice(0, 24)
        const html = readFileSync(f, 'utf8')
          // 占位符只出现在 <body data-token-file="…"> 里，不再出现在 <script> 里：
          // 脚本里那句「这个占位符还在不在」会被自己替换掉，逻辑永远为假（1.11.0 的坑）。
          .replace('__TOKEN_FILE__', tokenFile.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'))
          // 面板标题不再写死作者的角色名：填了 personaName 就是「名字 · 欲望面板」，没填就是「欲望面板」。
          .replace(/__PERSONA__/g, personaLabel ? `${personaLabel} · ` : '')
        return send(res, 200, html, 'text/html; charset=utf-8')
      },
    })
  }

  // webServer 可能比插件晚就绪：重试几次，拿不到就软失败（状态与工具照常）
  let webTries = 0
  let webTimer = null
  const tryRegisterWeb = () => {
    if (disposed) return
    const web = ctx?.get?.('webServer')
    if (web?.register) {
      try {
        registerWeb(web)
        return
      } catch (e) {
        logger.warn?.(`[dsh-longing] 面板路由注册失败：${e?.message ?? e}`)
        return
      }
    }
    if (++webTries < 15) {
      webTimer = setTimeout(tryRegisterWeb, 2000)
      webTimer?.unref?.()
      return
    }
    logger.info?.('[dsh-longing] webServer 不可用，面板路由未注册（状态与工具仍可用）')
  }
  tryRegisterWeb()

  /**
   * 只认「主人私聊」的会话。
   *
   * 登记由通道插件做（收到主人私聊时调 `__dshLongingOwnerSession(sessionId, ttl)`），
   * 进程内、不落盘。以前这里只认 dsh-qq 那张 `__dshQqOwnerSessions`：
   *   · 没装 dsh-qq，或者只跑 web / 别的通道 → 不但没人登记，也没有任何公开的登记口
   *     → `ownerOnly` 默认 true → set/bump/preset/pause/diary 永久 Permission Denied，
   *     主人自己也改不动，功能等于不存在；
   *   · 这就是典型的「只有作者那台机器上能用」，因为作者永远装着 dsh-qq。
   * 现在两个来源都认：通用表 `__dshLongingOwnerSessions`（Map 或 Set），以及旧表。
   * 两边都不存在（说明这个装法里没有通道在管主人这件事）→ 放行并警告一次：
   * 这时 ownerOnly 没有判据可用，硬拦只会把插件整个拦死。
   */
  let warnedNoOwnerReg = false
  function ownerSessionAllowed(exec) {
    const sid = exec?.agent?.session?.header?.id ?? exec?.agent?.session?.id
    const generic = globalThis.__dshLongingOwnerSessions
    const legacy = globalThis.__dshQqOwnerSessions
    // dsh-qq 存在 → 由它判；只有通用表存在、但从来没人登记过 → 说明这个装法里
    // 没有通道在管「谁是主人」，ownerOnly 没有判据可用（详见上面那段注释）。
    const reg =
      legacy instanceof Map ? legacy : globalThis.__dshLongingOwnerRegistered === true && generic instanceof Map ? generic : null
    if (!reg) {
      if (!warnedNoOwnerReg) {
        warnedNoOwnerReg = true
        logger.info?.(
          '[dsh-longing] 没有通道在登记主人会话：ownerOnly 暂时放行（通道插件收到主人私聊时调 __dshLongingOwnerSession）',
        )
      }
      return true
    }
    if (!sid) return false
    if (reg instanceof Set) return reg.has(String(sid))
    return Number(reg.get(String(sid)) ?? 0) > Date.now()
  }

  // tools 服务也可能比插件晚就绪：跟面板一样重试，别一次性 return 掉
  let toolTries = 0
  let toolTimer = null
  const tryRegisterTools = () => {
    if (disposed) return
    const tools = ctx?.get?.('tools')
    if (!tools?.register) {
      if (++toolTries < 15) {
        toolTimer = setTimeout(tryRegisterTools, 2000)
        toolTimer?.unref?.()
      } else {
        logger.info?.('[dsh-longing] tools 服务不可用，qq_longing 未注册（状态与面板仍可用）')
      }
      return
    }
    // 工具名不再写死 qq_longing：这个插件跟通道无关，没装 QQ 的人看到一个 qq_ 前缀的工具
    // 只会以为自己装错了；描述里写死作者的角色名，更不该出现在别人的模型面前。
    // 旧名 qq_longing 在勾了 qq 通道时继续注册成别名，dsh-qq 的提示词不用改。
    const toolName = String(settings()?.toolName || 'longing').replace(/[^a-zA-Z0-9_]/g, '').slice(0, 40) || 'longing'
    const chs = Array.isArray(settings()?.channels) ? settings().channels.map(String) : ['qq']
    const who = String(settings()?.personaName ?? '').trim() || '她'
    const toolDef = {
        description:
          `读写${who}的欲望状态：lust 性欲 / lewd 色情 / possess 占有 / shame 羞耻 / resist 理智 / fatigue 疲劳 / affection 好感（0-100）。` +
          'action=get 查看。' +
          'action=events 列出所有「事件」（夸奖/被拒/提别人/说狠话…），action=event 配 name 把刚才发生的事记进数值：' +
          '他说了什么、做了什么，就用对应事件登记一次，数值和她的语气会跟着变。' +
          'action=diary 读她最近几天的「心情日记」（高兴的、难受的、心里想的）。' +
          'action=reflect 让她现在就自己写一条日记（用当天的事和此刻的状态，由她自己写，不是你替她写）；' +
          'action=thought 配 text 是你替她记一句心里话，平时不用，除非她当面说了什么值得留的。' +
          '日记她不会主动说出来，只有主人问才给——主人问「你今天在想什么」「看看日记」时就调这个。' +
          'action=set/bump/preset 直接改值，只在调试模式打开时可用；平时数值靠聊天里发生的事慢慢养。' +
          '改值需要主人在私聊里先解锁管理员模式（由通道插件登记主人会话）。',
        parameters: {
          type: 'object',
          properties: {
            // 2026-11-10（审计 F16）：reflect 以前有实现却不在 enum 里 —— 模型永远调不到。
            action: { type: 'string', enum: ['get', 'set', 'bump', 'preset', 'pause', 'event', 'events', 'diary', 'thought', 'reflect'] },
          detail: {
            type: 'string',
            description: '配 action=event 用：他刚才说的那句原话（不超过 80 字）。日记要写事实，靠的就是这个；不填就只留事件类型。',
          },
            lust: { type: 'number' },
            lewd: { type: 'number' },
            possess: { type: 'number' },
            shame: { type: 'number' },
            resist: { type: 'number' },
            fatigue: { type: 'number' },
            affection: { type: 'number' },
            scene: { type: 'string' },
            name: { type: 'string' },
            text: { type: 'string' },
            minutes: { type: 'number' },
            days: { type: 'number', description: '配 action=diary 用：读最近几天（默认 3）' },
          },
          required: ['action'],
        },
        async execute(args, exec) {
          const action = String(args?.action ?? 'get')
          const isOwner = settings().ownerOnly === false || ownerSessionAllowed(exec)
          // get 也收进闸门：群聊里问一句「你现在什么状态」，不该把七个私密数字摆出来。
          // 非主人只给一个档位词 —— 她还答得上话，但说不出数值。
          if (action === 'get' && !isOwner) {
            return { ok: true, text: `现在：${curMode()}（具体数值只在主人私聊里能查）` }
          }
          if (!['get', 'events'].includes(action) && settings().ownerOnly !== false && !isOwner) {
            return { ok: false, text: 'Permission Denied：欲望值只能在主人私聊里改。' }
          }
          if (action === 'events') {
            return {
              ok: true,
              text: Object.entries(EVENTS)
                .map(([k, v]) => `${k}：${v.note}`)
                .join('\n'),
            }
          }
          if (action === 'diary') {
            const days = Math.max(1, Math.min(30, num(args?.minutes, num(settings()?.diaryDays, 1))))
            const list = recentDiary(diary, days)
            return { ok: true, text: list.length ? list.map(formatDay).join('\n\n') : '还没有记录。' }
          }
          if (action === 'reflect') {
            const r = await reflectNow({ force: true })
            if (!r?.ok) {
              const why = {
                'no-model': '没有可用的模型：先在 DSH 里配一个模型，或填 diaryProvider / diaryModel',
                off: 'diaryAutoWrite 是关着的',
                busy: '她正在写，等这条写完',
                empty: '写出来是空的（或者被清洗掉了），这次不留',
                error: '写的时候出错了，日记保持原样',
              }[r?.why] ?? `没写成：${r?.why ?? 'unknown'}`
              return { ok: false, text: why }
            }
            return { ok: true, text: `写下了：「${r.lines.join('」「')}」` }
          }
          if (action === 'thought') {
            const t = String(args?.text ?? '').trim()
            if (!t) return { ok: false, text: '写点什么再记。' }
            diary = addThought(diary, t, Date.now())
            saveDiary()
            return { ok: true, text: '记下了。' }
          }
          if (action === 'event') {
            const r = fireEvent(args?.name, { detail: args?.detail, src: 'tool' })
            return { ok: r.ok, text: r.text }
          }
          // 直接改值属于调试功能：关着的时候数值只能靠聊天事件养
          if (['set', 'bump', 'preset'].includes(action) && !isDebug()) {
            return {
              ok: false,
              text: '调试模式没开：数值只能靠聊天里发生的事慢慢养。要硬改先把 debugMode 打开（面板右上角「调试」）。',
            }
          }
          // 工具执行前先同步磁盘：否则会覆盖面板刚保存的值
          if (action !== 'get') {
            const disk = readJson(stateFile, null)
            if (disk && num(disk.updatedAt) > num(state.updatedAt)) state = normalizeState({ ...state, ...disk })
          }
          if (action === 'preset' && PRESETS[String(args?.name)]) Object.assign(state, PRESETS[String(args.name)])
          if (action === 'pause') {
            const minutes = Math.min(1440, Math.max(0, num(args?.minutes, 120)))
            state.pausedUntil = minutes > 0 ? Date.now() + minutes * 60_000 : 0
          }
          if (action === 'set' || action === 'bump') {
            for (const k of VALUE_KEYS) {
              if (args?.[k] === undefined) continue
              const delta = action === 'bump' ? Number(args[k]) : Number(args[k]) - num(state[k], 0)
              const capped = Math.max(-STEP_LIMIT, Math.min(STEP_LIMIT, Number.isFinite(delta) ? delta : 0))
              state[k] = clampFloat(num(state[k], 0) + capped)
            }
          }
          // scene 只在「改」的动作里接受：action=get 免权限检查，
          // 要是它也认 scene，任何会话里的模型都能借 get 把原话写进系统提示。
          if (action !== 'get' && args?.scene !== undefined) state.scene = String(args.scene ?? '').slice(0, 40)
          state.updatedAt = Date.now()
          if (!writeJson(stateFile, snapState(), logger)) return { ok: false, text: '写状态文件失败（可能被占用）' }
          refreshBlock()
          return {
            ok: true,
            text:
              `性欲 ${Math.round(state.lust)} / 色情 ${Math.round(state.lewd)} / 占有 ${Math.round(state.possess)}` +
              ` / 羞耻 ${Math.round(state.shame)} / 理智 ${Math.round(state.resist)} / 疲劳 ${Math.round(state.fatigue)}` +
              ` / 好感 ${Math.round(num(state.affection, 50))}｜${curMode()}` +
              (isPaused() ? '｜已暂停' : ''),
          }
        },
    }
    const toolNames = [toolName]
    // 旧名做别名：dsh-qq 的提示词里写的是 qq_longing，升级不该把老配置打断。
    if (chs.includes('qq') && toolName !== 'qq_longing') toolNames.push('qq_longing')
    for (const n of toolNames) {
      try {
        tools.register({ name: n, ...toolDef })
      } catch (e) {
        logger.warn?.(`[dsh-longing] 工具 ${n} 注册失败：${e?.message ?? e}`)
      }
    }
  }
  tryRegisterTools()

  // 暴露给通道插件：一次读全，省得各自拼字符串
  globalThis.__dshLongingState = () => statePayload()
  globalThis.__dshLongingRefresh = () => refreshBlock()
  /**
   * 主人会话登记口。
   *
   * 通道插件收到「主人私聊」时调一次：`__dshLongingOwnerSession(sessionId, ttlMs)`。
   * 进程内、不落盘，也**不随插件热重载清空**（登记方还活着；清掉它主人就改不动值了）。
   */
  if (!(globalThis.__dshLongingOwnerSessions instanceof Map)) globalThis.__dshLongingOwnerSessions = new Map()
  globalThis.__dshLongingOwnerSession = (sessionId, ttlMs = 3_600_000) => {
    const sid = String(sessionId ?? '').trim()
    if (!sid) return false
    const ttl = Math.max(60_000, Math.min(7 * 86_400_000, num(ttlMs, 3_600_000)))
    globalThis.__dshLongingOwnerSessions.set(sid, Date.now() + ttl)
    // 记下「有人真的在用这张表」：没有它的话，空表无法和「没有通道」区分开，
    // ownerOnly 就会把所有人的写操作全拒掉。
    globalThis.__dshLongingOwnerRegistered = true
    return true
  }
  /**
   * 主动开口的问与答：通道插件发消息之前问一句「现在能主动吗」，
   * 说出口之后回报一笔。判定全在 proactive.js，通道那边不许再自己算。
   */
  globalThis.__dshLongingProactive = () => proactiveGate({ cfg: settings(), state })
  /**
   * 安全词：通道插件认消息时用这个，不然面板里改「安全词」谁都不认。
   * 以前这个键在 longing 里没有读取点、dsh-qq 那边是硬编码正则。
   */
  globalThis.__dshLongingPauseWord = () => String(settings()?.pauseWord ?? '停').trim()
  /** 主动发图：判据 + 记一笔（通道插件真的把图发出去之后调） */
  globalThis.__dshLongingImageGate = () => imageGate({ cfg: settings(), state })
  globalThis.__dshLongingMarkImage = (info = null) => {
    state = normalizeState({ ...state, ...noteImage({ state, now: Date.now(), info }) })
    state.updatedAt = Date.now()
    writeJson(stateFile, snapState(), logger)
    refreshBlock()
    return imageGate({ cfg: settings(), state })
  }
  globalThis.__dshLongingMarkInitiate = (info = null) => {
    state = normalizeState({ ...state, ...noteInitiate({ state, now: Date.now(), info }) })
    state.updatedAt = Date.now()
    writeJson(stateFile, snapState(), logger)
    refreshBlock()
    return proactiveGate({ cfg: settings(), state })
  }
  /** 心情日记：只读。通道插件想让她「提一句昨天」可以拿，但别主动刷屏。 */
  globalThis.__dshLongingDiary = (days = 3) => recentDiary(diary, days)
  globalThis.__dshLongingDiaryText = (days = 1) => recentDiary(diary, days).map(formatDay).join('\n\n')
}
