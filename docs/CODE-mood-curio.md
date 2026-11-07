# mood + curio：处境、自述、好奇心（实际运行代码）

> 2026-11-06 新增。`src/mood.js` 管「怎么说」，`src/curio.js` 管「什么时候想去看点什么」。
> 两个文件都不碰 `curve.js` 的七维耦合 —— 那套算身体，这两个算表达和动机，混在一起会互相污染。

## 1. 为什么改（问题本身）

旧的 `prompt.js` 每个分支吐一句写死的话：

```js
'有点想要，但还没到开口的地步；身体先给了点反应，自己也知道。\n'
```

三个后果：

1. 模型拿到整句只能照抄，**措辞每轮一样** —— 听得出是设定稿，不是她的话。
2. 干跑发现 `lust 45 / resist 55 → eff = 14.35`，落进 `eff<25` 分支。
   而那条分支的句子是死得最彻底的一句：**大部分时间都在念它**。
3. 低数值那一档只有「身体这边是淡的」一种说法，冷淡被写成了「没有」。

## 2. 三层结构

```
数值层   lust/lewd/… → 只用来选档，不生成句子
处境层   WHEN / WHERE / DOING / BODY 各抽一条 → 拼成具体场景
自述层   SELF_TALK → 要求模型在开口前自己过一遍
```

抽签（`mood.js`）：

```js
export function pick(arr, seed) {
  const n = Math.abs(Math.floor(seed * 7919 + 13)) % arr.length
  return arr[n]
}
```

种子在 `prompt.js` 里算：`Math.floor(nowTs / 60_000) + Math.round(七个数值之和)`。
效果：同一档十分钟内不重复，跨档换一批，数值动一点也换。

## 3. 处境池

四组常态（`WHEN / WHERE / DOING / BODY`）+ 三组冷档（`COLD_BODY / COLD_MIND / COLD_HOLD`）。

```js
export function sceneOf({ lust = 0, lewd = 0, seed = 1, scene = '' }) {
  const cold = lust <= 22 && lewd <= 25
  if (cold) {
    return { cold: true, sceneLine: [COLD_BODY, COLD_MIND, COLD_HOLD 各一条].join('\n') }
  }
  const place = scene ? `在${scene}` : `${WHEN}，你${WHERE}，${DOING}`
  return { cold: false, sceneLine: `${place}\n${BODY}` }
}
```

冷档刻意不写「无」：`整个人懒懒的，提不起劲` / `不想听那些话，觉得有点腻` /
`今天不想主动开口` —— 有情绪的淡才是活人，空白会让她听起来像客服。

## 4. 自述指令（关键的那一行）

```js
const SELF_TALK =
  '[看完上面这些，别复述，也别照抄里面的词。\n' +
  '先在心里过一遍：这会儿身体是什么感觉、想不想开口、为什么还不动。\n' +
  '想完再说话，只说出口的那部分。]\n'
```

压在块的末尾（所有状态、处境、话题都看完之后）。**删掉它就退回念稿模式** ——
上面给什么她念什么，处境再随机也没用。

## 5. 好奇心

```js
export const CURIO_DEFAULTS = {
  curioStart: 30, curioGainPerHour: 14, curioDropOnTalk: 10,
  curioSearchAt: 65, curioCooldownMin: 90, curioPerDay: 6,
}
```

心跳里只算数值：

```js
export function tickCurio(state, cfg, now) {
  // 距上次「有新输入」过了多久 → 半速累加
  curio += (curioGainPerHour * hours) / 2
  // 五分钟内刚说过话 → 掉一点
  if (now - state.lastContactAt < 5 * 60_000) curio -= curioDropOnTalk
  return { curio, want: curio >= curioSearchAt }
}
```

放行判据（`shouldSearch`）只查三样：暂停、冷却、24 小时滚动额度。
**不在心跳里发请求** —— 这是硬约束，心跳一分钟一次，联网会把额度烧光。

## 6. 搜索

`searchTopic()` 走 `https://cn.bing.com/search`，HTML 正则解析 `li.b_algo`，
不需要 key。两处必要处理：

- **连字符要先拼掉**：Bing 把 `Z-Image` 拆成 `Z`，搜出来全是字母表。改成 `ZImage` 才准。
- `stripTags` 要清 `&ensp;` / `&#0183;` 这类实体，否则摘要里全是乱码。

搜索词（`buildQuery`）优先级：

```
引号/书名号里的 > 英文技术词 > 2~4 字干净中文短块 > curioTopics 兜底
```

抠出来的词含她自己名字或 `mua/嗯/啊` 这类，一律作废退回兜底 —— 搜一句撒娇话没意义。

## 7. 一句话话题的流转

```
tickCurio 到阈值 → shouldSearch 放行 → searchTopic → toTopic → state.pendingTopic
                                                              ↓
                        prompt.js 注入「你刚才自己翻到一件事，还没跟谁说：…」
                                                              ↓
                        proactiveGate 放行（lowlust 被话题绕过）→ 说出口
                                                              ↓
                                    noteInitiate → pendingTopic = null
```

6 小时没说出来就过期（`prompt.js` 判 `now - topic.at < 6h`）。
`pendingTopic` 只存一条，不做队列 —— 连搜两次前一条会被覆盖，这是刻意的简化。

## 8. 干跑怎么验

```bash
node tools/preview.mjs          # 看注入长什么样
```

或者直接：

```js
import { buildBlock } from './src/prompt.js'
console.log(buildBlock({ lust: 85, lewd: 80, possess: 75, shame: 30, resist: 25, fatigue: 20, affection: 75 },
  { channels: ['qq'], stealthInjection: true, activeHours: '00:00-23:59', scheduleEnabled: false },
  { channel: 'qq' }))
```

连跑三次（`now` 每次 +60_000）能看到处境和碎片在换。
