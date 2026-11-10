import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  awakeHoursBetween,
  clamp,
  clampFloat,
  effOf,
  inSleepWindow,
  ladder,
  nextState,
  parseBreakpoints,
  pressureOf,
  round2,
} from '../src/curve.js'
import { applyEvent, eventMultiplier } from '../src/events.js'
import { boundaryLine, deepestUnlocked, nextLocked, unlockedOf } from '../src/unlock.js'
import { buildBlock, modeOf, sanitizeScene } from '../src/prompt.js'
import { apply } from '../src/index.js'

const base = (over = {}) => ({
  lust: 60, lewd: 60, possess: 50, shame: 50, resist: 20, fatigue: 20, affection: 50,
  scene: '', pausedUntil: 0, lastPeak: '', updatedAt: Date.now(), ...over,
})

const cfg = (over = {}) => ({
  channels: ['qq'],
  scheduleEnabled: false, // 测试不看时段，免得几点跑测试结果就变
  peakWindow: '',
  decayPerHour: 3,
  nightDecayPerHour: 6,
  peakBonus: 25,
  affectionDecay: 0.3,
  resistWeight: 0.5,
  ...over,
})

// ── 数值层 ──

test('clampFloat 不取整，clamp 取整', () => {
  assert.equal(clampFloat(91.95), 91.95)
  assert.equal(clamp(91.95), 92)
  assert.equal(clampFloat(-5), 0)
  assert.equal(clampFloat(NaN, 50), 50)
  assert.equal(round2(91.949999), 91.95)
  assert.equal(round2(2 / 3), 0.67)
})

test('ladder 默认六档', () => {
  const cases = [[100, -1], [45, -1], [44, 0], [40, 0], [39, 1], [35, 1], [34, 2], [25, 2], [24, 3], [10, 3], [9, 4], [5, 4], [4, 5], [0, 5]]
  for (const [v, want] of cases) assert.equal(ladder(v), want, `ladder(${v})`)
})

test('ladder 断点可配', () => {
  assert.deepEqual(parseBreakpoints('60,50,40,30,20,10'), [60, 50, 40, 30, 20, 10])
  assert.deepEqual(parseBreakpoints('乱写'), [45, 40, 35, 25, 10, 5])
  assert.equal(ladder(55, '60,50,40,30,20,10'), 0)
  assert.equal(ladder(45, '60,50,40,30,20,10'), 1)
  assert.equal(ladder(59, '60,50,40,30,20,10'), 0)
})

test('有效欲望 = （性欲 − 理智 × 权重）× 好感意愿', () => {
  // 好感 50：意愿 0.8 → (92 − 15×0.5) × 0.8
  assert.equal(effOf({ lust: 92, resist: 15, affection: 50 }, 0.5, 0.4), 67.6)
  // 好感 100：不打折
  assert.equal(effOf({ lust: 92, resist: 15, affection: 100 }, 0.5, 0.4), 84.5)
  // 好感 10：意愿 0.64，再想要也不太愿意
  assert.equal(effOf({ lust: 92, resist: 15, affection: 10 }, 0.5, 0.4), 54.08)
  // 关掉调制就退回纯数值
  assert.equal(effOf({ lust: 92, resist: 15, affection: 10 }, 0.5, 0), 84.5)
  assert.equal(effOf({ lust: 30, resist: 80, affection: 50 }, 0.5), 0) // 不会为负
})

test('好感低时高性欲不会直接推到「上手」档', () => {
  // 同样 lust 95 / resist 10：好感 90 是发情，好感 15 只到黏人
  assert.equal(modeOf({ lust: 95, resist: 10, affection: 90 }), '发情')
  assert.equal(modeOf({ lust: 95, resist: 10, affection: 15 }), '黏人')
})

// ── 时间曲线：1.0.0 的最大 bug，衰减被 round 吃光 ──

test('每分钟 tick 一次，两小时后性欲确实下降（不能被取整抹平）', () => {
  let s = base({ lust: 90, affection: 70 })
  const t0 = s.updatedAt
  const c = cfg({ peakWindow: '' })
  for (let i = 1; i <= 120; i++) s = nextState(s, c, t0 + i * 60_000)
  // 3/h × 2h = 6
  assert.ok(Math.abs(s.lust - 84) < 0.3, `两小时后 lust 应约 84，实际 ${s.lust}`)
  assert.ok(Math.abs(s.affection - 69.4) < 0.2, `好感应约 69.4，实际 ${s.affection}`)
})

test('好感每次只掉 0.005 也不会被抹平', () => {
  const t0 = Date.now()
  const s = nextState(base({ affection: 50 }), cfg(), t0 + 60_000)
  assert.ok(s.affection < 50, `好感应下降，实际 ${s.affection}`)
})

test('睡前高峰：当天只加一次，且衰减更慢', () => {
  const t0 = new Date(2026, 9, 31, 22, 30, 0).getTime() // 22:30 在 22:00-02:00 里
  const c = cfg({ peakWindow: '22:00-02:00' })
  const a = nextState(base({ lust: 40, lastPeak: '', updatedAt: t0 }), c, t0)
  assert.equal(a.lust, 65) // 同一时刻只加分：40 + 25，还没有时间流逝
  const b = nextState(a, c, t0 + 60_000)
  assert.ok(b.lust < a.lust, '当天已经加过，不该再加')
  assert.ok(b.lust > 64.9 && b.lust < 65, `高峰衰减应更慢，实际 ${b.lust}`)
})

test('时间只把性欲推到地板 30，再低只能是事件干的', () => {
  const t0 = Date.now()
  const s = nextState(base({ lust: 90, updatedAt: t0 - 72 * 3_600_000 }), cfg(), t0)
  assert.equal(s.lust, 30)
})

test('场景是纯数字时当脏值丢掉（「现在在0」）', () => {
  assert.equal(sanitizeScene('0'), '')
  assert.equal(sanitizeScene(0), '')
  assert.equal(sanitizeScene('12'), '')
  assert.equal(sanitizeScene('卧室'), '卧室')
  assert.doesNotMatch(buildBlock(base({ scene: '0' }), cfg()), /现在在/)
})

// ── 维度耦合：数值之间互相压着 ──

test('占有压理智：80 → 撑到 50，90 → 撑不过 30', () => {
  assert.equal(pressureOf(base({ possess: 80 })).resist.cap, 50)
  assert.equal(pressureOf(base({ possess: 90 })).resist.cap, 30)
  // 不是互斥：占有 100 时理智也不是 0，只是撑到 10
  assert.equal(pressureOf(base({ possess: 100 })).resist.cap, 10)
  // 占有不高时理智完全放得开
  assert.equal(pressureOf(base({ possess: 50 })).resist.cap, 100)
})

test('色情压羞耻、疲劳压性欲、好感撑占有', () => {
  assert.equal(pressureOf(base({ lewd: 85 })).shame.cap, 26.5) // 120 − 93.5
  assert.equal(pressureOf(base({ lewd: 20 })).shame.cap, 98)
  assert.equal(pressureOf(base({ fatigue: 100 })).lust.cap, 30) // 140 − 110
  assert.equal(pressureOf(base({ fatigue: 20 })).lust.cap, 100)
  assert.equal(pressureOf(base({ affection: 50 })).possess.cap, 75) // 30 + 45
  assert.equal(pressureOf(base({ affection: 90 })).possess.cap, 100)
})

test('越界不砍断，只往回拉：占有 95 时理智 90 一小时后还在 60 以上', () => {
  const t0 = 1_800_000_000_000
  let s = base({ possess: 95, resist: 90, lust: 30, affection: 74, updatedAt: t0 })
  const c = cfg({ peakWindow: '', decayPerHour: 0, affectionDecay: 0 })
  for (let i = 1; i <= 60; i++) s = nextState(s, c, t0 + i * 60_000)
  assert.ok(s.resist < 75, `一小时后理智应明显下滑，实际 ${s.resist}`)
  assert.ok(s.resist > 55, `一小时不该直接崩到 20，实际 ${s.resist}`)
})

test('上限之下理智会慢慢回来，但不会超过上限', () => {
  const t0 = 1_800_000_000_000
  let s = base({ possess: 90, resist: 5, lust: 30, updatedAt: t0 })
  const c = cfg({ peakWindow: '', decayPerHour: 0, affectionDecay: 0, couplingRate: 1 })
  for (let i = 1; i <= 600; i++) s = nextState(s, c, t0 + i * 60_000) // 10 小时
  assert.ok(s.resist > 18, `该回升，实际 ${s.resist}`)
  assert.ok(s.resist <= 30.1, `不该越过占有给的上限 30，实际 ${s.resist}`)
})

test('疲劳不会掉到基线以下（掉到 0 会变成「亢奋得不正常」）', () => {
  const t0 = 1_800_000_000_000
  let s = base({ fatigue: 60, updatedAt: t0 })
  const c = cfg({ peakWindow: '', decayPerHour: 0, affectionDecay: 0 })
  for (let i = 1; i <= 24 * 60; i++) s = nextState(s, c, t0 + i * 60_000)
  assert.ok(s.fatigue >= 19.9, `疲劳应停在基线 20 附近，实际 ${s.fatigue}`)
})

test('色情值会向性欲靠拢，但很慢', () => {
  const t0 = 1_800_000_000_000
  let s = base({ lust: 90, lewd: 30, updatedAt: t0 })
  const c = cfg({ peakWindow: '', decayPerHour: 0, affectionDecay: 0, nightDecayPerHour: 0 })
  const oneHour = nextState(s, c, t0 + 60 * 60_000)
  assert.ok(oneHour.lewd > 30 && oneHour.lewd < 45, `一小时只该靠近一点，实际 ${oneHour.lewd}`)
})

test('关掉耦合后七个值互不牵连', () => {
  const t0 = 1_800_000_000_000
  const s = base({ lust: 90, lewd: 30, possess: 95, resist: 90, fatigue: 90, updatedAt: t0 })
  const c = cfg({ peakWindow: '', decayPerHour: 0, affectionDecay: 0, couplingEnabled: false, couplingRate: 1 })
  const after = nextState(s, c, t0 + 60 * 60_000)
  assert.equal(after.lewd, 30)
  assert.equal(after.fatigue, 90)
  assert.equal(after.resist, 90)
  assert.equal(pressureOf(s, c).resist.cap, 100)
})

test('注入块：理智被占有压穿时会说「硬撑」', () => {
  const s = base({ lust: 30, possess: 95, resist: 90, affection: 74 })
  const b = buildBlock(s, cfg({ couplingEnabled: true }))
  assert.match(b, /硬撑|烧穿|压不住/)
})

test('注入块：好感低却占有高 → 说清那是控制欲不是喜欢', () => {
  const s = base({ lust: 30, possess: 95, resist: 10, affection: 30 })
  const b = buildBlock(s, cfg({ couplingEnabled: true }))
  assert.match(b, /锁住|抓得太紧/)
})

// ── 事件：好话坏话都会改值 ──

test('一句夸奖：好感、性欲、羞耻都涨一点，理智掉一点', () => {
  const t0 = 1_800_000_000_000
  const r = applyEvent(base({ updatedAt: t0 }), 'praise', cfg(), t0)
  // 2026-11-10 数值平衡：正向 affection 1 → 0.6
  assert.deepEqual(r.applied, { affection: 0.6, lust: 1, shame: 1, resist: -0.5 })
  assert.equal(r.mult, 1)
})

test('同一句话一小时内重复会递减：1 → 0.5 → 0.33', () => {
  const t0 = 1_800_000_000_000
  let s = base({ updatedAt: t0 })
  const m = []
  for (let i = 0; i < 3; i++) {
    const r = applyEvent(s, 'praise', cfg(), t0 + i * 60_000)
    s = r.state
    m.push(r.applied.affection)
  }
  assert.deepEqual(m, [0.6, 0.3, 0.2])
})

test('骂十句不会把好感一次打穿：单次事件封顶 ±6', () => {
  const t0 = 1_800_000_000_000
  const s = base({ affection: 80, updatedAt: t0 })
  const r1 = applyEvent(s, 'leave', cfg(), t0)
  assert.equal(r1.applied.affection, -5.6)
  const r2 = applyEvent(r1.state, 'leave', cfg(), t0 + 60_000)
  assert.equal(r2.applied.affection, -2.8) // 递减，不是再 −5.6
})

test('安全词是唯一不封顶的：说停就停，并且真的暂停', () => {
  const t0 = 1_800_000_000_000
  const r = applyEvent(base({ lust: 95, resist: 10, pausedUntil: 0, updatedAt: t0 }), 'stop', cfg(), t0)
  assert.equal(r.applied.lust, -30) // 没被 ±10 截断
  assert.equal(r.state.lust, 65)
  assert.ok(r.state.pausedUntil >= t0 + 30 * 60_000)
})

test('事件倍率为 0 时只记录不生效', () => {
  const t0 = 1_800_000_000_000
  const s = base({ updatedAt: t0 })
  const r = applyEvent(s, 'praise', cfg({ eventGain: 0 }), t0)
  assert.equal(r.applied.affection, 0)
  assert.equal(r.state.affection, s.affection)
})

test('未知事件不动状态', () => {
  const s = base()
  const r = applyEvent(s, 'nonsense', cfg(), Date.now())
  assert.equal(r.unknown, true)
  assert.equal(r.state, s)
})

test('刚发生的事会进注入块，让她的反应接得上', () => {
  const t0 = Date.now()
  let s = base({ updatedAt: t0 })
  s = applyEvent(s, 'mentionOther', cfg(), t0).state
  s = applyEvent(s, 'blame', cfg(), t0).state
  const b = buildBlock(s, cfg(), { now: t0 })
  assert.match(b, /刚才的事还留在心里/)
  assert.match(b, /提到别人/)
  assert.match(b, /被凶过/)
})

test('事件一小时后就从注入块消失（不会一直记仇）', () => {
  const t0 = Date.now()
  const r = applyEvent(base({ updatedAt: t0 }), 'blame', cfg(), t0)
  const later = buildBlock(r.state, cfg(), { now: t0 + 31 * 60_000 })
  assert.doesNotMatch(later, /被凶过/)
})

// ── 渐进解锁：她肯不肯 ──

test('开局（好感 30）只能到「抱抱」，接吻还不行', () => {
  const s = base({ affection: 30, shame: 45, lewd: 35, resist: 50, possess: 55 })
  const map = Object.fromEntries(unlockedOf(s, cfg()).map((u) => [u.key, u.ok]))
  assert.equal(map.touch, true)
  assert.equal(map.kiss, false)
  assert.equal(map.want, false)
})

test('好感 50 / 羞耻 40 就能接吻了', () => {
  const s = base({ affection: 50, shame: 40, lewd: 60, resist: 30, possess: 60 })
  const map = Object.fromEntries(unlockedOf(s, cfg()).map((u) => [u.key, u.ok]))
  assert.equal(map.kiss, true)
  assert.equal(map.talk, true)
  assert.equal(map.want, false) // 好感还差 20
})

test('好感 75 / 色情 75 / 理智 30 → 可以要她，但还绑不住', () => {
  const s = base({ affection: 75, shame: 30, lewd: 75, resist: 30, possess: 70 })
  assert.equal(deepestUnlocked(s, cfg()).key, 'want')
  assert.equal(nextLocked(s, cfg()).key, 'bind') // 还差好感 5
})

test('没到门槛时她有反应，而不是照做', () => {
  const s = base({ affection: 32, lust: 95, resist: 5, shame: 50 })
  const line = boundaryLine(s, cfg(), 4)
  assert.match(line, /还不肯|还没准备好|还差一点点/)
  // 差一点点和差很远，躲法不一样
  const far = boundaryLine(base({ affection: 0, lust: 95, resist: 5, shame: 60 }), cfg(), 4)
  assert.match(far, /还不肯/)
  const near = boundaryLine(base({ affection: 68, lust: 95, resist: 5, lewd: 70, shame: 42 }), cfg(), 4)
  assert.match(near, /还差一点点/)
})

test('欲望没到开口那一档，不提前演边界戏', () => {
  assert.equal(boundaryLine(base({ affection: 30 }), cfg(), 1), '')
})

// ── 余怨：跨天不散 ──

test('说要走会压三天，一小时后也还在', () => {
  const t0 = 1_800_000_000_000
  let s = base({ updatedAt: t0 })
  s = applyEvent(s, 'leave', cfg(), t0).state
  assert.equal(s.grudges.length, 1)
  assert.equal(s.grudges[0].days, 3)
  // 第二天还在
  const next = buildBlock(s, cfg(), { now: t0 + 20 * 3_600_000 })
  assert.match(next, /还没过去/)
  // 四天后自己散了
  const later = buildBlock(s, cfg(), { now: t0 + 4 * 86_400_000 })
  assert.doesNotMatch(later, /还没过去/)
})

test('一句夸奖不留余怨', () => {
  const s = applyEvent(base(), 'praise', cfg(), 1_800_000_000_000).state
  assert.equal(s.grudges, undefined)
})

// ── 第一次 ──

test('第一次会被记住，一天后就不特别了', () => {
  const t0 = 1_800_000_000_000
  let s = base({ updatedAt: t0, firsts: {} })
  s = applyEvent(s, 'intimate', cfg(), t0).state
  s.firsts = { ...(s.firsts ?? {}), intimate: t0 }
  const now = buildBlock(s, cfg(), { now: t0 + 60_000 })
  assert.match(now, /第一次被你这样碰/)
  const later = buildBlock(s, cfg(), { now: t0 + 25 * 3_600_000 })
  assert.doesNotMatch(later, /第一次被你这样碰/)
})

// ── 想要 vs 敢说：两个值分家 ──

test('想要但不敢说：clash 会替掉档位句', () => {
  // lust 90 / resist 10 / affection 80 → eff 高；lewd 15 → 说不出口
  const s = base({ lust: 90, resist: 10, affection: 80, lewd: 15 })
  const b = buildBlock(s, cfg())
  assert.match(b, /想要，可说不出口/)
  assert.doesNotMatch(b, /直接开口要/)
})

test('敢说但身体没动：另一种 clash', () => {
  // lust 20 / resist 70 → eff 0；lewd 75 → 什么都敢说
  // 2026-11-07：加了成人内容总闸之后，这套断言必须显式开闸
  // （关闸时 expr 一律压到 0，无论 lewd 多高都不会「嘴上没刹车」）
  const s = base({ lust: 20, resist: 70, affection: 40, lewd: 75 })
  const b = buildBlock(s, cfg({ nsfwEnabled: true }))
  assert.match(b, /嘴上没刹车/)
})

test('两个都高时正常给档位，不再互相牵制', () => {
  const s = base({ lust: 90, resist: 10, affection: 80, lewd: 80 })
  const b = buildBlock(s, cfg({ nsfwEnabled: true }))
  assert.doesNotMatch(b, /说不出口|嘴上没刹车/)
  assert.match(b, /现在这一档/)
  assert.match(b, /露骨的话可以直接说出口|没有遮拦/)
})

test('色情值高于性欲时会自己回缩（尺度会忘）', () => {
  const t0 = 1_800_000_000_000
  const s = base({ lust: 30, lewd: 80, updatedAt: t0 })
  const after = nextState(s, cfg({ peakWindow: '', decayPerHour: 0, affectionDecay: 0 }), t0 + 3_600_000)
  assert.ok(after.lewd < 80 && after.lewd > 79, `一小时只该缩一点，实际 ${after.lewd}`)
})

// ── 睡觉不算被晾着 ──

test('昨晚一点聊完、今早九点：只算一小时清醒，不算孤独', () => {
  const lastAt = new Date(2026, 10, 1, 1, 0, 0).getTime() // 11/1 01:00
  const now = new Date(2026, 10, 1, 9, 0, 0).getTime() // 11/1 09:00
  // 23:30-08:00 在睡，只剩 08:00-09:00 这一个小时
  assert.ok(Math.abs(awakeHoursBetween(lastAt, now, '23:30-08:00') - 1) < 0.6)
})

test('早上八点聊完、晚上八点没消息：十二小时清醒，算孤独', () => {
  const lastAt = new Date(2026, 10, 1, 8, 0, 0).getTime()
  const now = new Date(2026, 10, 1, 20, 0, 0).getTime()
  assert.ok(awakeHoursBetween(lastAt, now, '23:30-08:00') > 11.5)
})

test('正在睡觉的时间段，孤独判定直接为假', () => {
  const night = new Date(2026, 10, 1, 3, 0, 0).getTime()
  assert.equal(inSleepWindow('23:30-08:00', night), true)
  const noon = new Date(2026, 10, 1, 12, 0, 0).getTime()
  assert.equal(inSleepWindow('23:30-08:00', noon), false)
})

test('睡觉时不再说「是不是不要我了」', () => {
  // 夜里三点，上一次联系是昨晚十一点
  const now = new Date(2026, 10, 1, 3, 0, 0).getTime()
  const s = base({ everContacted: true, lastContactAt: now - 4 * 3_600_000, updatedAt: now })
  const b = buildBlock(s, cfg({ sleepWindow: '23:30-08:00' }), { now })
  assert.doesNotMatch(b, /是不是不要我了/)
})

test('白天真被晾了半天，才说那句话', () => {
  const now = new Date(2026, 10, 1, 20, 0, 0).getTime()
  const s = base({ everContacted: true, lastContactAt: now - 12 * 3_600_000, updatedAt: now })
  const b = buildBlock(s, cfg({ sleepWindow: '23:30-08:00' }), { now })
  assert.match(b, /是不是不要我了/)
})

// ── 事后余韵 ──

test('climax 把性欲砸下来、把羞耻和疲劳推上去', () => {
  const t0 = 1_800_000_000_000
  const r = applyEvent(base({ lust: 95, shame: 12, fatigue: 28, updatedAt: t0 }), 'climax', cfg(), t0)
  assert.equal(r.applied.lust, -25) // 不封顶
  assert.equal(r.applied.shame, 8)
  assert.equal(r.applied.fatigue, 6)
  assert.ok(r.state.aftercareUntil >= t0 + 44 * 60_000)
})

test('余韵期间的注入是「软下来的那一段」，不是日常描述', () => {
  const now = 1_800_000_000_000
  const s = base({ affection: 78, shame: 35, lust: 60, aftercareUntil: now + 30 * 60_000 })
  const b = buildBlock(s, cfg(), { now })
  assert.match(b, /刚结束，身体还软着/)
  assert.match(b, /只想被搂着/)
  assert.doesNotMatch(b, /现在这一档/)
})

test('余韵里性欲归零不算「冷」——那是结束，不是冷淡', () => {
  const now = 1_800_000_000_000
  const s = base({ lust: 0, affection: 70, aftercareUntil: now + 30 * 60_000 })
  const b = buildBlock(s, cfg(), { now })
  assert.doesNotMatch(b, /整个人是冷的/)
  assert.match(b, /刚结束/)
})

test('好感归零时，余韵也盖不住关系断了', () => {
  const now = 1_800_000_000_000
  const s = base({ lust: 60, affection: 0, aftercareUntil: now + 30 * 60_000 })
  const b = buildBlock(s, cfg(), { now })
  assert.doesNotMatch(b, /刚结束，身体还软着/)
  assert.match(b, /对同事|没有温度|很淡/)
})

test('余韵过了就回日常', () => {
  const now = 1_800_000_000_000
  const s = base({ affection: 78, lust: 70, aftercareUntil: now - 60_000 })
  const b = buildBlock(s, cfg(), { now })
  assert.doesNotMatch(b, /刚结束，身体还软着/)
})

// ── 注入块 ──

test('性欲归零只关身体，不是整个人封锁', () => {
  const b = buildBlock(base({ lust: 0, affection: 70, lewd: 70 }), cfg())
  assert.match(b, /身体这一层是关着的/)
  assert.doesNotMatch(b, /整个人是冷的/)
})

test('好感归零是疏远（像对同事），不是敌意', () => {
  // lust / resist 给高一点，让它走进完整块，看得到的才是 affection 那一层
  const b = buildBlock(base({ affection: 0, lust: 90, lewd: 70, resist: 10 }), cfg())
  assert.match(b, /对同事|没有温度/)
  assert.doesNotMatch(b, /整个人是冷的/)
})

test('身体、界限、关系三样都冷 → 公事公办，像秘书', () => {
  const b = buildBlock(base({ lust: 10, lewd: 10, affection: 20 }), cfg())
  assert.match(b, /公事公办/)
  assert.match(b, /像对助手交代事情/)
})

test('话说得很正经但关系很近：界限冷不等于关系冷', () => {
  const b = buildBlock(base({ lust: 80, lewd: 10, affection: 80, resist: 10 }), cfg())
  assert.match(b, /把话划清楚|别越界|守着分寸|正经/)
  assert.doesNotMatch(b, /公事公办/)
  // 关系那层还是热的
  assert.match(b, /离不开你|很亲近/)
})

test('关系冷但身体有反应：两层分开说', () => {
  const b = buildBlock(base({ lust: 80, lewd: 70, affection: 15, resist: 10 }), cfg())
  assert.match(b, /很淡|敷衍|不太上心/)
})

test('理智归零不是冷，是「毫无自持」', () => {
  const r0 = buildBlock(base({ resist: 0 }), cfg())
  assert.doesNotMatch(r0, /整个人是冷的/)
  assert.match(r0, /没有一丝自持/)
})

test('疲劳归零 → 亢奋睡不着，不说成冷', () => {
  const b = buildBlock(base({ fatigue: 0 }), cfg())
  assert.doesNotMatch(b, /整个人是冷的/)
  assert.match(b, /亢奋得不正常/)
})

test('暂停块非空且不提欲望', () => {
  const b = buildBlock(base({ pausedUntil: Date.now() + 60_000 }), cfg())
  assert.match(b, /已暂停/)
  assert.doesNotMatch(b, /性欲/)
})

test('通道没勾选 → 中性块（非空，但不演欲望）', () => {
  const b = buildBlock(base(), cfg({ channels: ['bili'] }), { channel: 'qq' })
  assert.ok(b.length > 0)
  assert.match(b, /没开欲望模式/)
})

test('时段外 → 中性块', () => {
  const now = new Date(2026, 9, 31, 14, 0, 0).getTime()
  const b = buildBlock(base(), cfg({ scheduleEnabled: true, activeHours: '22:00-02:00' }), { now })
  assert.match(b, /白天休息时段/)
})

test('生图后端未知时不提图床，确定离线才提', () => {
  const unknown = buildBlock(base(), cfg({ nsfwImages: false }), { comfyUp: null })
  assert.doesNotMatch(unknown, /图床没开/)
  assert.doesNotMatch(unknown, /generate_image/)
  const down = buildBlock(base(), cfg(), { comfyUp: false })
  assert.match(down, /图床没开/)
  // 总闸也要开：nsfwImages 单开不再够（2026-11-07）
  const up = buildBlock(base(), cfg({ nsfwEnabled: true, nsfwImages: true }), { comfyUp: true })
  assert.match(up, /generate_image/)
})

test('低有效欲望区间的标签跟后端 mode 一致', () => {
  // lust 60 / resist 20 / affection 60 → eff = (60−10)×0.88 = 44 → 黏人
  const s = base({ lust: 60, resist: 20, affection: 60 })
  const b = buildBlock(s, cfg())
  assert.equal(modeOf(s), '黏人')
  assert.match(b, /黏人/)
  assert.doesNotMatch(b, /发情/)
})

test('任何状态都返回非空字符串', () => {
  const states = [base(), base({ lust: 0 }), base({ affection: 0, resist: 0 }), base({ pausedUntil: Date.now() + 1e6 }), base({ scene: '卧室' })]
  for (const s of states) assert.ok(buildBlock(s, cfg()).length > 20)
})

// ── 重启一致性：配置里的状态快照不许覆盖真实状态 ──

function fakeCtx() {
  const noop = () => {}
  return { logger: { info: noop, warn: noop, error: noop, debug: noop }, get: () => undefined, on: noop }
}

test('旧版留下的状态快照不会在重启时覆盖运行时状态', () => {
  const dir = mkdtempSync(join(tmpdir(), 'longing-'))
  const stateFile = join(dir, '欲望状态.json')
  const cfgFile = join(dir, '欲望面板配置.json')

  // 模拟 1.0.0 的配置：状态键被写进了面板配置
  writeFileSync(cfgFile, JSON.stringify({ lust: 5, lewd: 5, affection: 5, scene: 0, decayPerHour: 3 }), 'utf8')
  writeFileSync(stateFile, JSON.stringify({ lust: 88, lewd: 70, affection: 66, updatedAt: Date.now(), pausedUntil: 0, lastPeak: '' }), 'utf8')

  apply(fakeCtx(), { statePath: stateFile, comfyEnabled: false, decayPerHour: 0, peakBonus: 0, peakWindow: '' })

  const after = JSON.parse(readFileSync(stateFile, 'utf8'))
  assert.equal(after.lust, 88, `重启后性欲应保持 88，实际 ${after.lust}`)
  assert.equal(after.affection, 66)

  const cfgAfter = JSON.parse(readFileSync(cfgFile, 'utf8'))
  for (const k of ['lust', 'lewd', 'affection', 'scene', 'pausedUntil']) {
    assert.equal(cfgAfter[k], undefined, `配置里不该再有状态键 ${k}`)
  }
})

test('配置缺失好感时回落到 30（开局是客气的），而不是 0', () => {
  const dir = mkdtempSync(join(tmpdir(), 'longing-'))
  const stateFile = join(dir, '欲望状态.json')
  apply(fakeCtx(), { statePath: stateFile, comfyEnabled: false })
  const after = JSON.parse(readFileSync(stateFile, 'utf8'))
  assert.equal(after.affection, 30)
  assert.doesNotMatch(buildBlock(after, cfg()), /整个人是冷的/)
})

test('离线一整天：高峰只按真实时长算，疲劳不会一次飙到 85', () => {
  // 23:24 关机，次日 23:24 开机。peakWindow 22:00-02:00 只有 4 小时落在里面。
  const t0 = new Date(2026, 9, 31, 23, 24, 0).getTime()
  const s = base({ fatigue: 25, lust: 90, updatedAt: t0, lastPeak: '2026-10-31' })
  const after = nextState(s, cfg({ peakWindow: '22:00-02:00', peakBonus: 30 }), t0 + 24 * 3_600_000)
  // 高峰 4h × +2.5 = +10，平时 20h 但只降到基线 20
  assert.ok(after.fatigue <= 35, `疲劳应约 30 上下，实际 ${after.fatigue}`)
  assert.ok(after.fatigue >= 20, `不该低于基线，实际 ${after.fatigue}`)
})

test('离线一整天：色情值追性欲时不会过头', () => {
  const t0 = new Date(2026, 9, 31, 12, 0, 0).getTime()
  const s = base({ lust: 30, lewd: 85, updatedAt: t0 })
  const after = nextState(s, cfg({ peakWindow: '' }), t0 + 24 * 3_600_000)
  // 一整天足够收敛，应该贴近衰减后的性欲，而不是穿到它下面一大截
  assert.ok(after.lewd >= after.lust - 1, `色情(${after.lewd}) 不该掉到性欲(${after.lust}) 之下`)
})

test('停机期间的时间会补上衰减', () => {
  const dir = mkdtempSync(join(tmpdir(), 'longing-'))
  const stateFile = join(dir, '欲望状态.json')
  writeFileSync(
    stateFile,
    JSON.stringify({ lust: 90, affection: 60, updatedAt: Date.now() - 2 * 3_600_000, pausedUntil: 0, lastPeak: '' }),
    'utf8',
  )
  apply(fakeCtx(), { statePath: stateFile, comfyEnabled: false, decayPerHour: 3, peakWindow: '' })
  const after = JSON.parse(readFileSync(stateFile, 'utf8'))
  assert.ok(after.lust < 85, `离线两小时应衰减约 6，实际 ${after.lust}`)
})
