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
 * 安全词的默认值。三处必须一致：这里、config.js 的 pauseWord default、README §7.3。
 *
 * 2026-11-10（复审计 N1）：值是「停」。
 *
 * 中间有一版把它换成了「可克课科」，动机是把「停下来想想 / 停一会儿」这类误触挡死。
 * 但那是修错地方：误触的根因是「尾巴 ≤ 4 字」判太松，已经由下面的 SOFT_TAIL 白名单解决；
 * 换掉词只带来一个后果 —— 用户说「停」没反应，而 README、面板 placeholder、函数默认参数
 * 三处还都写着「停」。默认词必须是用户第一眼就懂的那个词。
 */
export const DEFAULT_PAUSE_WORD = '停'

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
// 事件的好/坏，用来决定要不要过否定门。只列会打痛的那几个 ——
// 正向事件不需要守（praise 自己的正则有 (?<!不)）。
const EVENT_TONE = {
  cold: 'bad', reject: 'bad', ignore: 'bad', neglect: 'bad',
  mentionOther: 'bad', compare: 'bad', blame: 'bad', lie: 'bad',
  leave: 'bad', force: 'bad', bodyShame: 'bad',
}


const RULES = [
  // ── 关系级重击 ──
  ['leave', /分手|再也不(理你|找你|来了)|别来找我|不要你了|滚吧|滚开|我要走了|我要走/],
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
  // 2026-11-10（审计 A04）：pauseWord 为空时安全词静默失效，没有任何提示。
  // 回退到默认词，并让调用方能在日志里看见（这里只做回退，不动全局）。
  const w = String(word ?? '').trim() || DEFAULT_PAUSE_WORD
  if (!t || !t.startsWith(w)) return false

  // 2026-11-10（审计 A04）：原来只看「尾巴 ≤ 4 字」，于是
  // 「停下来想想」「停下来」「停一会儿」全部被判成安全词 → 插件静默半小时。
  // 改成尾巴白名单：只认语气词和「一下」，其余一律不算。
  //
  // 代价：「停，别碰我」这种「安全词 + 后续内容」不中 —— 但那种情况下面
  // 还有 force / reject 规则兜着，比「停下来想想 = 暂停半小时」安全得多。
  const tail = t.slice(w.length).replace(/[，,。.!！?？…~、\s]/g, '')
  if (!tail) return true
  const SOFT_TAIL = /^(吧|啊|呀|哦|了|啦|呢|嘛|，|。|！|？|一下|好吗|好不好|行吗|好吗你|拜托)+$/
  return SOFT_TAIL.test(tail)
}

/**
 * 从一句话里认出事件名。
 * @param {string} text 主人发来的原文
 * @returns {string|null} dsh-longing 的事件名，认不出返回 null
 */
export function detectEvent(text, pauseWord = DEFAULT_PAUSE_WORD) {
  const t = String(text ?? '').trim()
  if (!t) return null
  if (t.length > MAX_LEN) return null

  // 安全词优先，且必须是整句（误判会直接暂停）。
  // pauseWord 从面板读，不硬编码 —— 档主换了词就该跟着换。
  if (isSafetyWord(t, pauseWord)) return 'stop'

  // 2026-11-10（审计 A03）：负面事件原来裸匹配，实测：
  //   「谁要跟你分手啊，别说这个」 → leave（affection −5.6、锚点强度 6.8，记仇五天）
  //   「如果哪天我们分手了会怎样」 → leave
  //   「别夸我，没用」             → blame
  // 而 detectAndRefine 在**每条**主人消息上跑，不需要模型同意。
  // 所以负面规则要过一遍否定/假设门；正向规则不用（「不喜欢你」这种
  // 已经由 praise 自己的 (?<!不) 处理了）。
  for (const [name, re] of RULES) {
    if (!re.test(t)) continue
    const tone = EVENT_TONE[name]
    if (tone === 'bad' && isHypotheticalOrNegated(t, re)) return null
    return name
  }
  return null
}

/**
 * 这句话是不是在假设、反问、或者转述别人？
 *
 * 只看**命中位置之前**的 8 个字 —— 「谁要跟你分手啊」里的「谁要」在前，
 * 「分手了会怎样」里的「会怎样」在后，前后都得看一点。
 *
 * @param {string} text
 * @param {RegExp} re 已经命中过的规则
 */
function isHypotheticalOrNegated(text, re) {
  const t = String(text ?? '')

  // ① 疑问/假设：整句带这些词就不算事实
  if (/[吗呢么][。.!！?？…~\s]*$/.test(t)) return true
  if (/(如果|假如|要是|万一|哪天|会不会|怎样|怎么办|怎么可能|难道|谁说|谁要|谁跟你|别再说|不许说|不要说|别提)/.test(t)) return true

  // ② 句首祈使的否定：「别夸我」「不要说了」—— 整句在否认，不是在陈述。
  //
  // 2026-11-10（复审计 N2）：这条会把 leave 自己的两个核心模式一起拦掉 ——
  // 「不要你了」「别来找我」本身就是以这两个词开头的分手表达，
  // 而它们是最重的两种（affection −7.8、grudge 3、锚点 4.6）。
  // 结果是「说分手吧」她炸，「说不要你了」她毫无反应。
  // 所以先看命中的是不是 leave 的强模式，是就跳过这条。
  if (/^(别|不要|不用|甭|少)/.test(t)) {
    const hit = re.exec(t)
    const strongBreakup = hit && hit.index === 0 && /^(不要你了|别来找我)/.test(hit[0])
    if (!strongBreakup) return true
  }

  // ③ 暂别词：「我要走了，等下再回你」不是分手。
  // 2026-11-10（复审计 N3）：光看「我要走了」会把它当成 leave，
  // 但这句每天都会说，记仇五天的代价太大。
  if (/(等下|一会儿|等会|待会|马上|稍后|晚点|回头|再回你|再聊|去忙|上个厕|洗澡|吃饭|睡觉)/.test(t)) return true

  // ④ 否定：**只看命中位置紧邻的 3 个字**。
  //
  // 原来是 8 个字，于是「我们不合适，分手吧」里「分手」前面 5 个字有个「不」，
  // 被判成否定 —— 那是真实的分手信号，不能拦。
  // 3 个字够挡住「不分手」这种紧贴的否定，又不会误伤「不合适」这种独立表达。
  const m = re.exec(t)
  if (m && m.index > 0) {
    const before = t.slice(Math.max(0, m.index - 3), m.index)
    // 但「不合适 / 不喜欢 / 不是很」这类是完整表达，不算否定
    if (/(不|没|没有|不是|别|甭|勿)/.test(before) && !/(不合适|不喜欢|不是很|不觉得|不想要)$/.test(before)) return true
  }
  return false
}

/**
 * 二次修正：一句话里同时出现两种信号时的优先级。
 *
 * - 夸的时候同时提了别人 → 算吃醋，不算被夸（人不会因为顺口一句好话就消气）
 * - 疑问句不算夸奖/表白（「我好看吗」是在问，不是在夸人）
 */
export function refineEvent(name, text) {
  const t = String(text ?? '')
  // 2026-11-10（审计 A10）：这条目前不可达 —— mentionOther 的规则在 RULES 里
  // 排在 praise 前面，detectEvent 已经先返回了。留着是防以后调顺序，加注释免得
  // 下一个人以为它在生效。
  if (name === 'praise' && /别的(女生|女孩|人)|前女友/.test(t)) return 'mentionOther'
  if (name === 'praise' && /[吗呢][。.!！?？…~\s]*$/.test(t)) return null
  return name
}

/**
 * 一步到位：认事件 + 修正。
 * @returns {string|null}
 */
export function detectAndRefine(text, pauseWord = DEFAULT_PAUSE_WORD) {
  return refineEvent(detectEvent(text, pauseWord), text)
}
