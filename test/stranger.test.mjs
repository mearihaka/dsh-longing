/**
 * 「路人装一遍」回归测试。
 *
 * 这一组不是测功能，是测**换一台机器装上去会不会直接废掉**：
 * 没有 dsh-qq、没有作者那张配置、状态目录不是 cwd/workspace、主人会话没人登记。
 * 1.11 及以前的实现里，这几条随便中一条就会出现「功能在，但永远不生效」。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { apply } from '../src/index.js'
import { STATE_KEYS } from '../src/curve.js'
import { imageGate, proactiveGate } from '../src/proactive.js'

const noop = () => {}

/** 起一份「干净机器」：家目录是临时目录，没有任何通道插件。 */
function boot({ home = mkdtempSync(join(tmpdir(), 'longing-home-')), config = {}, ownerSessions = true } = {}) {
  mkdirSync(home, { recursive: true })
  const tools = []
  let handler = null
  const ctx = {
    logger: { info: noop, warn: noop, error: noop, debug: noop },
    // dshHomePath 在真实环境里是「函数，参数是插件名」，这里照那个形状给
    get: (n) =>
      n === 'dshHomePath'
        ? (pluginName) => join(home, String(pluginName))
        : n === 'webServer'
          ? { register: ({ handler: h }) => { handler = h } }
          : n === 'tools'
            ? { register: (def) => tools.push(def) }
            : undefined,
    on: noop,
  }
  // 每次 apply 都会重建这张表，测试里要能干净地模拟「没有通道登记主人」
  if (ownerSessions) {
    delete globalThis.__dshLongingOwnerSessions
    delete globalThis.__dshLongingOwnerRegistered
  }
  apply(ctx, { comfyEnabled: false, peakWindow: '', ...config })
  const dir = join(home, 'dsh-longing')
  const token = readFileSync(join(dir, '面板令牌.txt'), 'utf8').trim()
  const call = async (method, url, body, tok = token) => {
    const { EventEmitter } = await import('node:events')
    const r = new EventEmitter()
    r.method = method
    r.url = url
    r.headers = { host: '127.0.0.1:52947', 'x-desire-token': tok }
    process.nextTick(() => {
      if (body !== undefined) r.emit('data', Buffer.from(JSON.stringify(body)))
      r.emit('end')
    })
    const out = { code: 0, body: '', type: '' }
    const res = {
      writeHead: (c, h) => { out.code = c; out.type = h?.['content-type'] ?? '' },
      end: (d) => { out.body = d?.toString?.() ?? '' },
    }
    await handler(r, res)
    let json = null
    try {
      json = JSON.parse(out.body)
    } catch {}
    return { ...out, json }
  }
  return { home, dir, tools, call }
}

test('没配 statePath：状态落在 DSH 给插件家的目录，不是 cwd/workspace', async () => {
  const { dir, call } = boot()
  const st = await call('GET', '/dsh-longing/api/state')
  assert.equal(st.code, 200)
  // 四个落盘文件都在插件家目录里
  for (const f of ['欲望状态.json', '欲望面板配置.json', '欲望注入.txt', '面板令牌.txt']) {
    assert.doesNotThrow(() => readFileSync(join(dir, f)), `${f} 应该在 ${dir}`)
  }
})

// 面板上每一个控件，都必须真的能改。
// 原来只验「GET 里有这个键」—— 存在 ≠ 可写。proactivePerHour / proactiveCooldownMin
// 就是这样在 ALLOWED_KEYS 外面挂了两个版本：保存回 200、值原地不动、面板还提示「已保存」。
test('面板上每个配置控件 POST 之后都能读回同一个值', async () => {
  const { call } = boot()
  const before = await call('GET', '/dsh-longing/api/config')

  // 只取「面板上真有控件」且「配置里有」的键，两者缺一都不算可运营
  const html = readFileSync(new URL('../panel/index.html', import.meta.url), 'utf8')
  const panelIds = new Set([...html.matchAll(/<(?:input|textarea)[^>]*\bid="([a-zA-Z]\w*)"/g)].map((m) => m[1]))
  // 这几个故意不动：改状态目录会搬走全部文件，数组类走另一条路径
  const SKIP = new Set(['statePath', 'migrateFrom', 'channels', 'curioTopics', 'negBreakpoints'])
  const keys = Object.keys(before.json).filter(
    (k) => !k.startsWith('__') && panelIds.has(k) && !SKIP.has(k) && typeof before.json[k] !== 'object',
  )
  assert.ok(keys.length > 50, `应该覆盖几十个键，实际只取了 ${keys.length}`)

  // 2026-11-10（审计 F03）：配置 POST 现在走 schema —— 超出 min/max 会 400，
  // 所以这里按面板控件自己的 min/max 取一个合法值，而不是一律塞 7。
  const inputs = new Map()
  for (const m of html.matchAll(/<(?:input|textarea)([^>]*)>/g)) {
    const id = /\bid="([a-zA-Z]\w*)"/.exec(m[1])?.[1]
    if (!id) continue
    inputs.set(id, {
      min: Number(/\bmin="(-?[\d.]+)"/.exec(m[1])?.[1] ?? NaN),
      max: Number(/\bmax="(-?[\d.]+)"/.exec(m[1])?.[1] ?? NaN),
    })
  }
  const want = {}
  for (const k of keys) {
    const v = before.json[k]
    if (typeof v === 'boolean') {
      want[k] = !v
    } else if (typeof v === 'number') {
      const lim = inputs.get(k) ?? {}
      const lo = Number.isFinite(lim.min) ? lim.min : Math.min(v, 7)
      const hi = Number.isFinite(lim.max) ? lim.max : Math.max(v, 7)
      // 取一个落在区间内、且和当前值不同的整数
      const pick = v !== lo ? lo : Math.min(hi, lo + 1)
      want[k] = pick
    } else {
      want[k] = 'audit-value'
    }
  }
  const saved = await call('POST', '/dsh-longing/api/config', want)
  assert.equal(saved.code, 200)

  const after = await call('GET', '/dsh-longing/api/config')
  const bad = keys.filter((k) => JSON.stringify(after.json[k]) !== JSON.stringify(want[k]))
  assert.deepEqual(bad, [], `这些键保存后没变（面板在骗人）：${bad.join(', ')}`)
})

// 这一段专门守「保存设置却回 500」那类假警：状态码要断言，不能只看写没写进去。
test('保存设置回 200，且改动真的生效（新键 curioEnabled / nsfwEnabled 也能存）', async () => {
  const { dir, call } = boot()
  const before = await call('GET', '/dsh-longing/api/config')
  assert.equal(before.json.curioEnabled, false, '默认必须是不联网')
  assert.equal(before.json.nsfwEnabled, false, '默认必须是成人内容关')

  const save = await call('POST', '/dsh-longing/api/config', { curioEnabled: true, curioPerDay: 3, nsfwEnabled: true })
  assert.equal(save.code, 200, `保存设置应回 200，实际 ${save.code}`)

  const after = await call('GET', '/dsh-longing/api/config')
  assert.equal(after.json.curioEnabled, true)
  assert.equal(after.json.curioPerDay, 3)
  assert.equal(after.json.nsfwEnabled, true)

  const onDisk = JSON.parse(readFileSync(join(dir, '欲望面板配置.json'), 'utf8'))
  assert.equal(onDisk.curioEnabled, true, '改过的键要落盘给只读文件的通道插件看')
  assert.ok(Array.isArray(onDisk.__panelKeys) && onDisk.__panelKeys.includes('curioEnabled'))
})

test('老安装的 cwd/workspace 里有状态 → 自动搬一次，不丢进度', async () => {
  const cwd0 = process.cwd()
  const legacyCwd = mkdtempSync(join(tmpdir(), 'longing-legacy-'))
  mkdirSync(join(legacyCwd, 'workspace'), { recursive: true })
  writeFileSync(
    join(legacyCwd, 'workspace', '欲望状态.json'),
    JSON.stringify({ lust: 77, lewd: 66, affection: 55, updatedAt: Date.now(), everContacted: true }),
    'utf8',
  )
  try {
    process.chdir(legacyCwd)
    const { dir, call } = boot()
    const st = await call('GET', '/dsh-longing/api/state')
    assert.equal(Math.round(st.json.lust), 77, '老状态要搬过来')
    assert.equal(JSON.parse(readFileSync(join(dir, '欲望状态.json'), 'utf8')).lust, 77)
  } finally {
    process.chdir(cwd0)
  }
})

test('没有任何通道登记主人时，ownerOnly 默认 true 也不会把工具锁死', async () => {
  const { tools } = boot({ config: { debugMode: true } })
  const main = tools.find((t) => t.name === 'longing')
  assert.ok(main, '默认工具名应该是 longing（不是 qq_longing）')
  const r = await main.execute({ action: 'bump', lust: 3 }, { agent: { session: { header: { id: 'sess-1' } } } })
  assert.equal(r.ok, true, `应该放行，实际：${r.text}`)
})

test('通道登记过主人之后，非主人的会话改不了值', async () => {
  const { tools } = boot({ config: { debugMode: true } })
  globalThis.__dshLongingOwnerSession('owner-sess', 60_000)
  const main = tools.find((t) => t.name === 'longing')
  const denied = await main.execute({ action: 'set', lust: 90 }, { agent: { session: { header: { id: 'other' } } } })
  assert.equal(denied.ok, false, '非主人要拒绝')
  const allowed = await main.execute({ action: 'set', lust: 90 }, { agent: { session: { header: { id: 'owner-sess' } } } })
  assert.equal(allowed.ok, true, `主人要能用，实际：${allowed.text}`)
  globalThis.__dshLongingOwnerSessions?.clear()
})

test('勾了 qq 通道时旧工具名 qq_longing 还注册着（dsh-qq 的提示词不用改）', async () => {
  const { tools } = boot({ config: { channels: ['qq'] } })
  assert.deepEqual(tools.map((t) => t.name).sort(), ['longing', 'qq_longing'])
})

test('DSH 设置页改的配置不会被上次启动写下的快照盖住', async () => {
  const home = mkdtempSync(join(tmpdir(), 'longing-home-'))
  boot({ home, config: { decayPerHour: 3 } })
  const { call } = boot({ home, config: { decayPerHour: 9 } })
  const cfg = await call('GET', '/dsh-longing/api/config')
  assert.equal(cfg.json.decayPerHour, 9, '设置页的值要生效（以前会被快照永久盖住）')

  // 面板改过的键要留下面板的意图，重启后仍然优先
  await call('POST', '/dsh-longing/api/config', { decayPerHour: 5 })
  const again = boot({ home, config: { decayPerHour: 9 } })
  const cfg2 = await again.call('GET', '/dsh-longing/api/config')
  assert.equal(cfg2.json.decayPerHour, 5, '面板改过的键重启后仍按面板走')
})

test('面板 HTML：占位符都被替换，没填名字也不残留作者的角色名', async () => {
  const { call } = boot()
  const page = await call('GET', '/dsh-longing')
  assert.equal(page.code, 200)
  assert.doesNotMatch(page.body, /__TOKEN_FILE__/)
  assert.doesNotMatch(page.body, /__PERSONA__/)
  // 没填 personaName 时标题就是「欲望面板」，不掺任何作者自己的角色名
  assert.match(page.body, /<h1>欲望面板<\/h1>/)
})

test('填了 personaName 就用在面板标题上', async () => {
  const { call } = boot({ config: { personaName: '小满' } })
  const page = await call('GET', '/dsh-longing')
  assert.match(page.body, /小满 · 欲望面板/)
})

test('主动发图跟着 autoInitiate 走：没开就一张都不发', () => {
  const base = { everContacted: true, lust: 80, lewd: 70, affection: 70 }
  assert.equal(imageGate({ cfg: { autoInitiate: false }, state: base }).reason, 'autooff')
  const okGate = imageGate({ cfg: { autoInitiate: true, enabled: true }, state: base })
  assert.equal(okGate.allowed, true, `分数 ${okGate.score}/${okGate.threshold}`)
  // 一次都没聊过就不发自拍
  assert.equal(imageGate({ cfg: { autoInitiate: true }, state: { ...base, everContacted: false } }).reason, 'never')
})

test('每小时上限真的读配置（1.11 里这个键根本提交不进去）', () => {
  const now = Date.now()
  const state = { everContacted: true, lust: 70, lastContactAt: now - 60 * 60_000, proactiveLog: [now - 10 * 60_000, now - 5 * 60_000] }
  const gate = proactiveGate({ cfg: { autoInitiate: true, proactivePerHour: 2, cooldownMin: 1 }, state, now })
  assert.equal(gate.reason, 'hourly')
  assert.ok(gate.nextAt > now)
  // proactiveCooldownMin = 0 不能变成「只隔 1 分钟」
  const gate2 = proactiveGate({ cfg: { autoInitiate: true, proactiveCooldownMin: 0, cooldownMin: 30, initiateThreshold: 0 }, state: { ...state, proactiveLog: [now - 5 * 60_000] }, now })
  assert.equal(gate2.reason, 'cooldown', 'proactiveCooldownMin=0 应该回落到 cooldownMin')
})

test('账本键不进面板配置（漏登记会导致重启时被旧快照反向覆盖）', async () => {
  for (const k of ['proactiveLog', 'lastInitiateAt', 'imageLog', 'lastImageInfo']) {
    assert.ok(STATE_KEYS.includes(k), `${k} 应该在 STATE_KEYS 里`)
  }
  const { call } = boot()
  await call('POST', '/dsh-longing/api/config', { proactiveLog: [1, 2, 3], imageLog: [4] })
  const cfg = await call('GET', '/dsh-longing/api/config')
  assert.equal(cfg.json.proactiveLog, undefined)
  assert.equal(cfg.json.imageLog, undefined)
})

// 下面三条是「干净环境验收」跑出来的：面板能开、但保存设置永远报失败，只有真装一遍才看得见。

test('保存设置要回 200，不能写成功却报失败', async () => {
  const { call } = boot()
  const r = await call('POST', '/dsh-longing/api/config', { personaName: '小满' })
  assert.equal(r.code, 200, `保存设置回了 ${r.code}`)
  assert.equal(r.json?.personaName, '小满')
})

test('首启就落下 心情日记.json（面板那张卡默认它在）', () => {
  const { dir } = boot()
  assert.ok(existsSync(join(dir, '心情日记.json')), '首次启动就该有心情日记.json')
})

test('调用方只给几个键，也要得到全部默认值', async () => {
  const { call } = boot() // boot 只传了 comfyEnabled / peakWindow
  const cfg = await call('GET', '/dsh-longing/api/config')
  const keys = Object.keys(cfg.json ?? {}).filter((k) => !k.startsWith('__'))
  // schema 共 103 项（1.13.0 加 7 个 curio*，11-07 加 nsfwEnabled，11-08 加 10 个 diary*，
  // 11-09 加 ownerRef），其中 8 项是「七维 + scene 的初始值」，属状态、API 不返回 → 95
  assert.equal(keys.length, 95, `实际 ${keys.length} 项`)
  assert.ok('personaName' in cfg.json && 'proactivePerHour' in cfg.json)
  assert.ok(!('lust' in cfg.json) && !('scene' in cfg.json), '状态键不该出现在配置接口里')
})

// 1.12 删掉 ownerIds 之后：旧版本写下的整份面板快照还带着它（没有 __panelKeys 标记），
// 而 flushPanelFile 每次启动都会把 panelOverrides 写回文件 —— 不过滤就永远复活、面板上清不掉。
test('旧面板文件里的死键不再复活', async () => {
  const home = mkdtempSync(join(tmpdir(), 'longing-legacy-'))
  const first = boot({ home })
  assert.ok(existsSync(join(first.dir, '欲望面板配置.json')))
  const cfgFile = join(first.dir, '欲望面板配置.json')
  // 1.11 时代的形状：无 __panelKeys，带已删除的 ownerIds
  writeFileSync(cfgFile, JSON.stringify({ ownerIds: [12345], autoInitiate: true, quietHours: '01:00-06:00' }))
  const { call } = boot({ home })
  const cfg = await call('GET', '/dsh-longing/api/config')
  assert.equal(cfg.json.ownerIds, undefined, '死键还出现在配置接口里')
  const onDisk = JSON.parse(readFileSync(cfgFile, 'utf8'))
  assert.equal(onDisk.ownerIds, undefined, '死键被写回文件了')
  assert.equal(onDisk.autoInitiate, true, '面板真改过的键要保留')
  assert.equal(onDisk.quietHours, '01:00-06:00')
  assert.ok(Array.isArray(onDisk.__panelKeys) && onDisk.__panelKeys.includes('autoInitiate'))
})
