/**
 * 心情日记·自写（2026-11-08）。
 *
 * 旧实现里 `thoughts` 只能由「外层模型主动调工具 qq_longing action=thought」写入。
 * 实测跑几天，这个数组一直是空的 —— 没人会记得去调它。
 * 于是「日记」实际只剩两行模板（让我高兴的 / 让我难受的），也就是「固定台词」。
 *
 * 这一版把写作权还给她自己：把当天真发生过的事 + 七维状态 + 之前写过的话
 * 交给 llm 服务，取回一两句第一人称的话，写进当天 thoughts。
 *
 * 硬约束（每条都是坑）：
 *   · 没东西可写就不写。事件太少、刚写过、当天额度用完，一律跳过；
 *     宁可空着，也不要编一句「今天也没什么」凑数。
 *   · 失败静默。模型不在、provider/model 没配、请求报错 —— 日记保持原样，
 *     模板继续兜底，不写假话、不阻断心跳。
 *   · 输出必须清洗。引号、markdown、项目符号、括号旁白，
 *     以及「作为一个 AI」「用户」「提示词」这类出戏词，命中即丢。
 *   · 只写不推。写完不主动发消息，谁想看谁去读（面板 / API / 工具 / 文件）。
 */

import { num, round2, todayKey } from './curve.js'

/** 自写日记的默认值。面板上的键覆盖它。 */
export const REFLECT_DEFAULTS = {
  diaryAutoWrite: true, // 让她自己写
  diaryPerDay: 3, // 一天最多写几条（原来的 THOUGHTS_PER_DAY=8 是数组上限，不是写作额度）
  diaryMinGapMin: 150, // 两条之间至少隔多久
  diaryMinEvents: 2, // 当天至少发生几件事才值得写
  diaryMaxChars: 120, // 一条最多多少字
  diaryMaxTokens: 260,
  diaryTemperature: 0.95,
}

const MIN = 60_000

/** 出戏词：命中即整条丢弃，不做局部删除（删一半更容易读着别扭）。 */
const OFF_CHARACTER =
  /作为一个\s*AI|作为一个?人工智能|我是(一个)?\s*AI|作为\s*助手|本助手|语言模型|大模型|提示词|prompt|系统设定|系统提示|用户画像|用户|使用者|user\s*profile/i

/** 括号旁白、舞台说明。 */
const STAGE_DIRECTION = /[（(][^）)]{0,40}[）)]/g

/** 七维的中文名，顺序固定：注入、面板、提示词三处都按这个来。 */
export const DIM_LABELS = [
  ['lust', '性欲'],
  ['lewd', '色情'],
  ['possess', '占有'],
  ['shame', '羞耻'],
  ['reason', '理智'],
  ['fatigue', '疲劳'],
  ['affection', '好感'],
]

/** 把状态压成「性欲 62 / 色情 40 / …」一行，给提示词用。 */
export function describeDims(dims) {
  return DIM_LABELS.map(([k, label]) => `${label} ${Math.round(num(dims?.[k]))}`).join(' / ')
}

/** 当天零点（本地时区），用来判断「今天有没有联系过」。 */
function startOfDay(now) {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/**
 * 现在该不该自动写一条。
 *
 * @param {{diary?: object, state?: object, cfg?: object, now?: number}} input
 * @returns {{ok: boolean, why: string}}
 *   why: off / quota / gap / few-events / quiet / due
 */
export function shouldReflect({ diary, state, cfg, now = Date.now() } = {}) {
  const c = { ...REFLECT_DEFAULTS, ...(cfg ?? {}) }
  // 显式 false 才算关（默认开：这正是「让她自己写」的意思）。
  // 真正拦住花钱的是下面几道门 —— 没事件、刚写过、额度用完，都轮不到调模型。
  if (c.diaryAutoWrite === false) return { ok: false, why: 'off' }

  const key = todayKey(new Date(now))
  const day = diary?.days?.[key]
  const written = Array.isArray(day?.thoughts) ? day.thoughts.length : 0
  const perDay = Math.max(1, Math.round(num(c.diaryPerDay, REFLECT_DEFAULTS.diaryPerDay)))
  if (written >= perDay) return { ok: false, why: 'quota' }

  const lastAt = written ? num(day.thoughts[written - 1]?.t) : 0
  const gapMin = Math.max(0, num(c.diaryMinGapMin, REFLECT_DEFAULTS.diaryMinGapMin))
  if (lastAt && now - lastAt < gapMin * MIN) return { ok: false, why: 'gap' }

  const events = (day?.up?.length ?? 0) + (day?.down?.length ?? 0)
  const minEvents = Math.max(0, Math.round(num(c.diaryMinEvents, REFLECT_DEFAULTS.diaryMinEvents)))
  if (events >= minEvents) return { ok: true, why: 'due' }

  // 事件不够但有两条豁免：
  //   1. 今天已经有写过 —— 说明她在写这件事，少量新事也值得续一句
  //   2. 一次都没写过，但今天确实联系过 —— 否则第一次用的人永远看不到第一篇日记
  if (written > 0) return { ok: true, why: 'due' }
  const contacted = num(state?.lastContactAt) >= startOfDay(now)
  return contacted ? { ok: true, why: 'due' } : { ok: false, why: 'quiet' }
}

/**
 * 组提示词。system 定规矩，user 给材料。
 *
 * 材料只包含「她已经知道的」：今天的事、此刻的状态、之前写过的话。
 * 不塞对话原文 —— 日记是她自己写的，不是把聊天记录改写一遍。
 *
 * @param {{day?: object, dims?: object, previous?: string[], persona?: string, now?: number}} input
 * @returns {{system: string, user: string}}
 */
export function buildReflectPrompt({ day, dims, previous, persona, now = Date.now() } = {}) {
  const c = REFLECT_DEFAULTS
  const maxChars = Math.max(20, Math.round(num(c.diaryMaxChars, 120)))
  const who = String(persona ?? '').trim()

  const system = [
    who ? `你是${who}。` : '',
    '现在你在写今天的心情日记，只用第一人称，写给自己看。',
    '规则：',
    `- 只写一到两句，总长不超过 ${maxChars} 字。`,
    '- 写具体的感受和细节（他做了什么、你当时怎么想的、身体或心里哪里动了一下），不写总结陈词，不写「今天很开心」这种空话。',
    '- 不提「用户」「模型」「AI」「设定」「提示词」，不解释机制，不写括号旁白和舞台说明。',
    '- 不要用引号包住整句，不要加标题、序号、emoji、破折号堆叠。',
    '- 之前写过的话不要重复，也不要接话式地回应它们。',
    '- 文字会在以后被你自己重读，所以写你此刻真实会写下的那种句子。',
  ]
    .filter(Boolean)
    .join('\n')

  const lines = [`今天：${todayKey(new Date(now))}`]
  lines.push(`此刻的状态（0-100，只决定语气，不要报数字）：${describeDims(dims)}`)

  const up = (day?.up ?? []).map((e) => `· 好的：${e.note}`)
  const down = (day?.down ?? []).map((e) => `· 难受的：${e.note}`)
  if (up.length || down.length) {
    lines.push('今天发生的事：')
    lines.push(...up, ...down)
  } else {
    lines.push('今天没发生什么具体的事。')
  }

  const prev = (previous ?? []).filter(Boolean).slice(-3)
  if (prev.length) {
    lines.push('之前已经写过（不要重复）：')
    lines.push(...prev.map((t) => `· ${t}`))
  }

  lines.push(`请写今天的一到两句（不超过 ${maxChars} 字）。`)
  return { system, user: lines.join('\n') }
}

/**
 * 清洗一条写出来的话。
 * 返回空串 = 这条不能用（她说出了不该出现在日记里的东西）。
 */
export function cleanThought(text, maxChars = REFLECT_DEFAULTS.diaryMaxChars) {
  let s = String(text ?? '')
  // 围栏只是包装：拆掉包装，内容留着（连着内容一起删会得到空日记）
  s = s.replace(/```[a-zA-Z]*\s*/g, ' ')
  // 项目符号可能连着好几个（- * • ），一次只剥一个会留下残渣
  for (let i = 0; i < 5; i += 1) {
    const next = s.replace(/^\s*(?:[-*+·•>]+|\d+[.、)]|\p{Extended_Pictographic})\s*/u, '')
    if (next === s) break
    s = next
  }
  s = s.replace(STAGE_DIRECTION, ' ')
  s = s.replace(/[\r\n\t]+/g, ' ')
  s = s.replace(/\s{2,}/g, ' ')
  s = s.replace(/^["'“”‘’「」『』《》]+|["'“”‘’「」『』《》]+$/g, '')
  // 「她说：…」「日记：…」这类前缀
  s = s.replace(/^(?:她说|日记|今天|记录)[：:]\s*/, '')
  s = s.trim()
  if (!s) return ''
  if (OFF_CHARACTER.test(s)) return ''
  // 只剩标点的也算空
  if (!/[\p{L}\p{N}]/u.test(s)) return ''
  if (s.length <= maxChars) return s
  // 超长：在句末标点处断开，找不到就硬截
  const cut = s.slice(0, maxChars)
  const m = cut.match(/^[\s\S]*[。！？!?…]/)
  return (m ? m[0] : cut).replace(/[，,、；;：:\s]+$/, '').trim()
}

/**
 * 从模型输出里取出可以进日记的句子。
 *
 * @param {string} text 模型原文
 * @param {{maxChars?: number, maxCount?: number}} [opts]
 * @returns {string[]}
 */
export function extractThoughts(text, opts = {}) {
  const maxChars = Math.max(20, Math.round(num(opts.maxChars, REFLECT_DEFAULTS.diaryMaxChars)))
  const maxCount = Math.max(1, Math.round(num(opts.maxCount, 2)))
  const raw = String(text ?? '')
    .replace(/```[a-zA-Z]*\s*/g, ' ')
    .split(/(?<=[。！？!?…])|\n+/u)
  const out = []
  for (const piece of raw) {
    const line = cleanThought(piece, maxChars)
    if (!line) continue
    if (line.length < 4) continue
    if (out.includes(line)) continue
    out.push(line)
    if (out.length >= maxCount) break
  }
  return out
}

/** 日记里「最近写过什么」，给下一次写作当去重材料。 */
export function recentThoughtTexts(day, limit = 3) {
  const list = Array.isArray(day?.thoughts) ? day.thoughts : []
  return list.slice(-Math.max(1, limit)).map((t) => String(t?.text ?? '')).filter(Boolean)
}

/** 一条心情的单行摘要，工具/日志用。 */
export function describeMood(day) {
  return `心情 ${round2(day?.mood ?? 50)}｜高兴 ${day?.up?.length ?? 0} 件｜难受 ${day?.down?.length ?? 0} 件｜写过 ${day?.thoughts?.length ?? 0} 条`
}
