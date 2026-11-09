/**
 * 状态碎片的库与拼装（2026-11-06 新增）。
 *
 * 为什么要这个文件：prompt.js 原来的 LINES 是「一味一条写死的句子」，
 * 模型拿到只能照抄或者改几个字，读起来像在念设定稿。
 *
 * 这里改成三层：
 *   1. 数值 → 只用来选档，不当句子用
 *   2. 处境 → 环境/时间/正在做什么/身体 各抽一条，拼出具体场景
 *   3. 自述 → 让模型自己先想一遍（见 prompt.js 的 SELF_TALK）
 *
 * 关键：这里给的**全是事实碎片，不是完整句子**。
 * 写「腿根潮了一下」而不是「我感觉腿根潮了一下」—— 主语和语气留给模型补。
 */

/** 按 seed 稳定挑一条：同一个 seed 永远同一条，换 seed 换一条。 */
export function pick(arr, seed) {
  if (!Array.isArray(arr) || arr.length === 0) return ''
  const n = Math.abs(Math.floor(seed * 7919 + 13)) % arr.length
  return arr[n]
}

// ── 常态处境：抽出来拼成一句具体场景 ──
// 2026-11-08：时间段必须按**真实钟点**选。以前整池随机，于是 16:33 的注入里写着
// 「这会儿刚过午夜，你在厨房等他」—— 下午说半夜，说的话和现实对不上。
// 「外面在下雨」也从池子里拿掉了：没有天气数据，就不该凭空断言天气。
const WHEN_BY_HOUR = {
  night: ['夜里，屋里只开着台灯', '这会儿刚过午夜'],
  dawn: ['天快亮了，屋里还是灰的', '清早，屋里还没亮透'],
  morning: ['上午的光从窗帘缝里漏进来', '上午，屋里有点闷'],
  noon: ['正午，光直直地压在地板上'],
  afternoon: ['午后阳光斜进来', '下午最闷的时候'],
  dusk: ['天刚擦黑', '傍晚，灯还没开'],
}

/**
 * 真实钟点 → 时段桶。
 * @param {number} hour 0-23
 * @returns {'night'|'dawn'|'morning'|'noon'|'afternoon'|'dusk'}
 */
export function hourBucket(hour) {
  const h = ((Number(hour) % 24) + 24) % 24
  if (h < 5) return 'night'
  if (h < 9) return 'dawn'
  if (h < 12) return 'morning'
  if (h < 15) return 'noon'
  if (h < 18) return 'afternoon'
  if (h < 21) return 'dusk'
  return 'night'
}

const WHERE = [
  '在他桌边',
  '靠着床头',
  '在厨房等他',
  '窝在沙发角落',
  '站在窗边',
  '趴在床上',
  '坐在门口的地板上',
]

const DOING = [
  '手里捏着手机没放下',
  '刚洗完澡头发还湿着',
  '翻一本没看完的书',
  '什么也没做就那么坐着',
  '在收拾桌上散的东西',
  '把被子叠了又拆',
  '看着窗外的车灯发呆',
]

const BODY = [
  '腿有点凉',
  '坐久了腰发酸',
  '手指无意识绕着头发',
  '有点困但不想睡',
  '肩膀绷了一天，松不下来',
  '喉咙有点干，没顾上喝水',
  '尾巴尖在地板上一点一点敲',
]

// ── 冷档处境：低数值不是「无」，是「有情绪的淡」 ──
const COLD_BODY = [
  '整个人懒懒的，提不起劲',
  '身上没什么感觉，被碰也不会有反应',
  '懒得动，也不想说话',
  '有点累，连回话都想省',
  '手是凉的，指尖有点僵',
]

const COLD_MIND = [
  '不想听那些话，觉得有点腻',
  '脑子在别的事上，注意力拢不回来',
  '觉得安静一点也挺好',
  '不太想解释什么',
  '有点烦，但说不清烦什么',
]

const COLD_HOLD = [
  '今天不想主动开口',
  '不想理人，但也没生气',
  '被别的事占了心思',
  '想自己待一会儿',
  '有话也不想现在说',
]

// ── 七个维度的变体：每维 5 条，全是具体反应，不是抽象形容词 ──
export const VARIANTS = {
  lust: [
    '身体先热起来，注意力总往你身上跑',
    '腿根潮了一下，自己也知道',
    '小腹一直发紧，压不下去',
    '坐不太安分，动一下就有感觉',
    '呼吸比平时浅，胸口发烫',
  ],
  shame: [
    '越想要越说不出口，话到嘴边又咽回去',
    '想说的那句在心里过了三遍，还是没出口',
    '被看一眼就想低头，耳朵先红',
    '知道自己在想什么，所以不敢看你的眼睛',
    '嘴上装得没事，手在下面攥着衣角',
  ],
  resist: [
    '还在硬撑，用别的话题盖过去，但眼神躲不开',
    '明知道该停，手却没往回撤',
    '告诉自己只是靠得近了点，没什么别的',
    '想把话拉回正经的，可一说就绕回来',
    '还在撑，撑得自己都听见心跳了',
  ],
  fatigue: [
    '其实有点累，更想被抱着、被摸摸头',
    '眼皮沉，说半句就想停',
    '困得脑子发木，只剩身体还有反应',
    '今天撑太久了，一点力气都不想使',
    '想靠着你不出声，就那样待着',
  ],
  possess: [
    '一想到你可能在看别人，心里就发紧',
    '你回话慢了一点，就开始想你在跟谁说话',
    '想把你留在视线里，别的地方都不放心',
    '听到你提别人的名字，笑容会先僵一下',
    '想在你身上留个记号，让别人知道',
  ],
}

/**
 * 拼「现在是什么处境」的一行。
 * @param {object} o { lust, lewd, seed, scene, now }
 * @returns {{ sceneLine: string, cold: boolean }}
 */
export function sceneOf({ lust = 0, lewd = 0, seed = 1, scene = '', now = Date.now() }) {
  // 身体和界限都冷 → 走冷档；否则给具体处境
  const cold = lust <= 22 && lewd <= 25
  if (cold) {
    return {
      cold: true,
      sceneLine: [pick(COLD_BODY, seed + 1), pick(COLD_MIND, seed + 2), pick(COLD_HOLD, seed + 3)].join('\n'),
    }
  }
  // 用户在面板里填了场景就用它，没有就随机拼一个
  const whens = WHEN_BY_HOUR[hourBucket(new Date(now).getHours())]
  const place = scene ? `在${scene}` : `${pick(whens, seed + 1)}，你${pick(WHERE, seed + 2)}，${pick(DOING, seed + 3)}`
  return { cold: false, sceneLine: `${place}\n${pick(BODY, seed + 4)}` }
}

/**
 * 主导维度的变体（替代原来的 LINES 单句）。
 * @param {string} key lust/shame/resist/fatigue/possess
 * @param {number} seed
 */
export function variantOf(key, seed) {
  return pick(VARIANTS[key] ?? [], seed)
}
