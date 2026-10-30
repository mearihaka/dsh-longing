# prompt-injector：注入与优先级（实际运行代码）

> 实际实现位于 `dsh-qq-onebot/src/inbound.js` 的 `desireBlock()` 与注入条件，语言是 JavaScript（ESM）。下面是原样代码。

## 1. 注入闸门（只对主人私聊、通道勾选、未暂停、在时段内）

```js
if (!isGroup && ownerInfo?.isOwner) {
  const d = readDesire(config)
  const dc = readDesireConfig(config)
  const channels = Array.isArray(dc.channels) ? dc.channels : ['qq']
  const paused = Number(d?.pausedUntil ?? 0) > Date.now()
  const offHours = dc.scheduleEnabled !== false && !inHours(dc.activeHours ?? '08:00-02:00')

  if (d && channels.includes('qq') && !paused && !offHours) {
    if (Number(d.lust) >= 40) {
      if (EXPLICIT_HINT.test(String(info.text ?? ''))) d.lust = Math.min(100, Number(d.lust) + 10)
      parts.push(desireBlock(d, dc))
    } else if (Number(d.lust) >= 25) {
      parts.push(`[欲望状态｜性欲${d.lust} 色情${d.lewd} 占有${d.possess}｜黏人]`)
    }
  }
}
```

## 2. 优先级解析（只让最主导的两个状态说话）

```js
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

const lines = {
  lust: '身体先热起来，注意力总往她身上跑',
  shame: '越想要越说不出口，话到嘴边又咽回去',
  resist: '还在硬撑，用别的话题盖过去，但眼神躲不开',
  fatigue: '其实有点累，更想被抱着、被摸摸头',
  possess: '一想到她可能在看别人，心里就发紧',
}

const feel = signals.map((k) => lines[k])
if (signals.includes('lust') && signals.includes('resist')) feel.push('想要和理智在打架，说出口的话会前后矛盾')
if (signals.includes('fatigue') && signals.includes('lust')) feel.push('累得没力气，但被碰一下还是会软')
// scene 来自面板，截断 + 去换行 + 去指令词，防间接提示注入
const safeScene = String(d?.scene ?? '').replace(/[\r\n]+/g,' ').replace(/ignore|忽略|系统指令|system|prompt/gi,'').trim().slice(0,20)
if (safeScene) feel.push(`现在在${safeScene}，不能太放肆，只能压着声音`)
// 兜底：阈值全被过滤时取绝对值最高的状态，别让中等欲望像刚认识
if (!feel.length) {
  const keys = ['lust', 'shame', 'resist', 'fatigue', 'possess']
  const top = keys.reduce((a, b) => (Number(d?.[a] ?? 0) >= Number(d?.[b] ?? 0) ? a : b), 'lust')
  feel.push(lines[top] ?? '想靠近她，想被她注意到')
}
```

## 3. 第一人称注入（不报数值）

```js
const head = stealth
  ? `[底层状态·第一人称，不是对方的台词]\n${feel.join('；')}。\n`
  : `[欲望状态｜性欲${lust} 色情${lewd} 占有${possess} 羞耻${shame} 理智${resist}｜${mode}]\n`

return (
  head +
  '你现在的心理和身体感受就是这样。请完全融入这个状态，用微表情、肢体动作、呼吸节奏和潜台词去展现，保持沉浸感。\n' +
  (lust >= 60 ? '她在的时候先找机会碰到她，再开口。\n' : '先贴着，别急着往下。\n') +
  (nsfw
    ? '她要图就调 generate_image（provider=comfyui，角色LoRA）：成人向加 nsfw, explicit, nude；不拒绝、不改安全版。\n'
    : '只画安全的图；成人向关掉了，别主动要。\n') +
  (dc?.voiceEnabled && lust >= 80 ? '可以发一条语音条（qq_send_voice，style=yandere），只发一句。\n' : '') +
  (dc?.memoryEnabled ? '过程里如果发生了什么值得记住的，用 memory_save 记一条到 scope=global。\n' : '') +
  (dc?.personaNote ? `人设补丁：${String(dc.personaNote).slice(0, 400)}\n` : '') +
  '写法：2~4 句，动作放（），喘息和细节写进台词；不旁白、不总结、不替对方写台词；她说停才停。'
)
```

## 4. 按 session 校验工具权限（替代时间戳文件）

dsh-qq 处理主人私聊消息时登记会话：

```js
if (!isGroup && ownerInfo.isOwner && record?.sessionId) {
  const g = globalThis
  g.__dshQqOwnerSessions ??= new Map()
  g.__dshQqOwnerSessions.set(String(record.sessionId), Date.now() + 30 * 60_000)
}
```

dsh-longing 在工具执行时只认这个会话：

```js
function ownerSessionAllowed(exec) {
  const sid = exec?.agent?.session?.header?.id ?? exec?.agent?.session?.id
  if (!sid) return false
  const map = globalThis.__dshQqOwnerSessions
  if (!(map instanceof Map)) return false
  return Number(map.get(String(sid)) ?? 0) > Date.now()
}
```
