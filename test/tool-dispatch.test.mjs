/**
 * 工具派发的集成测试 —— 专门抓「函数对但调不到」这类 bug。
 *
 * 为什么需要这份：`recall.test.mjs` 的 18 条全是对纯函数 `recall({...})` 的直接调用。
 * v1.15.0 的 A01 就是这么漏掉的 —— 函数本身没问题、测试全绿，
 * 但工具层的 enum 没登记、`execute()` 里没分支、参数表没声明，
 * 模型硬调也只会拿到一段七维摘要。
 *
 * 这里走的是真实路径：apply() → tools.register → execute(args)。
 *
 * **关键的一层是「源码里的分支」和「schema 里的 enum」双向对齐。**
 * 第一版测试漏了它：直接调 execute({action:'recall'}) 只证明「分支在」，
 * 证明不了「模型知道有这个 action」。把 recall 从 enum 里删掉，
 * 那个版本 8 条全绿 —— 因为它从来不读 enum 和分支的差集。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { apply } from '../src/index.js'

/** 兜底返回的特征：七个维度的数值摘要。任何落到这里的 action 都等于没派发。 */
const FALLBACK = /性欲 \d+ \/ 色情 \d+ \/ 占有 \d+/

function boot(over = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'longing-dispatch-'))
  const statePath = join(dir, '欲望状态.json')
  writeFileSync(
    statePath,
    JSON.stringify({
      lust: 40, lewd: 30, possess: 20, shame: 30, resist: 50, fatigue: 20, affection: 60,
      updatedAt: Date.now(), pausedUntil: 0, lastPeak: '', scene: '', everContacted: true,
      lastContactAt: Date.now(), events: [], grudges: [], firsts: {}, anchors: [],
    }),
    'utf8',
  )
  const tools = []
  const noop = () => {}
  const ctx = {
    logger: { info: noop, warn: noop, error: noop, debug: noop },
    get: (n) =>
      n === 'webServer' ? { register: () => {} }
        : n === 'tools' ? { register: (def) => tools.push(def) }
          : undefined,
    on: noop,
  }
  apply(ctx, {
    statePath,
    comfyEnabled: false,
    scheduleEnabled: false,
    peakWindow: '',
    debugMode: true,
    ownerOnly: false, // 测试里不模拟主人会话，直接放行
    ...over,
  })
  const tool = tools.find((t) => t.parameters)
  if (!tool) throw new Error('工具没注册上')
  return { tool, tools, dir, statePath }
}

/**
 * 从 index.js 源码里抠出工具 execute() 内的分支名。
 *
 * 第一版直接全文匹配 `action === 'x'`，把面板 API 的 `action === 'mark'`
 * 也抠进来了 —— 于是「正常状态」也报 mismatch。
 * 现在先切出 execute 的函数体再匹配，缩进也要求 10 空格（工具分支都在这一层）。
 */
function branchesInSource() {
  const src = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8')
  const start = src.indexOf('async execute(args, exec) {')
  if (start < 0) throw new Error('找不到 execute()')
  // execute 体到下一个同级 } 结束 —— 用「连续 8 空格 + }」近似
  const end = src.indexOf('\n        },', start)
  const body = end > start ? src.slice(start, end) : src.slice(start)
  const found = new Set()
  for (const m of body.matchAll(/action === '([a-zA-Z]+)'/g)) found.add(m[1])
  return found
}

// ── 1. enum ↔ 分支 双向对齐（这一条才是抓 A01 的）──

test('schema 的 enum 和源码里的分支必须一一对应', () => {
  const { tool } = boot()
  const enumActions = new Set(tool.parameters.properties.action.enum)
  const branchActions = branchesInSource()

  // ① 有分支但不在 enum → 模型不知道有这个 action（A01 就是这个）
  const missingInEnum = [...branchActions].filter((a) => !enumActions.has(a))
  assert.deepEqual(missingInEnum, [], `这些 action 有分支但不在 enum 里，模型调不到：${missingInEnum.join(', ')}`)

  // ② 在 enum 但没分支 → 模型调了会落到七维摘要
  const missingBranch = [...enumActions].filter((a) => !branchActions.has(a))
  assert.deepEqual(missingBranch, [], `这些 action 在 enum 里但 execute 没分支：${missingBranch.join(', ')}`)
})

test('enum 里每个 action 都有自己的返回，不落到七维摘要', async () => {
  const { tool } = boot()
  const actions = tool.parameters.properties.action.enum

  // 改值类本来就返回摘要（它们就是干这个的）
  const RETURNS_SUMMARY = new Set(['get', 'set', 'bump', 'preset', 'pause'])
  // 需要外部服务的跳过（reflect 要模型）
  const NEEDS_MODEL = new Set(['reflect'])

  for (const action of actions) {
    if (RETURNS_SUMMARY.has(action) || NEEDS_MODEL.has(action)) continue
    const r = await tool.execute({ action })
    assert.ok(r && typeof r.text === 'string', `${action} 没返回文本`)
    assert.doesNotMatch(r.text, FALLBACK, `action="${action}" 落到了兜底摘要 —— 说明 enum 里有它但 execute 里没分支`)
  }
})

// ── 2. recall 全链路 ──

test('recall：空日记时给出可读的空结果，不是摘要', async () => {
  const { tool } = boot()
  const r = await tool.execute({ action: 'recall', since: '3d' })
  assert.equal(r.ok, true)
  assert.doesNotMatch(r.text, FALLBACK)
  assert.match(r.text, /没有记下来的事/)
})

test('recall：记一件事之后能查回来，带原话', async () => {
  const { tool } = boot()
  const ev = await tool.execute({ action: 'event', name: 'blame', detail: '你真烦' })
  assert.equal(ev.ok, true)

  const r = await tool.execute({ action: 'recall', since: '1d' })
  assert.equal(r.ok, true)
  assert.doesNotMatch(r.text, FALLBACK)
  assert.match(r.text, /记下来的 \d+ 件事/)
  assert.match(r.text, /被他怪过/, '应该用过去式文案')
  assert.match(r.text, /你真烦/, '应该带上当时的原话')
})

test('recall：参数写错要报错，不能返回「没有事」', async () => {
  const { tool } = boot()
  const r = await tool.execute({ action: 'recall', since: '上周' })
  assert.equal(r.ok, false)
  assert.equal(r.error, 'bad-since')
  assert.match(r.text, /看不懂这个时间/)
})

test('recall：tone 只认 good/bad', async () => {
  const { tool } = boot()
  const r = await tool.execute({ action: 'recall', since: '3d', tone: 'positive' })
  assert.equal(r.ok, false)
  assert.equal(r.error, 'bad-tone')
})

test('recall：tone=bad 真的只给不好的', async () => {
  const { tool } = boot()
  await tool.execute({ action: 'event', name: 'blame', detail: '你真烦' })
  await tool.execute({ action: 'event', name: 'praise', detail: '你真乖' })

  const bad = await tool.execute({ action: 'recall', since: '1d', tone: 'bad' })
  assert.doesNotMatch(bad.text, /被他夸过/)
  const good = await tool.execute({ action: 'recall', since: '1d', tone: 'good' })
  assert.doesNotMatch(good.text, /被他怪过/)
})

// ── 3. 参数表要和分支对得上 ──

test('recall 的五个参数都在 schema 里', () => {
  const { tool } = boot()
  const props = tool.parameters.properties
  for (const k of ['since', 'tone', 'query', 'source', 'limit']) {
    assert.ok(props[k], `schema 缺参数 ${k} —— 模型传了也会被框架丢掉`)
  }
  assert.deepEqual(props.tone.enum, ['good', 'bad'])
  assert.deepEqual(props.source.enum, ['all', 'diary', 'anchor'])
})

// ── 4. 安全词 ──

test('安全词：stop 事件让插件进入暂停态', async () => {
  const { tool } = boot()
  const r = await tool.execute({ action: 'event', name: 'stop' })
  assert.equal(r.ok, true)
  const g = await tool.execute({ action: 'get' })
  assert.match(g.text, /已暂停/, 'stop 应该让插件暂停')
})
