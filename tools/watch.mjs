/**
 * 面板监控：盯着 /api/state，值一变就打印一行。
 *
 *   node tools/watch.mjs [面板根地址] [轮询秒]
 *   node tools/watch.mjs http://127.0.0.1:57688/dsh-longing 5
 *
 * 令牌从状态目录的「面板令牌.txt」读，不写死在代码里。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const base = (process.argv[2] || 'http://127.0.0.1:57688/dsh-longing').replace(/\/+$/, '')
const every = Math.max(2, Number(process.argv[3]) || 5) * 1000
const tokenFile = process.argv[4] || '<path>/dsh-qq/workspace/面板令牌.txt'

let token = ''
try {
  token = readFileSync(tokenFile, 'utf8').trim()
} catch {
  console.error(`读不到令牌：${tokenFile}\n用法：node tools/watch.mjs <面板地址> <秒> <令牌文件>`)
  process.exit(1)
}

const ts = () => new Date().toLocaleTimeString('zh-CN', { hour12: false })
const r1 = (n) => Math.round(Number(n) * 10) / 10
const DIMS = ['lust', 'lewd', 'possess', 'shame', 'resist', 'fatigue', 'affection']
const SHORT = { lust: 'lust', lewd: 'lewd', possess: 'poss', shame: 'sham', resist: 'resi', fatigue: 'fati', affection: 'affe' }

let last = null
async function tick() {
  try {
    const res = await fetch(`${base}/api/state`, { headers: { 'x-desire-token': token } })
    if (!res.ok) {
      console.log(`${ts()}  HTTP ${res.status}（令牌不对？）`)
      return
    }
    const s = await res.json()
    const line = DIMS.map((k) => `${SHORT[k]}:${r1(s[k])}`).join(' ')
    const extra = [`${s.mode}`, `档${s.urge}`, s.debug ? '调试' : '', s.paused ? '暂停' : '', s.lonely ? '孤独' : '']
      .filter(Boolean)
      .join(' ')
    if (!last) {
      console.log(`${ts()}  ${line}  | ${extra}`)
      console.log(`${ts()}  上限: ${DIMS.map((k) => `${SHORT[k]}:${s.caps?.[k] ?? '-'}`).join(' ')}`)
    } else {
      const diff = DIMS.filter((k) => Math.abs(Number(s[k]) - Number(last[k])) >= 0.5)
      if (diff.length) {
        console.log(`${ts()}  ${line}  | ${extra}`)
        console.log(`            变化: ${diff.map((k) => `${SHORT[k]} ${r1(last[k])}→${r1(s[k])}`).join(', ')}`)
      }
    }
    last = s
  } catch (e) {
    console.log(`${ts()}  连不上：${e.message}`)
  }
}

console.log(`监控 ${base}，每 ${every / 1000}s 一次，Ctrl+C 退出`)
await tick()
setInterval(tick, every)
