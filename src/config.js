import Schema from '@deepseek-ai/schemastery'

/**
 * dsh-longing 配置。
 * 默认值按「路人装完不会被吓到」的标准来：不主动、不生成成人图、只对主人生效。
 * 面板（/dsh-longing）写的是同一组键，面板优先。
 */
export const ConfigSchema = Schema.object({
  enabled: Schema.boolean().default(true).description('总开关'),

  // ── 通道绑定（多选）──
  channels: Schema.array(Schema.string())
    .default(['qq'])
    .description('哪些通道生效：qq / bili / web；没列出的通道完全不注入'),

  // ── 三个核心值 ──
  lust: Schema.number().min(0).max(100).step(1).default(30).description('性欲'),
  lewd: Schema.number().min(0).max(100).step(1).default(35).description('色情值'),
  possess: Schema.number().min(0).max(100).step(1).default(55).description('占有值'),
  shame: Schema.number().min(0).max(100).step(1).default(45).description('羞耻度：越高越欲拒还迎'),
  resist: Schema.number().min(0).max(100).step(1).default(50).description('理智/抗拒：越高越克制'),
  fatigue: Schema.number().min(0).max(100).step(1).default(20).description('疲劳度：高时欲望转成想被抱'),
  scene: Schema.string().default('').description('当前场景（卧室/办公室/被窝…），影响她能多放肆'),
  stealthInjection: Schema.boolean().default(true).description('用第一人称心理活动注入，而不是干瘪数值'),

  // ── 时间曲线 ──
  peakWindow: Schema.string().default('22:00-02:00').description('睡前高峰时段'),
  peakBonus: Schema.number().min(0).max(50).default(25).description('高峰加成'),
  decayPerHour: Schema.number().min(0).max(30).default(3).description('每小时衰减'),
  nightDecayPerHour: Schema.number().min(0).max(30).default(6).description('睡眠时段衰减'),
  activeHours: Schema.string().default('08:00-02:00').description('只在此时段内注入（白天不打扰）'),

  // ── 主动行为 ──

  // ── 主动开口（由通道插件执行，这里只给参数）──
  autoInitiate: Schema.boolean().default(false).description('允许她主动开口（冷场时自己发消息）'),
  idleTriggerMin: Schema.number().min(1).max(240).default(15).description('冷场多少分钟后可以考虑开口'),
  proactiveMaxPerDay: Schema.number().min(0).max(720).default(8).description('每天最多主动几次'),
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
  // ── 好感度 ──
  interactionLust: Schema.number().min(0).max(20).default(2).description('主人每说一句涨多少性欲'),
  affectionGain: Schema.number().min(0).max(10).default(1).description('每次主人聊天加多少好感'),
  affectionDecay: Schema.number().min(0).max(5).default(0.3).description('每小时自然回落多少好感'),
  affectionClose: Schema.number().min(0).max(100).default(60).description('好感到多少开始黏人'),
  affectionDevoted: Schema.number().min(0).max(100).default(80).description('好感到多少离不开'),
  cooldownMin: Schema.number().min(1).max(240).default(30).description('两次主动之间至少隔多少分钟'),
  resistWeight: Schema.number().min(0).max(1).default(0.5).description('理智对欲望的抵消权重（有效欲望 = 性欲 − 理智×权重）'),
  coldLust: Schema.number().min(0).max(100).default(25).description('性欲低于多少会变得冷淡'),
  shyLewd: Schema.number().min(0).max(100).default(30).description('色情低于多少会放不开'),
  distantPossess: Schema.number().min(0).max(100).default(30).description('占有低于多少会变得疏离'),
  numbAffection: Schema.number().min(0).max(100).default(30).description('好感低于多少会有距离感'),
  initiateThreshold: Schema.number().min(0).max(100).default(60).description('低于该性欲值时她不会主动开口'),

  // ── 强度门槛 ──
  explicitThreshold: Schema.number().min(0).max(100).default(55).description('露骨门槛'),
  imageThreshold: Schema.number().min(0).max(200).default(140).description('主动要图门槛'),
  imagesPerDay: Schema.number().min(0).max(20).default(2).description('每天主动发图上限'),
  nsfwImages: Schema.boolean().default(false).description('允许成人向图片（默认关）'),

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
  rememberAfterward: Schema.boolean().default(true).description('事后记忆（旧字段，兼容）'),

  // ── 安全 ──
  ownerOnly: Schema.boolean().default(true).description('只对主人生效（强烈建议保持开启）'),
  pauseWord: Schema.string().default('停').description('安全词：说出后立刻降回平静'),
  pausedUntil: Schema.number().default(0).description('暂停到什么时候（毫秒时间戳，面板按钮会改它）'),

  // ── 人设 ──
  personaNote: Schema.string()
    .default('')
    .description('额外人设补丁：写在这里的话会跟欲望状态一起注入（可留空）'),

  // ── 生图后端（ComfyUI）──
  comfyEnabled: Schema.boolean().default(true).description('启用生图后端探测'),
  comfyBaseUrl: Schema.string().default('http://127.0.0.1:8188').description('ComfyUI 地址'),
  comfyAutoLaunch: Schema.boolean().default(false).description('检测不到时自动拉起 ComfyUI'),
  comfyLaunchScript: Schema.string().default('').description('启动脚本路径（.ps1 / .bat / .exe）'),
  comfyProbeSec: Schema.number().min(15).max(600).default(60).description('探测间隔（秒）'),

  // ── 存储 ──
  migrateFrom: Schema.string().default('').description('可选：旧版状态目录（首次启动时把 欲望状态.json 等搬过来，只搬一次）'),
  statePath: Schema.string()
    .default('')
    .description('状态文件路径；留空 = 进程工作目录下的 workspace/（建议显式配一个）'),
})
