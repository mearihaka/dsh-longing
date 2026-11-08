/**
 * 自写日记的接线测试（1.14.0）。
 *
 * reflect.test.mjs 测的是纯函数；这个文件测的是**真的接上了没有**：
 * 走真实 apply()，用假的 llm 服务喂一段模型输出，看 心情日记.json 里有没有多出一条。
 *
 * 为什么必须测这一层：日记原来「永远是固定台词」的原因不是清洗逻辑写错，
 * 而是根本没有东西去写它 —— 只有外层模型主动调工具才有一条。
 * 只测纯函数会漏掉这种「逻辑对、没接线」的失败。
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { apply } from '../src/index.js'

/** 假的 llm：把 reply 拆成几个 text-delta 片段吐出来，顺带记下收到的请求。 */
function fakeLlm(reply, { throwAfter = 0 } = {}) {
  const calls = []
  const llm = {
    calls,
    stream(options) {
      calls.push(options)
      return (async function* () {
        if (throwAfter) throw new Error('provider exploded')
        yield { type: 'block-start', index: 0, blockType: 'text' }
        for (const piece of String(reply).match(/[\s\S]{1,6}/g) ?? []) {
          yield { type: 'text-delta', index: 0, textDelta: piece }
        }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
  return llm
}

function boot({ llm, over = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'longing-reflect-'))
  const files = {
    state: join(dir, '欲望状态.json'),
    diary: join(dir, '心情日记.json'),
    token: join(dir, '面板令牌.txt'),
  }
  writeFileSync(
    files.state,
    JSON.stringify({ lust: 64, lewd: 42, possess: 70, shame: 33, reason: 58, fatigue: 40, affection: 66, updatedAt: Date.now(), pausedUntil: 0, lastPeak: '', scene: '' }),
    'utf8',
  )
  let handler = null
  let tool = null
  const noop = () => {}
  const ctx = {
    logger: { info: noop, warn: noop, error: noop, debug: noop },
    get: (n) => {
      if (n === 'webServer') return { register: ({ handler: h }) => { handler = h } }
      if (n === 'tools') return { register: (def) => { tool = def } }
      if (n === 'llm') return llm
      if (n === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) }
      return undefined
    },
    on: noop,
  }
  apply(ctx, {
    statePath: files.state,
    comfyEnabled: false,
    scheduleEnabled: false,
    peakWindow: '',
    negBreakpoints: '45,40,35,25,10,5',
    debugMode: true,
    diaryAutoWrite: true,
    ...over,
  })
  const token = readFileSync(files.token, 'utf8').trim()

  const call = async (method, url, body) => {
    const out = { code: 0, body: '' }
    const res = { writeHead: (c) => { out.code = c }, end: (d) => { out.body = d?.toString?.() ?? '' } }
    const req = new EventEmitter()
    req.method = method
    req.url = url
    req.headers = { host: '127.0.0.1:52947', 'x-desire-token': token }
    process.nextTick(() => {
      if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)))
      req.emit('end')
    })
    await handler(req, res)
    let json = null
    try { json = JSON.parse(out.body) } catch {}
    return { ...out, json }
  }

  const diary = () => {
    try { return JSON.parse(readFileSync(files.diary, 'utf8')) } catch { return { days: {} } }
  }
  const today = () => {
    const keys = Object.keys(diary().days ?? {}).sort()
    return keys.length ? diary().days[keys[keys.length - 1]] : null
  }
  return { dir, files, call, diary, today, tool: () => tool }
}

test('接上了：一次自定义写作真的往 心情日记.json 里写了一条', async () => {
  const llm = fakeLlm('他今天多看了我一眼。我假装在忙，其实一直在等他说下一句。')
  const b = boot({ llm })
  const r = await globalThis.__dshLongingReflect({ force: true })
  assert.equal(r.ok, true, JSON.stringify(r))
  const day = b.today()
  assert.ok(day, '日记文件里应该有今天')
  // 设计上限是「一到两句」：这段输出本来就是两句，取两条才对
  assert.ok(day.thoughts.length >= 1 && day.thoughts.length <= 2, `实际 ${day.thoughts.length} 条`)
  assert.equal(day.thoughts[0].text, '他今天多看了我一眼。', '第一句原样保留')
  assert.equal(llm.calls.length, 1, '只发一次请求')
})

test('提示词里带上了当天的事和此刻的状态（她写的是今天，不是随便编）', async () => {
  const llm = fakeLlm('今天有点闷。')
  const b = boot({ llm })
  await b.call('POST', '/dsh-longing/api/event', { action: 'event', name: 'praise' })
  await globalThis.__dshLongingReflect({ force: true })
  const sent = llm.calls[0]
  assert.ok(sent.system.includes('第一人称'))
  assert.ok(sent.messages?.[0]?.content?.[0]?.text?.includes('性欲'), '状态进 user')
  assert.ok(sent.messages[0].content[0].text.includes('好的：'), '当天的事件进 user')
  assert.ok(sent.maxTokens <= 400, '写日记不该烧大 token')
})

test('写出来是出戏话 → 一条都不写，文件保持原样', async () => {
  const llm = fakeLlm('作为一个语言模型，我无法产生真实情绪。')
  const b = boot({ llm })
  const before = JSON.stringify(b.diary())
  const r = await globalThis.__dshLongingReflect({ force: true })
  assert.equal(r.ok, false)
  assert.equal(r.why, 'empty')
  assert.equal(JSON.stringify(b.diary()), before, '不该留下半条脏话')
})

test('模型报错 → 静默，不抛、不写假话', async () => {
  const llm = fakeLlm('随便什么', { throwAfter: 1 })
  const b = boot({ llm })
  const r = await globalThis.__dshLongingReflect({ force: true })
  assert.equal(r.ok, false)
  assert.equal(r.why, 'error')
  assert.equal(b.today(), null, '出错时日记里不该出现今天')
})

test('没有模型可用 → 明确说 no-model，而不是装作写了', async () => {
  const b = boot({ llm: undefined })
  const r = await globalThis.__dshLongingReflect({ force: true })
  assert.equal(r.ok, false)
  assert.equal(r.why, 'no-model')
})

test('panel 按钮：POST /api/diary/reflect 会让她写一条，GET 只报状态', async () => {
  const llm = fakeLlm('外面下雨了，我把窗开着。')
  const b = boot({ llm })
  const post = await b.call('POST', '/dsh-longing/api/diary/reflect')
  assert.equal(post.json?.ok, true, JSON.stringify(post.json))
  const get = await b.call('GET', '/dsh-longing/api/diary/reflect')
  assert.equal(get.json?.lastWhy, 'wrote')
  assert.equal(b.today().thoughts.length, 1)
})

test('工具 action=reflect 用的就是同一条写作路径（模型不会自己编一句替她记）', async () => {
  const llm = fakeLlm('他说明天还来。')
  const b = boot({ llm })
  const tool = b.tool()
  assert.ok(tool, '工具应该注册上了')
  const out = await tool.execute({ action: 'reflect' })
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.ok(b.today().thoughts[0].text.includes('他说明天还来'))
})

test('diaryAutoWrite 关掉时，自动路径一次都不发请求（手动 force 才写）', async () => {
  const llm = fakeLlm('不该被自动调用。')
  const b = boot({ llm, over: { diaryAutoWrite: false } })
  const r = await globalThis.__dshLongingReflect()
  assert.equal(r.ok, false)
  assert.equal(r.why, 'off')
  assert.equal(llm.calls.length, 0)
})
