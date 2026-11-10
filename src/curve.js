/**
 * 数值、时间窗、衰减 —— 全是纯函数，不碰 IO，方便 node --test 直接测。
 *
 * 这里只管「怎么算」，不管「存哪」。index.js 负责落盘，prompt.js 负责文案。
 */

/** 负面阶梯的默认断点，降序。跌破第一档开始有负面 buff。 */
export const DEFAULT_BREAKS = [45, 40, 35, 25, 10, 5]

/** 状态键：只活在状态文件里，绝不进面板配置。 */
export const STATE_KEYS = [
  'lust', 'lewd', 'possess', 'shame', 'resist', 'fatigue', 'affection',
  'scene', 'pausedUntil', 'lastPeak', 'events', 'lastContactAt', 'lastLonelyAt', 'everContacted',
  'grudges', 'firsts', 'aftercareUntil', 'tickedAt',
  // 主动开口 / 主动发图的账本也是状态：它们在 1.11.0 漏登记了。
  // 漏登记的后果和 1.0.0 那个「重启丢进度」一模一样 —— 一旦哪天被写进面板配置，
  // 下次启动就会拿配置里的旧快照反过来盖掉真实账本（每小时/每天的额度算错）。
  'proactiveLog', 'lastInitiateAt', 'lastInitiateInfo',
  'imageLog', 'lastImageAt', 'lastImageInfo',
]

/** 六个核心数值维 + 好感，共七个。 */
export const DIMS = ['lust', 'lewd', 'possess', 'shame', 'resist', 'fatigue', 'affection']

export function num(v, fallback = 0) {
  // null / '' / [] 一律当「缺失」，不是 0：否则 "updatedAt": null 会让 dt 变成 24 小时，
  // 一次性把一天的状态全演化掉。JSON.stringify(NaN) 产出 null，所以这不是理论情况。
  if (v === null || v === '' || v === undefined) return fallback
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

/**
 * 不取整的夹取。衰减每 tick 只有 0.05，
 * 这里要是 round 就永远抹平 —— 那是 1.0.0 里时间曲线完全不工作的根因。
 */
export function clampFloat(n, lo = 0, hi = 100) {
  const v = Number(n)
  if (!Number.isFinite(v)) return lo
  return Math.min(hi, Math.max(lo, v))
}

/** 两位小数：落盘够用，也不会让 JSON 里出现 91.94999999。 */
export function round2(n) {
  const v = Number(n)
  if (!Number.isFinite(v)) return 0
  return Math.round(v * 100) / 100
}

/** 取整的夹取：给面板滑块、工具返回值、注入文案用。 */
export function clamp(n, lo = 0, hi = 100) {
  return Math.round(clampFloat(n, lo, hi))
}

/** '45,40,35,25,10,5' 或 [45,40,...] → 六个降序断点；格式不对就退回默认。 */
export function parseBreakpoints(spec) {
  const raw = Array.isArray(spec) ? spec : String(spec ?? '').split(/[,\s]+/)
  const a = raw.map(Number).filter((n) => Number.isFinite(n))
  return a.length === 6 ? a : DEFAULT_BREAKS
}

/**
 * 负面档位。
 *   -1 = 正常（没跌破第一断点）
 *    0 = 刚跌破第一断点（45）
 *    5 = 低于最后一个断点（5）—— 最惨那一档
 */
export function ladder(v, breaks = DEFAULT_BREAKS) {
  const n = Number(v)
  const bs = parseBreakpoints(breaks)
  if (!Number.isFinite(n)) return -1
  for (let i = 0; i < bs.length; i++) if (n >= bs[i]) return i - 1
  return bs.length - 1
}

/** 'HH:MM-HH:MM' → {start,end}（分钟）；不合法返回 null。 */
export function parseWindow(spec) {
  const m = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(String(spec ?? '').trim())
  if (!m) return null
  return { start: Number(m[1]) * 60 + Number(m[2]), end: Number(m[3]) * 60 + Number(m[4]) }
}

/** 跨零点的窗口也认（22:00-02:00）。没配就是全天。 */
export function inWindow(win, d = new Date()) {
  if (!win) return true
  const cur = d.getHours() * 60 + d.getMinutes()
  return win.start <= win.end ? cur >= win.start && cur < win.end : cur >= win.start || cur < win.end
}

export function todayKey(d = new Date()) {
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

/**
 * 日期键 → 可比较的整数（20261109）。
 *
 * todayKey 用的是 `${y}-${m}-${d}`，10 号之前不补零，
 * 所以 '2026-11-9' > '2026-11-10'（字符串逐位比，'9' > '1'）。
 * 凡是「哪个日期更新」的判断都必须走这里，别用字符串直接比。
 *
 * @param {string} k 形如 2026-11-9
 * @returns {number} 解析不了返回 0（当作「最旧」）
 */
export function keyNum(k) {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(k ?? ''))
  return m ? Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3]) : 0
}

/**
 * 「这一次高峰属于哪一天」。
 *
 * 默认窗口 22:00-02:00 跨零点：23:00 和次日 00:30 都在这段高峰里，
 * 但拿日历日当 key 会算成两天，一夜加两次加成，之后相位整体偏到午夜。
 * 跨零点且当前时刻在窗口后半段时，归到前一天。
 */
export function peakKey(win, d = new Date()) {
  if (!win) return todayKey(d)
  const cur = d.getHours() * 60 + d.getMinutes()
  if (win.start > win.end && cur < win.end) {
    const prev = new Date(d.getTime() - 86_400_000)
    return todayKey(prev)
  }
  return todayKey(d)
}

/**
 * 有效欲望 = （性欲 − 理智 × 权重）× 意愿。
 *
 * 意愿由好感决定：再想要，也得她愿意。
 * 好感 10 的人不会因为性欲 90 就扑上来 —— 那只会变成烦躁和躲开。
 * 少了这个乘数，eff 就只是「她多想要」，而不是「她想不想给你」。
 *
 * @param {number} affWeight 0 = 关掉（退回纯数值），默认 0.4
 */
export function effOf(state, weight = 0.5, affWeight = 0.4) {
  const w = Number(weight)
  const raw = num(state?.lust, 30) - num(state?.resist, 50) * (Number.isFinite(w) ? w : 0.5)
  const aw = Number(affWeight)
  const will = Number.isFinite(aw) ? clampFloat(1 - aw * (1 - num(state?.affection, 50) / 100), 0.2, 1) : 1
  return round2(clampFloat(raw * will))
}

/**
 * 每小时的自然演化速度。
 *
 * 全部很慢：分钟级看不出来，小时级才有感觉。这是刻意的 ——
 * 状态要像人，但它不能在你眼皮底下蹦。总倍率见 couplingRate。
 */
export const EVOLVE = {
  resistBurn: 0.04, // 性欲 80 以上会烧理智：(lust − 80) × 它
  lewdFollow: 0.05, // 单向：身体热了，嘴会松一点（不是把两个值拽成一样）
  possessGain: 0.02, // 好感 60 以上才养得出占有：(affection − 60) × 它
  affectionWear: 0.03, // 占有 85 以上会磨好感：(possess − 85) × 它
  overRelax: 0.4, // 越过上限时，每小时回落掉的「超出量」比例
  fatigueNight: 2.5, // 睡前时段每小时更累（熬夜是债）
}

/**
 * 每个维度的「日常值」和回到一半要多久。
 *
 * 不是单向衰减，是**向基线收敛**：被撩起来会离开它，没刺激就慢慢回来。
 * 少了这个，`possess` 会只涨不降 —— 昨天提了别人一次，占有欲就锁死在高位。
 */
export const DRIFT = {
  lust: { base: 30, half: 24 }, // 一天不做就淡了，但时间不会把它推到 30 以下
  lewd: { base: 45, half: 36 }, // 话说野了，隔两天不练就收敛
  possess: { base: 55, half: 30 }, // 嫉妒会过去
  shame: { base: 55, half: 20 }, // 被撩开的那层皮，会重新长回来
  resist: { base: 50, half: 10 }, // 睡一觉就回来了（仍受占有压制）
  fatigue: { base: 20, half: 10 }, // 睡醒就恢复
  affection: { base: 40, half: 72 }, // 关系不会自己变好，但会淡
}

/** 性欲的时间衰减停在这个值：再往下只能是事件干的（被拒绝、做完了）。 */
export const LUST_FLOOR = DRIFT.lust.base

/** 半衰式收敛：dt 小时后，v 与基线之间的距离剩多少。 */
function decayTo(v, base, cap, halfLife, dt, rate) {
  const target = Math.min(base, cap)
  const k = Math.pow(0.5, (rate * dt) / Math.max(0.5, halfLife))
  return target + (v - target) * k
}

/**
 * 维度之间谁压着谁 —— 软上限，不是墙。
 *
 * 单向，避免 A 压 B、B 又压 A 互相踩到 0。经验锚点（来自实际调参）：
 *   占有 80 → 理智撑到 50 刚好；占有 90 → 理智撑不过 30。
 * 也就是 resistCap = 210 − 2 × possess。
 *
 * 回到 0 的语义要分清楚：这不是「不能到」，是「撑不久」——
 * 手动照样能设到 100，只是接下来每小时往回掉一点。
 */
export function pressureOf(state, cfg = {}) {
  const s = state ?? {}
  const off = cfg?.couplingEnabled === false
  const possess = num(s.possess, 55)
  const lewd = num(s.lewd, 35)
  const fatigue = num(s.fatigue, 20)
  const affection = num(s.affection, 50)
  const lust = num(s.lust, 30)
  // 2026-11-10：加第二个参数当地板。原来一律 5，导致 resist 被 possess 压到 28 以下、
  // 贴着自己的天花板动不了（48.6 小时只从 30 掉到 26.6）。地板让「占有再满也留点理智」。
  const cap = (v, lo = 5) => (off ? 100 : round2(clampFloat(v, lo, 100)))
  return {
    // 占有欲是执念，会烧掉自制
    resist: { cap: cap(210 - 2 * possess), by: 'possess', drift: off ? 0 : Math.max(0, lust - 80) * EVOLVE.resistBurn },
    // 说开了就不羞了
    shame: { cap: cap(120 - 1.1 * lewd), by: 'lewd', drift: 0 },
    // 累了就没性趣（但要先累到 60 上下才开始压）
    lust: { cap: cap(140 - 1.1 * fatigue), by: 'fatigue', drift: 0 },
    // 不熟的人不配有占有欲，那叫跟踪狂
    possess: { cap: cap(30 + affection * 0.9), by: 'affection', drift: 0 },
    // 占有太满会磨关系：病娇是不稳定状态，得靠好感撑着
    affection: { cap: 100, softCap: 90, by: '', drift: off ? 0 : Math.max(0, possess - 85) * EVOLVE.affectionWear },
    lewd: { cap: 100, by: '', drift: 0 },
    fatigue: { cap: 100, by: '', drift: 0 },
  }
}

/** 超出上限的差值：>0 表示正在硬撑（多撑了一会儿）。面板与注入都靠它说话。 */
export function overCap(state, cfg = {}) {
  const p = pressureOf(state, cfg)
  const out = {}
  for (const k of DIMS) {
    const d = round2(num(state?.[k]) - p[k].cap)
    if (d > 0) out[k] = d
  }
  return out
}

/**
 * 一个小时的自然演化：互相带动 + 越界回落。
 *
 * 不修改入参。dt 单位是小时；peakH/restH 是这段时间里分别落在高峰/平时的时长。
 */
export function evolve(prev, cfg = {}, dt = 0, peakH = 0, restH = dt) {
  const rate = cfg?.couplingEnabled === false ? 0 : num(cfg?.couplingRate, 1)
  if (!(rate > 0) || !(dt > 0)) return { ...prev }
  const out = { ...prev }
  const p = pressureOf(out, cfg)

  // 1. 越过上限：按超出量指数回落。撑得住一会儿，撑不住一天。
  for (const k of DIMS) {
    if (out[k] > p[k].cap) out[k] = p[k].cap + (out[k] - p[k].cap) * Math.exp(-EVOLVE.overRelax * rate * dt)
  }
  // 2. 疲劳：睡前那段更累（熬夜是债），剩下的交给下面的收敛拉回基线。
  //    归零会变成「亢奋得不正常」，那是 bug 不是性格，所以靠基线兜住。
  out.fatigue += EVOLVE.fatigueNight * rate * peakH
  // 3. 性欲太高会持续烧理智（每小时 drift，按 dt 摊）
  out.resist -= p.resist.drift * rate * dt
  // 4. 想要 和 敢 是两件事：lust 高时只把 lewd 往上带一点，不拽成一样
  if (out.lust > out.lewd) {
    out.lewd = out.lust + (out.lewd - out.lust) * Math.exp(-EVOLVE.lewdFollow * rate * dt)
  }
  // 5. 好感够，才养得出占有（但别顶穿 cap：顶住了就该靠下面的收敛淡下来）
  if (out.affection > 60 && out.possess < p.possess.cap) {
    out.possess = Math.min(
      p.possess.cap,
      out.possess + (out.affection - 60) * EVOLVE.possessGain * rate * dt,
    )
  }
  // 6. 占有过满会磨好感
  out.affection -= p.affection.drift * rate * dt

  // 7. 全部维度向各自的「日常值」收敛 —— 被撩起来会离开它，没刺激就慢慢回来。
  //    这是 possess 唯一的下降通道：嫉妒会过去，不会锁死在高位。
  //    lust 不在这里：它在 nextState 里按小时线性掉、并停在地板 30（见上）。
  for (const k of DIMS) {
    if (k === 'lust') continue
    const d = DRIFT[k]
    if (!d) continue
    // 好感沿用用户调的 affectionDecay：数值越大，半衰越短
    const half =
      k === 'affection' ? d.half * (0.3 / Math.max(0.05, num(cfg?.affectionDecay, 0.3))) : d.half
    // decayTo 里 target 会取 min(base, cap)：超上限的维度先贴着上限，再慢慢往基线淡
    out[k] = clampFloat(decayTo(out[k], d.base, p[k].cap, half, dt, rate))
  }

  for (const k of DIMS) out[k] = clampFloat(num(out[k], prev[k]))
  return out
}

/**
 * 某个时间区间里有多少小时落在窗口内（按 15 分钟采样，最多 96 次）。
 *
 * 为什么需要它：tick 只关心「现在是不是高峰」，但 nextState 一次可能覆盖
 * 几个小时甚至一天（关机再开）。拿「现在」去乘整个 dt，等于假设这段时间全在高峰里 ——
 * 离线一天能把疲劳一次加 60，那是算错，不是设定。
 */
export function peakHoursBetween(from, to, spec, stepMin = 15) {
  const win = parseWindow(spec)
  if (!win) return 0
  const start = num(from)
  const end = Math.min(num(to), start + 24 * 3_600_000)
  if (!(end > start)) return 0
  // 同 hoursInWindow：短窗口要用更细的步长，否则整段被跳过
  const spanMin = ((win.end - win.start + 1440) % 1440) || 1440
  const stepThis = Math.max(1, Math.min(num(stepMin, 15), Math.max(1, spanMin / 2))) * 60_000
  let acc = 0
  for (let t = start; t < end; t += stepThis) {
    const finish = Math.min(t + stepThis, end)
    if (inWindow(win, new Date(t))) acc += finish - t
  }
  return acc / 3_600_000
}

/**
 * 某个时间区间里有多少小时落在窗口内（按 stepMin 采样）。
 * 和 peakHoursBetween 的区别：不封顶 24 小时，跨几天也能算。
 */
export function hoursInWindow(from, to, spec, stepMin = 15) {
  const win = parseWindow(spec)
  if (!win) return 0
  const start = num(from)
  const end = num(to)
  if (!(end > start)) return 0
  // 采样步长不能超过窗口宽度的一半：7 分钟的窗口用 15 分钟采样会整段漏掉，
  // 于是峰值加成给了、夜间衰减却是 0，两个机制对同一段时间说法不一致。
  const spanMin = ((win.end - win.start + 1440) % 1440) || 1440
  const stepThis = Math.max(1, Math.min(num(stepMin, 15), Math.max(1, spanMin / 2))) * 60_000
  let acc = 0
  for (let t = start; t < end; t += stepThis) {
    const finish = Math.min(t + stepThis, end)
    if (inWindow(win, new Date(t))) acc += finish - t
  }
  return acc / 3_600_000
}

/**
 * 清醒时长 = 总时长 − 落在睡眠窗口里的那部分。
 *
 * 「被晾着」不能按墙上的钟算：凌晨一点聊完、早上八点起床，中间七个小时她在睡觉，
 * 不是被冷落。半夜扣好感更离谱 —— 人睡着了哪来的失望。
 */
export function awakeHoursBetween(from, to, sleepSpec, stepMin = 30) {
  const total = Math.max(0, num(to) - num(from)) / 3_600_000
  const slept = hoursInWindow(from, to, sleepSpec, stepMin)
  return Math.max(0, total - slept)
}

/** 现在是不是睡觉时间（窗口没配就当没睡）。 */
export function inSleepWindow(spec, now = Date.now()) {
  const win = parseWindow(spec)
  return win ? inWindow(win, new Date(now)) : false
}

/**
 * 一次 tick 的纯计算：衰减 + 睡前高峰加成 + 维度间演化。
 *
 * 不修改入参，返回新 state。暂停不在这里处理（暂停是「不推进」，由调用方跳过）。
 * @returns {object} 新 state，updatedAt 已推进到 now
 */
export function nextState(prev, cfg = {}, now = Date.now()) {
  const s = { ...prev }
  // 衰减基准用 tickedAt：消息和事件会刷新 updatedAt（那是给合并判定用的），
  // 拿它当基准的话，聊得越勤 dt 越小，整条时间曲线会在聊天时停摆。
  const last = num(s.tickedAt, num(s.updatedAt, now))
  // 上限 24h：进程睡了三天也只按一天补，不然重启直接把欲望清零
  const dt = Math.min(24, Math.max(0, (now - last) / 3_600_000))
  const peakWin = parseWindow(cfg?.peakWindow)
  const peak = peakWin ? inWindow(peakWin, new Date(now)) : false
  // 这段时间里有多少小时真落在高峰，决定衰减速率和疲劳增减 —— 不能拿 now 当成全天
  const peakH = Math.min(dt, peakHoursBetween(last, now, cfg?.peakWindow))
  const restH = Math.max(0, dt - peakH)
  // 高峰时段衰减压到 1/4，让 peakBonus 留得住
  const decayAmt =
    num(cfg?.decayPerHour, 3) * restH + num(cfg?.nightDecayPerHour, 6) * 0.25 * peakH
  // 这里绝不 round：每分钟好感只掉 0.005，一取整就永远掉不下去。
  // 取整只发生在落盘（index.js snapState）和展示的时候。
  // 性欲：高于日常值就往回掉，低于日常值慢慢回温。
  // 时间永远推不到 0 —— 掉到 0 只能是事件干的（被拒绝、做完了），
  // 否则几天不上线她就「身体完全没反应」，那是熬出来的，不是发生的。
  const curLust = num(s.lust, 30)
  if (curLust > LUST_FLOOR) s.lust = clampFloat(Math.max(LUST_FLOOR, curLust - decayAmt))
  else s.lust = clampFloat(Math.min(LUST_FLOOR, curLust + 0.5 * dt))
  // 2026-11-10（复审计 N5）：只比「日期键是否不同」的话，把时钟往回拨一天
  // 就会再发一次 +25 —— 实测 79 → 100，连续回拨能一直顶在 100。
  // 但「新的 key 必须更大」不能拿字符串比：todayKey 不补零，
  // '2026-11-10' < '2026-11-9'（'1' < '9'），于是 10 号反而少发一次。
  // 转成 20261109 这样的整数再比，跨月跨年也成立。
  const nextPeakKey = peakKey(peakWin, new Date(now))
  if (peak && s.lastPeak !== nextPeakKey && keyNum(nextPeakKey) > keyNum(s.lastPeak)) {
    s.lust = clampFloat(num(s.lust, 30) + num(cfg?.peakBonus, 25))
    s.lastPeak = nextPeakKey
  }
  const out = evolve(s, cfg, dt, peakH, restH)
  out.tickedAt = now
  out.updatedAt = now
  return out
}
