/**
 * 配置键闸门的一致性测试。
 *
 * 复审计 N4 抓到一个第三次复发的问题：A06 新加的 5 个键没进 ALLOWED_KEYS，
 * 于是面板 POST 回 200、值原地不动、还不报错。
 *
 * 前两次是 1.11.0 的 proactivePerHour / proactiveCooldownMin。
 * config.js 里那条注释自己都写了「ALLOWED_KEYS 会直接把面板提交的键丢掉，
 * 然后假装保存成功」—— 说明这个问题被记录过两次，还是又犯了。
 *
 * 根因是「两处清单手工维护」：schema 里声明一遍，ALLOWED_KEYS 里再抄一遍。
 * 光靠记性不行，得有断言。这里做两件事：
 *   ① 静态：schema 里每个 number/boolean/string 键都必须在对应的 KEY 表里
 *   ② 动态：真 POST 一遍，值必须真的变（不是只回 200）
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { apply } from '../src/index.js'

// 每个 boot() 起来的实例都挂着定时器（tick / comfy 探测）。
// 不 dispose 的话 node --test 跑完不退出 —— 上一版就是「全量测试卡住 25 秒以上」。
const opened = []

function boot(over = {}) {
  const home = mkdtempSync(join(tmpdir(), 'longing-keys-'))
  let handler = null
  const noop = () => {}
  const disposers = []
  const ctx = {
    logger: { info: noop, warn: noop, error: noop, debug: noop },
    get: (n) =>
      n === 'dshHomePath' ? (p) => join(home, String(p))
        : n === 'webServer' ? { register: ({ handler: h }) => { handler = h } }
          : n === 'tools' ? { register: () => {} }
            : undefined,
    on: (ev, cb) => { if (ev === 'dispose') disposers.push(cb) },
  }
  apply(ctx, { comfyEnabled: false, scheduleEnabled: false, peakWindow: '', factsFromLog: false, ...over })
  const token = readFileSync(join(home, 'dsh-longing', '面板令牌.txt'), 'utf8').trim()
  const call = async (method, url, body) => {
    const r = new EventEmitter()
    let status = 200
    let out = ''
    r.setHeader = noop
    r.writeHead = (code) => { status = code }
    r.end = (chunk) => { out += chunk ?? '' }
    const payload = body ? JSON.stringify(body) : ''
    const req = new EventEmitter()
    req.method = method
    req.url = url
    req.headers = { host: '127.0.0.1', 'x-desire-token': token, origin: 'http://127.0.0.1', 'content-type': 'application/json' }
    req.destroy = noop
    // index.js 的 body() 走 req.on('data') + req.on('end')，不是 asyncIterator。
    // 原来这里只给了 asyncIterator，body() 永远等不到 end —— 整个测试文件挂住不退出。
    const done = handler(req, r)
    setImmediate(() => {
      if (payload) req.emit('data', Buffer.from(payload))
      req.emit('end')
    })
    await done
    let json = null
    try { json = JSON.parse(out) } catch { /* 不是 JSON */ }
    return { status, json, raw: out }
  }
  const inst = {
    call,
    dispose: () => { for (const f of disposers) { try { f() } catch {} } },
  }
  opened.push(inst)
  return inst
}

// 所有 boot 实例在文件跑完后统一销毁，进程才退得掉
after(() => { for (const inst of opened) inst.dispose() })

// ── ① 静态：schema 的键 vs ALLOWED_KEYS ──

test('schema 里每个可写键都在 ALLOWED_KEYS 里（防第四次）', async () => {
  const src = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8')
  const cfgSrc = readFileSync(new URL('../src/config.js', import.meta.url), 'utf8')

  // 从 config.js 抓 schema 的全部键（含换行写法 `Schema\n  .number()`）
  const schemaKeys = [...cfgSrc.slice(cfgSrc.indexOf('export const ConfigSchema'))
    .matchAll(/^(\s+)(\w+):\s*Schema[.\n]/gm)].map((m) => m[2])

  // 状态初始键不进配置接口，也不算可写
  const STATE_INIT = new Set(['lust', 'lewd', 'possess', 'shame', 'resist', 'fatigue', 'affection', 'scene'])

  // 从 index.js 抓三张表
  const grab = (name) => {
    const m = src.match(new RegExp(`const ${name} = new Set\\(\\[([\\s\\S]*?)\\]\\)`))
    if (!m) return new Set()
    return new Set([...m[1].matchAll(/'([\w]+)'/g)].map((x) => x[1]))
  }
  const allowed = new Set([...grab('NUM_KEYS'), ...grab('BOOL_KEYS'), ...grab('STR_KEYS')])

  const missing = schemaKeys.filter((k) => !STATE_INIT.has(k) && !allowed.has(k))
  assert.deepEqual(
    missing, [],
    `这些键在 schema 里声明了但不在 ALLOWED_KEYS 里 —— 面板 POST 会回 200 而值不动：${missing.join(', ')}`,
  )
})

test('ALLOWED_KEYS 里没有 schema 已经删掉的死键', async () => {
  const src = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8')
  const cfgSrc = readFileSync(new URL('../src/config.js', import.meta.url), 'utf8')
  const schemaKeys = new Set([...cfgSrc.slice(cfgSrc.indexOf('export const ConfigSchema'))
    .matchAll(/^(\s+)(\w+):\s*Schema[.\n]/gm)].map((m) => m[2]))
  const grab = (name) => {
    const m = src.match(new RegExp(`const ${name} = new Set\\(\\[([\\s\\S]*?)\\]\\)`))
    return m ? [...m[1].matchAll(/'([\w]+)'/g)].map((x) => x[1]) : []
  }
  const dead = [...grab('NUM_KEYS'), ...grab('BOOL_KEYS'), ...grab('STR_KEYS')].filter((k) => !schemaKeys.has(k))
  assert.deepEqual(dead, [], `ALLOWED_KEYS 里有 schema 已不存在的键：${dead.join(', ')}`)
})

// ── ② 动态：新键真的能改 ──

test('A06 的 5 个新键：POST 之后能读回新值', async () => {
  const { call } = boot()
  const cases = [
    ['autoEventEnabled', false],
    ['anchorEnabled', false],
    ['anchorHalfLifeDays', 7],
    ['anchorMinStrength', 1.5],
    ['anchorMaxTotal', 20],
  ]
  for (const [k, v] of cases) {
    const save = await call('POST', '/dsh-longing/api/config', { [k]: v })
    assert.equal(save.status, 200, `${k} 保存应该回 200`)
    const after = await call('GET', '/dsh-longing/api/config')
    assert.equal(after.json[k], v, `${k} 保存了但读回来是 ${after.json[k]}（ALLOWED_KEYS 漏了它？）`)
  }
})

test('超出范围的 POST 要被拒（不是回 200 装没事）', async () => {
  const { call } = boot()
  // anchorHalfLifeDays: min 1 max 30
  for (const [k, v] of [['anchorHalfLifeDays', 0], ['anchorHalfLifeDays', 99], ['anchorMaxTotal', 41], ['anchorMinStrength', -5]]) {
    const r = await call('POST', '/dsh-longing/api/config', { [k]: v })
    assert.equal(r.status, 400, `${k}=${v} 超范围应该 400，实际 ${r.status}`)
  }
})

// ── ③ 安全词的默认值（复审计 N1）──

test('schema 的 pauseWord 默认值和 auto-event 的常量一致', () => {
  const cfgSrc = readFileSync(new URL('../src/config.js', import.meta.url), 'utf8')
  const evSrc = readFileSync(new URL('../src/auto-event.js', import.meta.url), 'utf8')
  const fromSchema = cfgSrc.match(/pauseWord: Schema\.string\(\)\.default\('([^']*)'\)/)?.[1]
  const fromModule = evSrc.match(/export const DEFAULT_PAUSE_WORD = '([^']*)'/)?.[1]
  assert.ok(fromSchema, 'config.js 里找不到 pauseWord 的 default')
  assert.ok(fromModule, 'auto-event.js 里找不到 DEFAULT_PAUSE_WORD')
  assert.equal(fromSchema, fromModule, '两处默认安全词必须一致，否则「说安全词没反应」')
})
