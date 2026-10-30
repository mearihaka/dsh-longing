import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ConfigSchema } from './config.js'
import { buildBlock } from './prompt.js'

export const name = 'dsh-longing'
export const inject = []
export const Config = ConfigSchema

const NUM_KEYS = new Set([
  'lust','lewd','possess','shame','resist','fatigue','scene','peakBonus','decayPerHour','nightDecayPerHour',
  'idleTriggerMin','proactiveMaxPerDay','initiateThreshold','urgeThink','urgeHint','urgeSpeak','urgeAct','urgeRepeatMin',
  'lewdDirect','possessJealous','fatigueTired','shameHiding','resistHolding','affection','affectionGain','affectionDecay',
  'affectionClose','affectionDevoted','cooldownMin','resistWeight','coldLust','shyLewd','distantPossess','numbAffection',
  'explicitThreshold','imageThreshold','imagesPerDay','jealousy','rejectionPenalty','pausedUntil','comfyProbeSec','interactionLust',
])
const BOOL_KEYS = new Set([
  'enabled','stealthInjection','autoInitiate','nsfwImages','curveEnabled','presetsEnabled','voiceEnabled','memoryEnabled',
  'scheduleEnabled','pauseEnabled','rememberAfterward','ownerOnly','comfyEnabled','comfyAutoLaunch',
])
// 面板能写的键：schema 字段 + channels/ownerIds。写死是为了防止任意键落盘。
const ALLOWED_KEYS = new Set([
  ...NUM_KEYS,
  ...BOOL_KEYS,
  'channels','ownerIds','scene','peakWindow','activeHours','quietHours','pauseWord','personaNote','comfyBaseUrl','comfyLaunchScript','statePath',
])

function safeEqual(a, b) {
  const x = Buffer.from(String(a))
  const y = Buffer.from(String(b))
  if (x.length !== y.length) return false
  return timingSafeEqual(x, y)
}

const DEFAULTS = { lust: 30, lewd: 35, possess: 55, shame: 45, resist: 50, fatigue: 20 }
const TICK_MS = 60_000
const HISTORY_MAX = 2880
const STEP_LIMIT = 25 // 面板一次最多跳 25，避免数值跳崖导致 OOC

const PRESETS = {
  calm: { lust: 20, lewd: 20, possess: 40, shame: 55, resist: 60, fatigue: 25 },
  clingy: { lust: 50, lewd: 40, possess: 60, shame: 45, resist: 45, fatigue: 30 },
  heat: { lust: 78, lewd: 70, possess: 80, shame: 25, resist: 30, fatigue: 20 },
  yandere: { lust: 90, lewd: 85, possess: 95, shame: 10, resist: 15, fatigue: 25 },
}

function clamp(n, lo = 0, hi = 100) {
  const v = Number(n)
  if (!Number.isFinite(v)) return lo
  return Math.min(hi, Math.max(lo, Math.round(v)))
}

function parseWindow(spec) {
  const m = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(String(spec ?? '').trim())
  if (!m) return null
  return { start: Number(m[1]) * 60 + Number(m[2]), end: Number(m[3]) * 60 + Number(m[4]) }
}

function inWindow(win, d = new Date()) {
  if (!win) return true
  const cur = d.getHours() * 60 + d.getMinutes()
  return win.start <= win.end ? cur >= win.start && cur < win.end : cur >= win.start || cur < win.end
}

function todayKey(d = new Date()) {
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJson(file, data, logger) {
  // 原子写：临时文件 + rename。Windows 上被占用会 EPERM；
  // 用 setTimeout 异步重试，绝不在主线程自旋（否则会卡死整个进程）。
  // 返回值只看第一次尝试：失败时面板会收到 500，用户能知道没写进去。
  let ok = false
  try {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
    const attempt = (n) => {
      try {
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

export function apply(ctx, config) {
  const statePath = String(config?.statePath ?? '').trim()
  // 不写死盘符：没配就用 DSH 运行目录下的 workspace
  const baseDir = statePath ? dirname(statePath) : join(process.cwd(), 'workspace')
  let stateFile = statePath || join(baseDir, '欲望状态.json')
  const cfgFile = join(baseDir, '欲望面板配置.json')
  const historyFile = join(baseDir, '欲望历史.json')

  // 可选迁移：只有显式配了 migrateFrom 才搬，搬一次就够（不写死任何本机路径）
  const migrateFrom = String(config?.migrateFrom ?? '').trim()
  if (!statePath && migrateFrom) {
    for (const name of ['欲望状态.json', '欲望面板配置.json', '欲望历史.json']) {
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
  const logger = ctx?.logger ?? console

  const panelCfg = readJson(cfgFile, {})
  // 把「配置 + 面板」合并后写回，保证 dsh-qq 只读文件也能看到通道/开关
  writeJson(cfgFile, { ...config, ...panelCfg })

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

  const base = {
    lust: clamp(panelCfg.lust ?? config?.lust ?? DEFAULTS.lust),
    lewd: clamp(panelCfg.lewd ?? config?.lewd ?? DEFAULTS.lewd),
    possess: clamp(panelCfg.possess ?? config?.possess ?? DEFAULTS.possess),
    shame: clamp(panelCfg.shame ?? config?.shame ?? DEFAULTS.shame),
    resist: clamp(panelCfg.resist ?? config?.resist ?? DEFAULTS.resist),
    fatigue: clamp(panelCfg.fatigue ?? config?.fatigue ?? DEFAULTS.fatigue),
    affection: clamp(panelCfg.affection ?? config?.affection ?? DEFAULTS.affection),
    scene: String(panelCfg.scene ?? config?.scene ?? ''),
  }

  let state = readJson(stateFile, null) ?? { ...base, updatedAt: Date.now(), lastPeak: '', pausedUntil: 0 }
  state = { ...state, ...base, updatedAt: Date.now() }
  writeJson(stateFile, state)

  const history = readJson(historyFile, [])

  // ── 生图后端：探测 + 可选自动拉起（失败只降级，不影响聊天）──
  const comfy = { up: false, checkedAt: 0, url: '', error: '' }
  let lastLaunchAt = 0
  globalThis.__dshComfyUp = false

  const launchComfy = () => {
    const eff = settings()
    const script = String(eff?.comfyLaunchScript ?? '').trim()
    if (!script || !existsSync(script)) return false
    if (Date.now() - lastLaunchAt < 10 * 60_000) return false
    try {
      const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], {
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
    if (eff?.comfyEnabled === false) return
    const base = String(eff?.comfyBaseUrl ?? 'http://127.0.0.1:8188').replace(/\/+$/, '')
    comfy.url = base
    try {
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(), 1500)
      const res = await fetch(`${base}/system_stats`, { signal: ac.signal })
      clearTimeout(timer)
      comfy.up = res.ok
      comfy.error = res.ok ? '' : `HTTP ${res.status}`
    } catch (e) {
      comfy.up = false
      comfy.error = String(e?.name === 'AbortError' ? 'timeout' : (e?.message ?? e))
    }
    comfy.checkedAt = Date.now()
    globalThis.__dshComfyUp = comfy.up
    if (!comfy.up && eff?.comfyAutoLaunch) launchComfy()
  }
  // 注入块：每轮 tick 生成一次，写文件 + 挂到 globalThis，供任何通道插件取用
  const injectFile = join(baseDir, '欲望注入.txt')
  function refreshBlock() {
    const eff = settings()
    const text = buildBlock(state, eff, { comfyUp: globalThis.__dshComfyUp })
    try {
      writeFileSync(injectFile, text, 'utf8')
    } catch {}
    globalThis.__dshDesireBlock = text
    return text
  }
  refreshBlock()

  // 通道插件收到主人消息时调一下：涨性欲、涨好感（热重载不重复注册）
  globalThis.__dshLongingNote = (kind) => {
    if (kind !== 'owner') return
    const eff = settings()
    state.lust = clamp(Number(state.lust) + Number(eff?.interactionLust ?? 2))
    state.affection = clamp(Number(state.affection ?? DEFAULTS.affection) + Number(eff?.affectionGain ?? 1))
    state.updatedAt = Date.now()
    writeJson(stateFile, state, logger)
    refreshBlock()
  }

  probeComfy().catch(() => {})
  const comfyTimer = setInterval(() => probeComfy().catch(() => {}), Math.max(15, Number(settings()?.comfyProbeSec ?? 60)) * 1000)
  comfyTimer?.unref?.()
  ctx?.on?.('dispose', () => clearInterval(comfyTimer))

  function settings() {
    return { ...config, ...readJson(cfgFile, {}) }
  }

  function tick() {
    const eff = settings()
    if (eff?.enabled === false) return

    // 顺手清理过期的「主人私聊会话」登记，避免 Map 无限增长
    const owners = globalThis.__dshQqOwnerSessions
    if (owners instanceof Map) {
      const nowTs = Date.now()
      for (const [sid, expire] of owners) if (Number(expire) < nowTs) owners.delete(sid)
    }
    // 暂停：冻结数值，只刷新注入（避免恢复后一次性补偿衰减）
    if (Number(state.pausedUntil ?? 0) > Date.now()) {
      state.updatedAt = Date.now()
      writeJson(stateFile, state)
      refreshBlock()
      return
    }
    const disk = readJson(stateFile, null)
    if (disk && Number(disk.updatedAt ?? 0) > Number(state.updatedAt ?? 0)) state = { ...state, ...disk }
    const now = Date.now()
    const dtHours = Math.min(24, Math.max(0, (now - Number(state.updatedAt ?? now)) / 3_600_000))
    const peak = inWindow(parseWindow(eff?.peakWindow))
    const decay = peak ? Number(eff?.nightDecayPerHour ?? 6) * 0.25 : Number(eff?.decayPerHour ?? 3)
    state.lust = clamp(state.lust - decay * dtHours)
    state.affection = clamp(Number(state.affection ?? DEFAULTS.affection) - Number(eff?.affectionDecay ?? 0.3) * dtHours)
    if (peak && state.lastPeak !== todayKey()) {
      state.lust = clamp(state.lust + Number(eff?.peakBonus ?? 25))
      state.lastPeak = todayKey()
    }
    state.updatedAt = now
    writeJson(stateFile, state)
    refreshBlock();
    history.push({ t: now, l: state.lust, d: state.lewd, p: state.possess })
    while (history.length > HISTORY_MAX) history.shift()
    writeJson(historyFile, history)
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
      new Promise((resolve) => {
        let raw = ''
        req.on('data', (c) => {
          raw += c
          if (raw.length > 262144) req.destroy() // 256KB 上限，挡误发的巨型 payload
        })
        req.on('end', () => {
          try {
            resolve(JSON.parse(raw || '{}'))
          } catch {
            resolve({})
          }
        })
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
        if (url.startsWith('/dsh-longing/api/state')) {
          if (req.method === 'POST') {
            const p = await body(req)
            for (const k of ['lust', 'lewd', 'possess', 'shame', 'resist', 'fatigue', 'affection']) {
              if (p[k] === undefined) continue
              state[k] = clamp(p[k]) // 面板由用户直接控制，不限幅
            }
            if (p.scene !== undefined) state.scene = String(p.scene).slice(0, 40)
            state.updatedAt = Date.now()
            if (!writeJson(stateFile, state, logger)) {
              return send(res, 500, JSON.stringify({ error: 'write failed', hint: '状态文件可能被记事本等程序占用' }))
            }
          }
          return json(res, { ...state, mode: modeOf(state) })
        }
        if (url.startsWith('/dsh-longing/api/config/meta')) {
          const cur = readJson(cfgFile, {})
          const overridden = Object.keys(cur).filter((k) => JSON.stringify(cur[k]) !== JSON.stringify(config?.[k]))
          return json(res, { overridden })
        }
        if (url.startsWith('/dsh-longing/api/config/reset')) {
          const p = await body(req)
          const cur = readJson(cfgFile, {})
          if (p?.all === true) {
            writeJson(cfgFile, {}, logger)
          } else {
            for (const k of Array.isArray(p?.keys) ? p.keys : []) delete cur[k]
            writeJson(cfgFile, cur, logger)
          }
          return json(res, settings())
        }
        if (url.startsWith('/dsh-longing/api/config')) {
          if (req.method === 'POST') {
            const p = await body(req)
            const cur = readJson(cfgFile, {})
            const patch = {}
            for (const [k, v] of Object.entries(p ?? {})) {
              if (!ALLOWED_KEYS.has(k)) continue // 只收 schema 里真有的键
              if (k === 'channels') patch.channels = (Array.isArray(v) ? v : []).map(String).filter(Boolean).slice(0, 8)
              else if (k === 'ownerIds') patch.ownerIds = (Array.isArray(v) ? v : String(v ?? '').split(',')).map((x) => String(x).trim()).filter(Boolean).slice(0, 20)
              else if (NUM_KEYS.has(k)) { const n = Number(v); if (Number.isFinite(n)) patch[k] = n }
              else if (BOOL_KEYS.has(k)) patch[k] = Boolean(v)
              else patch[k] = String(v ?? '').slice(0, 400)
            }
            writeJson(cfgFile, { ...cur, ...patch })
          }
          return json(res, settings())
        }
        if (url.startsWith('/dsh-longing/api/history')) return json(res, history.slice(-288))
        if (url.startsWith('/dsh-longing/api/preset')) {
          const p = await body(req)
          const preset = PRESETS[String(p?.name ?? '')] ?? null
          if (preset) {
            Object.assign(state, preset)
            state.updatedAt = Date.now()
            writeJson(stateFile, state)
          }
          return json(res, { ...state, mode: modeOf(state) })
        }
        if (url.startsWith('/dsh-longing/api/pause')) {
          const p = await body(req)
          state.pausedUntil = Date.now() + Math.min(1440, Math.max(0, Number(p?.minutes ?? 120))) * 60_000
          writeJson(stateFile, state)
          return json(res, state)
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
        return send(res, 200, readFileSync(f), 'text/html; charset=utf-8')
      },
    })
  }

  // webServer 可能比插件晚就绪：重试几次，拿不到就软失败（状态与工具照常）
  let webTries = 0
  const tryRegisterWeb = () => {
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
      const t = setTimeout(tryRegisterWeb, 2000)
      t?.unref?.()
      return
    }
    logger.info?.('[dsh-longing] webServer 不可用，面板路由未注册（状态与工具仍可用）')
  }
  tryRegisterWeb()

  function modeOf(s) {
    // 跟注入层保持一致：看「有效欲望 = 性欲 − 理智×权重」
    const eff = Math.max(0, Math.min(100, Number(s?.lust ?? 0) - Number(s?.resist ?? 0) * Number(settings()?.resistWeight ?? 0.5)))
    return eff >= 80 ? '发情' : eff >= 60 ? '主动' : eff >= 40 ? '黏人' : '平静'
  }

  const tools = ctx?.get?.('tools')
  if (!tools?.register) return

  /** 只认「主人私聊」的会话：由 dsh-qq 在处理主人私聊消息时登记 sessionId（进程内，不落盘）。 */
  function ownerSessionAllowed(exec) {
    const sid = exec?.agent?.session?.header?.id ?? exec?.agent?.session?.id
    if (!sid) return false
    const map = globalThis.__dshQqOwnerSessions
    if (!(map instanceof Map)) return false
    const until = Number(map.get(String(sid)) ?? 0)
    return until > Date.now()
  }

  tools.register({
    name: 'qq_longing',
    description:
      '读写角色的欲望状态：lust 性欲 / lewd 色情值 / possess 占有值（0-100）。' +
      'action=get 查看，set 直接设值，bump 增减，preset 套预设（calm/clingy/heat/yandere），pause 暂停亲密。' +
      '改值需要主人在私聊里先解锁管理员模式。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['get', 'set', 'bump', 'preset', 'pause'] },
        lust: { type: 'number' },
        lewd: { type: 'number' },
        possess: { type: 'number' },
        shame: { type: 'number' },
        resist: { type: 'number' },
        fatigue: { type: 'number' },
        affection: { type: 'number' },
        scene: { type: 'string' },
        name: { type: 'string' },
        minutes: { type: 'number' },
      },
      required: ['action'],
    },
    async execute(args, exec) {
      const action = String(args?.action ?? 'get')
      if (action !== 'get' && settings().ownerOnly !== false && !ownerSessionAllowed(exec)) {
        return { ok: false, text: 'Permission Denied：欲望值只能在主人私聊里改。' }
      }
      // 工具执行前先同步磁盘：否则会覆盖面板刚保存的值
      if (action !== 'get') {
        const disk = readJson(stateFile, null)
        if (disk && Number(disk.updatedAt ?? 0) > Number(state.updatedAt ?? 0)) {
          state = { ...state, ...disk }
        }
      }
      if (action === 'preset' && PRESETS[String(args?.name)]) Object.assign(state, PRESETS[String(args.name)])
      if (action === 'pause') state.pausedUntil = Date.now() + Math.min(1440, Math.max(0, Number(args?.minutes ?? 120))) * 60_000
      if (action === 'set' || action === 'bump') {
        for (const k of ['lust', 'lewd', 'possess', 'shame', 'resist', 'fatigue', 'affection']) {
          if (args?.[k] === undefined) continue
          const delta = action === 'bump' ? Number(args[k]) : Number(args[k]) - Number(state[k] ?? 0)
          const capped = Math.max(-STEP_LIMIT, Math.min(STEP_LIMIT, delta))
          state[k] = clamp(Number(state[k] ?? 0) + capped)
        }
      }
      if (args?.scene !== undefined) state.scene = String(args.scene).slice(0, 40)
      state.updatedAt = Date.now()
      if (!writeJson(stateFile, state, logger)) return { ok: false, text: '写状态文件失败（可能被占用）' }
      return {
        ok: true,
        text:
          `性欲 ${state.lust} / 色情 ${state.lewd} / 占有 ${state.possess} / 羞耻 ${state.shame}` +
          ` / 理智 ${state.resist} / 疲劳 ${state.fatigue} / 好感 ${state.affection ?? 50}｜${modeOf(state)}`,
      }
    },
  })
}
