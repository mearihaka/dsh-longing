/**
 * 行为参数：不掉 token 的那一半。
 *
 * 借鉴自《情绪系统设计参考》第六章：
 *
 *   这些参数只影响「怎么说」，不影响「说什么」。
 *   角色仍然可以心情极差但说一句很温柔的话——那才是人。
 *
 * 我们原来完全没有这一层。注入块里那几百字变了，可她说话的长度、分段、
 * 语气词、接不接话全都不变 —— 状态只是"台词里说说"，落不到行为上。
 *
 * 文档的公式：
 *   energy   = 0.5 + 0.30×效价 + 0.22×(底色-60)/40
 *   chars    = 16 + 20×energy          单条字数上限
 *   segments = 1 + 1.8×energy          分几条发
 *
 * 那套参数是按它自己的 14 维算的，我们的七维对不上。这里按同样的思路重推：
 *   效价 ≈ 好的那些（好感/想要）− 累的那些（疲劳/抗拒/羞）
 *
 * 另一件事：文档 3.3 第 5 条的「内容门闩」——
 *   把语气当内容，每句短句都判成「担心」，准确率只有 7.8%。
 * 所以「嗯」「哦」「随便」这种整句语气词**不该记事件**（不该改数值），
 * 只该压低 energy、拉高沉默概率。这一层就是它的去处。
 */

/** 七维当前值 → 一个 -1..1 的效价。 */
export function valenceOf(state) {
  const n = (v, d = 50) => {
    const x = Number(v)
    return Number.isFinite(x) ? x : d
  }
  // 好的：好感最重，想要次之，色情再次
  const good = (n(state?.affection) * 0.5 + n(state?.lust, 30) * 0.3 + n(state?.lewd, 35) * 0.2) / 100
  // 累的：疲劳最重，抗拒次之，羞再轻一点（羞不一定是坏事，但会让人缩）
  const tired = (n(state?.fatigue, 20) * 0.5 + n(state?.resist, 55) * 0.3 + n(state?.shame, 40) * 0.2) / 100

  // 2026-11-10（审计 F22）：全 0 不等于中性。
  // 七维全 0 时 good=0、tired=0、差也是 0 → 会算出 energy=0.5（"不冷不热"），
  // 但那其实是**麻木**：什么都没感觉。麻木的人话是少的，不是刚刚好。
  // 全 100（又想要又累又抗拒）反而真的是中性 —— 各种力量互相抵消，瘫在那儿。
  // 所以只在"两边都极低"时补一个负偏置。
  const flat = good + tired < 0.2 ? -0.4 : 0
  return Math.max(-1, Math.min(1, good - tired + flat))
}

const clamp01 = (v, lo = 0.05, hi = 0.95) => Math.max(lo, Math.min(hi, v))

/**
 * 算出一组行为参数。
 *
 * @param {object} state 七维状态
 * @param {object} [cfg] 配置（暂时没用到，留着给以后调系数）
 * @returns {{
 *   energy: number, chars: number, segments: number,
 *   particles: number, replyP: number, stickerP: number,
 *   tone: 'warm'|'flat'|'low'
 * }}
 */
export function behaviorOf(state, cfg = {}) {
  const valence = valenceOf(state)
  // 0.5 是中位；效价拉满也只到 0.9 / 0.1 —— 不给极端值，
  // 极端会让她要么像打了鸡血要么像断线，都不是人
  const energy = clamp01(0.5 + 0.4 * valence)

  return {
    energy: Math.round(energy * 100) / 100,
    chars: Math.round(16 + 20 * energy),
    segments: Math.max(1, Math.round(1 + 1.6 * energy)),
    // 语气词密度：话多的时候「啊/吧/呢/嘛」自然多，话少的时候几乎没有
    particles: Math.round((0.15 + 0.6 * energy) * 100) / 100,
    // 接话概率：心情差更容易已读不回（文档 reply_p）
    replyP: Math.round((0.55 + 0.4 * energy) * 100) / 100,
    stickerP: Math.round((0.08 + 0.5 * energy) * 100) / 100,
    tone: energy > 0.6 ? 'warm' : energy > 0.35 ? 'flat' : 'low',
  }
}

/**
 * 注入块里那一行（遵守文档「每轮最多 25 字」的约定）。
 *
 * 只说「怎么说」，绝不说「你现在是什么情绪」——
 * 一旦出现「你有点低落」这种标签，就变成让她念稿了。
 *
 * @returns {string} 带换行；不需要调整时返回空串
 */
export function behaviorLine(state, cfg = {}) {
  const b = behaviorOf(state, cfg)
  if (b.tone === 'warm') return '这会儿话可以多一点，想说什么就多说两句。\n'
  if (b.tone === 'low') return '这会儿话少，一两句就够，别硬凑。\n'
  return ''
}

/**
 * 语气信号：整句就一个语气词的「嗯」「哦」「随便」这类。
 *
 * 它们**不构成情绪**（文档 3.3 第 5 条的内容门闩），
 * 但确实是「心力低」的证据 —— 所以只压 energy，不记事件。
 *
 * @param {string} text
 * @returns {boolean}
 */
export function isFlatReply(text) {
  const t = String(text ?? '').trim()
  if (!t || t.length > 6) return false
  return /^(嗯+|哦+|呃+|啊+|呵+|好|行|ok|OK|可以的|还行|随便|都行|无所谓)[。.!！?？…~\s]*$/.test(t)
}
