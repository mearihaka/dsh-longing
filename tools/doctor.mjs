/**
 * 体检：一条命令看完 dsh-longing + dsh-qq 补丁 + 运行态。
 *
 *   node tools/doctor.mjs
 *   node tools/doctor.mjs --panel http://127.0.0.1:60839/dsh-longing
 *
 * 只读，不改任何东西。装完插件、重启完、觉得哪里不对的时候先跑这个。
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const WS = '<path>/dsh-qq/workspace'
const QQ = 'C:/Users/user/.dsh/profiles/desktop/node_modules/dsh-qq-onebot/src'
const SELF = '<path>/dsh-longing/src'

const panelArg = process.argv.indexOf('--panel')
const PANEL = panelArg > 0 ? process.argv[panelArg + 1] : ''
const TOKEN_FILE = join(WS, '面板令牌.txt')

const rows = []
const ok = (name, detail = '') => rows.push({ name, pass: true, detail })
const bad = (name, detail = '') => rows.push({ name, pass: false, detail })

const read = (p) => {
  try {
    return readFileSync(p, 'utf8')
  } catch {
    return ''
  }
}
const exists = (p) => existsSync(p)

// ── 1. dsh-longing 本体 ──
for (const f of ['index.js', 'prompt.js', 'curve.js', 'events.js', 'diary.js', 'unlock.js', 'config.js']) {
  if (exists(join(SELF, f))) ok(`longing/src/${f}`)
  else bad(`longing/src/${f}`, '缺文件')
}

// ── 2. dsh-qq 补丁 ──
const inbound = read(join(QQ, 'inbound.js'))
const outbound = read(join(QQ, 'outbound.js'))
const indexJs = read(join(QQ, 'index.js'))
const promptsJs = read(join(QQ, 'prompts.js'))

const patches = [
  ['qq: 主人私聊登记 + 涨值', inbound.includes('__dshLongingNote')],
  ['qq: 事件判定', inbound.includes('__dshLongingEvent')],
  ['qq: 读欲望注入.txt', inbound.includes('欲望注入')],
  ['qq: 拆条不把 … 当边界', !outbound.includes('[。！？!?…')],
  ['qq: 整段发送前剪尾', outbound.includes('trimFillerTail')],
  ['qq: qq_send 直发也剪尾', indexJs.includes('trimFillerTail')],
  ['qq: 私聊框架句改过', promptsJs.includes('只写你自己要回的那一句')],
  ['qq: 禁止「嗯…」收尾', promptsJs.includes('不要在结尾加「嗯…」')],
  ['qq: desire-events 存在', exists(join(QQ, 'desire-events.js'))],
  ['qq: shared/trim.js 存在', exists(join(QQ, 'shared', 'trim.js'))],
]
for (const [name, pass] of patches) pass ? ok(name) : bad(name, '补丁丢了，见 patches/dsh-qq/README.md')

// ── 3. 注入文件新鲜度 ──
const injectPath = join(WS, '欲望注入.txt')
if (exists(injectPath)) {
  const age = Math.round((Date.now() - statSync(injectPath).mtimeMs) / 1000)
  const body = read(injectPath)
  const lines = body.split('\n').length
  if (age <= 600) ok('注入文件新鲜', `${age}s 前更新，${lines} 行`)
  else bad('注入文件过期', `${age}s 没更新（dsh-qq 只认 600s 内）`)
  if (body.includes('[底层状态') || body.includes('[欲望状态')) ok('注入块格式', '首行标记正常')
  else bad('注入块格式', '不认识的格式')
} else {
  bad('注入文件', '不存在')
}

// ── 4. 状态文件 ──
const statePath = join(WS, '欲望状态.json')
if (exists(statePath)) {
  try {
    const s = JSON.parse(read(statePath))
    const dims = ['lust', 'lewd', 'possess', 'shame', 'resist', 'fatigue', 'affection']
    const missing = dims.filter((k) => typeof s[k] !== 'number')
    if (missing.length === 0) ok('状态七维齐全', dims.map((k) => `${k.slice(0, 4)}${Math.round(s[k])}`).join(' '))
    else bad('状态七维', `缺 ${missing.join(',')}`)
    ok('上次联系', s.everContacted ? new Date(s.lastContactAt).toLocaleString('zh-CN', { hour12: false }) : '还没联系过（补丁刚装/刚重启时正常）')
    if (String(s.scene ?? '') === '' || !/^\d+$/.test(String(s.scene))) ok('场景值', JSON.stringify(s.scene))
    else bad('场景值', `脏值 ${JSON.stringify(s.scene)}`)
    if (Number(s.pausedUntil ?? 0) < Date.now()) ok('暂停态', '未暂停')
    else ok('暂停态', `暂停到 ${new Date(s.pausedUntil).toLocaleString('zh-CN', { hour12: false })}`)
  } catch (e) {
    bad('状态文件解析', e.message)
  }
} else {
  bad('状态文件', '不存在')
}

// ── 5. 面板 API（可选）──
if (PANEL) {
  let token = ''
  try {
    token = read(TOKEN_FILE).trim()
  } catch {}
  if (!token) bad('面板令牌', '读不到 面板令牌.txt')
  else {
    try {
      const r = await fetch(`${PANEL.replace(/\/+$/, '')}/api/state`, { headers: { 'x-desire-token': token } })
      if (r.ok) {
        const j = await r.json()
        ok('面板 /api/state', `${j.mode}｜档${j.urge}｜解锁 ${(j.unlocked || []).length} 项｜debug ${j.debug}`)
      } else bad('面板 /api/state', `HTTP ${r.status}`)
    } catch (e) {
      bad('面板 /api/state', e.message)
    }
  }
}

// ── 6. ComfyUI（可选）──
try {
  const r = await fetch('http://127.0.0.1:8188/system_stats', { signal: AbortSignal.timeout(3000) })
  r.ok ? ok('ComfyUI', '在线') : bad('ComfyUI', `HTTP ${r.status}`)
} catch {
  bad('ComfyUI', '连不上（不影响聊天）')
}

// ── 输出 ──
const fails = rows.filter((r) => !r.pass)
for (const r of rows) console.log(`${r.pass ? '✓' : '✗'} ${r.name.padEnd(26)} ${r.detail}`)
console.log('')
console.log(fails.length === 0 ? `全部通过（${rows.length} 项）` : `${fails.length} 项没过 / 共 ${rows.length} 项`)
if (fails.length) process.exitCode = 1
