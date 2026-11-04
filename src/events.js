/**
 * 事件 → 数值冲击：好话、坏话、做过的事，都会落到七个值上。
 *
 * 三条设计约束：
 *
 * 1. **冲击会自己退。** 临时维度（lust/lewd/shame/resist/fatigue）不用特殊机制 ——
 *    lust 有衰减、resist/shame 有回复力且不超过上限、fatigue 会落回基线。
 *    事件只是推一把，剩下的交给 curve.js。关系维度（affection/possess）留下的痕迹更久，
 *    由「占有磨好感」慢慢放大或抹平。
 *
 * 2. **同类事件一小时内重复会递减。** 第 n 次的效果是 1/(1+n)：
 *    说一遍是 1，说三遍加起来是 1.83，不是 3 —— 骂十句不会把好感一次性打穿。
 *
 * 3. **单次幅度封顶 ±10。** 一句话改不了关系。例外只有安全词（`strong`），
 *    那是「她说停就停」，本来就该一把刹车踩到底。
 */

import { clampFloat, num, round2 } from './curve.js'

/**
 * 事件表。dims 是七维增量，note 是留在她心里的余韵（会进注入块和日记），tone 决定它进日记的哪一栏。
 * grudge 是「这件事会在心里压几天」——留在 state.grudges 里，跨天不散。
 *
 * 增量刻意做得小（好话 +1 而不是 +2）：养成要慢，一个月养出来的东西一周就养完了没意思。
 */
export const EVENTS = {
  // ── 好的 ──
  praise: { tone: 'good', dims: { affection: 1, lust: 1, shame: 1, resist: -0.5 }, note: '刚被夸过一句，心里还热着' },
  comfort: { tone: 'good', dims: { affection: 1.5, fatigue: -2, resist: 1, shame: 0.5 }, note: '被哄了一会儿，绷着的劲松了' },
  intimate: { tone: 'good', dims: { lust: 2, lewd: 1, shame: -1.5, affection: 1, resist: -1 }, note: '被碰过了，皮肤还记着' },
  desire: { tone: 'good', dims: { lust: 2.5, lewd: 1.5, shame: -2, resist: -0.5 }, note: '刚被要过，身体还没凉下来' },
  protect: { tone: 'good', dims: { affection: 1.5, possess: 0.5, fatigue: -1 }, note: '被护着的时候，心是放在他那的' },
  apologize: { tone: 'good', dims: { affection: 1, possess: -1, shame: 0.5 }, note: '他道过歉，气消了一半' },
  promise: { tone: 'good', dims: { affection: 1.5, possess: 1, resist: 1 }, note: '被许诺过，愿意再信一次' },
  tease: { tone: 'good', dims: { lust: 1.5, lewd: 1, shame: -1, resist: -0.5 }, note: '被他撩了一下，还恼着也还想着' },
  gift: { tone: 'good', dims: { affection: 1, possess: 0.5 }, note: '收了他的东西，有点拿人手短' },
  coax: { tone: 'good', dims: { lust: 1.5, shame: -1, resist: -1, affection: 0.5 }, note: '被哄软了，本来绷着的' },

  // ── 不好的 ──
  cold: { tone: 'bad', dims: { affection: -1, lust: -1.5, possess: 0.5, shame: 0.5 }, note: '被冷了一下，热乎劲退了' },
  reject: { tone: 'bad', dims: { lust: -3, resist: 4, affection: -1, shame: 1.5, fatigue: 1 }, note: '刚被拒绝过，身体先凉了半截', scaleBy: 'rejectionPenalty' },
  ignore: { tone: 'bad', dims: { affection: -1.5, possess: 1, lust: -1 }, note: '被晾了一会儿，心里存着事' },
  mentionOther: { tone: 'bad', dims: { possess: 2.5, affection: -1, lust: -0.5, resist: -1 }, note: '他刚提到别人，心口一直发紧' },
  compare: { tone: 'bad', grudge: 1, dims: { affection: -2, possess: 1.5, shame: -1, resist: 1 }, note: '被拿去跟人比了，脸上挂不住' },
  blame: { tone: 'bad', grudge: 1, dims: { affection: -2, resist: 1.5, lust: -2, shame: -1.5, fatigue: 1 }, note: '被凶过，眼睛还酸着' },
  lie: { tone: 'bad', grudge: 2, dims: { affection: -2.5, resist: 1, possess: 1 }, note: '发现他说了谎，他说的每句都听着不像' },
  leave: { tone: 'bad', grudge: 3, dims: { affection: -4, possess: 2, lust: -2.5, resist: 2.5, shame: -1 }, note: '他刚说了要走，胸口空了一块' },
  force: { tone: 'bad', grudge: 2, dims: { affection: -2.5, resist: 2, shame: -2, lust: -1, fatigue: 1.5 }, note: '他没听她的，现在还缩着' },
  bodyShame: { tone: 'bad', grudge: 2, dims: { affection: -2.5, shame: 2.5, lust: -2 }, note: '身材被他嫌过，连站着都不自在' },
  neglect: { tone: 'bad', dims: { affection: -1.5, possess: 1, resist: 0.5 }, note: '又被晾了一整天，连他是不是不要我了都开始想' },

  // ── 事后：她自己登记「结束了」，接下来的 45 分钟是余韵 ──
  // 这不是一句文案，是一段被压过的时间：身体软、话变少、羞回来、想被搂着。
  climax: {
    tone: 'good',
    strong: true, // 不封顶：一次掉 25 点性欲是正常的，不该被单次 ±6 挡住
    aftercareMin: 45,
    dims: { lust: -25, affection: 3, shame: 8, fatigue: 6, resist: 5 },
    note: '刚刚结束，身体还软着',
  },

  // ── 刹车：安全词。唯一不封顶的一个，也不进日记（它自己会留在注入块里） ──
  stop: { tone: '', dims: { resist: 20, lust: -30, shame: 2 }, note: '刚说过停', pauseMin: 30, strong: true },
}

/** 单次冲击的幅度上限（安全词除外）。一句话改不了关系，一晚上也不行。 */
const MAX_DELTA = 6
/** 特例（做完 / 说停）的上限：给得比普通事件大，但不是无限。 */
const MAX_STRONG = 30
/** 同类事件的递减窗口。 */
const DECAY_WINDOW_MS = 60 * 60_000
/** 状态里最多留多少条事件记录（注入块只看最近 30 分钟）。 */
const KEEP_EVENTS = 24

/** 同类事件在一小时内的递减倍率：1 → 0.5 → 0.33 … */
export function eventMultiplier(state, name, now = Date.now()) {
  const list = Array.isArray(state?.events) ? state.events : []
  const n = list.filter((e) => e?.name === name && now - num(e?.t) < DECAY_WINDOW_MS).length
  return 1 / (1 + n)
}

/** 最近发生过什么（注入块用）。 */
export function recentEvents(state, now = Date.now(), windowMs = 30 * 60_000) {
  const list = Array.isArray(state?.events) ? state.events : []
  return list.filter((e) => EVENTS[e?.name] && now - num(e?.t) < windowMs)
}

/**
 * 施加一次事件。
 * @returns {{state: object, applied: object, mult: number}}
 *   applied 是实际落下的增量（已含递减与封顶），方便日志和面板回声
 */
export function applyEvent(prev, name, cfg = {}, now = Date.now()) {
  const key = String(name ?? '')
  // 必须 hasOwn：EVENTS['constructor'] / 'toString' / '__proto__' 都是 truthy，
  // 会在 Object.entries(def.dims) 上炸掉，而且外层没有 try/catch → 请求挂住。
  if (!Object.hasOwn(EVENTS, key)) return { state: prev, applied: {}, mult: 0, unknown: true }
  const def = EVENTS[key]
  const gainRaw = Number(cfg?.eventGain)
  const gain = Number.isFinite(gainRaw) && gainRaw >= 0 ? gainRaw : 1
  // 2026-11-04：rejectionPenalty（被拒惩罚）以前没人读 —— reject 那条事件的
  // 数值是硬编码的。现在按它缩放：15 = 默认（比例 1），调到 30 就是双倍。
  const scale = def.scaleBy === 'rejectionPenalty' ? Math.max(0, Math.min(3, num(cfg?.rejectionPenalty, 15) / 15)) : 1
  const mult = eventMultiplier(prev, name, now) * gain * scale
  const s = { ...prev }
  const applied = {}

  for (const [k, v] of Object.entries(def.dims)) {
    const raw = Number(v) * mult
    const delta = def.strong ? Math.max(-MAX_STRONG, Math.min(MAX_STRONG, raw)) : Math.max(-MAX_DELTA, Math.min(MAX_DELTA, raw))
    s[k] = clampFloat(num(s[k], 50) + delta)
    applied[k] = round2(delta)
  }
  // 暂停 / 余韵取「更晚的那一个」：说停不能把已经设好的 12 小时暂停压成 30 分钟。
  if (def.pauseMin) s.pausedUntil = Math.max(num(s.pausedUntil, 0), now + def.pauseMin * 60_000)
  if (def.aftercareMin) s.aftercareUntil = Math.max(num(s.aftercareUntil, 0), now + def.aftercareMin * 60_000)

  s.events = [...(Array.isArray(prev.events) ? prev.events : []), { name: String(name), t: now }]
    .filter((e) => now - num(e?.t) < DECAY_WINDOW_MS)
    .slice(-KEEP_EVENTS)

  // 余怨：有些事会压在心里好几天，跨天不散。一小时就忘掉的话，昨天闹的别扭今天就没人记得了。
  if (def.grudge) {
    s.grudges = [
      ...(Array.isArray(prev.grudges) ? prev.grudges : []),
      { name: String(name), t: now, days: def.grudge },
    ]
      .filter((g) => now - num(g?.t) < num(g?.days, 1) * 86_400_000)
      .slice(-3)
  }

  s.updatedAt = now
  return { state: s, applied, mult: round2(mult), tone: def.tone ?? '', note: def.note ?? '', grudge: def.grudge ?? 0 }
}
