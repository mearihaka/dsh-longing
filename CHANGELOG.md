# CHANGELOG

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

`node --test` 从 76 条到 90 条。新增 `test/stranger.test.mjs`：十二条「路人装一遍」的回归。

### 干净环境验收补的三条

在临时 profile（junction + `bundles`）+ 空 `DSH_HOME` 里照 README 装了一遍，又抓出三个：

11. **「保存设置」永远回 500**：`flushPanelFile()` 忘了 `return writeJson(...)`，调用方拿到
    `undefined` → 永远走 500 分支。配置其实写进去了，面板却显示「保存失败（看日志）」——
    报假警最费人。测试以前只看 POST 之后的 GET，没人看 POST 的状态码。
12. **首启不生成 `心情日记.json`**：面板那张卡和 README 的文件表都默认它在，实际要等第一条事件才落盘。
13. **调用方只给几个配置键时，面板只剩那几项**：DSH 正常会先按 schema 填好 84 项默认值，
    但别的插件 / 脚本直接调 `apply()` 时不会。现在 `apply()` 里自己用 `ConfigSchema` 解析一次。

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
