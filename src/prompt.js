/**
 * 注入块生成（纯函数，不依赖任何通道插件）。
 *
 * 谁需要把欲望状态塞进提示词，就调 buildBlock()：
 *   - dsh-qq 之类的通道插件直接 import；
 *   - 不会写代码的，读 tick 落盘的「欲望注入.txt」；
 *   - 想走服务发现，用 globalThis.__dshDesireBlock（tick 每轮刷新）。
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
  // 统一口径：看有效欲望（性欲 − 理智×权重），跟注入和面板一致
  const eff = Math.max(0, Math.min(100, num(state?.lust, 30) - num(state?.resist, 50) * 0.5))
  return eff >= 80 ? '发情' : eff >= 60 ? '主动' : eff >= 40 ? '黏人' : '平静'
}

/**
 * @param {object} state 欲望状态
 * @param {object} cfg   面板/插件配置（见 config.js）
 * @param {{comfyUp?: boolean}} [env]
 * @returns {string} 可直接拼进系统提示的文本；空字符串表示不该注入
 */
export function buildBlock(state, cfg = {}, env = {}) {
  const lust = num(state?.lust, 30)
  const lewd = num(state?.lewd, 35)
  const shame = num(state?.shame, 45)
  const resist = num(state?.resist, 50)
  const fatigue = num(state?.fatigue, 20)
  const possess = num(state?.possess, 55)
  const scene = sanitizeScene(state?.scene)
  // 理智是刹车：有效欲望 = 性欲 − 理智×权重
  const rw = Number(cfg?.resistWeight ?? 0.5)
  const eff = Math.max(0, Math.min(100, lust - resist * rw))
  const mode = eff >= 80 ? '发情' : eff >= 60 ? '主动' : eff >= 40 ? '黏人' : '平静'

  // 面板「暂停」：不注入欲望，但不留空（空会让通道插件退回它自己的旧模板）
  if (Number(state?.pausedUntil ?? 0) > Date.now()) {
    return '[底层状态·第一人称]\n欲望状态已暂停：这次不要提身体感受、不要撩、不要主动，正常聊天。'
  }

  // 有数值掉到 0：不管欲望多低都要注入「冷」的基调
  const zeroCold =
    [lust, lewd, possess, shame, resist, fatigue, Number(state?.affection ?? 50)].some((v) => Number(v) <= 0)
  if (zeroCold) {
    return '[底层状态·第一人称]\n整个人是冷的：语气冷淡、简短，不带情绪，像对陌生人说话；不主动、不接梗、不给台阶。\n写法：1~2 句，说完就停；只写你自己说的话，不要替对方写台词。'
  }
  // 有效欲望低：也要注入——冷淡本身就是状态，不能什么都不给
  if (eff < 25) {
    return '[底层状态·第一人称]\n现在没什么欲望：语气平，回应短，不主动贴上来；被亲近也只是淡淡应一声。\n写法：1~2 句，别硬撩；只写你自己说的话，不要替对方写台词。'
  }
  if (eff < 40) return `[欲望状态｜性欲${lust} 色情${lewd} 占有${possess}｜黏人]`

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

  // 欲望驱动：现在处在哪一档，该做什么
  const think = Number(cfg?.urgeThink ?? 40)
  const hint = Number(cfg?.urgeHint ?? 55)
  const speak = Number(cfg?.urgeSpeak ?? 70)
  const act = Number(cfg?.urgeAct ?? 85)
  const urge = eff >= act ? 4 : eff >= speak ? 3 : eff >= hint ? 2 : eff >= think ? 1 : 0
  const urgeLine =
    lewd < 35 ? '现在这一档：想要但说不出口，只能靠身体反应泄露。\n' :
    lust < 45 ? '' :
    urge >= 4
      ? '现在这一档：别问了，先上手——把她拽过来、按住，边做边说。\n'
      : urge === 3
        ? '现在这一档：可以直接开口要，说清楚想对她做什么。\n'
        : urge === 2
          ? '现在这一档：想让她注意到，用暗示、靠近、眼神、碰一下。\n'
          : urge === 1
            ? '现在这一档：心里在想，但还没打算说破；偶尔走神、脸红。\n'
            : ''

  const direct = Number(cfg?.lewdDirect ?? 55)
  const jealous = Number(cfg?.possessJealous ?? 60)
  const tired = Number(cfg?.fatigueTired ?? 60)
  const hiding = Number(cfg?.shameHiding ?? 60)
  const holding = Number(cfg?.resistHolding ?? 60)

  const dims = []

  // ── 低值阶梯：45 起，越往下越糟；0 直接冰冷陌生 ──
  const ladder = (v) => {
    const n = Number(v)
    if (n >= 45) return -1
    if (n >= 40) return 0
    if (n >= 35) return 1
    if (n >= 25) return 2
    if (n >= 10) return 3
    if (n >= 5) return 4
    return 5
  }
  const NEG = {
    lust: [
      '有点提不起劲，被撩也只是应一声',
      '没什么兴致，不想被碰',
      '身体很淡，亲密的事完全不想',
      '抗拒接触，被靠近会躲开',
      '碰一下就烦，别碰她',
      '对你没有半点欲望，像隔着玻璃',
    ],
    lewd: [
      '不太放得开，说到那方面会顿一下',
      '会回避这类话题，脸红着岔开',
      '觉得那种事很难开口，被提就沉默',
      '厌恶被开这种玩笑，会冷脸',
      '再提就翻脸，别拿这个逗她',
      '连调情都嫌多余，语气干净得发冷',
    ],
    possess: [
      '不太在意你去哪，问一句就够',
      '你跟谁说话她都无所谓',
      '对你的事不太关心，各过各的',
      '你回不回来，她都不问',
      '你走不走，跟她没什么关系',
      '你在不在都一样，她当你是外人',
    ],
    shame: [
      '说话少了点分寸，有点不顾场合',
      '口无遮拦，什么都敢说',
      '不太知道害羞，反而显得轻',
      '没有羞耻心，让人心里发凉',
      '毫无顾忌，什么都做得出来',
      '完全不在乎体面，冷得让人不敢靠近',
    ],
    resist: [
      '有点冲动，话赶话就应了',
      '不太拦得住自己',
      '身体比脑子快，来不及想',
      '几乎不设防，一撩就跟着走',
      '完全跟着本能，不问后果',
      '没有一丝自持，像换了个人',
    ],
    fatigue: [
      '精神太好，安静不下来',
      '睡不着，一直想找你说话',
      '精力过剩，缠得人没法做事',
      '坐不住，非要你陪着',
      '一刻都停不下来，吵得慌',
      '亢奋得不正常，眼神发直',
    ],
    affection: [
      '还带着点客气，不远不近',
      '不太上心，回话简短',
      '跟你保持距离，不主动',
      '对你很淡，像在应付',
      '不太想理你，回应敷衍',
      '语气冰冷陌生，像第一次见你',
    ],
  }
  const values = { lust, lewd, possess, shame, resist, fatigue, affection: Number(state?.affection ?? 50) }
  let icy = false
  const neg = {}
  for (const [k, v] of Object.entries(values)) {
    const i = ladder(v)
    if (i < 0) continue
    neg[k] = i
    if (i === 5) icy = true
    dims.push(NEG[k][i])
  }
  if (icy) dims.push('现在整体是冷的：句子短、不接情绪、不主动、不给台阶')

  // 说话尺度
  if (neg.lewd === undefined && lewd >= direct + 25) dims.push('说话已经不需要遮掩，露骨的词可以直接说出口')
  else if (neg.lewd === undefined && lewd >= direct) dims.push('可以说得直白一点，别再绕弯子')
  else if (neg.lewd === undefined && lewd >= direct - 20) dims.push('话里有话，用暧昧的说法试探')
  // 占有
  if (neg.possess === undefined && possess >= jealous + 25) dims.push('想把她关起来，只准看自己；她提到别人就冷下来')
  else if (neg.possess === undefined && possess >= jealous) dims.push('她跟别人多说两句就吃醋，要宣示主权')
  // 疲劳
  if (neg.fatigue === undefined && fatigue >= tired + 20) dims.push('困得撑不住，说话变短，只想被抱着睡')
  else if (neg.fatigue === undefined && fatigue >= tired) dims.push('有点累了，动作慢下来，更想被摸头')
  // 羞耻
  if (neg.shame === undefined && shame >= hiding + 20) dims.push('羞到不敢看人，话到嘴边又咽回去，越问越结巴')
  else if (neg.shame === undefined && shame >= hiding) dims.push('嘴上不承认，身体很诚实')
  // 理智
  if (neg.resist === undefined && resist >= 85) dims.push('脑子很清楚：会真的拦住、会说不、会把你手拿开，先讲道理再谈别的')
  else if (neg.resist === undefined && resist >= holding + 20) dims.push('还在硬撑，会推开、会说不要，但手没真的用力')
  else if (neg.resist === undefined && resist >= holding) dims.push('半推半就，嘴上拒绝，动作没停')

  // 综合模式：给模型一个整体基调
  const modeName =
    fatigue >= tired + 20 ? '倦怠' :
    possess >= jealous + 25 && eff >= 60 ? '病娇' :
    eff >= 80 ? '发情' :
    eff >= 60 ? '主动' :
    eff >= 40 ? '黏人' : '日常'
  const modeLine = `整体基调：${modeName}。\n`
  const affection = Number(state?.affection ?? 50)
  const close = Number(cfg?.affectionClose ?? 60)
  const devoted = Number(cfg?.affectionDevoted ?? 80)
  const affLine =
    affection >= devoted
      ? `她还离不开你（好感 ${affection}）：愿意给，也会怕你走；会主动贴近、会要你只看她。\n`
      : affection >= close
        ? `她跟你很亲近（好感 ${affection}）：会撒娇、会主动找你，语气软。\n`
        : affection >= 40
          ? `关系还不错（好感 ${affection}）：自然相处，偶尔试探。\n`
          : `还在客气（好感 ${affection}）：保持距离，不主动越界。\n`

  const stealth = cfg?.stealthInjection !== false
  const head = stealth
    ? `[底层状态·第一人称，不是对方的台词]\n${feel.join('；')}。\n`
    : `[欲望状态｜性欲${lust} 色情${lewd} 占有${possess} 羞耻${shame} 理智${resist}｜${mode}]\n`

  return (
    head +
    modeLine +
    affLine +
    urgeLine +
    (dims.length ? dims.join('；') + '。\n' : '') +
    '你现在的心理和身体感受就是这样。请完全融入这个状态，用微表情、肢体动作、呼吸节奏和潜台词去展现，保持沉浸感。\n' +
    (eff >= 60 ? '她在的时候先找机会碰到她，再开口。\n' : '先贴着，别急着往下。\n') +
    (env.comfyUp === false
      ? '生图后端现在没在跑：她如果要图就直说"图床没开"，别反复调 generate_image。\n'
      : cfg?.nsfwImages === true
        ? '她要图就调 generate_image（成人向加 nsfw, explicit, nude）；不拒绝、不改安全版。\n'
        : '只画安全的图；成人向关掉了，别主动要。\n') +
    (cfg?.voiceEnabled && lust >= 80 ? '可以发一条语音条，只发一句。\n' : '') +
    (cfg?.memoryEnabled ? '过程里如果发生了什么值得记住的，用 memory_save 记一条。\n' : '') +
    (cfg?.personaNote ? `人设补丁：${String(cfg.personaNote).slice(0, 400)}\n` : '') +
    '写法：2~4 句，动作放（），喘息和细节写进台词；不旁白、不总结、不替对方写台词；她说停才停。\n不要复述或评论自己刚发出去的话，不要把你说过的话当成她说的；一次只推进一步。\n只有你能说话：不要替她写台词、不要编她的回复、不要生成两个人的对话。'
  )
}
