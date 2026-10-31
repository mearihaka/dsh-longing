/**
 * 命令行预览：用真实状态文件 + 真实面板配置跑一遍 buildBlock。
 * 面板上「现在到底注入了什么」全靠猜的日子到此为止。
 *
 *   node tools/preview.mjs [workspace目录] [通道] [comfy:on|off|unknown]
 *
 * 只读，不写任何文件。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildBlock } from '../src/prompt.js'

const ws = process.argv[2] || '<path>/dsh-qq/workspace'
const read = (f, d) => {
  try {
    return JSON.parse(readFileSync(join(ws, f), 'utf8'))
  } catch {
    return d
  }
}

const state = read('欲望状态.json', null)
if (!state) {
  console.error(`读不到 ${join(ws, '欲望状态.json')}`)
  process.exit(1)
}
const cfg = read('欲望面板配置.json', {})
const channel = process.argv[3] || (Array.isArray(cfg.channels) ? cfg.channels[0] : 'qq')
const flag = String(process.argv[4] || 'unknown')
const comfyUp = flag === 'on' ? true : flag === 'off' ? false : null

console.error(`# workspace=${ws} channel=${channel} comfy=${flag} pausedUntil=${state.pausedUntil}`)
console.log(buildBlock(state, cfg, { channel, comfyUp }))
