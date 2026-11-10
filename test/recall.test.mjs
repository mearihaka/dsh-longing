// recall 纯函数的测试。固定 now 和时间标签，不随运行时间变化。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { recall, parseSince, timeLabel } from '../src/recall.js'

const TZ = 'Asia/Shanghai'
// 2026-11-10 07:44 +08:00
const NOW = new Date('2026-11-10T07:44:00+08:00').getTime()
const H = 3_600_000
const D = 86_400_000

/** 造一份结构化日记。day 用 '2026-11-9' 这种不补零的键（和 diary.js 的 todayKey 一致）。 */
function makeDiary(days) {
  const out = { days: {}, updatedAt: NOW }
  for (const [key, { up = [], down = [] }] of Object.entries(days)) {
    out.days[key] = { date: key, up, down, events: [], thoughts: [], updatedAt: NOW }
  }
  return out
}

const EV = {
  praise: { tone: 'good', note: '刚被夸过一句，心里还热着', dims: { affection: 1 } },
  cold: { tone: 'bad', note: '被冷了一下，热乎劲退了', dims: { affection: -1, lust: -1.5 } },
  leave: { tone: 'bad', note: '他刚说了要走，胸口空了一块', dims: { affection: -3, resist: -2 } },
  gift: { tone: 'good', note: '收了他的东西，有点拿人手短', dims: { affection: 1, possess: 0.5 } },
  stop: { tone: '', note: '刚说过停', dims: { resist: 20, lust: -30 } },
}

test('parseSince 认出 小时/天/周/分钟', () => {
  assert.equal(parseSince('3h', NOW), 3 * H)
  assert.equal(parseSince('2d', NOW), 2 * D)
  assert.equal(parseSince('1w', NOW), 7 * D)
  assert.equal(parseSince('30m', NOW), 30 * 60_000, 'm 是分钟，不是月')
  assert.equal(parseSince('', NOW), 3 * D, '不填默认 3 天')
})

test('parseSince 拒绝看不懂的输入，不静默兜底', () => {
  for (const bad of ['7', '上周', '7天', 'abc', '-3d', '0d', '999999d']) {
    assert.equal(parseSince(bad, NOW), null, `${bad} 应该被拒绝`)
  }
})

test('since 看不懂时报错，而不是返回"没有事"', () => {
  const r = recall({ diary: makeDiary({}), params: { since: '7' }, now: NOW, events: EV })
  assert.equal(r.ok, false)
  assert.equal(r.error, 'bad-since')
  assert.match(r.text, /看不懂这个时间/)
  assert.doesNotMatch(r.text, /没有记下来的事/, '不能回答成"没有事"')
})

test('timeLabel 按日历日算，不按 24 小时', () => {
  // 07:44 回看 36 小时前 = 前天 19:44，不是"1 天前 19:44"
  assert.equal(timeLabel(NOW - 36 * H, NOW), '前天 19:44')
  // 凌晨回看昨晚的 23:00，要写"昨天"
  const early = new Date('2026-11-10T01:00:00+08:00').getTime()
  assert.equal(timeLabel(new Date('2026-11-09T23:00:00+08:00').getTime(), early), '昨天 23:00')
  // 当天
  assert.equal(timeLabel(NOW - 30 * 60_000, NOW), '今天 07:14')
})

test('从结构化日记取事件，不合并同名', () => {
  const diary = makeDiary({
    '2026-11-9': {
      down: [
        { t: NOW - 3 * D + 1 * H, e: 'cold', note: '被冷了一下' },
        { t: NOW - 2 * D + 2 * H, e: 'cold', note: '被冷了一下' },
        { t: NOW - 1 * D + 3 * H, e: 'cold', note: '被冷了一下' },
      ],
    },
  })
  const r = recall({ diary, anchors: [], params: { since: '3d' }, now: NOW, events: EV })
  assert.equal(r.count, 3, '三次被冷落应该是三条，不是一条')
  assert.equal((r.text.match(/被他冷过/g) ?? []).length, 3)
})

test('tone 过滤同时作用于来源', () => {
  const diary = makeDiary({
    '2026-11-9': {
      up: [{ t: NOW - 2 * H, e: 'praise', note: '' }],
      down: [{ t: NOW - 3 * H, e: 'cold', note: '' }],
    },
  })
  const good = recall({ diary, params: { since: '1d', tone: 'good' }, now: NOW, events: EV })
  assert.equal(good.count, 1)
  assert.match(good.text, /被他夸过/)
  assert.doesNotMatch(good.text, /被他冷过/)

  const bad = recall({ diary, params: { since: '1d', tone: 'bad' }, now: NOW, events: EV })
  assert.equal(bad.count, 1)
  assert.match(bad.text, /被他冷过/)
})

test('tone 填非法值直接报错，不假装过滤', () => {
  const r = recall({ diary: makeDiary({}), params: { since: '1d', tone: 'positive' }, now: NOW, events: EV })
  assert.equal(r.ok, false)
  assert.equal(r.error, 'bad-tone')
  assert.match(r.text, /good 或 bad/)
})

test('source=diary 时不输出锚点段', () => {
  const diary = makeDiary({ '2026-11-9': { down: [{ t: NOW - H, e: 'cold', note: '' }] } })
  const anchors = [{ name: 'leave', tone: 'bad', at: NOW - H, strength: 6 }]
  const r = recall({ diary, anchors, params: { since: '3d', source: 'diary' }, now: NOW, events: EV })
  assert.match(r.text, /被他冷过/)
  assert.doesNotMatch(r.text, /还压在心上/, 'source=diary 不该出现锚点段')
})

test('source=anchor 时不列事件，只列还压着的', () => {
  const diary = makeDiary({ '2026-11-9': { down: [{ t: NOW - H, e: 'cold', note: '' }] } })
  const anchors = [{ name: 'leave', tone: 'bad', at: NOW - H, strength: 6 }]
  const r = recall({ diary, anchors, params: { since: '3d', source: 'anchor' }, now: NOW, events: EV })
  assert.match(r.text, /还压在心上/)
  assert.match(r.text, /他说过要走/)
  assert.doesNotMatch(r.text, /被他冷过/, 'source=anchor 不该列事件')
})

test('回想用过去式文案，不是"刚被夸过"', () => {
  const diary = makeDiary({ '2026-11-5': { up: [{ t: NOW - 5 * D, e: 'praise', note: '' }] } })
  const r = recall({ diary, params: { since: '7d' }, now: NOW, events: EV })
  assert.match(r.text, /被他夸过/, '应该用过去式')
  assert.doesNotMatch(r.text, /刚被夸过/, '不能出现"刚"')
})

test('gift（强度 0.75）在结构化日记里照样查得到', () => {
  const diary = makeDiary({ '2026-11-9': { up: [{ t: NOW - 2 * H, e: 'gift', note: '' }] } })
  const r = recall({ diary, params: { since: '1d' }, now: NOW, events: EV })
  assert.equal(r.count, 1, '锚点门槛 0.8 会漏掉它，日记不会')
  assert.match(r.text, /收过他的东西/)
})

test('同样的原话出现多次时保留次数', () => {
  const diary = makeDiary({ '2026-11-9': { up: [{ t: NOW - H, e: 'praise', note: '', n: 3 }] } })
  const r = recall({ diary, params: { since: '1d' }, now: NOW, events: EV })
  assert.match(r.text, /×3/)
})

test('query 同时比对回想文案和原话', () => {
  const diary = makeDiary({
    '2026-11-9': {
      down: [
        { t: NOW - H, e: 'leave', note: '', detail: '我明天要走了' },
        { t: NOW - 2 * H, e: 'cold', note: '', detail: '别烦我' },
      ],
    },
  })
  const byText = recall({ diary, params: { since: '1d', query: '走' }, now: NOW, events: EV })
  assert.equal(byText.count, 1, '命中"他说过要走"')
  const byDetail = recall({ diary, params: { since: '1d', query: '明天' }, now: NOW, events: EV })
  assert.equal(byDetail.count, 1, '命中原话')
})

test('单字 query 不静默返回空', () => {
  const diary = makeDiary({ '2026-11-9': { down: [{ t: NOW - H, e: 'cold', note: '', detail: '烦' }] } })
  const r = recall({ diary, params: { since: '1d', query: '烦' }, now: NOW, events: EV })
  assert.equal(r.count, 1)
})

test('没有结果时提示带上实际参数', () => {
  const r = recall({ diary: makeDiary({}), params: { since: '2d', tone: 'bad', query: '哭' }, now: NOW, events: EV })
  assert.equal(r.ok, true)
  assert.equal(r.count, 0)
  assert.match(r.text, /2d/)
  assert.match(r.text, /只看不好的/)
  assert.match(r.text, /关键词「哭」/)
})

test('空 diary / 脏 diary 不炸', () => {
  for (const d of [null, undefined, {}, { days: null }, { days: {} }, { days: { x: null } }]) {
    const r = recall({ diary: d, params: { since: '1d' }, now: NOW, events: EV })
    assert.equal(r.ok, true)
  }
})

test('未来时间的事件不列入', () => {
  const diary = makeDiary({ '2026-11-10': { up: [{ t: NOW + 10 * D, e: 'praise', note: '' }] } })
  const r = recall({ diary, params: { since: '3d' }, now: NOW, events: EV })
  assert.equal(r.count, 0)
})

test('limit 生效且有上限', () => {
  const up = Array.from({ length: 30 }, (_, k) => ({ t: NOW - (k + 1) * 60_000, e: 'praise', note: '' }))
  const diary = makeDiary({ '2026-11-10': { up } })
  const r3 = recall({ diary, params: { since: '1d', limit: 3 }, now: NOW, events: EV })
  assert.equal((r3.text.match(/被他夸过/g) ?? []).length, 3)
  const r99 = recall({ diary, params: { since: '1d', limit: 99 }, now: NOW, events: EV })
  assert.ok((r99.text.match(/被他夸过/g) ?? []).length <= 20, 'limit 上限 20')
})
