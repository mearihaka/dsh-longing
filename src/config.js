import Schema from '@deepseek-ai/schemastery'

/**
 * dsh-longing 配置。
 * 默认值按「路人装完不会被吓到」的标准来：不主动、不生成成人图、只对主人生效。
 * 面板（/dsh-longing）写的是同一组键，面板优先。
 */
/**
 * 校验面板提交的配置。类型、范围、数组结构都交给 schema —— 它会 throw。
 *
 * 2026-11-10（审计 F03）：API 层以前自己 Number()/Boolean() 强转，
 * 于是 "false" 变成 true、-3 直接存、数组被拍成 "甲,乙"。
 * 唯一的传送层转换：数值控件的字符串数字（"3" → 3）、数组控件的逗号串（"a,b" → ['a','b']）。
 */
const ARRAY_KEYS = new Set(['channels', 'curioTopics'])

export function validatePatch(patch = {}) {
  const clean = {}
  for (const [k, raw] of Object.entries(patch ?? {})) {
    if (raw === undefined || raw === null || (typeof raw === 'number' && Number.isNaN(raw))) continue
    if (ARRAY_KEYS.has(k)) {
      clean[k] = Array.isArray(raw) ? raw.map((x) => String(x)) : String(raw).split(/[,，、;；\s]+/).filter(Boolean)
      continue
    }
    if (typeof raw === 'string' && /^-?\d+(?:\.\d+)?$/.test(raw.trim())) {
      clean[k] = Number(raw.trim())
      continue
    }
    clean[k] = raw
  }
  try {
    const v = ConfigSchema(clean)
    return { ok: true, values: Object.fromEntries(Object.keys(clean).map((k) => [k, v[k]])) }
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e).slice(0, 200) }
  }
}

export const ConfigSchema = Schema.object({
  enabled: Schema.boolean().default(true).description('总开关'),

  // ── 通道绑定（多选）──
  channels: Schema.array(Schema.string())
    .default(['qq'])
    .description('哪些通道生效：qq / bili / web；没列出的通道完全不注入'),

  // ── 身份与工具名 ──
  // 这两项是为了让插件不自称某个特定角色：作者自己的名字不该出现在别人的模型面前。
  personaName: Schema.string()
    .default('')
    .description('她的名字：面板标题和工具说明里会用（留空 = 只写「她」，不写名字）'),
  toolName: Schema.string()
    .default('longing')
    .description('注册给模型的工具名；默认 longing。勾了 qq 通道时会额外注册旧名 qq_longing 做兼容'),

  // ── 初始数值 ──
  // 注意：这几个是「状态文件不存在时的初始值」，不是可写的配置。
  // 运行时数值只活在状态文件里；面板和 qq_longing 工具改的是状态，不是这里。
  lust: Schema.number().min(0).max(100).step(1).default(30).description('性欲（初始值）'),
  lewd: Schema.number().min(0).max(100).step(1).default(35).description('色情值（初始值）'),
  possess: Schema.number().min(0).max(100).step(1).default(55).description('占有值（初始值）'),
  shame: Schema.number().min(0).max(100).step(1).default(45).description('羞耻度（初始值）：越高越欲拒还迎'),
  resist: Schema.number().min(0).max(100).step(1).default(50).description('理智/抗拒（初始值）：越高越克制'),
  fatigue: Schema.number().min(0).max(100).step(1).default(20).description('疲劳度（初始值）：高时欲望转成想被抱'),
  affection: Schema.number().min(0).max(100).step(1).default(30).description('好感度（初始值）：开局是客气的，要慢慢养'),
  scene: Schema.string().default('').description('当前场景（初始值，卧室/办公室/被窝…），影响她能多放肆'),
  stealthInjection: Schema.boolean().default(true).description('用第一人称心理活动注入，而不是干瘪数值'),

  // ── 时间曲线 ──
  peakWindow: Schema.string().default('22:00-02:00').description('睡前高峰时段'),
  peakBonus: Schema.number().min(0).max(50).default(25).description('高峰加成'),
  decayPerHour: Schema.number().min(0).max(30).default(3).description('每小时衰减'),
  nightDecayPerHour: Schema.number().min(0).max(30).default(6).description('睡眠时段衰减'),
  activeHours: Schema.string().default('08:00-02:00').description('只在此时段内注入（白天不打扰）'),

  // ── 主动行为 ──

  // ── 主动开口（由通道插件执行，这里只给参数）──
  autoInitiate: Schema.boolean().default(false).description('允许她主动开口（冷场时自己发消息）；主动发图也归这一项管'),
  idleTriggerMin: Schema.number().min(1).max(240).default(15).description('冷场多少分钟后可以考虑开口'),
  proactiveMaxPerDay: Schema.number().min(0).max(720).default(8).description('每天最多主动几次'),
  // 这两个键 1.11.0 只写进了判据，没进 schema 也没进面板可写清单 —— 等于改不动
  // （ALLOWED_KEYS 会直接把面板提交的键丢掉，然后假装保存成功）。
  proactivePerHour: Schema.number().min(0).max(720).default(10).description('每小时最多主动几次（0 = 不限）'),
  proactiveCooldownMin: Schema
    .number()
    .min(0)
    .max(240)
    .default(0)
    .description('两次主动之间至少隔多少分钟；0 = 跟「两次主动至少隔」那个键走'),
  quietHours: Schema.string().default('23:30-08:00').description('安静时段（不主动）'),
  urgeThink: Schema.number().min(0).max(100).default(40).description('到多少：开始在心里想'),
  urgeHint: Schema.number().min(0).max(100).default(55).description('到多少：开始暗示'),
  urgeSpeak: Schema.number().min(0).max(100).default(70).description('到多少：开口说'),
  urgeAct: Schema.number().min(0).max(100).default(85).description('到多少：直接上手'),
  urgeRepeatMin: Schema.number().min(1).max(240).default(30).description('在发情档位时，多久可以再主动一次'),
  lewdDirect: Schema.number().min(0).max(100).default(55).description('色情值到多少开始说直白的话'),
  possessJealous: Schema.number().min(0).max(100).default(60).description('占有值到多少开始吃醋'),
  fatigueTired: Schema.number().min(0).max(100).default(60).description('疲劳到多少开始撑不住'),
  shameHiding: Schema.number().min(0).max(100).default(60).description('羞耻到多少开始口是心非'),
  resistHolding: Schema.number().min(0).max(100).default(60).description('理智到多少开始半推半就'),

  // ── 好奇心与自主搜索（2026-11-06 新增）──
  // 为什么要它：原来的主动开口只有 Lust/Lewd 两个动机，数值一被满足就掉，
  // 结果是「陪得越久越不会被主动找」。好奇心不看亲密，只看多久没换过新东西。
  // 搜索不在心跳里，只在判定放行的那一刻发一次请求（见 curio.js）。
  curioEnabled: Schema.boolean().default(false).description('开启好奇心：没有新东西时会自己想去查点东西'),
  curioGainPerHour: Schema.number().min(0).max(60).default(14).description('一小时没有新东西，好奇心涨多少'),
  curioDropOnTalk: Schema.number().min(0).max(50).default(10).description('说过一次话，好奇心掉多少'),
  curioSearchAt: Schema.number().min(0).max(100).default(65).description('好奇心到多少才允许去搜'),
  curioCooldownMin: Schema.number().min(10).max(1440).default(90).description('两次搜索之间至少隔多少分钟'),
  curioPerDay: Schema.number().min(0).max(48).default(6).description('24 小时内最多搜几次（0 = 不搜；一次约 2000~4000 token）'),
  curioTopics: Schema.array(Schema.string())
    .default([])
    .description('她不知道该搜什么时的兜底话题（一个一行；留空 = 用「最近科技新闻」这类通用词）'),
  // ── 好感度 ──
  interactionLust: Schema.number().min(0).max(20).step(0.01).default(0.1).description('主人每说一句涨多少性欲（很小，避免聊天把性欲顶满）'),
  affectionGain: Schema.number().min(0).max(10).default(0.3).description('每次主人聊天加多少好感（默认很小，好感要靠事件养）'),
  affectionDecay: Schema.number().min(0).max(5).default(0.3).description('每小时自然回落多少好感'),
  affectionClose: Schema.number().min(0).max(100).default(60).description('好感到多少开始黏人'),
  affectionDevoted: Schema.number().min(0).max(100).default(80).description('好感到多少离不开'),
  cooldownMin: Schema.number().min(1).max(240).default(30).description('两次主动之间至少隔多少分钟'),
  resistWeight: Schema.number().min(0).max(1).default(0.5).description('理智对欲望的抵消权重（有效欲望 = 性欲 − 理智×权重）'),
  affectionWeight: Schema.number()
    .min(0)
    .max(1)
    .default(0.4)
    .description('好感对有效欲望的调制：她愿不愿意。0 = 只看性欲和理智；0.4 = 好感低的时候再想要也不太愿意'),
  negBreakpoints: Schema.string()
    .default('45,40,35,25,10,5')
    .description('负面阶梯断点，六个降序数字，逗号分隔：跌破第一档开始有负面 buff，低于最后一个断点算「彻底没了」'),

  // ── 维度耦合：数值之间互相压着 ──
  couplingEnabled: Schema.boolean().default(true).description('让维度互相牵制（占有压理智、色情压羞耻、疲劳压性欲、好感养占有），关掉则七个值各自独立'),
  couplingRate: Schema.number()
    .min(0)
    .max(3)
    .default(1)
    .description('耦合与自然演化的总倍率：0.5 = 一切慢一半，0 = 只保留时间衰减'),

  // ── 事件冲击 ──
  eventGain: Schema.number()
    .min(0)
    .max(3)
    .default(1)
    .description('一句话/一件事对数值的冲击倍率：0 = 事件不影响数值，只剩时间演化'),

  // ── 养成：调试与门槛 ──
  debugMode: Schema.boolean()
    .default(false)
    .description('调试模式：开启后才能直接拖滑块改数值、套预设、用工具 set/bump。关掉时只能靠聊天事件慢慢养'),
  feedbackThink: Schema.boolean().default(true).description('「开始在心里想」这一档允许她表现出来'),
  feedbackHint: Schema.boolean().default(true).description('「开始暗示」这一档允许她表现出来'),
  feedbackSpeak: Schema.boolean().default(true).description('「开口要」这一档允许她说出口'),
  feedbackAct: Schema.boolean().default(true).description('「直接上手」这一档允许她动手'),
  lonelyHours: Schema.number()
    .min(1)
    .max(72)
    .default(6)
    .description('多久没有主人消息就算「被晾着」：只算清醒时段，睡觉的那几小时不计'),
  sleepWindow: Schema.string()
    .default('23:30-08:00')
    .description('睡眠时段：这段时间的沉默不算冷落，也不会在她睡着时扣好感'),
  diaryDays: Schema.number().min(1).max(30).default(7).description('面板默认显示最近几天的日记'),
  // ── 自写日记（1.14.0）──
  // 为什么要这些：日记原来只有「让我高兴的 / 让我难受的」两行模板，
  // 内心那栏要等外层模型想起调工具才会有一条 —— 实际永远是空的。
  diaryAutoWrite: Schema.boolean()
    .default(true)
    .description('让她自己写心情日记：把当天发生的事和此刻的状态交给模型，写一两句第一人称的话；关掉就只剩两行模板'),
  diaryPerDay: Schema.number().min(1).max(12).default(3).description('一天最多自己写几条'),
  diaryMinGapMin: Schema.number().min(0).max(720).default(150).description('两条之间至少隔多少分钟（防止翻来覆去写同一件事）'),
  diaryMinEvents: Schema.number().min(0).max(50).default(2).description('当天至少发生几件事才值得写；0 = 每天都写'),
  diaryMaxChars: Schema.number().min(20).max(300).default(120).description('一条日记最多多少字'),
  diaryMaxTokens: Schema.number().min(60).max(4000).default(1200).description('写日记时给模型的最大输出 token'),
  diaryTemperature: Schema.number().min(0).max(2).default(0.95).description('写日记的温度：高一点更像人话，低一点更稳'),
  diaryProvider: Schema.string().default('').description('写日记用的 provider（留空 = 用 DSH 当前默认模型）'),
  diaryModel: Schema.string().default('').description('写日记用的 model（留空 = 用 DSH 当前默认模型）'),
  ownerRef: Schema.string().default('TA').description('日记和注入里怎么称呼主人（他/她/姐姐/名字）；留空用 TA'),
  diaryPersona: Schema.string().default('').description('写日记时告诉模型「你是谁」；留空则用 personaName'),

  // ── 渐进解锁 ──
  unlocksEnabled: Schema.boolean()
    .default(true)
    .description('按好感/羞耻/色情逐步解锁亲密程度：没到门槛她会躲开，而不是照做'),
  coldLust: Schema.number().min(0).max(100).default(25).description('性欲低于多少会变得冷淡'),
  shyLewd: Schema.number().min(0).max(100).default(30).description('色情低于多少会放不开'),
  distantPossess: Schema.number().min(0).max(100).default(30).description('占有低于多少会变得疏离'),
  numbAffection: Schema.number().min(0).max(100).default(30).description('好感低于多少会有距离感'),
  initiateThreshold: Schema
    .number()
    .min(0)
    .max(100)
    .default(45)
    .description('低于该性欲值时她不会主动开口（性欲的时间地板是 30，最高峰也就 55 上下，所以默认 45 —— 原来写 60 等于永远不主动）'),

  // ── 强度门槛 ──
  explicitThreshold: Schema.number().min(0).max(100).default(55).description('露骨门槛'),
  imageThreshold: Schema.number()
    .min(0)
    .max(200)
    .default(110)
    .description('主动发图门槛：性欲 + 色情 合计到多少，她会自己出一张图发过来（0~200）。默认 110 ≈ 性欲 45 + 色情 65；原来 140 在默认曲线下基本到不了'),
  imagesPerDay: Schema.number().min(0).max(20).default(2).description('每天主动发图上限（张）；0 = 不发'),
  // ── 成人内容总闸（2026-11-07）──
  // 为什么要单独一个总闸：以前 nsfwImages 只关「成人图片」，但露骨的话、娇喘、亲密事件
  // 全都不归它管 —— 用户以为关掉了「成人向」，结果她照样说骚话、照样发娇喘。
  // 现在 nsfwEnabled 是唯一的成人内容开关：关掉之后不谈、不说、不画、不发。
  // ── 私有定制：从本机聊天记录抽事实（2026-11-09）──
  nsfwEnabled: Schema.boolean()
    .default(false)
    .description('全局成人内容总开关：关掉后不说露骨的话、不发诱惑图、不发娇喘、不记亲密事件'),
  nsfwImages: Schema.boolean().default(false).description('允许成人向图片（只对图片生效，总闸 nsfwEnabled 关着时无效）'),

  // ── 功能开关 ──
  curveEnabled: Schema.boolean().default(true).description('面板显示 24 小时曲线'),
  presetsEnabled: Schema.boolean().default(true).description('面板显示一键预设'),
  voiceEnabled: Schema.boolean().default(false).description('发情时用语音条（需要 TTS）'),
  memoryEnabled: Schema.boolean().default(true).description('事后写一条 global 记忆'),
  scheduleEnabled: Schema.boolean().default(true).description('按 activeHours 限制时段'),
  pauseEnabled: Schema.boolean().default(true).description('允许红色暂停'),

  // ── 质感 ──
  jealousy: Schema.number().min(0).max(100).default(50).description('吃醋敏感度'),
  rejectionPenalty: Schema.number().min(0).max(50).default(15).description('被拒惩罚'),
  rememberAfterward: Schema.boolean().default(true).description('已弃用：功能和 memoryEnabled 完全重复，留着只为兼容旧配置'),

  // ── 安全 ──
  ownerOnly: Schema.boolean().default(true).description('只对主人生效（强烈建议保持开启）'),
  pauseWord: Schema.string().default('可克课科').description('安全词：说出后立刻降回平静'),
  // pausedUntil 曾是这里的配置项，但运行时只认状态文件里的那一个（面板改它走 /api/pause），
  // 面板提交也会被 ALLOWED_KEYS 挡掉 —— 是个「看起来能配、坏了会误导人」的死键，删掉。

  // ── 人设 ──
  personaNote: Schema.string()
    .default('')
    .description('额外人设补丁：写在这里的话会跟欲望状态一起注入（可留空）'),

  // ── 生图后端（ComfyUI）──
  comfyEnabled: Schema.boolean().default(true).description('启用生图后端探测'),
  comfyBaseUrl: Schema.string().default('http://127.0.0.1:8188').description('ComfyUI 地址'),
  comfyAutoLaunch: Schema.boolean().default(false).description('检测不到时自动拉起 ComfyUI'),
  comfyLaunchScript: Schema.string().default('').description('启动脚本路径（.ps1 / .bat / .cmd / .exe）'),
  comfyLaunchAllowDir: Schema.string()
    .default('')
    .description('只允许执行这个目录下的启动脚本（留空 = 不限制）。防止面板令牌被拿走后用来跑任意文件；装完建议改成你自己的目录'),
  comfyProbeSec: Schema.number().min(15).max(600).default(60).description('探测间隔（秒）'),

  // ── 存储 ──
  migrateFrom: Schema.string().default('').description('可选：旧版状态目录（首次启动时把 欲望状态.json 等搬过来，只搬一次）'),
  statePath: Schema.string()
    .default('')
    .description('状态文件路径；留空 = dshHomePath / DSH_HOME / ~/.dsh 下的 dsh-longing（也可以用 DSH_LONGING_DIR 环境变量）'),
})
