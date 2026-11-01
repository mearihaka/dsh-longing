// 用 GitHub API 把本地 HEAD 推上去。
// 本机 git push 长期不通（src refspec / 网络），所以走 API：blob → tree → commit → PATCH ref。
//
// 用法：node tools/publish.mjs [--dry]
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const OWNER = 'mearihaka'
const REPO = 'dsh-longing'
const BRANCH = 'main'
const dry = process.argv.includes('--dry')

const token = execSync('gh auth token', { encoding: 'utf8' }).trim()
const api = async (path, init = {}) => {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path} -> ${res.status} ${text.slice(0, 300)}`)
  return JSON.parse(text)
}

const ref = await api(`/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`)
const headSha = ref.object.sha
const headCommit = await api(`/repos/${OWNER}/${REPO}/git/commits/${headSha}`)

const files = execSync('git ls-files', { cwd: REPO_DIR, encoding: 'utf8' }).split('\n').map((s) => s.trim()).filter(Boolean)
console.log(`远端 HEAD ${headSha.slice(0, 7)}，本地 ${files.length} 个文件${dry ? '（dry run）' : ''}`)

const local = new Map()
for (const f of files) local.set(f, readFileSync(join(REPO_DIR, f)))

// 只对内容变了的文件建 blob：对比远端树的 sha
const remoteTree = await api(`/repos/${OWNER}/${REPO}/git/trees/${headCommit.tree.sha}?recursive=1`)
const remoteSha = new Map(remoteTree.tree.filter((t) => t.type === 'blob').map((t) => [t.path, t.sha]))

const { createHash } = await import('node:crypto')
const gitBlobSha = (buf) => {
  const h = createHash('sha1')
  h.update(`blob ${buf.length}\0`)
  h.update(buf)
  return h.digest('hex')
}

const tree = []
let changed = 0
for (const [path, buf] of local) {
  const sha = gitBlobSha(buf)
  if (remoteSha.get(path) === sha) continue
  changed++
  if (dry) {
    console.log(`  变化 ${path} (${buf.length}B)`)
    tree.push({ path, mode: '100644', type: 'blob', sha })
    continue
  }
  const blob = await api(`/repos/${OWNER}/${REPO}/git/blobs`, {
    method: 'POST',
    body: JSON.stringify({ content: buf.toString('base64'), encoding: 'base64' }),
  })
  tree.push({ path, mode: '100644', type: 'blob', sha: blob.sha })
  console.log(`  blob ${path} (${buf.length}B) -> ${blob.sha.slice(0, 7)}`)
}

if (!changed) {
  console.log('没有变化，不用推。')
  process.exit(0)
}
if (dry) {
  console.log(`\n会推 ${changed} 个文件。`)
  process.exit(0)
}

const newTree = await api(`/repos/${OWNER}/${REPO}/git/trees`, {
  method: 'POST',
  // base_tree 必传：不传的话新树只含本次推送的文件，没变过的文件会被整棵抹掉
  // （2026-11-01 就漏掉过 README.md 和 tools/publish.mjs）
  body: JSON.stringify({ base_tree: headCommit.tree.sha, tree }),
})
const message = execSync('git log -1 --pretty=%B', { cwd: REPO_DIR, encoding: 'utf8' }).trim() || 'docs: 更新'
const commit = await api(`/repos/${OWNER}/${REPO}/git/commits`, {
  method: 'POST',
  body: JSON.stringify({ message, tree: newTree.sha, parents: [headSha] }),
})
await api(`/repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`, {
  method: 'PATCH',
  body: JSON.stringify({ sha: commit.sha, force: false }),
})
console.log(`\n完成 ${changed} 个文件：https://github.com/${OWNER}/${REPO}/commit/${commit.sha}`)
