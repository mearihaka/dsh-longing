/**
 * 渐进解锁：她肯不肯做到哪一步。
 *
 * 这是「养成」里最该有的东西 —— 不是数值到了就什么都能做，
 * 而是关系到了一定程度，才轮得到那件事。
 *
 * 门槛全部挂在好感上（少量挂在羞耻/色情/理智/占有），因为「肯不肯」是关系问题，不是欲望问题。
 * 没到门槛时不硬拒：差得远就明确躲开，差一点就半推半就 —— 躲的方式本身说明差距。
 */

import { num } from './curve.js'

/**
 * 每一项：名字 + 门槛。gap < 0 表示已经解锁；gap 越大差得越多。
 * order 只用于展示，不影响判定。
 */
export const UNLOCKS = {
  touch: { name: '抱抱、摸头', order: 1, need: { affection: 30 } },
  kiss: { name: '接吻', order: 2, need: { affection: 45, shame: -60 } },
  talk: { name: '说露骨的话', order: 3, need: { affection: 50, lewd: 55 } },
  undress: { name: '脱', order: 4, need: { affection: 65, shame: -40 } },
  want: { name: '要她', order: 5, need: { affection: 70, lewd: 70, resist: -40 } },
  bind: { name: '绑住、命令', order: 6, need: { affection: 80, possess: 70 } },
}

/**
 * need 里正的表示「至少要这么高」，负的表示「至多只能这么高」（羞耻、理智是刹车）。
 * @returns {{key:string,name:string,ok:boolean,gap:number,short:object}[]}
 */
export function unlockedOf(state, cfg = {}) {
  if (cfg?.unlocksEnabled === false) {
    return Object.entries(UNLOCKS).map(([key, def]) => ({ key, name: def.name, ok: true, gap: -1, short: {} }))
  }
  const out = []
  for (const [key, def] of Object.entries(UNLOCKS)) {
    let gap = 0
    const short = {}
    for (const [k, v] of Object.entries(def.need)) {
      const cur = num(state?.[k], k === 'affection' ? 30 : 50)
      // 负门槛：越低越容易，差距 = 当前 − 上限
      const d = v >= 0 ? v - cur : cur + v
      if (d > 0) {
        short[k] = d
        gap = Math.max(gap, d)
      }
    }
    out.push({ key, name: def.name, ok: gap <= 0, gap, short })
  }
  return out.sort((a, b) => (UNLOCKS[a.key].order - UNLOCKS[b.key].order))
}

/**
 * 现在能到哪一步：从最浅一项开始数，**遇到第一个锁住就停**。
 *
 * 不能取「order 最大的已解锁项」—— 门槛不是单调链：可能出现
 * 「能要她、但接吻还锁着」（shame 太高）这种组合，那时说她「最多只到要她」
 * 会自相矛盾（可以要她，却不能脱）。
 */
export function deepestUnlocked(state, cfg = {}) {
  const all = unlockedOf(state, cfg)
  let i = 0
  while (i < all.length && all[i].ok) i++
  return i > 0 ? all[i - 1] : null
}

/** 差一点就解锁的那一项：紧跟在已解锁前缀后面的第一个。 */
export function nextLocked(state, cfg = {}) {
  const all = unlockedOf(state, cfg)
  let i = 0
  while (i < all.length && all[i].ok) i++
  return i < all.length ? all[i] : null
}

/**
 * 注入用的那句话：她肯到什么程度，以及为什么要躲。
 *
 * 差得远就明确拦住，差一点就半推半就 —— 躲的方式本身说明差距。
 * 只在她欲望已经起来（urge ≥ 3）时才说，不然低欲望时演边界戏很突兀。
 */
export function boundaryLine(state, cfg = {}, urge = 0) {
  if (cfg?.unlocksEnabled === false) return ''
  if (urge < 3) return ''
  const next = nextLocked(state, cfg)
  if (!next) return ''
  const deep = deepestUnlocked(state, cfg)
  const where = deep ? `最多只到「${deep.name}」` : '还什么都没有过'
  if (next.gap <= 8) {
    return `想再往前一步，可还差一点点：会半推半就，嘴上说不要，手没真推（${where}）。\n`
  }
  if (next.gap <= 20) {
    return `想再往前一步，但她还没准备好：会躲开那只手，小声说「今天不行」（${where}）。\n`
  }
  return `想再往前一步，这一步她还不肯：会真的拦住，把话说清楚，不留余地（${where}）。\n`
}
