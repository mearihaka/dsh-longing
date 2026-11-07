/**
 * 好奇心与自主搜索（2026-11-06 新增）。
 *
 * 解决的是另一个问题：以前的「主动开口」只有 Lust/Lewd 两个动机，
 * 数值一被满足就掉下去 —— 陪得越久越不会被主动找，正好反着来。
 * 好奇心不看亲密，只看「多久没换过新东西」。
 *
 * 三件事：
 *   1. tickCurio —— 涨/落，纯数值，不联网
 *   2. shouldSearch —— 到点了才放行（冷却 / 每日上限 / 时段）
 *   3. searchTopic —— 真去搜，抓回来一条，做成 pendingTopic
 *
 * 设计约束：
 *   · 搜索绝不塞进心跳本身，只在「判定要搜」那一步发一次请求
 *   · 单次最多 2 个 query，一天最多 perDay 次
 *   · 拿到的话题不自动说话，只挂起来等下一次主动开口
 */

/** 好奇心参数默认值。面板上那几个键覆盖它。 */
export const CURIO_DEFAULTS = {
  curioStart: 30, // 初始值
  curioGainPerHour: 14, // 一小时没新东西能涨多少
  curioDropOnTalk: 10, // 说过一次话就掉多少
  curioSearchAt: 65, // 涨到多少才去搜
  curioCooldownMin: 90, // 两次搜索至少隔多久
  curioPerDay: 6, // 一天最多搜几次
  curioEnabled: false, // 默认关：公共版默认不联网，用户显式打开才去搜
}

const clamp100 = (v) => Math.max(0, Math.min(100, Number(v) || 0))

/**
 * 心跳里调：只算数值，不联网。
 * @param {object} state 欲望状态（会被读 curio / lastContactAt / searchLog）
 * @param {object} cfg   面板配置
 * @param {number} now
 * @returns {{curio: number, want: boolean, why: string}}
 */
export function tickCurio(state, cfg = {}, now = Date.now()) {
  const on = cfg?.curioEnabled !== false
  if (!on) return { curio: num(state?.curio, CURIO_DEFAULTS.curioStart), want: false, why: 'off' }

  const gainPerHour = num(cfg?.curioGainPerHour, CURIO_DEFAULTS.curioGainPerHour)
  const dropOnTalk = num(cfg?.curioDropOnTalk, CURIO_DEFAULTS.curioDropOnTalk)
  let curio = num(state?.curio, CURIO_DEFAULTS.curioStart)

  // 距上次「有新输入」（他说话 / 上次搜索）过了多久。
  // 注意 curioAt 是「上次算好奇心的时刻」，每次 tick 都会被刷新，
  // 所以这里的 hours 实际上恒等于「距上一 tick 的间隔」（约 1 分钟）——
  // 累加靠每分钟叠一次，不靠一次乘个大的。
  const last = Math.max(num(state?.lastContactAt, 0), num(state?.lastSearchAt, 0), num(state?.curioAt, now))
  const hours = Math.max(0, (now - last) / 3_600_000)
  curio = clamp100(curio + gainPerHour * hours)

  // 刚说过话掉一点 —— 但**只掉一次**。
  // 原来的写法是「只要 5 分钟内说过话就扣」，而 tick 是一分钟一次，
  // 于是连着聊 5 分钟会扣 5 次（50 点），curio 直接被扣到 0，再也涨不回来。
  // 现在加一道闸：距上次扣值至少 15 分钟。
  const dropGateMin = 15
  const lastDrop = num(state?.curioDropAt, 0)
  let dropAt = lastDrop
  if (now - num(state?.lastContactAt, 0) < 5 * 60_000 && now - lastDrop > dropGateMin * 60_000) {
    curio = clamp100(curio - dropOnTalk)
    dropAt = now
  }

  const at = num(cfg?.curioSearchAt, CURIO_DEFAULTS.curioSearchAt)
  return { curio, want: curio >= at, why: curio >= at ? 'threshold' : 'idle', dropAt }
}

/**
 * 能不能搜。所有门都在这里，心跳只管调。
 * @returns {{ok: boolean, why: string, next?: number}}
 */
export function shouldSearch(state, cfg = {}, now = Date.now()) {
  // 失败即关闭：只有显式 true 才允许联网。少一个键、配置没解析出来、老版本升级上来
  // 少写了这一项——一律当「关」，绝不因为「没读到」就去发请求。
  if (cfg?.curioEnabled !== true) return { ok: false, why: 'off' }

  // 暂停 / 时段
  if (num(state?.pausedUntil) > now) return { ok: false, why: 'paused' }

  const cd = num(cfg?.curioCooldownMin, CURIO_DEFAULTS.curioCooldownMin)
  const lastSearch = num(state?.lastSearchAt, 0)
  if (lastSearch && now - lastSearch < cd * 60_000) {
    return { ok: false, why: 'cooldown', next: lastSearch + cd * 60_000 }
  }

  // 每日上限：按滚动的 24 小时算，不按自然日（跨零点不该翻倍）
  const perDay = num(cfg?.curioPerDay, CURIO_DEFAULTS.curioPerDay)
  const log = Array.isArray(state?.searchLog) ? state.searchLog.map(Number).filter((t) => now - t < 86_400_000) : []
  if (perDay > 0 && log.length >= perDay) {
    return { ok: false, why: 'daily', next: log[0] + 86_400_000 }
  }

  return { ok: true, why: 'ok' }
}

const STOP = new Set(
  ('我 你 他 她 它 的 了 吗 呢 啊 吧 呀 这 那 个 是 就 都 也 还 不 在 有 和 跟 把 被 让 给 对 从 到 很 太 好 要 会 能 想 说 一个 什么 怎么 这样 那样 现在 今天 明天 昨天 一下 一点 真的 可以 已经 还是 就是 是不是 有没有')
    .split(/\s+/)
    .filter(Boolean),
)

/**
 * 从最近一句话里抠出能搜的东西。抠不到就往话题池退。
 * 抠法刻意简单：中文没有空格，靠「连续汉字块 + 停用词过滤」比什么都稳。
 */
export function buildQuery(state, cfg = {}, seed = 1) {
  const raw = String(state?.lastUserText ?? '')
    .replace(/\[[^\]]*\]/g, ' ') // 去掉 [图片] 这类占位
    .replace(/https?:\/\/\S+/g, ' ')
    .trim()

  // 英文词、书名号、引号里的东西优先 —— 那通常就是要查的主题
  const quoted = raw.match(/[《「『"“]([^》」』"”]{2,20})[》」』"”]/)
  if (quoted) return quoted[1]

  const en = raw.match(/[A-Za-z][A-Za-z0-9_.+-]{2,24}/)
  // 中文这边宁可少取：连续汉字块切得太粗，「早上你自己说的」整块都会被当成词。
  // 只留 2~4 字、不含人称和语气词、不像动词短语的短块。
  const blocks = (raw.match(/[\u4e00-\u9fa5]{2,12}/g) ?? []).filter(
    (w) =>
      w.length >= 2 &&
      w.length <= 4 &&
      !STOP.has(w) &&
      !/[我你他她它咱自己说想得要那这得挺很太蛮超]/u.test(w),
  )

  // 有英文/技术词就以它为主 —— 那是他真在讲的东西，搜它有结果
  let q = ''
  if (en) {
    const zh = blocks.slice(-1).join(' ')
    q = zh ? `${en[0]} ${zh}` : en[0]
  } else if (blocks.length) {
    q = blocks.slice(-2).join(' ')
  }

  // 抠出来的是她自己的名字/撒娇词，搜了没意义 —— 退回去搜宽一点的
  const name = String(cfg?.personaName ?? '')
  const junk = /^(mua|嗯+|啊+|哈+|呜+|唔+)/i
  if (q && ((name && q.includes(name)) || junk.test(q))) q = ''

  if (q) return q

  // 什么都没有：退到话题池（不硬凑具体内容，让它搜宽一点的）
  const pool = Array.isArray(cfg?.curioTopics) && cfg.curioTopics.length ? cfg.curioTopics : ['今天有什么新东西', '最近科技新闻']
  return pool[Math.abs(Math.floor(seed)) % pool.length]
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

const stripTags = (s) =>
  String(s ?? '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&ensp;/g, ' ')
    .replace(/&emsp;/g, ' ')
    .replace(/&#0183;/g, '·')
    .replace(/&#\d+;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()

/**
 * 真去搜。Bing 国内直连、不需要 key —— 和 qq_web_search 走同一条路。
 * @returns {Promise<Array<{title: string, snippet: string, url: string}>>}
 */
export async function searchTopic(query, { limit = 5, timeoutMs = 12000 } = {}) {
  // Bing 会把连字符拆成两个词（「Z-Image」→ 搜「Z」），所以先拼起来，
  // 其他符号一律当分隔符。留数字和汉字，别把 GGUF / 4B 这种搞丢。
  const q = String(query ?? '')
    .replace(/-/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!q) return []
  const url = `https://cn.bing.com/search?q=${encodeURIComponent(q)}&setlang=zh-CN&form=QBLH`
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9' },
      signal: ac.signal,
    })
    if (!res.ok) return []
    const html = await res.text()
    const out = []
    for (const m of html.matchAll(/<li class="b_algo"[\s\S]*?(?=<li class="b_algo"|<\/ol>)/g)) {
      const block = m[0]
      const a = block.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/)
      if (!a) continue
      const p = block.match(/<p[^>]*>([\s\S]*?)<\/p>/)
      const title = stripTags(a[2])
      const snippet = stripTags(p?.[1] ?? '')
      if (!title) continue
      out.push({ title, snippet, url: a[1] })
      if (out.length >= limit) break
    }
    return out
  } catch {
    return []
  } finally {
    clearTimeout(timer)
  }
}

/** 把搜到的一条压成「一句话话题」，注入时只给这一句，不给整段摘要。 */
export function toTopic(results, seed = 1) {
  if (!Array.isArray(results) || results.length === 0) return null
  const r = results[Math.abs(Math.floor(seed)) % Math.min(results.length, 3)]
  const snippet = String(r.snippet ?? '').slice(0, 90)
  return {
    title: String(r.title ?? '').slice(0, 60),
    snippet,
    url: String(r.url ?? '').slice(0, 300),
    at: Date.now(),
  }
}

function num(v, d = 0) {
  const n = Number(v)
  return Number.isFinite(n) ? n : d
}
