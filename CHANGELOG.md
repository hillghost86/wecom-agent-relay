# 更新记录

格式参考 Keep a Changelog；版本号对应 GitHub Release 的 tag。
「未发布」是已提交到 main、尚未打 tag 的改动。

## 未发布

### 文档
- 新增 `docs/` 参考手册，入口 `docs/README.md` 按「我想查什么」和功能索引：HTTP API 完整字段（含消息记录格式）、服务端与客户端全部配置项、部署 / 升级 / `.env` 迁移、企微协议事实（标注文档 / 实测 / 推断，含媒体文件解密方法）、处理端在线状态、agent 接入与 `poll.mjs` 命令表、路线图。根 README、`server/README.md`、CLAUDE.md 指向它。

### 变更
- `client/sentinel.mjs` 只对真消息（`kind=message`）唤醒：新 seq 里全是 `enter_chat` 等事件时只推进本地 `last_seen`、不退出（`--once` 打印 `NO_MSG`）；
  `NEW_MSG` 的 `count` 和 `seq` 区间只算真消息，格式不变。查询 `/messages` 失败时按旧逻辑当作全是真消息唤醒，宁可多唤醒不漏处理。
- `/health` 的 `pending` 只数未 ack 的真消息，事件不计入积压（离线告警同样按这个数判断）。
- `test_mock.mjs` 从 36 项扩到 39 项，新增只有事件时不唤醒、`pending` 不计事件、事件后真消息的 seq 区间断言。

## v0.2.0 — 2026-09-24

### 变更
- **服务端配置从环境变量迁到 `config.json`**（结构见 `server/config.example.json`：顶层 `http` / `tz` / `agent_online_secs`，机器人放在 `bots` 列表，本版本只允许一个）。
  启动方式变为 `node index.mjs --config /opt/wecom-bot/config.json`，不给 `--config` 时读工作目录下的 `config.json`；`server/.env.example` 已删除，
  `wecom-bot.service` 去掉 `EnvironmentFile=`、`ExecStart` 带上 `--config`。
  **迁移步骤**：把原 `.env` 里的值填进 `config.json`（`WECOM_BOT_ID`→`bots[0].bot_id`、`WECOM_BOT_SECRET`→`bots[0].secret`、`API_TOKEN`→`http.api_token`、
  `ADMIN_USERID`→`bots[0].admin_userid`、`REPLY_TEXT`→`bots[0].reply_text`、`MSG_LOG`→`bots[0].msg_log`、`HTTP_HOST`/`HTTP_PORT`→`http.host`/`http.port`），
  `chmod 600 config.json`，再把 systemd 单元的 `ExecStart` 加上 `--config`。
  兼容期：没有 `config.json` 但有 `WECOM_BOT_ID` / `WECOM_BOT_SECRET` 环境变量时仍能启动并打一条迁移警告，**下个版本移除**。
- **stdout 契约变更**：`client/sentinel.mjs` 的 `NEW_MSG` 行末尾多一段 `agent=<agent_id>`，
  完整格式为 `NEW_MSG count=<n> seq=<a>-<b> acked=<cursor> agent=<id>`（`NO_MSG` 不变）。按前缀或 seq 解析的脚本不受影响，整行精确匹配的要改。

### 新增
- **处理端在线状态（presence）**：HTTP 请求带 `X-Relay-Agent: <agent_id>` 头即视为处理端露面，`/ack` 记为处理端在干活；
  `agent_online_secs`（默认 300 秒）内有露面或 ack 就算在线，进程启动后还没见过任何 agent 时为「未知」并按在线处理。
- **自动回复分档**：处理端离线时，给企微的秒回文案换成 `reply_text_offline`（默认「已收到。处理端已离线 {duration}，上线后会处理」，`{duration}` 替换为实际离线时长）。
- `/health` 新增 `bot`、`agent_online`（true/false/null）、`agent_last_seen`、`last_agent`、`last_ack_at`、`pending`（未 ack 条数）；presence 与游标一起持久化。
- **管理员离线告警** `offline_alert_mins`（默认 `0` = 关闭）：处理端离线超过这个分钟数且有积压时给 `admin_userid` 推一条，恢复后再推一条。
  默认关，因为处理端所在的电脑每晚休眠就会每晚报一次。
- `client/config.json` 新增可选项 `agent_id`（读取优先级：环境变量 `WECOM_AGENT_ID` > `config.json` 的 `agent_id` > 本机主机名）。
  `poll.mjs` 的所有网关请求都带 `X-Relay-Agent`；`sentinel.mjs` 只在长跑循环里带，`--once` / `--status` 不带（它们常由人手工执行，不代表处理端在线）。
- `client/sentinel.mjs --status` 输出补上 `处理端=<在线|离线|未知>(<last_agent>)`。
- `test_mock.mjs` 从 28 项扩到 36 项，新增 presence、分档回复、离线告警、config.json 校验与环境变量兼容加载的断言。

### 文档
- README、`server/README.md`、SKILL.md、架构说明、排障手册、CLAUDE.md 同步配置迁移与 presence：
  部署清单里 `.env` 全部换成 `config.json`（`chmod 600`），`/health` 字段表补齐，新增「为什么要知道处理端在不在」「处理端在线状态」两节，
  排障手册新增「用户收到『处理端已离线』的回复」和「`/health` 的 `agent_online` 是 null」两条。

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
