/**
 * 主动开口（dsh-longing 自带，不依赖任何通道插件）。
 *
 * 三档通道：
 *   off   —— 什么都不发（默认）
 *   file  —— 把要说的话写进 待发消息.txt，由外部 bot 自己取走
 *   http  —— 直接 POST OneBot 的 /send_private_msg（需要 HTTP API 端口）
 *
 * 限速与安静时段全部读面板配置，改完下一轮生效。
 */

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const TICK_MS = 60_000

const OPENERS = {
  heat: [
    '（把脸埋进你颈窝）……你终于看我了。',
    '（贴过来，声音有点哑）今天……别让我一个人待着。',
    '（拉着你的手不放）我刚才一直在想你。',
  ],
  clingy: [
    '（从背后抱住）你在忙吗？',
    '（戳了戳你）理我一下。',
    '（靠过来）就抱一会儿，不说话也行。',
  ],
  calm: ['（抬头看你）今天怎么样？'],
}

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJson(file, data) {
  try {
    writeFileSync(file, JSON.stringify(data, null, 2), 'utf8')
  } catch {}
}

function inHours(spec, d = new Date()) {
  const m = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(String(spec ?? '').trim())
  if (!m) return true
  const start = Number(m[1]) * 60 + Number(m[2])
  const end = Number(m[3]) * 60 + Number(m[4])
  const cur = d.getHours() * 60 + d.getMinutes()
  return start <= end ? cur >= start && cur < end : cur >= start || cur < end
}

export function startProactive({ baseDir, getCfg, logger, intervalMs = TICK_MS, immediate = false }) {
  const stateFile = join(baseDir, '欲望状态.json')
  const metaFile = join(baseDir, '主动记录.json')
  const outbox = join(baseDir, '待发消息.txt')
  let stopped = false

  async function sendHttp(cfg, text) {
    const base = String(cfg?.onebotHttpBase ?? '').replace(/\/+$/, '')
    if (!base) throw new Error('没配 onebotHttpBase')
    const owners = Array.isArray(cfg?.ownerIds) ? cfg.ownerIds : []
    if (!owners.length) throw new Error('没配 ownerIds')
    for (const uid of owners) {
      const res = await fetch(`${base}/send_private_msg`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(cfg?.onebotToken ? { authorization: `Bearer ${cfg.onebotToken}` } : {}),
        },
        body: JSON.stringify({ user_id: Number(uid), message: [{ type: 'text', data: { text } }] }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
    }
  }

  async function check() {
    if (stopped) return
    const cfg = getCfg()
    const mode = String(cfg?.proactiveMode ?? 'off')
    if (mode === 'off' || cfg?.autoInitiate === false) return
    if (cfg?.enabled === false) return

    const d = readJson(stateFile, null)
    if (!d) return
    if (Number(d.pausedUntil ?? 0) > Date.now()) return
    if (cfg?.scheduleEnabled !== false && !inHours(cfg.activeHours ?? '08:00-02:00')) return
    if (inHours(cfg.quietHours ?? '02:00-08:00')) return

    const now = Date.now()
    // 冷场判断：优先用宿主报的最近消息时间，其次读 活动时间.json
    const lastOwnerAt = Number(globalThis.__dshQqLastOwnerAt ?? readJson(join(baseDir, '活动时间.json'), {})?.at ?? 0)
    if (now - lastOwnerAt < Number(cfg.idleTriggerMin ?? 20) * 60_000) return
    const meta = readJson(metaFile, { lastSent: 0, hourStart: 0, hourCount: 0 })
    if (now - Number(meta.lastSent ?? 0) < Number(cfg.proactiveCooldownMin ?? 120) * 60_000) return
    if (now - Number(meta.hourStart ?? 0) > 3_600_000) {
      meta.hourStart = now
      meta.hourCount = 0
    }
    if (Number(meta.hourCount ?? 0) >= Number(cfg.proactivePerHour ?? 1)) return

    const lust = Number(d.lust ?? 0)
    if (lust < Number(cfg.initiateThreshold ?? 60)) return

    const pool = lust >= 80 ? OPENERS.heat : lust >= 50 ? OPENERS.clingy : OPENERS.calm
    const text = pool[Math.floor(Math.random() * pool.length)]

    try {
      // auto：能连上 HTTP 就直接发，连不上就落到文件，不让用户关心通道
      const useHttp = mode === 'http' || (mode === 'auto' && String(cfg?.onebotHttpBase ?? '').trim())
      if (useHttp) {
        try {
          await sendHttp(cfg, text)
        } catch (e) {
          logger?.warn?.(`[dsh-longing] HTTP 发送失败，改写入文件：${e?.message ?? e}`)
          appendFileSync(outbox, `${new Date().toISOString()}\t${text}\n`, 'utf8')
        }
      } else appendFileSync(outbox, `${new Date().toISOString()}\t${text}\n`, 'utf8')
    } catch (e) {
      logger?.warn?.(`[dsh-longing] 主动开口失败：${e?.message ?? e}`)
      return
    }

    meta.lastSent = now
    meta.hourCount = Number(meta.hourCount ?? 0) + 1
    writeJson(metaFile, meta)
    logger?.info?.(`[dsh-longing] 主动开口（${mode}）：lust=${lust}`)
  }

  const timer = setInterval(() => check().catch((e) => logger?.debug?.(`[dsh-longing] 主动检查失败：${e?.message ?? e}`)), intervalMs)
  timer?.unref?.()
  if (immediate) setTimeout(() => check().catch(() => {}), 50).unref?.()
  return () => {
    stopped = true
    clearInterval(timer)
  }
}
