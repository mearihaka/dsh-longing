# tick：状态演化（实际运行代码 v2）

> JavaScript（ESM），`src/index.js` 原样代码。v2 修掉了同步自旋与内存泄漏。

```js
const TICK_MS = 60_000
const HISTORY_MAX = 2880
const STEP_LIMIT = 25 // 只作用于模型调用 qq_desire 的 set/bump，不限制面板

function clamp(n, lo = 0, hi = 100) {
  const v = Number(n)
  if (!Number.isFinite(v)) return lo
  return Math.min(hi, Math.max(lo, Math.round(v)))
}

function parseWindow(spec) {
  const m = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(String(spec ?? '').trim())
  if (!m) return null
  return { start: Number(m[1]) * 60 + Number(m[2]), end: Number(m[3]) * 60 + Number(m[4]) }
}

function inWindow(win, d = new Date()) {
  if (!win) return true
  const cur = d.getHours() * 60 + d.getMinutes()
  return win.start <= win.end ? cur >= win.start && cur < win.end : cur >= win.start || cur < win.end
}

/** 原子写：临时文件 + rename；EPERM 用 setTimeout 异步重试，绝不自旋 */
function writeJson(file, data) {
  try {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
    const attempt = (n) => {
      try {
        renameSync(tmp, file)
      } catch {
        if (n < 4) {
          const t = setTimeout(() => attempt(n + 1), 20 * (n + 1))
          t?.unref?.()
        } else {
          try { unlinkSync(tmp) } catch {}
        }
      }
    }
    attempt(0)
  } catch {}
}

function tick() {
  const eff = settings()
  if (eff?.enabled === false) return

  // 清理过期的「主人私聊会话」登记，防止 Map 无限增长
  const owners = globalThis.__dshQqOwnerSessions
  if (owners instanceof Map) {
    const nowTs = Date.now()
    for (const [sid, expire] of owners) if (Number(expire) < nowTs) owners.delete(sid)
  }

  // 面板可能刚改过文件：以文件里更新的 updatedAt 为准
  const disk = readJson(stateFile, null)
  if (disk && Number(disk.updatedAt ?? 0) > Number(state.updatedAt ?? 0)) {
    state = { ...state, ...disk }
  }

  const now = Date.now()
  const dtHours = Math.min(24, Math.max(0, (now - Number(state.updatedAt ?? now)) / 3_600_000))
  const peak = inWindow(parseWindow(eff?.peakWindow))
  const decay = peak ? Number(eff?.nightDecayPerHour ?? 6) * 0.25 : Number(eff?.decayPerHour ?? 3)
  state.lust = clamp(state.lust - decay * dtHours)

  if (peak && state.lastPeak !== todayKey()) {
    state.lust = clamp(state.lust + Number(eff?.peakBonus ?? 25))
    state.lastPeak = todayKey()
  }

  state.updatedAt = now
  writeJson(stateFile, state)

  history.push({ t: now, l: state.lust, d: state.lewd, p: state.possess })
  while (history.length > HISTORY_MAX) history.shift()
  writeJson(historyFile, history)
}

const timer = setInterval(tick, TICK_MS)
timer?.unref?.()
ctx?.on?.('dispose', () => clearInterval(timer))
```

## 工具侧限幅（只在模型调用时）

```js
const delta = action === 'bump' ? Number(args[k]) : Number(args[k]) - Number(state[k] ?? 0)
const capped = Math.max(-STEP_LIMIT, Math.min(STEP_LIMIT, delta))
state[k] = clamp(Number(state[k] ?? 0) + capped)
```

## 面板写入（不限幅）

```js
state[k] = clamp(p[k]) // 面板由用户直接控制
```
