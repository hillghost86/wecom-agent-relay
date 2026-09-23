# wecom-agent-relay

把**企业微信智能机器人**的消息变成 **AI agent 的事件**：VPS 长连接收消息落盘，
本地哨兵发现新消息即「退出唤醒」对话式 agent —— 秒级响应、哨兵离线也不丢消息、
不耗 agent 平台积分。

**无需公网 IP、无需域名备案、无需加解密**（用的是企微智能机器人的 WebSocket 长连接 API 模式）。

```
企微服务器
   │ wss 长连接（30s 心跳 · 断线自动重连）
   ▼
VPS 网关 server/（7×24 在线，唯一持久层 messages.jsonl）
   │ HTTPS API：/health /messages /messages/<seq> /ack /send
   ▼
本机 client/
   ├─ sentinel.mjs   哨兵：轮询发现新消息 → 退出 → 借「后台任务完成通知」唤醒 agent
   └─ poll.mjs       工具：单条取 / 回复 / 推送 / 推进游标
```

## 为什么这么设计

- **为什么必须有 VPS 落盘？** 实测：企业微信会**静默丢弃**机器人不在线期间的消息。
  agent 所在的电脑会关机、会断网，所以消息可靠性只能靠一台 7×24 的 VPS。
- **为什么哨兵要「退出」？** 对话式 agent（WorkBuddy、Claude Code 等）不能常驻监听，
  但它们的「后台任务完成」会自动唤醒 agent。哨兵是一个后台任务：
  平时长跑待命（零消耗），一发现新消息就退出 —— 退出即事件，事件即唤醒。
- **为什么消息不会丢？** agent 处理消息的几分钟里哨兵不在线，但连接在 VPS 上，
  新消息照常落盘；agent 处理完重挂哨兵，从游标补拉，一条不丢。
- **为什么不耗平台积分？** 轮询由本地哨兵进程承担（不经过 agent）；
  agent 只在「真有消息」时被唤醒，唤醒即干活，没有空转的定时任务。
- **为什么要知道处理端在不在？** 哨兵和客户端每次请求都带 `X-Relay-Agent` 头，网关据此判断
  「处理端（agent 那台机器）」是否还在。这样用户发消息时能拿到一句诚实的回复：在线回「已收到」，
  离线回「已收到。处理端已离线 X 小时，上线后会处理」，而不是让人干等。管理员则能在 `/health` 里
  一眼看到三层状态——企微连接在不在（`subscribed`）、处理端在不在（`agent_online`）、积压多少（`pending`）。

## 目录

```
├── server/                   VPS 长连接网关（部署说明见 server/README.md）
├── client/
│   ├── sentinel.mjs          事件哨兵（本机，agent 后台任务）
│   ├── poll.mjs              处理客户端（拉取 / 单条取 / 回复 / 推送 / ack）
│   ├── config.example.json   复制为同目录 config.json 填入真实配置
│   └── start.example.bat     Windows 挂哨兵示例（%~dp0 相对路径，放哪都能跑）
└── skill/wecom-agent-relay/  WorkBuddy 一句话安装技能（SKILL.md + 架构说明 + 排障手册）
```

## 快速开始

### WorkBuddy 用户（推荐）：一句话安装

本仓库自带 WorkBuddy 技能（`skill/wecom-agent-relay/`），装上后对 WorkBuddy 说一句
「**帮我接入企微机器人**」，它会引导完成前置检查 → 克隆配置 → VPS 部署 → 挂哨兵 → 实测闭环。

安装方式（二选一）：

```bash
# 方式 A：clone 后复制技能目录
git clone https://github.com/hillghost86/wecom-agent-relay.git && mkdir -p ~/.workbuddy/skills
cp -r wecom-agent-relay/skill/wecom-agent-relay ~/.workbuddy/skills/

# 方式 B：直接下载发布包里的 wecom-agent-relay.zip，解压到 ~/.workbuddy/skills/
```

重启 WorkBuddy 后说「接入企微机器人」即可。技能内置架构说明与故障排查手册。

### 其他 agent / 手动部署

见下文「快速开始」五步；哨兵的 stdout 契约与 `--exec` 见「接入你的 agent」。

### 1. 前置

- 企业微信管理后台 → 管理工具 → 智能机器人 → 开启 API 模式 → 连接方式选「长连接」，
  拿到 **Bot ID** 和 **Secret**（Secret 只显示一次）
- 一台 VPS（在线率越高越好）+ 一个能解析到 VPS 的域名（给 HTTP API 套 HTTPS；长连接模式不需要备案）
- 本机 Node ≥ 18

### 2. 部署 VPS 网关

见 [server/README.md](server/README.md)。核心：`server/index.mjs` 以 systemd 常驻，
配置走 `config.json`（从 `server/config.example.json` 复制）：`bot_id` / `secret` /
`http.api_token`（`openssl rand -hex 32` 自生成）必填，`admin_userid` 填一个 userid 可收到断线自报。

### 3. 配置本机客户端

```bash
cp client/config.example.json client/config.json
# api_base = 反代后的 HTTPS 地址；api_token = 服务端 config.json 里的 http.api_token
# agent_id 可选，用来在网关侧标识这台处理端，不填默认用本机主机名
```

### 4. 验证

```bash
node client/poll.mjs --health      # subscribed: true 即网关已订阅企微（connected 只代表 WS 已建立）
node client/sentinel.mjs --once    # NO_MSG 或 NEW_MSG 都正常；有未 ack 的积压会立刻 NEW_MSG
```

### 5. 挂哨兵

保持一个常驻终端（或把 `start.example.bat` 的快捷方式放进 `shell:startup`）：

```bash
node client/sentinel.mjs --interval 10
```

之后在企微里 @机器人 说句话，10 秒内哨兵退出 —— 事件已就绪。

## 接入你的 agent

### WorkBuddy / Claude Code（推荐姿势）

让 agent 把哨兵作为**后台任务**挂起。以 WorkBuddy 为例，对 agent 说：

> 把 `node client/sentinel.mjs` 用后台任务挂起，它退出时你会被自动唤醒；
> 唤醒后从输出里的 seq 范围用 `GET /messages/<seq>` 取消息，
> 按内容处理，用 `response_url` 回复（格式见 [server/README.md](server/README.md#通过-response_url-回复)），
> 然后 `--ack` 推进游标，最后重挂哨兵。

之后即可在企微里 @机器人 下指令（记账、查询、提醒……），agent 秒级响应，
全程无需打开 agent 界面。**关键约定：agent 每次处理完必须重挂哨兵**，
否则后续消息没人发现（消息会安全地攒在 VPS）。

### 其他系统（--exec）

哨兵发现新消息时可执行任意命令（webhook、脚本、通知……），执行完照常退出：

```bash
node client/sentinel.mjs --exec "curl -s -X POST https://your-hook -d new_message"   # 只取一个参数，整体加引号
```

### stdout 契约

| 输出 | 含义 |
|---|---|
| `NEW_MSG count=<n> seq=<a>-<b> acked=<cursor> agent=<id>` | 发现 n 条新消息（seq 闭区间），`agent` 是本机的处理端标识；只算真消息，`enter_chat` 等事件不唤醒 |
| `NO_MSG ...` | `--once` 模式下无新消息 |

## HTTP API（VPS 网关，请求头 `Authorization: Bearer <api_token>`；处理端另带 `X-Relay-Agent: <agent_id>` 报在线）

| 接口 | 作用 |
|---|---|
| `GET /health` | 连接状态、最新 seq、游标，以及处理端在线状态（`agent_online` / `agent_last_seen` / `last_agent`）和 `pending`（未 ack 的真消息数，事件不计） |
| `GET /messages?after=<seq>&limit=50&kind=message` | 拉 seq > after 的消息；不带 after 时从已确认游标起；limit 上限 500 |
| `GET /messages/<seq>` | 按 seq 取单条，不存在返回 404 |
| `GET /ack?seq=<seq>` | 游标推进到 seq（超过最大 seq 会钳到当前 seq） |
| `POST /send` | 主动推送。msgtype 只支持 `markdown`/`template_card`/`file`/`image`/`voice`/`video`（**没有 text**）；`chatid` 单聊填 userid、群聊填群 chatid |

## 踩坑记录（给后来者）

1. **企微会静默丢弃机器人离线期间的消息** —— 别指望重推，VPS 常驻是唯一解。
2. 一个机器人**只允许一条 WS 连接**，新连接会踢掉旧连接；高可用用主备切换。
3. `response_url` 回复：1 小时内有效、只能调一次；msgtype 只认 `markdown`；
   **HTTP 200 不代表成功**，必须看 body 里的 `errcode`（过期返回 60140）。
4. `/send` 主动推送：字段是 `chatid` 不是 `chat_id`；企微拒绝时返回 200 且 `ok:false`。
5. 群聊只有 @机器人 才会推送消息回调；单聊消息只有 `from.userid`。

## 安全

- `client/config.json` / `server/config.json` / `*.jsonl` 游标与消息文件已在 `.gitignore`，绝不入库
- `api_token` 与 `Secret` 泄露 = 任何人可读你的消息、冒充你的机器人，妥善保管
- 本项目与腾讯官方无关，仅调用公开的企业微信智能机器人 API，请遵守企微开发者协议

## 更新记录

见 [CHANGELOG.md](CHANGELOG.md)。

## License

[MIT](LICENSE)
