#!/usr/bin/env node
/**
 * 公开面体检：在提交/发布前确认「会被公开的那些文件」里没有不该有的东西。
 *
 * 为什么要它：这个仓库有两套版本，作者本地还有一份 patches/ 镜像和一份个人开发日志。
 * 手滑一次 `git add -f` 或一次打包，就会把本机路径、个人称呼、密钥一起推上去。
 *
 * 用法：
 *   node tools/check-public.mjs              # 检查 git 跟踪的文件（= 推上去就是公开的）
 *   node tools/check-public.mjs --all        # 连工作区未跟踪文件一起看（打包前用）
 *   node tools/check-public.mjs --extra <file>   # 追加本地私有规则，一行一个正则
 *
 * 退出码：0 干净，1 有命中。
 *
 * 注意：脚本本身是公开的，所以这里**只放通用规则**（密钥形状、绝对路径、常见凭据键），
 * 个人称呼、本机用户名这类规则写在 --extra 指向的本地文件里，不进仓库。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = process.cwd()
const args = process.argv.slice(2)
const all = args.includes('--all')
const extraIdx = args.indexOf('--extra')
const extraFile = extraIdx >= 0 ? args[extraIdx + 1] : null

/**
 * 通用规则：任何公开仓库都不该出现。
 * 前缀一律用字符串拼，别在这份文件里写出完整的密钥格式 —— 否则它自己会被别的扫描器盯上。
 */
const P = (...parts) => parts.join('')
const RULES = [
  ['密钥形态（最长那种前缀）', new RegExp(P('s', 'k-[A-Za-z0-9_-]{16,}'))],
  ['密钥形态（带后缀的那族）', new RegExp(P('s', 'k-ant-[A-Za-z0-9_-]{16,}'))],
  ['密钥形态（云厂商 Google）', new RegExp(P('A', 'Iza[0-9A-Za-z_-]{30,}'))],
  ['密钥形态（代码托管短前缀）', new RegExp(P('g', 'h[opsu]_[A-Za-z0-9]{20,}'))],
  ['密钥形态（代码托管细粒度）', new RegExp(P('github', '_pat_[A-Za-z0-9_]{20,}'))],
  ['密钥形态（某家 x 开头）', new RegExp(P('x', 'ai-[A-Za-z0-9]{16,}'))],
  ['密钥形态（某家 g 开头）', new RegExp(P('g', 'sk_[A-Za-z0-9]{20,}'))],
  ['Bearer 长串', /Bearer\s+[A-Za-z0-9._-]{20,}/],
  ['凭据赋值（带引号的真值）', new RegExp(P('(?:\\baccessToken|\\bapiKey|\\bapi_key|\\bsecret|\\bpassword|\\badmin', 'Password)\\s*[:=]\\s*[\'"]{1}[^\'"]{8,}[\'"]{1}'), 'i')],
  ['凭据赋值（不带引号的长串）', new RegExp(P('(?:\\baccessToken|\\bapiKey|\\bapi_key|\\bsecret|\\badmin', 'Password)\\s*[:=]\\s*[A-Za-z0-9_-]{20,}\\b'), 'i')],
  ['Windows 绝对用户路径', /[A-Za-z]:[\\/]{1,2}Users[\\/]{1,2}[A-Za-z0-9_.-]+/],
  ['DSH 凭据文件名', new RegExp(P('cred', 'entials\\.ya?ml'), 'i')],
]

const SKIP_DIR = new Set(['.git', 'node_modules'])

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIR.has(name)) continue
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

function trackedFiles() {
  try {
    const raw = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
    return raw.split('\0').filter(Boolean).map((f) => join(ROOT, f))
  } catch {
    return []
  }
}

const textFiles = (all ? walk(ROOT) : trackedFiles()).filter((f) => !/\.(jpg|jpeg|png|gif|webp|zip|bundle|woff2?)$/i.test(f))
const imageFiles = (all ? walk(ROOT) : trackedFiles()).filter((f) => /\.(jpe?g|png|webp)$/i.test(f))
const rules = [...RULES]
if (extraFile && existsSync(extraFile)) {
  const lines = readFileSync(extraFile, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#'))
  for (const l of lines) {
    try {
      rules.push([`本地规则 ${l}`, new RegExp(l)])
    } catch {
      console.log(`! 跳过无效正则：${l}`)
    }
  }
}

let hits = 0
// 路径级检查：私有镜像目录不该被跟踪，也不该被打进发布包。
// --all 时它一定物理存在（就在仓库目录里），那不是错误，只提示，不算命中 ——
// 否则这个模式在本机永远 exit 1，等于把提示音关掉的烟雾报警器。
const mirror = textFiles
  .map((f) => relative(ROOT, f).replace(/\\/g, '/'))
  .filter((rel) => /(^|\/)patches\//.test(rel))
if (mirror.length) {
  if (all) {
    console.log(`· 私有镜像 ${mirror.length} 个文件：物理存在、已 gitignore、不会被跟踪 —— 别 git add -f，打包时排除 patches/`)
  } else {
    for (const rel of mirror) {
      console.log(`✗ 私有镜像目录被跟踪  ${rel}`)
      hits++
    }
  }
}

for (const file of textFiles) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    continue
  }
  if (text.includes('\u0000')) continue
  const lines = text.split(/\r?\n/)
  for (const [label, re] of rules) {
    for (let i = 0; i < lines.length; i++) {
      if (!re.test(lines[i])) continue
      // 命中行打个掩码，别把真东西打到终端历史里
      const masked = lines[i].replace(/([:=]\s*['"]?)([^\s'"]{4})[^\s'"]*/, '$1$2***')
      console.log(`✗ ${label}  ${relative(ROOT, file)}:${i + 1}  ${masked.trim().slice(0, 120)}`)
      hits++
    }
  }
}

// 图片是文本扫描的盲区：EXIF / XMP 里可能带作者名、本机路径、软件序列号。
// 不解析格式，只找标记段和几类明文 —— 够用了，真出问题也是这些地方。
for (const file of imageFiles) {
  let buf
  try {
    buf = readFileSync(file)
  } catch {
    continue
  }
  const ascii = buf.toString('latin1')
  const problems = []
  if (ascii.includes('Exif')) problems.push('EXIF 段')
  if (/http:\/\/ns\.adobe\.com\/xap/.test(ascii)) problems.push('XMP 段')
  if (/[A-Za-z]:[\\/]{1,2}Users[\\/]{1,2}[A-Za-z0-9_.-]+/.test(ascii)) problems.push('本机路径')
  if (/\b(USERNAME|harness-workspace)\b/.test(ascii)) problems.push('本机用户名')
  if (problems.length) {
    console.log(`✗ 图片元数据  ${relative(ROOT, file)}  含 ${problems.join(' / ')}`)
    hits++
  }
}

console.log(hits === 0 ? `✓ ${textFiles.length} 个文本 + ${imageFiles.length} 张图片，0 命中` : `\n共 ${hits} 处命中 —— 别提交，先把它们换掉或加进 .gitignore`)
process.exit(hits === 0 ? 0 : 1)
