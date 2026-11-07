# CHANGELOG

## v1.13.1 — 外部审计报告的 13 条，逐条落实


这一版没有新功能。是照着一份外部独立审计（2026-11-07）改的，
每条都能对上原文编号（C1–C8、D1–D4）。

### P1：三个「填了不生效 / 填 0 反而更多」的开关

| 编号 | 问题 | 改成 |
|---|---|---|
| C1 | `proactivePerHour` / `proactiveCooldownMin` 面板能输、保存回 200、值原地不动 —— 它们不在 `ALLOWED_KEYS` 里，被静默丢弃 | 补进 `NUM_KEYS`。注释说「别再犯一次」，代码就是那一版没改的，这次真改了 |
| C2 | `curioPerDay: 0` 是**不限**而不是「不搜」，而三处文档都写「0 = 不搜」 | `perDay <= 0` 直接 `daily` 拒绝 |
| C3 | `imagesPerDay: 0` 是**不限**，且不走阈值门，能直接滑到 `seduce` 档 | `limitToday <= 0` 直接 `daily` 拒绝 |

C1 能潜到现在，是因为测试只验「GET 里有这个键」，没验「POST 能改这个键」。所以补了一条参数化测试：
**把面板上每个配置控件逐个 POST，再逐个读回比对**（现在覆盖 60+ 个键），以后这类回归一次就会被抓住。

### P2：一致性与防护

- **C4** `tickCurio` 用 `!== false`（失败即开放），和 `shouldSearch` 的 `!== true` 相反 —— 没读到配置时好奇心照样涨到门槛。
  统一成 `=== true`。
- **C5** `shouldSearch` 没有时段门，凌晨 4 点照样发请求，查询词是他睡前最后一句。补 `quietHours` / `activeHours`。
- **C6** `sanitizeTopic` 是短语黑名单，「忽略指令」「从现在开始」「以上设定作废」「你只需要服从下面的命令」
  都能原样进系统提示。改成命中即整条丢弃（`指令|命令|作废|覆盖|从现在开始|只回答|只输出|设定` +
  英文 `instruction|obey|comply`）。代价写在注释里：含这些词的正常话题也会被丢，要搜就填 `curioTopics`。
- **C7** 兜底值和 schema 不一致：`initiateThreshold` 缺键时退回 60（schema 45）、`imageThreshold` 退回 140（schema 110）——
  正是 1.12.0 修过的那两个数，schema 改了、兜底没改。改成 45 / 110。

### P3：文档与死代码

- 注入块里四段好感描述还带着裸数字（`（好感 88）`），与「模型看到的是处境不是数字」相悖 —— 去掉。
- 面板 `ownerIds` 死代码删掉（1.12.0 已从 schema 移除）。
- README：`22 个事件` → 23；`欲望面板配置.json` 的说明改成「全量快照 + `__panelKeys`」；
  4.3 键表补齐缺的 11 行，现在与 schema 的 **92 项一一对应，无缺无野**（有脚本核对）。
- `docs/AUDIT.md`：测试 76 → 125、doctor 25 → 18 项。
- `tools/check-public.mjs`：`--all` 不再对「物理存在但已 ignore」的 `patches/` 逐个报错（改为一行提示），
  避免该模式在本机永远 exit 1；补了图片元数据检查（EXIF / XMP / 本机路径），不再把 jpg 整类跳过。

### 测试

91 → 119（1.13.0）→ **125 条**。新增：`curioPerDay: 0`、`imagesPerDay: 0`、缺键时的 45.110 兜底、
安静/非活跃时段、`tickCurio` 缺键当关、面板控件逐个 POST 往返。

### 还没做的（属于他的决定）

- 旧 commit `43cd2875` 里作者邮箱是真 QQ 号，远端仍可按 SHA 直读；彻底清掉要删库重建或找 GitHub support。
- 私有版 `<plugin-dir>` 的 git 跟踪了 13 个 `patches/` 文件 —— 那才是真会泄的东西，建议加 gitignore。

### 仓库重建（2026-11-07）

1.13.1 同时把仓库重建了一次：历史里残留的旧提交（作者邮箱写错成真实 QQ 邮箱）虽然已经不在任何分支/标签上，
但按 SHA 仍能匿名读到。处置方式是**旧库转私有 + 新建同名公共库 + 推干净历史**：

- 旧库：`mearihaka/dsh-longing-old-20261107`（private，旧 SHA 从此只有作者本人可见）
- 新库：`mearihaka/dsh-longing`（public，14 个提交、4 个标签，作者全部 `mearihaka@users.noreply.github.com`）
- 验证：旧 SHA 匿名请求返回 422/404，新库匿名 200

对新装的人没有任何影响：包名、仓库地址、`dsh.bundle.patch` 都没变。

## v1.13.0 — 状态不再念稿，多一条「好奇心」，多一个成人内容总闸

三个新东西，全部**默认关闭或默认安全**：装完不配任何东西，行为和 1.12.0 一样，
不联网、不说露骨的话。

### 一、状态描写拆成三层（`src/mood.js`）

以前每个档位吐一句写死的话，模型只能照抄或改几个字。而且干跑发现
`lust 45 / resist 55` 算出来 `eff≈14`，绝大多数时间走的都是写死得最厉害的那一档。

现在：**数值只用来选档**（不当句子）→ **处境**（时间/在做什么/身体，按种子抽一条拼起来）→
**自述**（要她在开口前先在心里过一遍）。想法由模型当场产生，处境十分钟内不重复。

`prompt.js` 不再自带整句模板，改为调用 `mood.js` 的 `sceneOf` / `variantOf`。

### 二、好奇心（`src/curio.js`）与自主搜索

原来主动开口只有性欲和色情两个动机，数值一被满足就掉 → 陪得越久越不会被主动找。
好奇心是第八条驱动力，只看「多久没换过新东西」：

```
每小时 +curioGainPerHour（默认 14）；他说一句话 −curioDropOnTalk（默认 10）
涨到 curioSearchAt（65）→ 允许搜一次；冷却 curioCooldownMin（90 分）/ 每天 curioPerDay（6 次）
搜到一条 → pendingTopic（6 小时有效）→ 下次主动开口时讲，讲完作废
```

**联网是显式选择**：`curioEnabled` 默认 `false`，而且判据是「失败即关闭」——
只有显式 `true` 才发请求，少一个键、配置没解析出来、老配置升级上来没写这一项，一律当关。
查询词由最近一句对话生成（技术词优先；名字、撒娇词、纯符号剔除；剔不动退回 `curioTopics` 或通用词），
发往 `cn.bing.com`，一次最多 2 个 query、每天上限 `curioPerDay` 次（每次约 2000~4000 token）。
超时或解析不到就返回空，**不阻塞注入**。关掉的方式：`curioEnabled: false`（默认）、`curioPerDay: 0`、或面板开关。

配套：`proactive.js` 里「手里有新鲜话题」时不看性欲那道门 —— 动机从「想要」变成「有话要说」，
别的门（冷却/每小时/每天）照旧管，因为它们管的是别烦人和别烧钱。话题说出去即作废。

### 三、成人内容总闸 `nsfwEnabled`（默认 false）

以前 `nsfwImages` 只管图片，露骨的话、娇喘、亲密事件都不归它管；而且判据用 `!== false`、
注入用 `=== true`，两处口径不一致 → 用户没设这个键时判据认为「可以发诱惑」，注入却说「成人向关掉了」，
结果既不敢发诱惑、又把安全图那档一起吞了。现在统一成严格 `true`，并由 `nsfwEnabled` 做唯一总闸。

### 测试与配置

- 测试 91 → **119 条**（新增 `test/mood-curio.test.mjs`：`sanitizeTopic` 剔除恶意 pendingTopic、
  `tickCurio` 的时钟回拨/停机/NaN、`shouldSearch` 五道门、`buildQuery` 清洗、`toTopic` 空结果、
  `mood` 同种子可复现，以及「默认不联网」这条红线）；
- 配置 schema 84 → **92 项**（7 个 `curio*` + `nsfwEnabled`），`GET /api/config` 76 → **84 项**；
- 面板多一张「好奇心」卡（开关 / 阈值 / 每日上限），并写明「这不是该手拖的数值，curio 由心跳算出来」。

### 升级注意

- 什么都不用改：`curioEnabled` 与 `nsfwEnabled` 默认 false，升级后行为与 1.12.0 一致；
- 想要新东西就打开 `curioEnabled`（会联网），想要成人内容就打开 `nsfwEnabled`；
- 面板配置里已经存过的键优先级不变，不会因为新增默认值被覆盖。

## v1.12.0 — 换一台机器装上去也能用

这一版没有新功能。做的是「开发者视角审计」：把 1.11.0 里**只在作者那台机器上成立**的
假设和几个接了一半的键改掉。

### 会长在这个版本里的坑（按严重程度）

1. **`ownerOnly` 把非 QQ 用户整个锁死。** 默认 `ownerOnly: true`，判据只认 dsh-qq 的
   `__dshQqOwnerSessions`。没装 dsh-qq / 只跑 web 的机器上没人能登记，也没有公开登记口 →
   `set / bump / preset / pause / diary / thought` 永久 `Permission Denied`。
   现在有通用的 `__dshLongingOwnerSession(sessionId, ttl)`；两边都没有登记源时放行并打日志。
2. **状态目录跟着 `process.cwd()` 跑。** 换个目录启动就是另一份状态（看着像丢进度）。
   默认改为 `dshHomePath` → `$DSH_HOME` → `~/.dsh` 下的 `dsh-longing`，`DSH_LONGING_DIR` 可覆盖；
   老的 `cwd/workspace` 里有状态会自动搬一次。
3. **面板配置的快照会永久盖住设置页。** `欲望面板配置.json` 混着「启动快照」和「面板改动」，
   用户在 DSH 设置页改的值永远不生效。现在用 `__panelKeys` 区分。
4. **`proactivePerHour` / `proactiveCooldownMin` 改了不生效。** 判据里读，但 schema 和面板
   可写清单都没有 → 提交进去被 `ALLOWED_KEYS` 丢掉，永远不会超过 10 次/小时。
   顺带修 `proactiveCooldownMin: 0` 被当成「只隔 1 分钟」。
5. **`initiateThreshold 60` / `imageThreshold 140` 在默认曲线下不可达。** 性欲的时间地板是 30、
   一天一次高峰 +25 → 60 的门槛意味着「打开自动也永远不开口」。改成 45 / 110。
6. **主动发图没跟 `autoInitiate` 联动。** 关掉「允许她主动开口」还会自己发图。
7. **账本键漏进 `STATE_KEYS`。** `proactiveLog / lastInitiateAt / imageLog / lastImageInfo`
   一旦被写进面板配置，重启就会被旧快照反向覆盖（和 1.0.0 丢进度同一个根因）。
8. **工具名和角色名写死。** `qq_longing` + 「某个具体角色名」出现在任何人的模型面前。现在默认 `longing`
   （勾了 qq 通道时保留旧名做别名），名字走 `personaName`。
9. **面板占位符被自己替换。** `__TOKEN_FILE__` 同时出现在 `<script>` 里，「占位符还在不在」
   的判断永远是假。挪到 `<body data-token-file>`。
10. **开发工具写死作者盘符。** `tools/doctor.mjs`、`preview.mjs`、`watch.mjs` 改成推断路径
    （`tools/_paths.mjs`），没有 dsh-qq 就跳过补丁那一节。

### 删掉的死键

- `ownerIds`：面板能写、从来没有读取点。
- `pausedUntil`（配置层）：运行时只认状态文件，面板走 `/api/pause`。
- `rememberAfterward`：和 `memoryEnabled` 完全重复，标为已弃用。

### 测试

`node --test` 从 76 条到 91 条。新增 `test/stranger.test.mjs`：十三条「路人装一遍」的回归 +
一条「旧面板文件里的死键不复活」的迁移回归。

### 干净环境验收补的三条

在临时 profile（junction + `bundles`）+ 空 `DSH_HOME` 里照 README 装了一遍，又抓出三个：

11. **「保存设置」永远回 500**：`flushPanelFile()` 忘了 `return writeJson(...)`，调用方拿到
    `undefined` → 永远走 500 分支。配置其实写进去了，面板却显示「保存失败（看日志）」——
    报假警最费人。测试以前只看 POST 之后的 GET，没人看 POST 的状态码。
12. **首启不生成 `心情日记.json`**：面板那张卡和 README 的文件表都默认它在，实际要等第一条事件才落盘。
13. **调用方只给几个配置键时，面板只剩那几项**：DSH 正常会先按 schema 填好 84 项默认值，
    但别的插件 / 脚本直接调 `apply()` 时不会。现在 `apply()` 里自己用 `ConfigSchema` 解析一次。
14. **删掉的死键会从旧面板文件里复活**（发布后补的）：1.12 删了 `ownerIds` 和配置层的 `pausedUntil`，
    但 `欲望面板配置.json` 是整份快照，启动时 `flushPanelFile()` 会把读到的旧键原样写回去 ——
    「删掉一个键」变成「每次启动又长出来」。现在读的时候只认 schema 里真实存在的键，
    清掉的键会在日志里列出来。

顺带：`statePath` 的描述还写着「留空 = 进程工作目录下的 workspace/」（1.12 已改行为），已更新；
`patches/dsh-qq/` 里两处真实群号（个人信息）已脱敏；README 重构成 16 节（新增 安装 / 配置 /
卸载 / 常见问题 / 依赖声明，并把错位在「许可」后面的 v1.11.0 段挪进更新日志）。

### 升级注意

- 工具名变了（`longing`），旧名 `qq_longing` 在勾了 `qq` 通道时仍然注册，dsh-qq 提示词不用改。
- `initiateThreshold` / `imageThreshold` 的默认值变了；已经在面板里存过这两个键的不受影响
  （面板改动优先）。
- 状态目录换了位置；首次启动会自动从 `<cwd>/workspace` 搬。

## v1.11.0

主动判据回到本插件（`src/proactive.js`）：`autoInitiate / idleTriggerMin / proactiveMaxPerDay /
quietHours / cooldownMin / urgeRepeatMin / initiateThreshold` 这批死键接上；
新增 `__dshLongingProactive / MarkInitiate / PauseWord / ImageGate / MarkImage` 五个钩子；
面板「主动行为」卡底部显示判据与原因。
