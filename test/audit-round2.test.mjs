/**
 * 复审计第二轮的回归测试。
 *
 * 这一个文件守的是「修 A 的时候把 B 弄坏了」—— 上一版 209 条全绿，
 * 但安全词默认值、leave 的两个核心模式、面板改新键这三件事同时是坏的。
 * 共同点：新写的分支有测试，旧的行为没人守。
 *
 * 覆盖：
 *   N1 安全词默认值（schema / 常量 / 函数默认参数三处一致，且真的能触发）
 *   N2 否定门不能拦 leave 自己的强模式
 *   N3 「我要走了，等下再回你」不是分手
 *   N5 日期键按数值比大小（跨 9/10、跨年），回拨不发峰值加成
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { DEFAULT_PAUSE_WORD, detectAndRefine, detectEvent, isSafetyWord } from '../src/auto-event.js'
import { keyNum, nextState, parseWindow } from '../src/curve.js'

const schemaSrc = readFileSync(new URL('../src/config.js', import.meta.url), 'utf8')
const schemaPauseWord = schemaSrc.match(/pauseWord: Schema\.string\(\)\.default\('([^']*)'\)/)?.[1]

// ── N1：「说停没反应」那个洞 ──

test('N1：schema 的默认安全词是「停」，且真的能触发 stop', () => {
  assert.equal(schemaPauseWord, '停', 'config.js 里的 pauseWord default 必须是「停」')
  assert.equal(DEFAULT_PAUSE_WORD, '停', 'auto-event.js 的常量必须是同一个词')
  assert.equal(detectEvent('停', schemaPauseWord), 'stop', '拿 schema 默认值直接喂，必须认成安全词')
  assert.equal(detectAndRefine('停', schemaPauseWord), 'stop')
  assert.equal(detectEvent('停'), 'stop', '函数默认参数不传时也必须是同一个词')
})

test('N1：安全词被清空时回退到「停」，不是静默失效', () => {
  assert.equal(isSafetyWord('停', ''), true)
  assert.equal(isSafetyWord('停', '   '), true)
  assert.equal(detectEvent('停', ''), 'stop')
  assert.equal(detectEvent('停', undefined), 'stop')
})

test('A04：安全词只认「词 + 语气词/一下」，不带正文', () => {
  assert.equal(detectEvent('停', '停'), 'stop')
  assert.equal(detectEvent('停一下', '停'), 'stop')
  assert.equal(detectEvent('停吧', '停'), 'stop')
  assert.equal(detectEvent('停下来想想', '停'), null, '这是正常句子，不该暂停半小时')
  assert.equal(detectEvent('停一会儿', '停'), null)
  assert.equal(detectEvent('停，我们聊点别的', '停'), null)
})

// ── N2：否定门不能把真阳性一起拦掉 ──

test('N2：「不要你了」「别来找我」仍是 leave', () => {
  for (const t of ['不要你了', '别来找我', '我们分手吧', '滚吧', '我不想再见到你，滚吧']) {
    assert.equal(detectAndRefine(t, '停'), 'leave', `「${t}」是关系级重击，必须记`)
  }
})

test('N2：否定与假设仍然拦得住', () => {
  for (const t of [
    '谁要跟你分手啊，别说这个',
    '如果哪天我们分手了会怎样',
    '我不喜欢你',
    '我不想分手',
    '别提分手这种话',
  ]) {
    assert.equal(detectAndRefine(t, '停'), null, `「${t}」不该记事件`)
  }
})

// ── N3：暂别语不是分手 ──

test('N3：场合性的「我走了」不算 leave', () => {
  for (const t of ['我走了哦，明天见', '那我走了', '我要走了，等下再回你', '我先走了，晚点聊', '我要走了，去吃饭']) {
    assert.equal(detectAndRefine(t, '停'), null, `「${t}」是告别，不该记仇五天`)
  }
  assert.equal(detectAndRefine('我要走了', '停'), 'leave', '没有上下文的「我要走了」仍按关系级处理')
})

// ── N5：日期键的比较 ──

test('N5：日期键按数值比大小，不按字符串', () => {
  assert.ok(keyNum('2026-11-10') > keyNum('2026-11-9'), '10 号必须大于 9 号（字符串比会反过来）')
  assert.ok(keyNum('2026-10-2') < keyNum('2026-10-19'))
  assert.ok(keyNum('2027-1-1') > keyNum('2026-12-31'))
  assert.equal(keyNum(''), 0)
  assert.equal(keyNum(undefined), 0)
  assert.equal(keyNum('乱七八糟'), 0)
})

test('N5：时钟回拨不再发峰值加成，正常跨天仍然发', () => {
  const cfg = { peakWindow: '22:00-02:00', peakBonus: 25, decayPerHour: 3, nightDecayPerHour: 6 }
  const win = parseWindow(cfg.peakWindow)
  const inWin = (d) => {
    const m = d.getHours() * 60 + d.getMinutes()
    return win.start <= win.end ? m >= win.start && m < win.end : m >= win.start || m < win.end
  }
  // 与时区无关地找「峰内」时刻
  let peakAt = null
  const base = new Date(2026, 10, 10, 12, 0, 0).getTime()
  for (let i = 0; i < 48 * 60 && peakAt === null; i += 15) {
    const t = base + i * 60_000
    if (inWin(new Date(t))) peakAt = t
  }
  assert.ok(peakAt !== null, '找不到峰内时刻')

  const st = {
    lust: 55, lewd: 35, possess: 40, shame: 40, resist: 50, fatigue: 20, affection: 30,
    lastPeak: '', tickedAt: peakAt - 1800e3, updatedAt: peakAt - 1800e3,
  }
  const first = nextState(st, cfg, peakAt)
  assert.ok(first.lust > 70, `峰内首次应该吃到 +25，实际 ${first.lust}`)
  assert.ok(first.lastPeak, 'lastPeak 应该被写上')

  const rollback = nextState(first, cfg, peakAt - 24 * 3600e3)
  assert.equal(rollback.lastPeak, first.lastPeak, '时钟回拨不该改写 lastPeak（更不该再发一次 +25）')

  const forward = nextState(first, cfg, peakAt + 24 * 3600e3)
  assert.notEqual(forward.lastPeak, first.lastPeak, '正常跨天应该记下新的 key')
})
