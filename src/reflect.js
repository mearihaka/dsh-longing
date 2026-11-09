/**
 * 心情日记：她自己写。
 *
 * 2026-11-09 重构（用户：不要守卫了）：
 *
 * 旧版为了让日记「干净」，在写入口堆了四道拦：脏话表、最小长度、标点当截断、
 * 与前一天去重。结果是她经常一句话都写不出来 —— 面板上表现成「让她写一篇没反应」。
 * **守卫拦掉的是她的心情，不是脏东西。**
 *
 * 现在只有格式清理，没有内容审查：
 *   去代码围栏 / 剥项目符号 / 合并空白 / 去首尾引号 / 超长按句号断（找不到就硬截）。
 * 剩下的一律保留 —— 她想写什么就写什么，写歪了是她的字，不是 bug。
 *
 * 另一个根因：她写在日记里的话**从来没进过注入块**，所以她写完和没写一样。
 * 现在 `index.js` 把今天的最近两条 thoughts 传给 `buildBlock`（prompt.js 的 thoughtLine），
 * 她下一轮说话就带着这个心情。
 */

import { num, todayKey } from './curve.js'

export const REFLECT_DEFAULTS = {
  diaryAutoWrite: true,
  // 一天最多写几条。这不是内容守卫，是防止心跳每分钟一次把额度烧光。
  diaryPerDay: 6,
  // 两条之间最短间隔（分钟）。同上：节流，不是审查。
  diaryMinGapMin: 60,
  diaryMaxChars: 160,
  // 当天至少发生几件事才值得写（0 = 每天都写）
  diaryMinEvents: 2,
  diaryMaxTokens: 600,
  diaryTemperature: 0.95,
}

/** 七维的中文标签（提示词和工具输出共用）。 */
export const DIM_LABELS = [
  ['lust', '性欲'],
  ['lewd', '色情'],
  ['possess', '占有'],
  ['shame', '羞耻'],
  ['resist', '理智'],
  ['fatigue', '疲劳'],
  ['affection', '好感'],
]

/**
 * 一行七维，不带语气。只给模型当「此刻的状态」，不让它报数字。
 * @param {object} dims
 */
export function describeDims(dims) {
  return DIM_LABELS.map(([k, label]) => `${label} ${Math.round(num(dims?.[k]))}`).join(' / ')
}

/** 某天的日记（今天没有就造一个空的，不写盘）。 */
function dayOf(diary, now) {
  const key = todayKey(new Date(now))
  return diary?.days?.[key] ?? { date: key, up: [], down: [], thoughts: [], mood: 50 }
}

/**
 * 该不该写。
 *
 * 只判断三件事：开关、额度、间隔 —— 都是「别把 token 烧光」的节流，
 * 不判断内容好坏。剩下的交给「今天有没有新东西可说」。
 *
 * @returns {{ ok: boolean, why: string }}
 *   off / quota / gap / quiet / nothing-new / due
 */
export function shouldReflect({ diary, state, cfg = {}, now = Date.now() } = {}) {
  const c = { ...REFLECT_DEFAULTS, ...(cfg ?? {}) }
  if (c.diaryAutoWrite === false) return { ok: false, why: 'off' }

  const day = dayOf(diary, now)
  const thoughts = Array.isArray(day.thoughts) ? day.thoughts : []
  // 2026-11-10（审计 F05）：配额看「成功写了几次」，不看 thoughts 长度。
  // 改成一天一篇之后长度恒为 1~4，拿长度当次数等于配额失效。
  // 旧数据没有 writes，就退回按条数估一次。
  // 老日记没有 writes 字段（升级前写的），按想法条数估一次，别让配额突然放开
  const writes = num(day.writes) > 0 ? num(day.writes) : thoughts.length
  const perDay = Math.max(1, Math.round(num(c.diaryPerDay, REFLECT_DEFAULTS.diaryPerDay)))
  if (writes >= perDay) return { ok: false, why: 'quota' }

  // 间隔与退避都看「最后一次尝试」，不是最后一条想法的时间
  // 老数据没有 lastTryAt：退回最后一条想法的时间（和旧行为一致）
  const lastTry = num(day.lastTryAt) || (thoughts.length ? num(thoughts[thoughts.length - 1]?.t) : 0)
  const gapMs = Math.max(0, num(c.diaryMinGapMin, REFLECT_DEFAULTS.diaryMinGapMin)) * 60_000
  if (lastTry && now - lastTry < gapMs) return { ok: false, why: 'gap' }
  const fails = Math.max(0, num(day.fails))
  if (fails > 0 && lastTry) {
    const backoff = Math.min(60, 5 * 2 ** Math.min(4, fails - 1)) * 60_000
    if (now - lastTry < backoff) return { ok: false, why: 'backoff' }
  }

  const events = [...(day.up ?? []), ...(day.down ?? [])]
  // 2026-11-10（审计 F15）：diaryMinEvents 之前写了却没人用，现在真的当门槛。
  const minEvents = Math.max(0, Math.round(num(c.diaryMinEvents, REFLECT_DEFAULTS.diaryMinEvents)))
  const startOfDay = new Date(now).setHours(0, 0, 0, 0)
  const contactedToday = num(state?.lastContactAt) >= startOfDay
  const firstOfDay = writes === 0 && contactedToday

  // 今天什么都没有：不是「事不够」，是「没什么可说」
  if (!events.length) {
    if (firstOfDay) return { ok: true, why: 'due' }
    return { ok: false, why: writes ? 'nothing-new' : 'quiet' }
  }
  // 门槛只管「今天第一篇」：已经写过一篇，之后单来一件小事也算新料，不该再等凑数
  if (writes === 0 && minEvents > 0 && events.length < minEvents && !firstOfDay) {
    return { ok: false, why: 'few-events' }
  }

  // 水位取「上次成功写作的开始时间」：那之后发生的事才算新事。
  // 老数据没有 lastWriteAt，退回最后一条的想法时间。
  const water = num(day.lastWriteAt) || lastTry
  const fresh = water ? events.some((e) => num(e?.t) > water) : true
  if (fresh) return { ok: true, why: 'due' }
  return { ok: false, why: writes ? 'nothing-new' : 'quiet' }
}

/**
 * 组提示词。system 定规矩，user 给材料。
 *
 * 材料只有「她已经知道的」：今天发生的事（清单，带原话）、此刻的状态、之前写过的话。
 * 清单是**闭集**：不许她发明没发生过的物件和对话 —— 那是唯一一条硬规则，
 * 因为编出来的日记不是她的心情，是假的。
 *
 * @param {{day?: object, dims?: object, previous?: string[], persona?: string, owner?: string, now?: number}} input
 * @returns {{ system: string, user: string }}
 */
export function buildReflectPrompt({ day, dims, previous, persona, owner, maxChars: mx, now = Date.now() } = {}) {
  const c = REFLECT_DEFAULTS
  // 2026-11-10（审计 F15）：字数上限以前没传进来，提示里写死 160，
  // 用户把 diaryMaxChars 改成 30 也不生效。
  const maxChars = Math.max(20, Math.round(num(mx, num(c.diaryMaxChars, 160))))
  const who = String(persona ?? '').trim()
  const ownerRef = String(owner ?? '').trim() || 'TA'

  const system = [
    who ? `你是${who}。` : '',
    '现在把今天的心情记下来。第一人称，写给自己看，不用给谁看。',
    '规则：',
    '- 两三句话，总长不超过 ' + maxChars + ' 字。',
    `- 写三件事：今天发生了什么（只写清单里的）、你当时是什么感觉、现在回头想又是什么感受。`,
    '- 写具体的身体和心里的反应，不写总结陈词，不写「今天很开心」这种空话。',
    `- 提到${ownerRef}就用「${ownerRef}」。`,
    '- 不要照抄发给你的事实清单，用你自己的话重写。',
    '- 不提「用户」「模型」「AI」「设定」「提示词」，不解释机制，不写括号旁白和舞台说明。',
    '- 不要用引号包住整句，不要加标题、序号、emoji。',
    '- 清单里没有的事不许写：不许加清单上没有的人、东西、地点、天气、对话。',
    '- 每句结尾必须标上你用的是哪一条，写成 [编号]；一句话用了两条就写 [1][3]。',
    '- 清单是空的，就只能写此刻的感受，标 [0]。',
    '- 之前写过的话不要重复。',
  ]
    .filter(Boolean)
    .join('\n')

  const lines = [`今天：${todayKey(new Date(now))}`]
  lines.push(`此刻的状态（0-100，只决定语气，不要报数字）：${describeDims(dims)}`)

  // 事实清单：detail（他到底说了什么）优先于固定 note；带时间，编号，闭集
  let n = 0
  const fact = (e, tag) => {
    n += 1
    const time = num(e?.t) ? new Date(num(e.t)).toTimeString().slice(0, 5) : ''
    return `${n}. ${time ? `${time} ` : ''}${tag}：${String(e?.detail || e?.note || '').trim()}`
  }
  const facts = [
    ...(day?.up ?? []).map((e) => fact(e, '好的')),
    ...(day?.down ?? []).map((e) => fact(e, '难受的')),
  ]
  if (facts.length) {
    lines.push('今天发生的事（只能引用这些）：')
    lines.push(...facts)
  } else {
    lines.push('今天发生的事：一条都没有。')
    lines.push('（那就只写此刻的状态和感觉，不许写任何具体事件、物品或对话。）')
  }

  const prev = (previous ?? []).filter(Boolean).slice(-3)
  if (prev.length) {
    lines.push('之前已经写过（不要重复）：')
    lines.push(...prev.map((t) => `· ${t}`))
  }

  lines.push(`请写今天的两三句（不超过 ${maxChars} 字）。`)
  return { system, user: lines.join('\n') }
}

/**
 * 有没有依据。
 *
 * 用户的要求：**只能拿今天记下的事写，不许捏造**。
 * 所以写出来的每一句都要能对上今天的事实清单：
 *   ① 句尾标了 [编号] 且编号在范围内 → 有依据（最可靠）
 *   ② 没标编号，但和某条事实有词面重合（≥2 个 2-gram）→ 也算有依据
 *   ③ 都不是 → 这句是凭空来的，不进日记
 *
 * ③ 不是「审查她的心情」，是「这句没有出处」—— 心情可以自由，事实必须有依据。
 */
// 虚词：这些字不参与「有没有依据」的判定。
// 不加这个表，「我心里」「他一下」这种通用短语就能把凭空编的一句放进来。
const STOP_CHARS = new Set('的了着过是我你他她它们这那个些在和与就都也还很不没来去上下里天今心时候想要得地之以为对会能可又再从被把给让说一有'.split(''))

/** 一句话里真正的「实词字」（去掉虚词）。 */
const contentChars = (s) =>
  new Set(
    [...String(s ?? '').replace(/[\s\p{P}\p{S}]/gu, '')].filter((ch) => !STOP_CHARS.has(ch)),
  )

/**
 * 有没有依据。
 *
 * 用户的要求：**只能拿今天记下的事写，不许捏造**。
 * 三档判定：
 *   ① 句尾标了 [编号] 且编号在范围内 → 有依据（最可靠）
 *   ② 没标编号，但和某条事实有 ≥2 个实词字重合 → 也算有依据
 *   ③ 都不是 → 这句没有出处，不进日记
 *
 * ③ 不是「审查她的心情」，是「这句没有出处」。心情可以自由，事实必须有依据。
 */
function anchoredTo(line, facts) {
  const mine = contentChars(line)
  if (!mine.size) return false
  return facts.some((f) => {
    let hit = 0
    for (const ch of contentChars(f)) {
      if (mine.has(ch)) hit += 1
      if (hit >= 2) return true
    }
    return false
  })
}

/**
 * 清理一条写出来的话。**只做格式清理，不做内容审查。**
 *
 * @param {string} text
 * @param {number} maxChars
 * @returns {string} 空串只代表「这段没字」，不代表「这句话不合格」
 */
export function cleanThought(text, maxChars = REFLECT_DEFAULTS.diaryMaxChars) {
  let s = String(text ?? '')
  // 围栏是包装：拆掉包装，内容留着
  s = s.replace(/```[a-zA-Z]*\s*/g, ' ')
  // 项目符号可能连着几个（- * • 1. ），一次剥一个会留残渣
  for (let i = 0; i < 5; i += 1) {
    const next = s.replace(/^\s*(?:[-*+·•>]+|\d+[.、)]|\p{Extended_Pictographic})\s*/u, '')
    if (next === s) break
    s = next
  }
  s = s.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim()
  s = s.replace(/^["'“”‘’「」『』《》]+|["'“”‘’「」『』《》]+$/g, '').trim()
  if (!s) return ''
  // 只剩标点等于没字（格式层面的空，不是内容审查）
  if (!/[\p{L}\p{N}]/u.test(s)) return ''
  const limit = Math.max(20, Math.round(num(maxChars, REFLECT_DEFAULTS.diaryMaxChars)))
  if (s.length <= limit) return s
  // 超长才动手：优先在句末断开，找不到就硬截 —— 硬截也比整条丢掉好
  const cut = s.slice(0, limit)
  const m = cut.match(/^[\s\S]*[。！？!?…]/)
  return (m ? m[0] : cut).replace(/[，,、；;：:\s]+$/, '').trim()
}

/**
 * 从模型输出里取出可以进日记的句子。
 *
 * 不查脏话、不查最短长度、不按标点判断截断、不跟历史去重 ——
 * 只按句子切开，清掉格式，留前 N 条。真的一无所有时才返回空数组。
 *
 * @param {string} text 模型原文
 * @param {{maxChars?: number, maxCount?: number}} [opts]
 * @returns {string[]}
 */
export function extractThoughts(text, opts = {}) {
  const maxChars = Math.max(20, Math.round(num(opts.maxChars, REFLECT_DEFAULTS.diaryMaxChars)))
  const maxCount = Math.max(1, Math.round(num(opts.maxCount, 3)))
  const facts = Array.isArray(opts.facts) ? opts.facts.map(String).filter(Boolean) : null
  // 模型常把编号写在句号后面（「……。[1]」），先把编号挪到句号前，
  // 否则切句时编号会掉到下一片，前面那句就被判成「没依据」。
  const src = String(text ?? '').replace(/([。！？!?…])\s*((?:\[\d+\])+)/g, '$2$1')
  const out = []
  for (const piece of src.split(/(?<=[。！？!?…])|\n+/u)) {
    const cites = [...piece.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]))
    const line = cleanThought(piece.replace(/\[\d+\]/g, ''), maxChars)
    if (!line) continue
    if (facts && facts.length) {
      // 2026-11-10（审计 F06）：编号不再当免死牌。模型自报 [1] 不等于这句话来自第 1 条，
      // 所以无论标不标编号，都要过内容锚定（实词字重合）。
      if (!anchoredTo(line, facts)) continue
    } else if (hasConcreteClaim(line)) {
      // 清单为空：今天什么都没记，就只能写感受，不许出现具体的人/物/数字/引号内容
      continue
    }
    out.push(line)
    if (out.length >= maxCount) break
  }
  if (!out.length) {
    const whole = cleanThought(src.replace(/\[\d+\]/g, ''), maxChars)
    // 2026-11-10（审计 F06）：兜底那条以前只做 anchoredTo，没做「清单为空就别写具体的事」，
    // 于是「今天收到一辆红色跑车。」照样从这条路进日记。
    const okAnchored = facts && facts.length ? anchoredTo(whole, facts) : !hasConcreteClaim(whole)
    if (whole && okAnchored) out.push(whole)
  }
  return out
}

/** 清单为空时，判断这句话是不是在讲具体的事。 */
function hasConcreteClaim(line) {
  const s = String(line ?? '')
  if (/[0-9]/.test(s)) return true
  if (/[「」『』“”"]/.test(s)) return true
  // 中文数量词 + 量词：一辆车 / 三条消息 / 两句话
  // 「个」不算：「作为一个语言模型」这种句子会误判成具体事实，把正常感受也拦掉。
  // 「个」「句」「次」不算：「作为一个语言模型」「下一句」「那几句」都是口头语，
  // 拿它们当具体事实会把正常感受整段拦掉（审计 F06 修正过头的那一面）。
  if (/[一二三四五六七八九十百千万几两半]+[辆只本条张台件遍封块把杯束片顿场瓶盒袋双套支根层]/.test(s)) return true
  return false
}

/** 日记里「最近写过什么」，给下一次写作当去重材料（只是材料，不是拦截）。 */
export function recentThoughtTexts(day, limit = 3) {
  const list = Array.isArray(day?.thoughts) ? day.thoughts : []
  return list
    .slice(-Math.max(1, limit))
    .map((t) => String(t?.text ?? ''))
    .filter(Boolean)
}
