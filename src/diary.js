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
  return {
    date,
    up: [],
    down: [],
    thoughts: [],
    mood: 50,
    updatedAt: 0,
    // 2026-11-10（审计 F05）：写作账本。之前配额拿 thoughts.length 当次数，
    // 而日记改成「一天一篇、重写覆盖」之后，长度永远是 1~4 —— 配额等于失效。
    writes: 0, // 当天成功写了几次（重写也算一次）
    fails: 0, // 连续失败次数，用来退避
    lastTryAt: 0, // 最后一次尝试（成功或失败）的时间
    lastWriteAt: 0, // 最后一次成功写作的时间：判断「这之后有没有新事」用它
  }
}

/**
 * 日期键 → 可比较的数字。
 *
 * todayKey() 不补零（2026-11-9 而不是 2026-11-09），于是字符串排序是错的：
 * '2026-11-10' < '2026-11-9'（'1' < '9'），'2026-10-2' > '2026-10-19'。
 * 后果不是好看不好看：recentDiary(diary, 1)[0] 在每月 10 号之后会取到「昨天」，
 * pruneDiary 会裁掉比留下的还新的那几天。所以所有"哪天更新"的比较都走这个函数。
 */
const dateNum = (key) => {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(key ?? ''))
  if (!m) return Number.NEGATIVE_INFINITY
  return Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3])
}

/** 只保留最近 N 天，顺手按日期排序。 */
export function pruneDiary(diary, keep = DIARY_KEEP_DAYS) {
  const days = diary?.days ?? {}
  const keys = Object.keys(days).sort((a, b) => dateNum(a) - dateNum(b))
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
  // 同一件事一小时内重复记：合进上一条的计数，别在日记里刷成四行。
  // 2026-11-10（审计 F10）：只合并「原话也一样」的。以前只看类型和固定 note，
  // 于是第二句话（detail 不同）被并进第一条，原话丢了 —— 日记里就只剩第一句。
  const name = String(ev?.name ?? '')
  const noteText = String(ev?.note ?? '').slice(0, 120)
  const detailText = String(ev?.detail ?? '').replace(/\s+/g, ' ').trim().slice(0, 80)
  const list = ev?.tone === 'good' ? day.up : day.down
  const prev = list[list.length - 1]
  if (prev && prev.e === name && prev.note === noteText && String(prev.detail ?? '') === detailText && now - Number(prev.t ?? 0) < 3_600_000) {
    prev.n = (Number(prev.n) || 1) + 1
    day.updatedAt = now
    day.mood = moodOf(day)
    out.days[key] = day
    out.updatedAt = now
    return out
  }
  const entry = { t: now, e: name, note: noteText }
  // 2026-11-09（私有定制）：note 是固定文案，只有类型。detail 才是「他到底说了什么」——
  // 日记要写事实，靠的就是这个字段。src 记来源（panel / tool / log），方便回溯。
  if (detailText) entry.detail = detailText
  const src = String(ev?.src ?? '').trim()
  if (src) entry.src = src
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
  day.thoughts.push({ t: now, text: clean, kind: 'mine' })
  while (day.thoughts.length > THOUGHTS_PER_DAY) day.thoughts.shift()
  day.updatedAt = now
  day.mood = moodOf(day)
  out.days[key] = day
  out.updatedAt = now
  return out
}

/**
 * 模型重写今天的日记：**覆盖**当天她写的那部分，不追加。
 *
 * 2026-11-9：以前每次写都 push 一条，一天能堆八句「被碰过的地方还留着温度」，
 * 面板上看就是复读机。日记本来就是一天一篇的东西 —— 重写就是重写。
 * 手动「记下一句心里话」（kind=mine）不动，她自己的和模型写的分开存。
 *
 * @param {object} diary
 * @param {string[]} lines
 * @param {number} [now]
 */
export function replaceThoughts(diary, lines, now = Date.now()) {
  const key = todayKey(new Date(now))
  const out = pruneDiary(diary ?? { days: {} })
  const day = out.days[key] ?? emptyDay(key)
  // 2026-11-10（审计 F12）：升级前的手记没有 kind 字段，按 mine 保留 —— 否则
  // 第一次重写就把用户自己写的话删了。没有 kind 的老条目一律当手记。
  const kept = (day.thoughts ?? []).filter((x) => x?.kind === 'mine' || x?.kind === undefined)
  const fresh = (Array.isArray(lines) ? lines : [])
    .map((x) => String(x ?? '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(0, 4)
    .map((text) => ({ t: now, text: text.slice(0, 200), kind: 'write' }))
  day.thoughts = [...kept, ...fresh]
  // 2026-11-10（审计 F05）：配额计数放在这里 —— 唯一的「写日记」入口。
  // 换成别的调用方（工具、面板、测试）也不会漏记，配额不会再因为「只覆盖不追加」失效。
  day.writes = num(day.writes) + 1
  day.fails = 0
  day.lastTryAt = now
  day.lastWriteAt = now
  day.updatedAt = now
  day.mood = moodOf(day)
  out.days[key] = day
  out.updatedAt = now
  return out
}

/**
 * 今天的日记对象（没有就造一个空的，不写盘）。
 *
 * 2026-11-10（审计 F09）：不能再拿 `recentDiary(diary,1)[0]` 当「今天」——
 * 今天还没有记录时它返回的是昨天，于是昨天的动作和想法被当成今天的材料，
 * 注入块里还会写成「你自己今天写下的」。
 */
export function todayOf(diary, now = Date.now()) {
  const key = todayKey(new Date(now))
  return diary?.days?.[key] ?? emptyDay(key)
}

/**
 * 记一次写作尝试（成功/失败都要记）。
 *
 * @param {object} diary
 * @param {{now?: number, ok?: boolean, wroteAt?: number}} r
 */
export function noteReflect(diary, r = {}) {
  const now = num(r?.now, Date.now())
  const key = todayKey(new Date(now))
  const out = pruneDiary(diary ?? { days: {} })
  const day = out.days[key] ?? emptyDay(key)
  day.lastTryAt = now
  if (r?.ok) {
    // 计数已经由 replaceThoughts 记过（那里才是写入点），这里只补水位：
    // 材料水位取「请求开始」的时间，模型思考期间新产生的事下一轮还能用（审计 F11）
    day.fails = 0
    day.lastWriteAt = num(r?.wroteAt, now)
  } else {
    day.fails = num(day.fails) + 1
  }
  day.updatedAt = now
  out.days[key] = day
  out.updatedAt = now
  return out
}

/** 最近 N 天，新的在前。 */
export function recentDiary(diary, days = 7) {
  const all = diary?.days ?? {}
  return Object.keys(all)
    .sort((a, b) => dateNum(b) - dateNum(a))
    .slice(0, Math.max(1, num(days, 7)))
    .map((k) => all[k])
}

/** 一天的文字版，给面板和「查日记」这类指令用。 */
export function formatDay(day) {
  if (!day) return '这天没有记录。'
  const lines = [`${day.date}｜心情 ${round2(day.mood ?? 50)}`]
  // 显示也合并：历史里同一条被记了四次，面板就画四遍（2026-11-9 的截图）。
  // detail（他到底说了什么）优先于固定 note；重复的写成「×4」。
  const merge = (list) => {
    const order = []
    const count = new Map()
    for (const e of list) {
      const text = String(e?.detail || e?.note || '').trim()
      if (!text) continue
      const n = Math.max(1, Number(e?.n) || 1)
      if (!count.has(text)) {
        order.push(text)
        count.set(text, 0)
      }
      count.set(text, count.get(text) + n)
    }
    return order.map((t) => (count.get(t) > 1 ? `${t} ×${count.get(t)}` : t)).join('；')
  }
  if (day.up?.length) lines.push(`让我高兴的：${merge(day.up)}`)
  if (day.down?.length) lines.push(`让我难受的：${merge(day.down)}`)
  // 想法是她自己写的整句，用换行列出来，不要拼成一大串
  if (day.thoughts?.length) lines.push(`心里想的：\n${day.thoughts.map((e) => `· ${e.text}`).join('\n')}`)
  if (lines.length === 1) lines.push('今天没什么特别的。')
  return lines.join('\n')
}
