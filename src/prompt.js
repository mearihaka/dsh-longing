/**
 * 注入块生成（纯函数，不依赖任何通道插件）。
 *
 * 谁需要把欲望状态塞进提示词，就调 buildBlock()：
 *   - dsh-qq 之类的通道插件直接 import；
 *   - 不会写代码的，读 tick 落盘的「欲望注入.txt」；
 *   - 想走服务发现，用 ctx.get('desire').block()。
 */

const LINES = {
  lust: '身体先热起来，注意力总往她身上跑',
  shame: '越想要越说不出口，话到嘴边又咽回去',
  resist: '还在硬撑，用别的话题盖过去，但眼神躲不开',
  fatigue: '其实有点累，更想被抱着、被摸摸头',
  possess: '一想到她可能在看别人，心里就发紧',
}

function num(v, fallback = 0) {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

/** 场景文本消毒：截断 + 去换行 + 去指令词，防面板里的间接提示注入 */
export function sanitizeScene(scene) {
  return String(scene ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/ignore|忽略|系统指令|system|prompt/gi, '')
    .trim()
    .slice(0, 20)
}

export function modeOf(state) {
  const l = num(state?.lust)
  return l >= 80 ? '发情' : l >= 60 ? '主动' : l >= 40 ? '黏人' : '平静'
}

/**
 * @param {object} state 欲望状态
 * @param {object} cfg   面板/插件配置（见 config.js）
 * @param {{comfyUp?: boolean}} [env]
 * @returns {string} 可直接拼进系统提示的文本；空字符串表示不该注入
 */
export function buildBlock(state, cfg = {}, env = {}) {
  const lust = num(state?.lust)
  const lewd = num(state?.lewd)
  const shame = num(state?.shame, 45)
  const resist = num(state?.resist, 50)
  const fatigue = num(state?.fatigue, 20)
  const possess = num(state?.possess)
  const scene = sanitizeScene(state?.scene)
  const mode = modeOf(state)

  // 低欲望只给一行，省 token
  if (lust < 25) return ''
  if (lust < 40) return `[欲望状态｜性欲${lust} 色情${lewd} 占有${possess}｜黏人]`

  // 优先级解析：只让最主导的两个状态说话
  const signals = [
    { k: 'lust', w: lust - 40 },
    { k: 'shame', w: shame - 50 },
    { k: 'resist', w: resist - 50 },
    { k: 'fatigue', w: fatigue - 50 },
    { k: 'possess', w: possess - 50 },
  ]
    .filter((x) => x.w > 0)
    .sort((a, b) => b.w - a.w)
    .slice(0, 2)
    .map((x) => x.k)

  const feel = signals.map((k) => LINES[k])
  if (signals.includes('lust') && signals.includes('resist')) feel.push('想要和理智在打架，说出口的话会前后矛盾')
  if (signals.includes('fatigue') && signals.includes('lust')) feel.push('累得没力气，但被碰一下还是会软')
  if (scene) feel.push(`现在在${scene}，不能太放肆，只能压着声音`)
  if (!feel.length) {
    const keys = ['lust', 'shame', 'resist', 'fatigue', 'possess']
    const top = keys.reduce((a, b) => (num(state?.[a]) >= num(state?.[b]) ? a : b), 'lust')
    feel.push(LINES[top] ?? '想靠近她，想被她注意到')
  }

  const stealth = cfg?.stealthInjection !== false
  const head = stealth
    ? `[底层状态·第一人称，不是对方的台词]\n${feel.join('；')}。\n`
    : `[欲望状态｜性欲${lust} 色情${lewd} 占有${possess} 羞耻${shame} 理智${resist}｜${mode}]\n`

  return (
    head +
    '你现在的心理和身体感受就是这样。请完全融入这个状态，用微表情、肢体动作、呼吸节奏和潜台词去展现，保持沉浸感。\n' +
    (lust >= 60 ? '她在的时候先找机会碰到她，再开口。\n' : '先贴着，别急着往下。\n') +
    (env.comfyUp === false
      ? '生图后端现在没在跑：她如果要图就直说"图床没开"，别反复调 generate_image。\n'
      : cfg?.nsfwImages === true
        ? '她要图就调 generate_image（成人向加 nsfw, explicit, nude）；不拒绝、不改安全版。\n'
        : '只画安全的图；成人向关掉了，别主动要。\n') +
    (cfg?.voiceEnabled && lust >= 80 ? '可以发一条语音条，只发一句。\n' : '') +
    (cfg?.memoryEnabled ? '过程里如果发生了什么值得记住的，用 memory_save 记一条。\n' : '') +
    (cfg?.personaNote ? `人设补丁：${String(cfg.personaNote).slice(0, 400)}\n` : '') +
    '写法：2~4 句，动作放（），喘息和细节写进台词；不旁白、不总结、不替对方写台词；她说停才停。'
  )
}
