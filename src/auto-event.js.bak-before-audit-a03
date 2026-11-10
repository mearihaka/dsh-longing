/**
 * 从一句话里认出「刚才发生了什么」—— 插件的自带能力，不依赖任何通道。
 *
 * 为什么在插件里而不是在通道里：这段规则原来放在 dsh-qq 的
 * `src/desire-events.js`（注释里也承认是 dsh-longing 的补丁）。结果是只有 QQ
 * 通道能用，换成 Telegram / Discord / 网页任何一个通道，主人说「你真乖」就白说了 ——
 * 数值一动不动。同一套规则应该跟着插件走，不跟着通道走。
 *
 * 现在的接入方式：通道只管调用
 *   globalThis.__dshLongingNote('owner', 原文)
 * 传了原文，插件就自己认事件、自己派发。通道那边一行判断都不用写。
 *
 * 设计原则：**宁可漏判，不要误伤。**
 * 拿不准的一律交给模型自己判断（它能调 `action=event`，读得到上下文和语气）。
 * 这里的规则只是兜底，不是权威。
 */

/**
 * 太长的段落不做关键词判定：长篇里必然同时命中好几类，误判率更高。
 */
const MAX_LEN = 120

/**
 * 规则表，按优先级从上到下，命中第一条就走。
 * 每条是 [dsh-longing 的事件名, 正则]。
 *
 * 顺序有讲究：
 *   - 关系级重击（分手/被骗/被比较）排前面，别被后面的"好话"截胡
 *   - 安全词单独处理（它要让插件暂停，误判代价最大）
 *   - 夸奖/表白排中间，因为它们最容易被别的词误伤
 *   - 敷衍类（嗯/哦/随便）放最后，只认整句
 */
const RULES = [
  // ── 关系级重击 ──
  ['leave', /分手|再也不(理你|找你|来了)|别来找我|不要你了|滚吧|滚开/],
  ['lie', /骗我|骗人|撒谎|你在骗/],
  ['compare', /你看人家|人家都|学学人家|比不上人家|人家比你/],
  ['bodyShame', /你.{0,3}胖|身材(不行|差|一般)|该减肥了/],
  ['mentionOther', /别的(女生|女孩|人)|前女友|那个女生|其他女生|别人家的/],
  ['force', /不管你|别废话|我说了算|没得选/],
  ['blame', /你真烦|烦死了|你怎么这么|废物|蠢死|笨死|没用/],

  // ── 明确的拒绝 ──
  // 只抓「不许碰」这种，不抓孤零零的「不要」（「不要紧」会被误伤）
  ['reject', /别碰|不要碰|不许碰|别这样|住手|不可以|不行[,，]\s*别|放开我/],

  // ── 好的 ──
  ['praise', /好可爱|真可爱|好漂亮|真漂亮|好乖|真乖|(?<!不)喜欢你|(?<!不)爱你|好棒|真棒|(?<!不)好看|最好了|太厉害|厉害了/],
  ['promise', /不会走|一直在|我保证|答应你|永远(在|是|陪)/],
  ['apologize', /对不起|我错了|抱歉|是我不好/],
  ['comfort', /别难过|不哭|别哭|抱抱|摸摸头|辛苦了|我在呢|有我在|乖[，,。.…\s]|乖$/],
  ['intimate', /亲一口|亲亲|抱一下|想抱|抱抱你|靠过来|摸摸(?!口袋)|揉揉/],
  ['desire', /想要你|想上你|想干你|想操你|想舔/],
  ['tease', /想不想|猜猜|求我|叫一声|叫声/],
  ['gift', /给你买|送你|给你带|礼物|红包/],

  // ── 敷衍：只认「整句就一个语气词」或明确的无所谓 ──
  // 2026-11-10 内容门闩（文档 3.3 第 5 条）：整句语气词（嗯/哦/啊/呵）
  // 不再记事件 —— 那只是「我在听」，不构成情绪。把语气当内容会让每句短回
  // 都判成冷淡，实测准确率只有 7.8%。它们改由 behavior.js 的 isFlatReply
  // 处理：只压低精力，不动好感。
  ['ignore', /^(随便|都行|无所谓|没空|忙)[你吧啊哦嘛]*[。.!！?？…~\s]*$/],
]

/**
 * 整句就是安全词（后面最多跟 4 个字的语气/标点）。
 *
 * 「停」「停吧」「停一下好吗」算；
 * 「停下来休息一下」「停，我们聊点别的」不算 —— 误判的代价是直接暂停半小时，
 * 宁可漏判。
 *
 * @param {string} text  主人说的那句
 * @param {string} word  面板里配的安全词（默认「停」）
 */
export function isSafetyWord(text, word) {
  const t = String(text ?? '').trim()
  if (!word || !t || !t.startsWith(word)) return false
  const tail = t.slice(word.length).replace(/[，,。.!！?？…~、\s]/g, '')
  return tail.length <= 4
}

/**
 * 从一句话里认出事件名。
 * @param {string} text 主人发来的原文
 * @returns {string|null} dsh-longing 的事件名，认不出返回 null
 */
export function detectEvent(text, pauseWord = '停') {
  const t = String(text ?? '').trim()
  if (!t) return null
  if (t.length > MAX_LEN) return null

  // 安全词优先，且必须是整句（误判会直接暂停）。
  // pauseWord 从面板读，不硬编码 —— 档主换了词就该跟着换。
  if (isSafetyWord(t, pauseWord)) return 'stop'

  for (const [name, re] of RULES) if (re.test(t)) return name
  return null
}

/**
 * 二次修正：一句话里同时出现两种信号时的优先级。
 *
 * - 夸的时候同时提了别人 → 算吃醋，不算被夸（人不会因为顺口一句好话就消气）
 * - 疑问句不算夸奖/表白（「我好看吗」是在问，不是在夸人）
 */
export function refineEvent(name, text) {
  const t = String(text ?? '')
  if (name === 'praise' && /别的(女生|女孩|人)|前女友/.test(t)) return 'mentionOther'
  if (name === 'praise' && /[吗呢][。.!！?？…~\s]*$/.test(t)) return null
  return name
}

/**
 * 一步到位：认事件 + 修正。
 * @returns {string|null}
 */
export function detectAndRefine(text, pauseWord = '停') {
  return refineEvent(detectEvent(text, pauseWord), text)
}
