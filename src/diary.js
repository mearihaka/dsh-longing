/**
 * 心情日记：只写，不推。
 *
 * 「今天什么让我开心、什么让我难过、心里在想什么」——记下来就够了。
 * 主动发出去就变成了表演，她一天里真在想什么反而说不出口。
 *
 * 读的四个口子，随便用哪个：
 *   - 文件 <workspace>/心情日记.json
 *   - globalThis.__dshLongingDiary(days)      同进程零 IO
 *   - HTTP GET /dsh-longing/api/diary
 *   - 工具 qq_longing action=diary
 * 通道无关：dsh-qq 能读，web / bili / 别的插件也能读，不读也不影响运行。
 */

import { clamp, num, round2, todayKey } from './curve.js'

/** 留多少天。再久就没意义了，文件也会越来越大。 */
export const DIARY_KEEP_DAYS = 30
/** 每天最多几条内心想法（模型主动写的）。 */
export const THOUGHTS_PER_DAY = 8

export function emptyDay(date) {
  return { date, up: [], down: [], thoughts: [], mood: 50, updatedAt: 0 }
}

/** 只保留最近 N 天，顺手按日期排序。 */
export function pruneDiary(diary, keep = DIARY_KEEP_DAYS) {
  const days = diary?.days ?? {}
  const keys = Object.keys(days).sort()
  while (keys.length > keep) delete days[keys.shift()]
  return { days, updatedAt: num(diary?.updatedAt) }
}

/**
 * 当天情绪。
 *
 * 按**比例**算，不按次数：聊二十句和聊两句的人，心情不该差出几十点。
 * 场次越多越可信（对数收敛），但不会因为话多就顶到 100。
 */
export function moodOf(day) {
  const up = Array.isArray(day?.up) ? day.up.length : 0
  const down = Array.isArray(day?.down) ? day.down.length : 0
  const thoughts = Array.isArray(day?.thoughts) ? Math.min(day.thoughts.length, 8) : 0
  const total = up + down
  // 没有事件时，想法本身说明「今天她心里有事」，轻微推一把
  if (!total) return clamp(50 + thoughts * 2, 0, 100)
  const ratio = (up - down) / total // −1..1
  const confidence = Math.min(1, Math.log2(1 + total) / 3) // 3 件事≈0.67，7 件≈1
  return clamp(50 + ratio * 45 * confidence + thoughts * 1.5, 0, 100)
}

/**
 * 记一条「今天发生的事」。
 * @param {object} diary
 * @param {{name: string, note: string, tone: 'good'|'bad'|'', now: number}} ev
 */
export function recordEvent(diary, ev) {
  const now = num(ev?.now, Date.now())
  const key = todayKey(new Date(now))
  const out = pruneDiary(diary ?? { days: {} })
  const day = out.days[key] ?? emptyDay(key)
  const entry = { t: now, e: String(ev?.name ?? ''), note: String(ev?.note ?? '').slice(0, 120) }
  if (ev?.tone === 'good') day.up.push(entry)
  else if (ev?.tone === 'bad') day.down.push(entry)
  else return out // 没有倾向的事件（比如 stop）不进日记，它自己会留在注入块里
  day.updatedAt = now
  day.mood = moodOf(day)
  out.days[key] = day
  out.updatedAt = now
  return out
}

/**
 * 她自己的内心想法（由模型写，不是模板）。
 * 一天最多 THOUGHTS_PER_DAY 条，超了丢最早的。
 */
export function addThought(diary, text, now = Date.now()) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 160)
  if (!clean) return diary
  const key = todayKey(new Date(now))
  const out = pruneDiary(diary ?? { days: {} })
  const day = out.days[key] ?? emptyDay(key)
  day.thoughts.push({ t: now, text: clean })
  while (day.thoughts.length > THOUGHTS_PER_DAY) day.thoughts.shift()
  day.updatedAt = now
  day.mood = moodOf(day)
  out.days[key] = day
  out.updatedAt = now
  return out
}

/** 最近 N 天，新的在前。 */
export function recentDiary(diary, days = 7) {
  const all = diary?.days ?? {}
  return Object.keys(all)
    .sort()
    .reverse()
    .slice(0, Math.max(1, num(days, 7)))
    .map((k) => all[k])
}

/** 一天的文字版，给面板和「查日记」这类指令用。 */
export function formatDay(day) {
  if (!day) return '这天没有记录。'
  const lines = [`${day.date}｜心情 ${round2(day.mood ?? 50)}`]
  if (day.up?.length) lines.push(`让我高兴的：${day.up.map((e) => e.note).join('；')}`)
  if (day.down?.length) lines.push(`让我难受的：${day.down.map((e) => e.note).join('；')}`)
  // 想法是她自己写的整句，用换行列出来，不要拼成一大串
  if (day.thoughts?.length) lines.push(`心里想的：\n${day.thoughts.map((e) => `· ${e.text}`).join('\n')}`)
  if (lines.length === 1) lines.push('今天没什么特别的。')
  return lines.join('\n')
}
