/**
 * 回想（recall）：纯函数，输入数据、输出文本，不读盘、不看全局。
 *
 * 为什么抽出来：它原来长在 index.js 的工具分支里（200 行），
 * 参数解析、时间格式化、数据筛选、文案拼装全糊在一起，
 * 没法单独测，改一处要看三遍。抽出来之后 test/recall.test.mjs 能直接喂数据。
 *
 * 数据源（2026-11-10 改，采纳外部审计建议）：
 *   ① **结构化日记** `心情日记.json` —— 每次事件单独一条 {t, e, note, detail?, n}，
 *      按天分 up/down 两栏，保留 30 天。**它才是「发生过什么」的事实来源。**
 *   ② 事件锚点 state.anchors —— 同名会合并、有 5 天半衰期。
 *      用来标「这件事还压在心上（强度高）/ 已经淡了（强度低）」，不用来列事件。
 *
 * 以前 recall 只查 ① 的一半（读 md 自由文本）和 ②，结果是：
 *   - 三天里被冷落三次只剩一条（锚点合并）
 *   - 原话和时间对不上（同名刷新时沿用旧 detail）
 *   - gift 强度 0.75 低于门槛，从来不存
 *   - stop 的 tone 是空字符串，被当成负面锚点
 * 换成结构化日记之后这四个问题一起消失。
 */

/** 回想用的过去式文案：EVENTS 里的 note 都是「刚被夸过」这种现在时，放进「3 天前」会错位。 */
const PAST_FALLBACK = {
  praise: '被他夸过',
  comfort: '被他哄过',
  intimate: '被他碰过',
  desire: '被他要过',
  protect: '被他护着过',
  apologize: '他道过歉',
  promise: '他许诺过',
  tease: '被他撩过',
  gift: '收过他的东西',
  coax: '被他哄软过',
  cold: '被他冷过',
  reject: '被他拒过',
  ignore: '被他晾过',
  neglect: '被他无视过',
  mentionOther: '他提过别人',
  compare: '他拿你比较过',
  blame: '被他怪过',
  lie: '被他骗过',
  leave: '他说过要走',
  force: '他硬来过',
  bodyShame: '被他说过羞',
  climax: '做过一次',
}

/**
 * 解析 since。
 *
 * 单位：h 小时 / d 天 / w 周 / m **分钟**（不是月 —— 模型写 30m 想的是半小时）。
 * 要查月请用 4w。
 *
 * @returns {number|null} 毫秒跨度；解析不了返回 null（调用方要报错，不能静默兜底）
 */
export function parseSince(raw, now = Date.now()) {
  const s = String(raw ?? '').trim()
  if (!s) return 3 * 86_400_000 // 默认 3 天
  const m = s.match(/^(\d+(?:\.\d+)?)\s*(h|d|w|m)$/i)
  if (!m) return null
  const n = Number(m[1])
  if (!Number.isFinite(n) || n <= 0) return null
  const unit = m[2].toLowerCase()
  const span = unit === 'h' ? n * 3_600_000
    : unit === 'd' ? n * 86_400_000
      : unit === 'w' ? n * 7 * 86_400_000
        : n * 60_000 // m = 分钟
  // 上限 90 天，超过就当解析失败（防止 999999d 把整个日记扫一遍）
  return span > 90 * 86_400_000 ? null : span
}

const dayStart = (x) => {
  const d = new Date(x)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/**
 * 时间标签，**按日历日算**。
 *
 * 以前是「过了几个 24 小时」+「几点几分」拼在一起，两个不是一套算法：
 * 07:44 回看 36 小时前的事会写成「1 天前 19:44」（其实那是前天 19:44），
 * 凌晨 01:00 回看昨晚 23:00 会写成「23:00」（看起来像今天还没到的时间）。
 */
export function timeLabel(t, now = Date.now()) {
  const d = new Date(t)
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  const diff = Math.round((dayStart(now) - dayStart(t)) / 86_400_000)
  if (diff <= 0) return `今天 ${hm}`
  if (diff === 1) return `昨天 ${hm}`
  if (diff === 2) return `前天 ${hm}`
  return `${diff} 天前 ${hm}`
}

/** 双字组打分（中文不分词）。单字 query 退化成包含判定。 */
function bigrams(s) {
  const t = String(s ?? '').replace(/[\s，。！？、,.!?"“”「」（）()【】\[\]：:；;…—\-]/g, '')
  if (t.length <= 1) return new Set(t ? [t] : [])
  const out = new Set()
  for (let i = 0; i + 1 < t.length; i++) out.add(t.slice(i, i + 2))
  return out
}

function relevance(text, query) {
  const q = String(query ?? '').trim()
  if (!q) return 0
  if (q.length === 1) return String(text ?? '').includes(q) ? 1 : 0
  const a = bigrams(q)
  if (!a.size) return 0
  const b = bigrams(text)
  let hit = 0
  for (const g of a) if (b.has(g)) hit++
  return hit / a.size
}

/** 日期键（YYYY-M-D，和 diary.js 的 todayKey 对齐 —— 它没补零）。 */
function dayKeyOf(ts) {
  const d = new Date(ts)
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

/**
 * 回想主函数。
 *
 * @param {object} input
 * @param {object} input.diary    心情日记.json 的结构 {days: {'2026-11-9': {up:[], down:[]}}}
 * @param {Array}  [input.anchors] state.anchors（只用来标"还压着"）
 * @param {object} input.params   { since, tone, query, source, limit }
 * @param {number} [input.now]
 * @param {object} [input.events] EVENTS 表（拿 note / past）
 * @returns {{ok: boolean, text: string, count: number, error?: string}}
 */
export function recall({ diary, anchors = [], params = {}, now = Date.now(), events = {} } = {}) {
  const rawSince = String(params?.since ?? '').trim()
  const span = parseSince(rawSince, now)
  if (span === null) {
    // 明确报错，不要静默按 3 天查 —— 那样她会把「7 内没有记下来的事」当成事实
    return {
      ok: false,
      count: 0,
      text: `看不懂这个时间：「${rawSince}」。用 3h（小时）/ 2d（天）/ 1w（周）/ 30m（分钟）。`,
      error: 'bad-since',
    }
  }

  const wantTone = String(params?.tone ?? '').toLowerCase()
  if (wantTone && wantTone !== 'good' && wantTone !== 'bad') {
    return {
      ok: false,
      count: 0,
      text: `tone 只能填 good 或 bad，收到的是「${params.tone}」。`,
      error: 'bad-tone',
    }
  }

  const wantSource = String(params?.source ?? 'all').toLowerCase()
  if (!['all', 'diary', 'anchor'].includes(wantSource)) {
    return {
      ok: false,
      count: 0,
      text: `source 只能填 all / diary / anchor，收到的是「${params.source}」。`,
      error: 'bad-source',
    }
  }

  const query = String(params?.query ?? '').trim()
  const limit = Math.max(1, Math.min(20, Number(params?.limit) || 8))
  const from = now - span

  // ── 收集事件（来源：结构化日记，按天分栏）──
  const entries = []
  if (wantSource !== 'anchor') {
    const days = diary?.days && typeof diary.days === 'object' ? diary.days : {}
    for (const [key, day] of Object.entries(days)) {
      for (const [bucket, list] of [['good', day?.up], ['bad', day?.down]]) {
        if (!Array.isArray(list)) continue
        if (wantTone && bucket !== wantTone) continue
        for (const e of list) {
          const t = Number(e?.t)
          if (!Number.isFinite(t) || t < from || t > now + 60_000) continue
          const name = String(e?.e ?? '')
          const note = String(e?.note ?? '')
          const past = String(events?.[name]?.past ?? PAST_FALLBACK[name] ?? note)
          const detail = String(e?.detail ?? '').replace(/\s+/g, ' ').trim()
          const times = Math.max(1, Number(e?.n) || 1)
          entries.push({ t, name, tone: bucket, text: past || note, detail, times, day: key })
        }
      }
    }
  }

  // 给了 query 就按字面筛（同时看回想文案和原话）
  const scoped = query
    ? entries.filter((e) => relevance(e.text + ' ' + e.detail, query) > 0)
    : entries
  const sorted = scoped.sort((a, b) => b.t - a.t)

  // ── 锚点只用来标「还压着」──
  const anchorMap = new Map()
  if (wantSource !== 'diary' && Array.isArray(anchors)) {
    for (const a of anchors) {
      const name = String(a?.name ?? '')
      const at = Number(a?.at)
      if (!name || !Number.isFinite(at) || at < from || at > now + 60_000) continue
      if (wantTone && (a?.tone === 'good' ? 'good' : 'bad') !== wantTone) continue
      const prev = anchorMap.get(name)
      const strength = Math.max(0, Number(a?.strength) || 0)
      if (!prev || at > prev.at) anchorMap.set(name, { at, strength })
    }
  }

  const parts = []
  if (sorted.length) {
    const lines = sorted.slice(0, limit).map((e) => {
      const mark = e.tone === 'good' ? '＋' : '－'
      const times = e.times > 1 ? ` ×${e.times}` : ''
      const said = e.detail ? `｜他说「${e.detail}」` : ''
      return `${mark} ${timeLabel(e.t, now)} · ${e.text}${times}${said}`
    })
    parts.push(`【记下来的 ${sorted.length} 件事】\n${lines.join('\n')}`)
  }

  // 还压在心上的（锚点强度高 = 没淡；只列跟前面对得上的，不重复列事件）
  // 2026-11-10：query 是"按关键词找"，锚点不响应关键词 ——
  // 查「抱」没命中事件时，不该拿一堆跟「抱」无关的"还压着"充数。
  let heavyCount = 0
  if (wantSource === 'anchor' || (anchorMap.size && !sorted.length && !query)) {
    const heavy = [...anchorMap.entries()]
      .filter(([, v]) => v.strength >= 2)
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, limit)
    heavyCount = heavy.length
    if (heavy.length) {
      const lines = heavy.map(([name, v]) => {
        const past = String(events?.[name]?.past ?? PAST_FALLBACK[name] ?? events?.[name]?.note ?? name)
        return `· ${timeLabel(v.at, now)} · ${past}（还压着）`
      })
      parts.push(`【还压在心上】\n${lines.join('\n')}`)
    }
  }

  if (!parts.length) {
    const spanText = rawSince || '3d'
    const toneText = wantTone ? `（只看${wantTone === 'good' ? '好的' : '不好的'}）` : ''
    const queryText = query ? `（关键词「${query}」）` : ''
    return { ok: true, count: 0, text: `最近 ${spanText} 里没有记下来的事${toneText}${queryText}。` }
  }

  // count = 总共找到多少条（和标题里那个数字一致）。
  // limit 只控制列几行，不影响 count。
  // heavyCount 是 source=anchor 时补的：那时事件 0 条但有锚点输出，
  // 返回 0 会让人以为没查到。
  return { ok: true, count: sorted.length + heavyCount, text: parts.join('\n\n') }
}
