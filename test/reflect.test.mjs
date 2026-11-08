/**
 * reflect.js（自写心情日记，1.14.0）的单元测试。
 *
 * 为什么补：这一版把「写日记」从「外层模型主动调工具」改成「插件自己问模型」，
 * 变成了会花钱、会写进用户文件的路径。三条边界必须钉死：
 *   一、不该写的时候一条都不写（关着 / 额度满 / 间隔没到 / 今天什么都没发生）
 *   二、写出来的东西必须干净（引号、markdown、旁白、出戏词）
 *   三、提示词里只有她已知的东西（当天事件、状态、写过的话），不塞对话原文
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  REFLECT_DEFAULTS,
  buildReflectPrompt,
  cleanThought,
  describeDims,
  extractThoughts,
  recentThoughtTexts,
  shouldReflect,
} from '../src/reflect.js'

const MIN = 60_000

// 与 curve.js 的 todayKey 同口径：不补零（2026-11-8 不是 2026-11-08）
const todayKeyOf = (now) => {
  const d = new Date(now)
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

const dayWith = (now, { up = 0, down = 0, thoughts = [] } = {}) => ({
  days: {
    [todayKeyOf(now)]: {
      date: todayKeyOf(now),
      up: Array.from({ length: up }, (_, i) => ({ t: now, e: 'praise', note: `好事 ${i}` })),
      down: Array.from({ length: down }, (_, i) => ({ t: now, e: 'reject', note: `坏事 ${i}` })),
      thoughts: thoughts.map((t) => ({ t, text: '写过的话' })),
      mood: 60,
      updatedAt: now,
    },
  },
})

// ── 一、该不该写 ──
test('shouldReflect：没显式打开就是关（新装用户不该莫名其妙花 token）', () => {
  const now = Date.now()
  assert.equal(shouldReflect({ diary: dayWith(now, { up: 5 }), cfg: { diaryAutoWrite: false }, now }).why, 'off')
  assert.equal(shouldReflect({ diary: dayWith(now, { up: 5 }), cfg: {}, now }).ok, true, '默认是开着的')
})

test('shouldReflect：额度用完就不再写', () => {
  const now = Date.now()
  const diary = dayWith(now, { up: 5, thoughts: [now - 300 * MIN, now - 200 * MIN, now - 150 * MIN] })
  assert.equal(shouldReflect({ diary, cfg: { diaryAutoWrite: true, diaryPerDay: 3 }, now }).why, 'quota')
})

test('shouldReflect：刚写过就等间隔', () => {
  const now = Date.now()
  const diary = dayWith(now, { up: 5, thoughts: [now - 10 * MIN] })
  assert.equal(shouldReflect({ diary, cfg: { diaryAutoWrite: true, diaryMinGapMin: 150 }, now }).why, 'gap')
})

test('shouldReflect：事够多就写', () => {
  const now = Date.now()
  const diary = dayWith(now, { up: 2, down: 1 })
  const r = shouldReflect({ diary, cfg: { diaryAutoWrite: true, diaryMinEvents: 2 }, now })
  assert.equal(r.ok, true)
  assert.equal(r.why, 'due')
})

test('shouldReflect：今天什么都没发生、也没联系过 —— 不写', () => {
  const now = Date.now()
  assert.equal(shouldReflect({ diary: { days: {} }, state: { lastContactAt: 0 }, cfg: { diaryAutoWrite: true }, now }).why, 'quiet')
})

test('shouldReflect：什么都还没写，但今天联系过 —— 让人看得到第一篇', () => {
  const now = Date.now()
  const r = shouldReflect({ diary: { days: {} }, state: { lastContactAt: now - 5 * MIN }, cfg: { diaryAutoWrite: true }, now })
  assert.equal(r.ok, true)
})

test('shouldReflect：写过之后，少量新事也值得续一句', () => {
  const now = Date.now()
  const diary = dayWith(now, { up: 0, thoughts: [now - 200 * MIN] })
  const r = shouldReflect({ diary, cfg: { diaryAutoWrite: true, diaryMinEvents: 5 }, now })
  assert.equal(r.ok, true)
})

// ── 二、清洗 ──
test('cleanThought：引号、项目符号、markdown 都去掉', () => {
  assert.equal(cleanThought('「今天他叫我名字的时候，我耳朵热了一下。」'), '今天他叫我名字的时候，我耳朵热了一下。')
  assert.equal(cleanThought('- *  今天他叫我名字，我耳朵热了一下。'), '今天他叫我名字，我耳朵热了一下。')
  assert.equal(cleanThought('```\n今天很开心\n```'), '今天很开心')
})

test('cleanThought：括号旁白整段丢掉', () => {
  assert.equal(cleanThought('（她低头看了看手机）他没回我。'), '他没回我。')
})

test('cleanThought：出戏的词命中就整条不要', () => {
  for (const bad of [
    '作为一个 AI，我没有真实情绪。',
    '用户今天说了三句话。',
    '系统提示让我这样回答。',
    '我的 prompt 里写了要保持角色。',
  ]) {
    assert.equal(cleanThought(bad), '', `应该丢掉：${bad}`)
  }
})

test('cleanThought：超长在句末断开，不硬切在词中间', () => {
  const long = '第一句话写得挺长的。第二句话也写得挺长的。第三句话同样长。'
  const out = cleanThought(long, 22)
  assert.ok(out.length <= 22, `没截断：${out}`)
  assert.ok(out.endsWith('。'), `没在句末断开：${out}`)
})

test('cleanThought：只有标点 / 空白算空', () => {
  assert.equal(cleanThought('。。。'), '')
  assert.equal(cleanThought('   '), '')
  assert.equal(cleanThought(null), '')
})

// ── 三、取句 ──
test('extractThoughts：一句话就是一条', () => {
  assert.deepEqual(extractThoughts('今天他多看了我一眼。'), ['今天他多看了我一眼。'])
})

test('extractThoughts：多句按句号切，最多两条', () => {
  const out = extractThoughts('今天他多看了我一眼。我假装在忙。其实一直在等他说下一句。')
  assert.equal(out.length, 2)
  assert.equal(out[0], '今天他多看了我一眼。')
})

test('extractThoughts：重复的不要、太短的不要', () => {
  assert.deepEqual(extractThoughts('嗯。今天他多看了我一眼。今天他多看了我一眼。'), ['今天他多看了我一眼。'])
})

test('extractThoughts：全是脏话就返回空数组（宁可不写）', () => {
  assert.deepEqual(extractThoughts('作为一个语言模型，我无法产生情绪。'), [])
})

// ── 四、提示词 ──
test('buildReflectPrompt：当天的事、状态、写过的话都在里面', () => {
  const now = Date.now()
  const day = dayWith(now, { up: 1, down: 1 }).days[todayKeyOf(now)]
  const { system, user } = buildReflectPrompt({
    day,
    dims: { lust: 61.4, lewd: 40, possess: 71, shame: 33, reason: 58, fatigue: 44, affection: 66 },
    previous: ['我在等他那句晚安。'],
    persona: '洛洛',
    now,
  })
  assert.ok(system.includes('第一人称'))
  assert.ok(system.includes('洛洛'), '人设在 system 里')
  assert.ok(user.includes('好的：好事 0'))
  assert.ok(user.includes('难受的：坏事 0'))
  assert.ok(user.includes('性欲 61'), '状态进提示词')
  assert.ok(user.includes('我在等他那句晚安。'), '之前写过的话要带上，避免重复')
  assert.ok(user.includes('不要报数字'), '要求它别把数字写进日记')
})

test('buildReflectPrompt：没事件时也给她一个落点，不留空节', () => {
  const { user } = buildReflectPrompt({ day: { date: '2026-11-08', up: [], down: [], thoughts: [] }, dims: {}, now: Date.now() })
  assert.ok(user.includes('今天没发生什么具体的事'))
  assert.ok(!user.includes('之前已经写过'))
})

test('describeDims：一行七维，数值取整', () => {
  assert.equal(
    describeDims({ lust: 61.4, lewd: 40, possess: 71, shame: 33, reason: 58, fatigue: 44, affection: 66 }),
    '性欲 61 / 色情 40 / 占有 71 / 羞耻 33 / 理智 58 / 疲劳 44 / 好感 66',
  )
})

test('recentThoughtTexts：只取最后几条，空的不算', () => {
  const day = { thoughts: [{ text: 'a' }, { text: '' }, { text: 'b' }, { text: 'c' }] }
  assert.deepEqual(recentThoughtTexts(day, 2), ['b', 'c'])
})

test('REFLECT_DEFAULTS：默认开着但不放肆（一天 3 条、间隔 150 分钟）', () => {
  assert.equal(REFLECT_DEFAULTS.diaryAutoWrite, true)
  assert.equal(REFLECT_DEFAULTS.diaryPerDay, 3)
  assert.equal(REFLECT_DEFAULTS.diaryMinGapMin, 150)
  assert.ok(REFLECT_DEFAULTS.diaryMaxTokens <= 400, '写日记不该烧大 token')
})
