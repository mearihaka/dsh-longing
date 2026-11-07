import { effOf, inWindow, parseWindow } from './curve.js'

/**
 * 主动开口的闸门 —— 面板「主动行为」那一栏就是这里。
 *
 * 为什么要单独一个文件：2026-11-04 之前，那批键（autoInitiate / idleTriggerMin /
 * proactiveMaxPerDay / quietHours / cooldownMin / urgeRepeatMin / proactivePerHour /
 * proactiveCooldownMin）只写在 config.js 的 schema 和 index.js 的面板可写键清单里，
 * 全项目没有任何读取点 —— 面板改了不生效，真正限速的是通道插件自己的定时器
 * （dsh-qq 那边一个 2 分钟的冷场配置就能把它刷成 3 分钟一次、一小时烧 149 万 token）。
 *
 * 分工从这里定死：
 *   longing  = 想不想、能不能、多久一次（主观世界）
 *   通道插件 = 真的发出去、真的花钱（执行层，只查门开没开）
 *
 * 所以判断必须落在 longing 这一侧：同一套数值，QQ / 哔哩哔哩 / Web 任何通道
 * 得到的答案都一样，不会各写一套定时器。
 */

const MINUTE = 60_000
const HOUR = 60 * MINUTE

const num = (v, d) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : d
}

/** 本地日历日 key（跨零点的日配额按它重置）。 */
function dayKey(now) {
  const d = new Date(now)
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

/**
 * 下一次「某个时间窗开始/结束」的时刻。
 *
 * 按分钟扫，最多扫 48 小时。看着笨，但跨零点、24 小时窗、start==end 这些
 * 边界全靠 inWindow 自己判，不需要我再写一遍特例。
 */
export function nextWindowChange(win, now, wantInside) {
  if (!win) return now
  for (let i = 1; i <= 60 * 48; i++) {
    const t = now + i * MINUTE
    if (inWindow(win, new Date(t)) === wantInside) return t
  }
  return now + MINUTE
}

/** 档位：0 没有 / 1 心里想 / 2 暗示 / 3 开口 / 4 上手（阈值与 prompt 里那套一致）。 */
export function tierOf(state, cfg) {
  const eff = effOf(state, num(cfg?.resistWeight, 0.5), num(cfg?.affectionWeight, 0.4))
  if (eff >= num(cfg?.urgeAct, 85)) return 4
  if (eff >= num(cfg?.urgeSpeak, 70)) return 3
  if (eff >= num(cfg?.urgeHint, 55)) return 2
  if (eff >= num(cfg?.urgeThink, 40)) return 1
  return 0
}

function readLog(state) {
  const raw = Array.isArray(state?.proactiveLog) ? state.proactiveLog : []
  return raw.map(Number).filter((t) => Number.isFinite(t) && t > 0).sort((a, b) => a - b).slice(-64)
}

/**
 * 现在能不能主动。
 *
 * 返回值里 nextAt 是「最早什么时候值得再问一次」：通道插件拿到它就能直接睡到那个点，
 * 不用每 60 秒醒一次问一遍（被否掉的那些轮次也是要花 token 的）。
 *
 * reason 取值：
 *   off        自动开口没开
 *   paused     红色暂停中
 *   never      还没聊过，谈不上冷场
 *   quiet      安静时段
 *   inactive   不在活跃时段（scheduleEnabled）
 *   cold       冷场还不够久
 *   lowlust    性欲没到「会主动」的地板
 *   cooldown   两次主动离得太近
 *   hourly     这一小时主动太多次
 *   daily      今天的额度用完了
 *   ok         可以
 */
export function proactiveGate({ cfg = {}, state = {}, now = Date.now() } = {}) {
  const log = readLog(state)
  const lastInitiateAt = log.length ? log[log.length - 1] : num(state?.lastInitiateAt, 0)
  const lastContactAt = num(state?.lastContactAt, 0)
  // 冷场只看「他最后一次说话」：他自己不回，冷场就该一直涨着。
  // 两次主动之间由 cooldown 单独管（否则冷场一重置，cooldown 就永远轮不到生效）。
  const silenceFrom = lastContactAt > 0 ? lastContactAt : num(state?.updatedAt, now)
  const coldMin = Number.isFinite(silenceFrom) && silenceFrom > 0 ? Math.max(0, (now - silenceFrom) / MINUTE) : 0

  const limitToday = Math.max(0, Math.round(num(cfg?.proactiveMaxPerDay, 8)))
  const limitPerHour = Math.max(0, Math.round(num(cfg?.proactivePerHour, 10)))
  const today = dayKey(now)
  const usedToday = log.filter((t) => dayKey(t) === today).length
  const usedLastHour = log.filter((t) => now - t < HOUR).length
  const tier = tierOf(state, cfg)
  const lust = num(state?.lust, 0)

  const out = {
    allowed: false,
    reason: 'ok',
    now,
    nextAt: 0,
    tier,
    lust,
    coldMin: Math.round(coldMin),
    idleTriggerMin: Math.round(num(cfg?.idleTriggerMin, 15)),
    usedToday,
    limitToday,
    usedLastHour,
    limitPerHour,
    lastInitiateAt,
    lastContactAt,
  }
  const deny = (reason, nextAt = 0) => ({ ...out, allowed: false, reason, nextAt })

  if (cfg?.autoInitiate !== true) return deny('off')
  if (num(state?.pausedUntil, 0) > now) return deny('paused', num(state.pausedUntil, 0))
  if (state?.everContacted !== true) return deny('never')

  const quiet = parseWindow(cfg?.quietHours)
  if (quiet && inWindow(quiet, new Date(now))) return deny('quiet', nextWindowChange(quiet, now, false))

  const active = parseWindow(cfg?.activeHours)
  // scheduleEnabled === false 时不管活跃时段（面板上叫「按时间段限制」）
  if (active && cfg?.scheduleEnabled !== false && !inWindow(active, new Date(now))) {
    return deny('inactive', nextWindowChange(active, now, true))
  }

  const idle = Math.max(1, Math.round(num(cfg?.idleTriggerMin, 15)))
  if (coldMin < idle) return deny('cold', silenceFrom + idle * MINUTE)

  // 地板：性欲低于这个值她根本不会主动（不是「不想说」，是「没那个心思」）
  // 2026-11-06：手里有东西的时候不看这道门 —— 她翻到点什么想给他看，
  // 跟想不想要是两件完全不同的事。别的门（冷却/每小时/每天）照样管，
  // 因为那些管的是「别烦人」和「别烧钱」，跟动机无关。
  const topic = state?.pendingTopic && typeof state.pendingTopic === 'object' ? state.pendingTopic : null
  const topicFresh = topic && now - num(topic.at, 0) < 6 * HOUR
  const floor = num(cfg?.initiateThreshold, 60)
  if (lust < floor && !topicFresh) return deny('lowlust')

  // 发情档位允许更密：urgeRepeatMin 顶掉 cooldownMin。
  // proactiveCooldownMin = 0 表示「跟 cooldownMin 走」——不能直接把它当 0 分钟用，
  // 否则配置里出现一个 0（schema 默认值就是 0）就会变成两次之间只隔 1 分钟。
  const heat = lust >= num(cfg?.urgeAct, 85) || tier >= 4
  const cdRaw = heat ? num(cfg?.urgeRepeatMin, 0) : num(cfg?.proactiveCooldownMin, 0)
  const cd = Math.max(1, Math.round(cdRaw > 0 ? cdRaw : num(cfg?.cooldownMin, 30)))
  if (lastInitiateAt > 0 && now - lastInitiateAt < cd * MINUTE) {
    return deny('cooldown', lastInitiateAt + cd * MINUTE)
  }

  if (limitPerHour > 0 && usedLastHour >= limitPerHour) {
    // 等到「这一小时里最早那次」滑出窗口为止
    const oldest = log.filter((t) => now - t < HOUR)[0] ?? now
    return deny('hourly', oldest + HOUR)
  }
  if (limitToday > 0 && usedToday >= limitToday) {
    const d = new Date(now)
    const tomorrow = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime()
    return deny('daily', tomorrow)
  }

  return { ...out, allowed: true, reason: 'ok', via: topicFresh ? 'curio' : 'lust', topic: topicFresh ? topic : null }
}

/** 真的说出口之后记一笔（通道插件在投递成功后调）。返回要并回 state 的字段。 */
export function noteInitiate({ state = {}, now = Date.now(), info = null } = {}) {
  const log = [...readLog(state), now].slice(-64)
  const patch = { proactiveLog: log, lastInitiateAt: now }
  // 留个痕：谁执行的、当时什么档位，面板和日记都能用上
  if (info && typeof info === 'object') patch.lastInitiateInfo = { ...info, t: now }
  // 2026-11-06：话题说出去就作废，否则下一轮会把它当新发现再讲一遍
  if (state?.pendingTopic) patch.pendingTopic = null
  return patch
}

/**
 * 主动发图 —— 2026-11-04 定的语义：不是「向她要图」，是**她自己拍/自己画一张发过来**。
 *
 * 原来面板上 `imageThreshold`（主动要图门槛）和 `imagesPerDay`（每天主动发图上限）
 * 两个键都没有读取点，功能本身也不存在。这里把「什么时候该发、发什么、今天还能发几张」
 * 定下来，通道插件只管真的出图 + 发出去，发成功回来记一笔。
 *
 * 门槛用「性欲 + 色情」合计（0~200 的量纲，和面板那一栏的上限 200 对得上）。
 * 类型不是让她瞎选：按当前数值和场景挑一个最像她会发的。
 */
const IMAGE_KINDS = {
  seduce: '诱惑（贴得近一点、只给他看的那种）',
  selfie: '自拍（自己的脸、当下的样子）',
  scene: '场景（她现在待的地方、正在做的事）',
  scenery: '风景（窗外/路上看到的，随手拍给他）',
}

function readImageLog(state) {
  const raw = Array.isArray(state?.imageLog) ? state.imageLog : []
  return raw.map(Number).filter((t) => Number.isFinite(t) && t > 0).sort((a, b) => a - b).slice(-32)
}

export function imageGate({ cfg = {}, state = {}, now = Date.now() } = {}) {
  const log = readImageLog(state)
  const today = dayKey(now)
  const usedToday = log.filter((t) => dayKey(t) === today).length
  const limitToday = Math.max(0, Math.round(num(cfg?.imagesPerDay, 2)))
  const threshold = num(cfg?.imageThreshold, 140)
  const score = Math.round(num(state?.lust, 0) + num(state?.lewd, 0))
  const lust = num(state?.lust, 0)
  const lewd = num(state?.lewd, 0)
  const aff = num(state?.affection, 0)
  const scene = String(state?.scene ?? '').trim()

  // 类型：先看敢不敢发诱惑，再看亲近程度，再看有没有场景，最后退到风景
  // 2026-11-07：这里原来是 `nsfwImages !== false`，而 prompt.js 那边用的是 `=== true`。
  // 两处口径不一致：用户没设这个键时，判据认为「可以发诱惑」，注入却说「成人向关掉了」，
  // 结果她既不敢发诱惑、又把「可以发安全图」那档也一起吞了。统一成严格 true。
  // 2026-11-07 晚：再加一道总闸 —— nsfwEnabled 关着时，图片层面再开也不给诱惑档。
  const nsfw = cfg?.nsfwEnabled === true && cfg?.nsfwImages === true
  const kind = nsfw && lust >= num(cfg?.urgeSpeak, 70) && lewd >= num(cfg?.lewdDirect, 55)
    ? 'seduce'
    : aff >= num(cfg?.affectionClose, 60)
      ? 'selfie'
      : scene
        ? 'scene'
        : 'scenery'

  const out = {
    allowed: false,
    reason: 'ok',
    now,
    nextAt: 0,
    kind: IMAGE_KINDS[kind] ? kind : 'scenery',
    kindLabel: IMAGE_KINDS[kind] ?? IMAGE_KINDS.scenery,
    score,
    threshold: Math.round(threshold),
    usedToday,
    limitToday,
  }
  const deny = (reason, nextAt = 0) => ({ ...out, allowed: false, reason, nextAt })

  if (cfg?.enabled === false) return deny('off')
  // 「主动发图」是主动行为的一部分：`autoInitiate` 没开就不发。
  // 1.11.0 只看总开关，于是关掉「允许她主动开口」之后她还会自己发图 —— 语义对不上，
  // 而且默认配置下路人第一天就会被塞一张图。
  if (cfg?.autoInitiate !== true) return deny('autooff')
  if (num(state?.pausedUntil, 0) > now) return deny('paused', num(state.pausedUntil, 0))
  // 一次都没聊过就发自拍，比发不出来更不像人。
  if (state?.everContacted !== true) return deny('never')
  if (limitToday > 0 && usedToday >= limitToday) {
    const d = new Date(now)
    return deny('daily', new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime())
  }
  if (score < threshold) return deny('low')
  const active = parseWindow(cfg?.activeHours)
  if (active && cfg?.scheduleEnabled !== false && !inWindow(active, new Date(now))) {
    return deny('inactive', nextWindowChange(active, now, true))
  }
  const quiet = parseWindow(cfg?.quietHours)
  if (quiet && inWindow(quiet, new Date(now))) return deny('quiet', nextWindowChange(quiet, now, false))
  return { ...out, allowed: true, reason: 'ok' }
}

/** 图片真发出去了才记一笔（通道插件调）。 */
export function noteImage({ state = {}, now = Date.now(), info = null } = {}) {
  const patch = { imageLog: [...readImageLog(state), now].slice(-32) }
  if (info && typeof info === 'object') patch.lastImageInfo = { ...info, t: now }
  return patch
}

/** 给通道插件的一句人话（日志/调试用，不进提示词）。 */
export function explain(gate) {
  if (!gate) return '（没有主动判据）'
  if (gate.allowed) return `可以主动（档位 ${gate.tier}，冷场 ${gate.coldMin} 分钟，今天 ${gate.usedToday}/${gate.limitToday}）`
  const reason = {
    off: '自动开口关着',
    paused: '暂停中',
    never: '还没聊过',
    quiet: '安静时段',
    inactive: '不在活跃时段',
    cold: `冷场 ${gate.coldMin} 分钟，还不够 ${gate.idleTriggerMin} 分钟`,
    lowlust: `性欲 ${Math.round(gate.lust)} 没到地板`,
    cooldown: '两次主动太近',
    hourly: '这一小时次数用满',
    daily: '今天次数用满',
  }[gate.reason] ?? gate.reason
  return `不能主动：${reason}`
}
