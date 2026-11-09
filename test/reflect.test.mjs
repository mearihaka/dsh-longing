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

const dayWith = (now, { up = 0, down = 0, thoughts = [], eventAt = now } = {}) => ({
  days: {
    [todayKeyOf(now)]: {
      date: todayKeyOf(now),
      up: Array.from({ length: up }, (_, i) => ({ t: eventAt, e: 'praise', note: `好事 ${i}` })),
      down: Array.from({ length: down }, (_, i) => ({ t: eventAt, e: 'reject', note: `坏事 ${i}` })),
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

test('shouldReflect：写过之后，有新的好事就续一句；没有新事就不硬凑', () => {
  const now = Date.now()
  // 事件发生在最后一条日记之后 → 值得续
  const withNew = dayWith(now, { up: 1, thoughts: [now - 200 * MIN] })
  assert.equal(shouldReflect({ diary: withNew, cfg: { diaryAutoWrite: true }, now }).ok, true)
  // 只有旧事件（t 早于最后一条日记）→ 不硬凑
  const stale = dayWith(now, { up: 1, thoughts: [now - 30 * MIN], eventAt: now - 300 * MIN })
  assert.equal(shouldReflect({ diary: stale, cfg: { diaryAutoWrite: true }, now }).ok, false)
})

// ── 二、清洗 ──
test('cleanThought：引号、项目符号、markdown 都去掉', () => {
  assert.equal(cleanThought('「今天他叫我名字的时候，我耳朵热了一下。」'), '今天他叫我名字的时候，我耳朵热了一下。')
  assert.equal(cleanThought('- *  今天他叫我名字，我耳朵热了一下。'), '今天他叫我名字，我耳朵热了一下。')
  assert.equal(cleanThought('```\n今天很开心\n```'), '今天很开心')
})

test('cleanThought：括号旁白也留着（只清格式，不审查内容）', () => {
  // 2026-11-9 重构：不再删旁白。她写什么就是什么，格式以外的判断一律不做。
  assert.match(cleanThought('（把被子往上拉了拉）今天有点冷'), /今天有点冷/)
})

test('cleanThought：出戏的词不再整条丢弃（守卫已撤）', () => {
  const s = cleanThought('作为一个 AI，我其实没有情绪。')
  assert.ok(s.length > 0, '不再因为这几个词丢整句')
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

test('extractThoughts：多句按句号切，默认最多三条', () => {
  const out = extractThoughts('今天他多看了我一眼。我假装在忙。其实一直在等他说下一句。')
  assert.equal(out.length, 3)
  assert.equal(out[0], '今天他多看了我一眼。')
  assert.equal(extractThoughts('今天他多看了我一眼。我假装在忙。', { maxCount: 1 }).length, 1)
})

test('extractThoughts：重复和短句都保留（不再挑三拣四）', () => {
  const out = extractThoughts('想他。想他。嗯。')
  assert.deepEqual(out, ['想他。', '想他。', '嗯。'])
})

test('extractThoughts：气话照样留下（那是她的心情，不是脏数据）', () => {
  const out = extractThoughts('烦死了，不想理他。')
  assert.equal(out.length, 1)
  assert.match(out[0], /烦死了/)
})

test('extractThoughts：半句话也留（宁可短，也不要空）', () => {
  assert.deepEqual(extractThoughts('今天他多看了我一眼。他凶我那几句还卡在'), [
    '今天他多看了我一眼。',
    '他凶我那几句还卡在',
  ])
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
  assert.ok(user.includes('今天发生的事：一条都没有'))
  assert.ok(!user.includes('之前已经写过'))
})

test('describeDims：一行七维，数值取整', () => {
  assert.equal(
    describeDims({ lust: 61.4, lewd: 40, possess: 71, shame: 33, resist: 58, fatigue: 44, affection: 66 }),
    '性欲 61 / 色情 40 / 占有 71 / 羞耻 33 / 理智 58 / 疲劳 44 / 好感 66',
  )
})

test('extractThoughts：没有句号也照样留下', () => {
  const line = '今天他凶了我，我心里一直堵着'
  assert.deepEqual(extractThoughts(line), [line])
})

test('extractThoughts：对不上今天事实的句子进不来（不许捏造）', () => {
  const facts = ['刚被夸过一句，心里还热着', '抱歉，洛洛']
  // ① 标了编号 → 有依据（编号会被剥掉）
  assert.deepEqual(extractThoughts('他夸我那句还在心里热着。[1]', { facts }), ['他夸我那句还在心里热着。'])
  // ② 没标编号，但和事实有实词重合（抱歉/洛洛）→ 也算有依据
  assert.deepEqual(extractThoughts('他跟我道了抱歉，我才慢慢缓过来。', { facts }), ['他跟我道了抱歉，我才慢慢缓过来。'])
  // ③ 凭空多出来的物件 → 进不来
  assert.deepEqual(extractThoughts('他袖口那颗扣子松了，我看了好几秒。', { facts }), [])
  // 清单为空时只允许写感受
  assert.equal(extractThoughts('今天心里空空的。', { facts: [] }).length, 1)
})

test('recentThoughtTexts：只取最后几条，空的不算', () => {
  const day = { thoughts: [{ text: 'a' }, { text: '' }, { text: 'b' }, { text: 'c' }] }
  assert.deepEqual(recentThoughtTexts(day, 2), ['b', 'c'])
})

test('REFLECT_DEFAULTS：默认开着，只做节流不做审查', () => {
  assert.equal(REFLECT_DEFAULTS.diaryAutoWrite, true)
  assert.equal(REFLECT_DEFAULTS.diaryPerDay, 6, '一天最多 6 条（防心跳烧 token）')
  assert.equal(REFLECT_DEFAULTS.diaryMinGapMin, 60, '两条之间至少 60 分钟')
  assert.ok(REFLECT_DEFAULTS.diaryMaxChars >= 120, '能写下两句像样的话')
})
