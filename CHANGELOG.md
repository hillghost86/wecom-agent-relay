# 更新记录

格式参考 Keep a Changelog；版本号对应 GitHub Release 的 tag。
「未发布」是已提交到 main、尚未打 tag 的改动。

## 未发布

（暂无）

## v0.1.1 — 2026-09-22

### 修复
- 服务端 `/ack` 的 seq 钳到当前最大值，误传大数不再让后续消息全部落在游标之下被跳过
- 服务端对企微重推的重复 `msgid` 仍回「已收到」帧（只是不再落盘）；企微重推正是因为上次没在 5 秒内收到回帧，原来直接忽略会让用户看到机器人无响应
- 服务端 `/send` 在网关未订阅、等回执超时等预期失败时返回 200 + `ok:false` + `error`，不再返回 500；反代 / Cloudflare 会用自己的错误页覆盖 5xx 响应体
- 服务端 `/messages` 的 `after`、`limit` 非数字时返回 400，不再因 NaN 返回全部内存记录
- `client/poll.mjs --ack` 不带数字时改为「拉取后按最大 seq 确认」，原来会发 `seq=undefined` 被拒
- `client/poll.mjs` 拉取列表的时间列改读 `received_at`，原来引用的 `send_time` 字段不存在，一直为空
- `client/sentinel.mjs` 首次运行以服务端已确认游标起步，有未 ack 的积压会立刻唤醒一次；原来以最新 seq 起步会跳过积压
- `client/sentinel.mjs --exec` 只取紧跟的一个参数，不再把后续 `--interval` 的值拼进命令、也不再丢掉命令里以 `--` 开头的片段
- `client/*.mjs --help` 在 ESM 下引用不存在的 `__filename` 报错（WorkBuddy 修复）

### 变更
- 服务端日志里 `response_url` 只留尾部 8 位，落盘文件仍保留完整
- `test_mock.mjs` 从 21 项扩到 28 项，新增 client 两个脚本对假网关的断言

### 文档
- README、SKILL.md 里的仓库地址占位符换成真实 GitHub 地址
- SKILL.md 部署第 3 步补上安装 systemd 单元的命令，原来直接 enable 会失败
- 验证步骤改为看 `subscribed` 而非 `connected`；`--exec` 示例改为跨平台写法
- `wecom-bot.service` 和 server/README 补充 nvm 环境下 systemd 找不到 node 的处理
- 排障手册补充：被踢线可从 `disconnected_event` 记录识别；`--send` 返回 `not subscribed` 的含义
- CLAUDE.md 记录官方 SDK `@wecom/aibot-node-sdk` 的评估结论：暂不引入，做媒体消息时再考虑

## v0.1.0 — 2026-09-22

首次发布。

- `server/`：VPS 长连接网关。连企微 WebSocket 收消息、落盘 `messages.jsonl`、HTTP API（`/health` `/messages` `/messages/<seq>` `/ack` `/send`）、30 秒心跳、指数退避重连、断线自报（含进程重启空窗）
- `client/`：`sentinel.mjs` 哨兵（发现新消息即退出，唤醒对话式 agent）、`poll.mjs`（拉取 / 单条取 / 回复 / 推送 / ack）
- `skill/`：WorkBuddy 一句话安装技能，附架构说明与排障手册，Release 附带 zip
- 实测结论写入文档：企微静默丢弃机器人离线期间的消息；一个机器人只允许一条连接；`response_url` 1 小时内一次、只认 markdown；`/send` 没有 text 类型
