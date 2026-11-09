/**
 * 集成冒烟：走真实的 apply + 面板 HTTP 路由，验证「面板 → 状态文件 → 注入文件」闭环。
 * 每个用例自带临时 workspace，不碰真实状态。
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { apply } from '../src/index.js'
import { formatDay, pruneDiary, recentDiary } from '../src/diary.js'

function boot(over = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'longing-smoke-'))
  const files = {
    state: join(dir, '欲望状态.json'),
    cfg: join(dir, '欲望面板配置.json'),
    inject: join(dir, '欲望注入.txt'),
    token: join(dir, '面板令牌.txt'),
  }
  writeFileSync(
    files.state,
    JSON.stringify({ lust: 60, lewd: 40, affection: 55, updatedAt: Date.now(), pausedUntil: 0, lastPeak: '', scene: '' }),
    'utf8',
  )
  let handler = null
  const noop = () => {}
  const ctx = {
    logger: { info: noop, warn: noop, error: noop, debug: noop },
    get: (n) => (n === 'webServer' ? { register: ({ handler: h }) => { handler = h } } : n === 'tools' ? { register: noop } : undefined),
    on: noop,
  }
  apply(ctx, {
    statePath: files.state,
    comfyEnabled: false,
    scheduleEnabled: false,
    peakWindow: '',
    negBreakpoints: '45,40,35,25,10,5',
    couplingEnabled: true,
    couplingRate: 1,
    debugMode: true,
    ...over,
  })
  const token = readFileSync(files.token, 'utf8').trim()

  const req = (method, url, body, tok = token) => {
    const r = new EventEmitter()
    r.method = method
    r.url = url
    r.headers = { host: '127.0.0.1:52947', 'x-desire-token': tok }
    process.nextTick(() => {
      if (body !== undefined) r.emit('data', Buffer.from(JSON.stringify(body)))
      r.emit('end')
    })
    return r
  }
  const call = async (method, url, body, tok) => {
    const out = { code: 0, body: '' }
    const res = { writeHead: (c) => { out.code = c }, end: (d) => { out.body = d?.toString?.() ?? '' } }
    await handler(req(method, url, body, tok), res)
    let json = null
    try {
      json = JSON.parse(out.body)
    } catch {}
    return { code: out.code, json }
  }
  return { dir, files, call }
}

test('面板 → 状态文件 → 注入文件 闭环', async () => {
  const { files, call } = boot()

  // 鉴权
  assert.equal((await call('GET', '/dsh-longing/api/state')).code, 200)
  assert.equal((await call('GET', '/dsh-longing/api/state', undefined, 'wrong')).code, 401)

  // 写状态 → 文件和注入同步
  const st = await call('POST', '/dsh-longing/api/state', { lust: 71, scene: '浴室' })
  assert.equal(st.json.lust, 71)
  assert.ok(st.json.mode, 'state 响应要带 mode')
  assert.ok(st.json.caps && typeof st.json.caps.resist === 'number', 'state 响应要带每个维度的软上限')
  assert.equal(JSON.parse(readFileSync(files.state, 'utf8')).scene, '浴室')
  assert.match(readFileSync(files.inject, 'utf8'), /浴室/)

  // 配置接口不带状态键，但带行为参数
  const cfg = await call('GET', '/dsh-longing/api/config')
  assert.equal(cfg.json.lust, undefined)
  assert.equal(cfg.json.scene, undefined)
  assert.ok('negBreakpoints' in cfg.json)
  assert.ok('couplingRate' in cfg.json)

  // 往配置里塞状态键 → 被丢弃
  await call('POST', '/dsh-longing/api/config', { lust: 5, lewd: 5, channels: ['qq'], decayPerHour: 4, couplingRate: 0.5 })
  const cfgDisk = JSON.parse(readFileSync(files.cfg, 'utf8'))
  assert.equal(cfgDisk.lust, undefined)
  assert.equal(cfgDisk.decayPerHour, 4)
  assert.equal(cfgDisk.couplingRate, 0.5, '耦合倍率要能存')
})

test('暂停 / 恢复 会影响注入块', async () => {
  const { files, call } = boot()
  await call('POST', '/dsh-longing/api/pause', { minutes: 60 })
  assert.match(readFileSync(files.inject, 'utf8'), /已暂停/)
  const rs = await call('POST', '/dsh-longing/api/resume', {})
  assert.equal(rs.json.pausedUntil, 0)
  assert.doesNotMatch(readFileSync(files.inject, 'utf8'), /已暂停/)
})

test('通道没勾选 qq 时，老式主注入文件只给中性块', async () => {
  const { dir, files, call } = boot()
  await call('POST', '/dsh-longing/api/config', { channels: ['bili'] })
  assert.match(readFileSync(files.inject, 'utf8'), /没开欲望模式/)
  // bili 自己的那份仍然是完整块
  assert.doesNotMatch(readFileSync(join(dir, '欲望注入.bili.txt'), 'utf8'), /没开欲望模式/)
})

test('事件接口：一句坏话就改值，并写进注入块', async () => {
  const { files, call } = boot()
  const before = JSON.parse(readFileSync(files.state, 'utf8')).affection

  const r = await call('POST', '/dsh-longing/api/event', { name: 'blame' })
  assert.equal(r.json.ok, true, '事件应生效')
  assert.ok(r.json.applied.affection < 0, '凶一句好感应下降')

  const after = JSON.parse(readFileSync(files.state, 'utf8')).affection
  assert.ok(after < before, `好感应从 ${before} 降下来，实际 ${after}`)
  assert.match(readFileSync(files.inject, 'utf8'), /刚才的事还留在心里/)

  assert.equal((await call('POST', '/dsh-longing/api/event', { name: 'zzz' })).json.ok, false, '未知事件要拒绝')
})

test('暂停期间亲密事件不算，但坏话照记', async () => {
  const { files, call } = boot()
  await call('POST', '/dsh-longing/api/pause', { minutes: 60 })

  assert.equal((await call('POST', '/dsh-longing/api/event', { name: 'intimate' })).json.ok, false)
  const before = JSON.parse(readFileSync(files.state, 'utf8')).affection
  assert.equal((await call('POST', '/dsh-longing/api/event', { name: 'blame' })).json.ok, true)
  assert.ok(JSON.parse(readFileSync(files.state, 'utf8')).affection < before, '暂停也拦不住已经发生的坏话')
})

test('调试关着时改不了值，但事件照常记', async () => {
  const { files, call } = boot({ debugMode: false })

  const st = await call('POST', '/dsh-longing/api/state', { lust: 99 })
  assert.equal(st.code, 403, '没开调试就该拒绝直接改值')
  assert.notEqual(JSON.parse(readFileSync(files.state, 'utf8')).lust, 99)

  const pre = await call('POST', '/dsh-longing/api/preset', { name: 'yandere' })
  assert.ok(pre.json.error, '预设也要挡住')

  // 聊天里发生的事不受调试开关影响 —— 这才是养成的手段
  const ev = await call('POST', '/dsh-longing/api/event', { name: 'praise' })
  assert.equal(ev.json.ok, true)
})

test('心情日记：事件自动归类，内心想法能单独记', async () => {
  const { call } = boot()
  await call('POST', '/dsh-longing/api/event', { name: 'praise' })
  await call('POST', '/dsh-longing/api/event', { name: 'blame' })
  await call('POST', '/dsh-longing/api/diary', { text: '他今天回消息很快，我高兴得有点不像话' })

  const d = await call('GET', '/dsh-longing/api/diary?days=1')
  const day = d.json.days[0]
  assert.equal(day.up.length, 1, '夸奖要进「让我高兴的」')
  assert.equal(day.down.length, 1, '被凶要进「让我难受的」')
  assert.equal(day.thoughts.length, 1, '内心想法单独一栏')
  assert.match(d.json.text, /让我高兴的/)
})

test('调试关着时改不了值（工具侧）', async () => {
  const { call } = boot({ debugMode: false })
  const st = await call('GET', '/dsh-longing/api/state')
  assert.equal(st.json.debug, false)
})

test('暂停期间 __dshLongingNote 不涨，恢复后正常涨', async () => {
  const { files, call } = boot()
  await call('POST', '/dsh-longing/api/pause', { minutes: 60 })
  const before = JSON.parse(readFileSync(files.state, 'utf8')).lust
  globalThis.__dshLongingNote?.('owner')
  assert.equal(JSON.parse(readFileSync(files.state, 'utf8')).lust, before)

  await call('POST', '/dsh-longing/api/resume', {})
  globalThis.__dshLongingNote?.('owner')
  assert.ok(JSON.parse(readFileSync(files.state, 'utf8')).lust > before)
})

test('pruneDiary：超过保留天数就裁掉最旧的，留下的是最近的', () => {
  const days = {}
  for (let i = 0; i < 40; i += 1) {
    const d = new Date(2026, 9, 1 + i)
    days[`${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`] = { date: 'x', up: [], down: [], thoughts: [], mood: 50 }
  }
  const out = pruneDiary({ days }, 30)
  const kept = Object.keys(out.days)
  assert.equal(kept.length, 30)
  assert.equal(kept[kept.length - 1], '2026-11-9', '最新的一天（11-9）要留着')
  assert.ok(!out.days['2026-10-1'], '最旧的要被裁掉')
})

test('formatDay：空的一天也给出可读的一行，不崩', () => {
  const t = formatDay({ date: '2026-11-9', up: [], down: [], thoughts: [], mood: 50 })
  assert.ok(t.includes('2026-11-9'))
  assert.ok(t.length > 0)
})

test('recentDiary：跨个位数和十位数也按真实日期排，不按字符串', () => {
  // todayKey 不补零，字符串排序会把 11-2 排到 11-10 前面
  const days = {}
  for (let d = 1; d <= 12; d += 1) {
    days[`2026-11-${d}`] = { date: `2026-11-${d}`, up: [], down: [], thoughts: [], mood: 50 }
  }
  assert.equal(recentDiary({ days }, 1)[0].date, '2026-11-12', '"今天"必须是最大的那天')
  assert.deepEqual(
    recentDiary({ days }, 3).map((d) => d.date),
    ['2026-11-12', '2026-11-11', '2026-11-10'],
  )
})

test('formatDay：同一条被记了四次，显示成 ×4，不画四遍', () => {
  const day = {
    date: '2026-11-8',
    mood: 62,
    up: [{ t: 1, e: 'praise', note: '刚被夸过一句，心里还热着' }],
    down: [
      { t: 2, e: 'cold', note: '被冷了一下，热乎劲退了', n: 3 },
      { t: 3, e: 'apologize', note: '他道过歉，气消了一半', detail: '抱歉，洛洛' },
    ],
    thoughts: [],
  }
  const text = formatDay(day)
  assert.match(text, /被冷了一下，热乎劲退了 ×3/)
  assert.match(text, /抱歉，洛洛/, 'detail 优先于固定 note')
})
