# 独立审查记录（v1.8.x）

2026-11-01 做的一轮外部审查。四个**互不看结论**的对抗视角，各自只负责一层，
每个都给了行号、触发条件、后果和修法。共 32 条，去重后 25 条真问题，**修复 24 条**。

保留这份记录的原因很简单：这套东西是给「状态影响说话」用的，错误不会崩，
只会让她说话不对劲——那种 bug 最难自己发现，所以需要外部视角。

**2026-11-09 复核（v1.14.1）**：25 条逐条对着代码重新核了一遍，全部仍然成立，
证据见文末[复核清单](#复核清单2026-11-09)。唯一过期的是数字——测试从 119 条涨到 164 条，
体检从 18 项涨到 20 项。

## 四层视角

| 视角 | 重点 | 找到 | 最狠的一条 |
|---|---|---|---|
| 安全 | 越权、注入、路径、SSRF、令牌 | 8 | `channels` 能路径穿越写任意 .txt |
| 并发一致性 | 内存/磁盘竞争、重复注册、状态迁移 | 8 | `writeJson` 异步重试用旧快照盖掉新数据 |
| 数值边界 | 单位、极端值、时钟、单调性、测试缺口 | 8 | 事件名走原型链，`EVENTS['constructor']` 炸请求 |
| 提示词工程 | 注入面、分支矛盾、人称、映射断层 | 8 | `scene` 能伪造 `[欲望状态｜…]` 头 |

## 最值得记的三条

**① `updatedAt` 被消息重置，整条时间曲线在聊天时停摆**

`__dshLongingNote` 每条消息都设 `updatedAt = now`，而 `nextState` 拿它当衰减基准。
消息间隔 5 秒时，tick 的 `dt` 只有 5 秒，3/h 的衰减只剩 8%。
**这是 v1.0.1 修过的同一个 bug 换了个入口复发** —— 提醒：修 bug 时要想清楚"这个字段还有谁在用"。

修法：新增 `tickedAt` 专做衰减基准，只由 `nextState` 推进。

**② 生图三态判定顺序错了**

```js
comfyUp === false ? '图床没开' : nsfwImages ? '调 generate_image' : comfyUp === true ? '只画安全的' : ''
```

`nsfw` 分支排在"未知"前面，于是**后端还没探测到时就教她去调生图工具**。
三态必须按 `false → 未知 → true` 排。

**③ 人称混用**

块头写着「第一人称」，里面却三个称谓乱飞：「注意力总往**她**身上跑」（她=对方）、
「你回不回来，**她**都不问」（她=角色自己）、「第一次被**他**这样碰」（他=对方）。
模型读到自己嘴里冒出「她」，可能当第三方，自己加个情敌角色。全表统一成「你/我」。

## 完整对照

<details>
<summary>安全（8 条，全修）</summary>

| 问题 | 修法 |
|---|---|
| `channels` 拼进文件名，可 `../` 穿越 | 白名单 `/^[a-z0-9_-]{1,16}$/` |
| `comfyLaunchScript` 任意路径 + `ExecutionPolicy Bypass` → RCE | 改 `RemoteSigned`（本地脚本照跑、下载的要签名）+ 扩展名白名单 + `comfyLaunchAllowDir` |
| 原型链事件名炸请求 | `Object.hasOwn(EVENTS, key)` |
| `comfyBaseUrl` 盲 SSRF | 只允许回环地址 |
| 令牌存 `localStorage`（同源可读） | 改 `sessionStorage` |
| 群聊 `get` 能读出七个数 | 非主人只回档位词 |
| `personaNote` 400 字零过滤、位置在块末 | 消毒 + 100 字 + 挪到块首 |
| 事件 API 可无限刷值 | 非调试模式 30 秒冷却 + strong 封 ±30 |

</details>

<details>
<summary>并发一致性（8 条，7 修 1 缓解）</summary>

| 问题 | 修法 |
|---|---|
| `writeJson` 重试用旧快照覆盖 | 重试前比对目标 mtime，更新则放弃 |
| 重试 timer 没清、热重载重复注册 | 保存句柄 + dispose 清全局入口 |
| 注入文件非原子写 | tmp + rename |
| 多处吞写失败 | `resume`/`preset`/`pause` 都检查返回值 |
| `fireEvent` 不更新 `lastContactAt` | 成功时同步刷新，避免"被夸"和"被晾着"同分钟打架 |
| `stop` 覆盖更长的暂停 | `Math.max` |
| `body()` 中文跨分片被截断 | `Buffer.concat` 再解码 |
| tick 整对象覆盖 | **缓解**，见 [DESIGN.md §9.1](DESIGN.md) |

</details>

<details>
<summary>数值边界（8 条，全修）</summary>

| 问题 | 修法 |
|---|---|
| 原型链事件名 | `Object.hasOwn` |
| `peakBonus` 跨零点算两天（一夜 +50） | `peakKey` 归到高峰起始日 |
| `updatedAt` 被消息重置 | `tickedAt` |
| `num(null)` 当 0 → `dt` 变 24 小时 | null/''/[] 视为缺失 |
| `deepestUnlocked` 取最大 order（非单调） | 改「最长已解锁前缀」 |
| 采样步长漏掉短窗口 | 步长取窗口宽的一半 |
| 面板数字框清空 → 写 0 | 空值跳过 |

</details>

<details>
<summary>提示词工程（8 条，全修）</summary>

| 问题 | 修法 |
|---|---|
| `scene` 可伪造数值头 | 剔标点 + `get` 门禁 |
| `personaNote` 后门 | 同上 |
| `resist` 同时"在崩"和"不会崩" | `over.resist > 0` 时禁用"坚决拦住"那句 |
| 人称混用 | 全表统一「你/我」 |
| `eff ∈ [25,40)` 只吐裸数值 | 改第一人称 + 写法守卫 |
| `boundaryLine` 跳档 | 前缀式取下一档 |
| `approachLine` 被写死句覆盖（档位开关失效） | 删掉三元，统一走 `approachLine` |
| 生图三态顺序错 | `false → 未知 → true` |

</details>

## 测试缺口（审查顺带指出，已补 6 条）

这六条当时一条测试都没有，其中三条正是修掉的 P0/P1：

- 跨零点峰值加成
- `eff ∈ [25,40)` 分支
- `null` 时间戳
- 短窗口采样
- 非单调门槛
- 更新时钟被消息重置

**说明测试覆盖的是"我以为会坏的地方"，不是"真会坏的地方"。**

## 怎么自己跑一遍

```bash
node --test --test-concurrency=1     # 164 条（1.14.5；审计当时 119 条）
node tools/doctor.mjs --panel http://127.0.0.1:<端口>/dsh-longing   # 20 项体检（1 项在干净环境里会显示未连接，正常）
```

数字会长，所以上面这两个数只当参考；以 `npm test` 的实际输出为准。

## 复核清单（2026-11-09）

对着 v1.14.1 的代码逐条找落点，行号是复核当天的。

| 层 | 修法 | 代码位置 |
|---|---|---|
| 安全 | `channels` 白名单 | `src/index.js:1015` `/^[a-z0-9_-]{1,16}$/` |
| 安全 | `comfyLaunchScript` 三项收紧 | `src/index.js:520`（扩展名）、`:525`（允许目录）、`:537`（`RemoteSigned`） |
| 安全 | 原型链事件名 | `src/events.js:97`、`src/index.js:354,711` `Object.hasOwn(EVENTS, …)` |
| 安全 | `comfyBaseUrl` 只许本机 | `src/index.js:568,574` |
| 安全 | 令牌改 `sessionStorage` | `panel/index.html:305` |
| 安全 | 非主人只回档位词 | `src/index.js:1238` |
| 安全 | `personaNote` 消毒/100 字/挪到块首 | `src/prompt.js:70-77`（消毒）、`:676`（块首） |
| 安全 | 事件冷却 + 安全词封顶 | `src/index.js:707-717`（30 秒）、`src/events.js:69,110`（`MAX_STRONG = 30`） |
| 并发 | 重试比对 mtime | `src/index.js:123-128` |
| 并发 | timer 句柄 + dispose | `src/index.js:771-772,882` |
| 并发 | 注入文件原子写 | `src/index.js:156` `writeTextAtomic` |
| 并发 | 写失败要检查返回值 | `src/index.js:1083-1085`（pause 为例，resume/preset 同） |
| 并发 | `fireEvent` 刷新 `lastContactAt` | `src/index.js:721` |
| 并发 | `stop` 取更长暂停 | `src/events.js:115` `Math.max` |
| 并发 | `body()` 分片拼接 | `src/index.js:915` `Buffer.concat` |
| 并发 | tick 整对象覆盖 | 缓解，`docs/DESIGN.md` §9.1 |
| 数值 | `peakKey` 归到高峰起始日 | `src/curve.js:101,360` |
| 数值 | `tickedAt` 做衰减基准 | `src/curve.js:341,365` |
| 数值 | `num()` 把 null/''/[] 当缺失 | `src/curve.js:25-31` |
| 数值 | `deepestUnlocked` 改最长已解锁前缀 | `src/unlock.js:59` |
| 数值 | 采样步长 ≤ 窗口宽一半 | `src/curve.js:282,304` |
| 数值 | 面板空数字框跳过 | `panel/index.html:702` |
| 提示词 | `scene` 消毒 + 门禁 | `src/prompt.js:78-92` |
| 提示词 | `resist` 档内互斥 | `src/prompt.js:323,581` |
| 提示词 | `eff ∈ [25,40)` 改第一人称 | `src/prompt.js:486-514` |
| 提示词 | `boundaryLine` 前缀式取下一档 | `src/unlock.js` `boundaryLine` |
| 提示词 | `approachLine` 统一出口 | `src/prompt.js:603,690` |
| 提示词 | 生图三态顺序 `false → 未知 → true` | `src/prompt.js:648-657` |

复核顺带发现一处审计没写到的：`extractThoughts` 之前用**标点**判断流有没有被截断，
模型忘打句号就把整条日记砍成空（面板表现为「让她写一篇没反应」）。已在 1.14.2 改成
按 `finish.reason.kind` 判断，`length`/`error` 才算截断。
