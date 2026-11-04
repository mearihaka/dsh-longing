/**
 * 工具脚本的路径推断 —— 不写死任何人的盘符。
 *
 * 顺序和插件本身一致：显式参数 > DSH_LONGING_DIR > 插件家目录（DSH_HOME/~/.dsh 下的
 * dsh-longing）> 老的 cwd/workspace（只为了不打断 1.11 以前的安装）。
 *
 * 环境变量：
 *   DSH_LONGING_DIR  状态目录（相当于插件配置里的 statePath 所在目录）
 *   DSH_QQ_SRC       通道插件 dsh-qq-onebot 的 src 目录（体检用；不填就跳过那一节）
 *   DSH_HOME         DSH 家目录（默认 ~/.dsh）
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const srcDir = join(repoRoot, 'src')

export function stateDir(arg = '') {
  const explicit = String(arg ?? '').trim()
  if (explicit) return resolve(explicit)
  const env = String(process.env.DSH_LONGING_DIR ?? '').trim()
  if (env) return resolve(env)
  const home = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'dsh-longing')
  if (existsSync(join(home, '欲望状态.json'))) return home
  const legacy = join(process.cwd(), 'workspace')
  if (existsSync(join(legacy, '欲望状态.json'))) return legacy
  return home
}

export function channelSrc() {
  return String(process.env.DSH_QQ_SRC ?? '').trim()
}
