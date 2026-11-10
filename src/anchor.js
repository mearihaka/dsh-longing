/**
 * 事件锚点：让「最近老是这样」有存在感，又不至于把底色冲垮。
 *
 * 借鉴自《情绪系统设计参考》4.1 节：
 *
 *   问题：如果每次强情绪都写进底色，聊一周之后角色就"不知道自己到底是什么心情"了。
 *   解法：强情绪先变成「锚点」，带 5 天半衰期、单方向最多 8 个、总上限 12 个；
 *        锚点不等于底色，只在行为上微微偏移。
 *
 * 我们原来的做法只有 `recentEvents`（30 分钟窗口，见 events.js）——
 * 过了窗口就彻底忘。结果是「昨天被骂」和「一周前被骂」对她完全一样。
 * 锚点补的就是这一段：30 分钟到 5 天之间。
 *
 * **锚点不进注入块。** 这是刻意的（2026-11-10）：
 *   · 常驻每天花几十个 token，而且「最近心里有点：被冷了一下」反复出现会变成念稿；
 *   · 需要的时候她自己调 `action=recall source=anchor` 查 —— 数据一直在 state.anchors 里。
 * recall 的「还压在心上」就是从这里来的，强度 ≥2 才算「还压着」。
 *
 * 和 recentEvents 的分工：
 *   recentEvents  30 分钟内   → 进注入块（「刚才的事还留在心里：…」），带情绪余温
 *   anchors       5 天半衰期  → 进上下文但更淡（「这阵子老是…」），改底色倾向
 */

/** 半衰期（天）。文档实测值：5 天。 */
const HALF_LIFE_MS = 5 * 86_400_000
/** 单方向最多留几个（正面 / 负面各算）。 */
const MAX_PER_TONE = 8
/** 总上限，防止 state 无限增长。 */
const MAX_TOTAL = 12
/** 低于这个强度就不算锚点，直接丢 —— 打卡式的「嗯」「哦」不该留下。 */
const MIN_STRENGTH = 0.8

/**
 * 一个事件能留下多强的锚点。
 *
 * 用事件表里的 dims 绝对值之和除以一个基准 —— 改得越狠，刻得越深。
 * 实测（2026-11-10 再平衡后重算）：gift 0.55（低于门槛 0.8，永远不存）·
 *   apologize 1.05 · protect 1.2 · promise 1.45 · praise 1.55 · cold 1.8 ·
 *   comfort 2.0 · blame 3.0 · leave 4.6 · climax 18.8
 * 再平衡（正向 ×0.6 / 负向 ×1.4）之后整体都降了，门槛 0.8 卡掉的更多 ——
 * 这也是 recall 改用结构化日记、不再靠锚点列事件的原因之一。
 *
 * @param {object} dims  EVENTS[name].dims
 * @returns {number} 0 以上的强度，通常 1~6
 */
export function anchorStrength(dims) {
  if (!dims || typeof dims !== 'object') return 0
  let sum = 0
  for (const v of Object.values(dims)) {
    const n = Number(v)
    if (Number.isFinite(n)) sum += Math.abs(n)
  }
  return Math.round((sum / 2) * 100) / 100
}

/**
 * 写一个锚点进 state（不可变：返回新数组）。
 *
 * 同名事件不叠加成多条 —— 更新那条的时间和强度即可。
 * 人不会因为「被冷落三次」就在心里存三个一模一样的怨恨。
 *
 * @param {Array} anchors  现有的 state.anchors
 * @param {string} name    事件名
 * @param {string} tone    事件的好坏（'good' | 'bad'）
 * @param {number} strength 强度（见 anchorStrength）
 * @param {number} now     当前时间戳
 * @returns {Array} 新的 anchors（已按强度和时间裁剪）
 */
export function addAnchor(anchors, name, tone, strength, now = Date.now(), detail = '') {
  const list = Array.isArray(anchors) ? anchors.slice() : []
  if (!name || !(strength >= MIN_STRENGTH)) return pruneAnchors(list, now)
  // 2026-11-10：tone 必须是 good 或 bad。
  // stop 的 tone 是空字符串（它不算好也不算坏，只让插件暂停），
  // 原来的 `tone === 'good' ? 'good' : 'bad'` 会把空串当 'bad'，
  // 而 stop 的强度 26 是所有事件里最高的 —— 安全词会变成最重的负面锚点。
  // fireEvent 那边已经挡了一道，这里再挡一道，免得别的调用点绕过去。
  if (tone !== 'good' && tone !== 'bad') return pruneAnchors(list, now)

  const key = String(name)
  // 2026-11-10（外部审计）：原话要先压掉空白字符，不然带换行会把一条拆成两行。
  // diary.js:94 早就这么做了，这里漏了。
  const said = String(detail ?? '').replace(/\s+/g, ' ').trim().slice(0, 120)
  const idx = list.findIndex((a) => a?.name === key)
  if (idx >= 0) {
    // 同名：取更强的那个，时间刷成最新的，原话取最新的一句
    list[idx] = {
      name: key,
      tone: tone === 'good' ? 'good' : 'bad',
      at: now,
      // 2026-11-10（审计 A05）：原来取的是**原始值**的 max，于是 5 天半衰期被「同名刷新」抵消 ——
      // leave(6.8) 在 4.9 天后衰减到 3.4，只要再来一条弱同名事件（强度 2）就把 at 刷成 now、
      // strength 回到 6.8。同一件事 5 天内出现一次，强度就恒等于历史最高值，永不衰减。
      // 改成按**衰减后的现值**取 max：重复事件只能「续命」，不能「回满」。
      strength: Math.max(decayedStrength(list[idx], now), strength),
      detail: said || String(list[idx]?.detail ?? ''),
    }
    return pruneAnchors(list, now)
  }

  list.push({ name: key, tone: tone === 'good' ? 'good' : 'bad', at: now, strength, detail: said })
  return pruneAnchors(list, now)
}

/**
 * 计算一个锚点现在的强度（5 天半衰期）。
 * @param {object} anchor {at, strength}
 * @param {number} now
 */
export function decayedStrength(anchor, now = Date.now()) {
  const base = Number(anchor?.strength) || 0
  if (!(base > 0)) return 0
  const age = Math.max(0, now - (Number(anchor?.at) || 0))
  const halfLives = age / HALF_LIFE_MS
  return Math.round(base * Math.pow(0.5, halfLives) * 100) / 100
}

/**
 * 裁掉衰减到没意义的、超出上限的。
 * 正的负的各留 MAX_PER_TONE 个，总数不超过 MAX_TOTAL，按「现在的强度」排。
 */
export function pruneAnchors(anchors, now = Date.now()) {
  const list = (Array.isArray(anchors) ? anchors : [])
    .filter((a) => a && a.name && decayedStrength(a, now) >= MIN_STRENGTH * 0.35)
    .map((a) => ({ ...a, decayed: decayedStrength(a, now) }))
    .sort((x, y) => y.decayed - x.decayed)

  const kept = []
  const perTone = { good: 0, bad: 0 }
  for (const a of list) {
    const tone = a.tone === 'good' ? 'good' : 'bad'
    if (perTone[tone] >= MAX_PER_TONE) continue
    if (kept.length >= MAX_TOTAL) break
    perTone[tone]++
    kept.push({ name: a.name, tone: a.tone, at: a.at, strength: a.strength, detail: a.detail ?? '' })
  }
  return kept
}

/**
 * 当前还活着的锚点（按现强度降序）。
 * @returns {Array<{name, tone, at, strength, decayed}>}
 */
export function activeAnchors(state, now = Date.now()) {
  const list = (Array.isArray(state?.anchors) ? state.anchors : [])
    .map((a) => ({ ...a, decayed: decayedStrength(a, now) }))
    .filter((a) => a.decayed >= MIN_STRENGTH * 0.5)
    .sort((x, y) => y.decayed - x.decayed)
  return list
}

/**
 * 注入用的一句话。没锚点返回空串（调用方直接拼，不会多出空行）。
 *
 * 写法遵循文档 5 节：不给情绪名、不给分数，只说「最近老是」这件事本身。
 * 强度按衰减后的值分档：≥2.5 说重一点，1~2.5 说淡一点。
 *
 * @param {object} state
 * @param {object} events  EVENTS 表（拿 note）
 * @param {number} now
 * @returns {string} 例：「这阵子老是：被冷了一下，热乎劲退了；你道过歉，气消了一半。\n」
 */
export function anchorLine(state, events, now = Date.now()) {
  const live = activeAnchors(state, now)
  if (!live.length) return ''

  // 只取最强的两条：多了就变成流水账，反而稀释
  const top = live.slice(0, 2)
  const notes = top.map((a) => {
    const note = events?.[a.name]?.note
    return note ? String(note) : ''
  }).filter(Boolean)
  if (!notes.length) return ''

  const heaviest = top[0].decayed
  const lead = heaviest >= 2.5 ? '这阵子一直压着：' : '最近心里有点：'
  return `${lead}${notes.join('；')}。\n`
}
