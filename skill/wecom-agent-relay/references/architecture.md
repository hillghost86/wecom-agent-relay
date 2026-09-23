# wecom-agent-relay 架构与设计理由

## 全链路

```
企微服务器
   │ wss 长连接（aibot_subscribe 鉴权，30s 心跳，断线自动重连）
   ▼
VPS 网关（server/index.mjs，systemd 常驻）
   │ 收到 aibot_msg_callback → 毫秒级追加 bots/<key>/messages.jsonl
   │ HTTPS API：/health /messages /messages/<seq> /ack /send（Bearer API_TOKEN）
   ▼
本机哨兵（client/sentinel.mjs，agent 的后台任务）
   │ 轮询 GET /health 只看最新 seq（10s）
   │ seq > last_seen → 查 /messages?kind=message：有真消息才打印 NEW_MSG → 进程退出
   │ （enter_chat 等事件也占 seq，只推进 last_seen、不唤醒）
   ▼
「后台任务完成通知」自动唤醒对话式 agent
   ▼
agent：GET /messages/<seq> 取消息 → 按内容处理 → POST body.response_url 回复企微
       → GET /ack?seq= 推进游标 → 重新挂起哨兵（循环待命）
```

## 设计决策与依据

### 1. 为什么必须有 VPS 常驻落盘

实测结论：**企业微信会静默丢弃智能机器人不在线期间的消息**——长连接模式没有官方的
「离线消息保留/重推」承诺（协议里 msgid 仅用于事件排重，不构成重推保证）。
agent 所在电脑会关机、断网、WorkBuddy 会关闭，因此消息可靠性只能由一台
在线率接近 100% 的 VPS 保证。bots/<key>/messages.jsonl 是整个系统唯一的消息持久层。

### 2. 为什么哨兵靠「退出」唤醒 agent

对话式 agent（WorkBuddy、Claude Code 等）的运行模型是「对话轮次驱动」：
两次对话之间 agent 不存在，无法常驻监听任何东西。但它们普遍支持
「后台任务完成时通知/唤醒 agent」（WorkBuddy 的 task-notification、
Claude Code 的 run_in_background 完成回调）。

因此把「监听」做成一个后台进程：平时睡眠轮询（每 10s 一次 HTTP，零 agent 消耗），
一旦发现新消息立即 `process.exit(0)`——退出即事件，事件即唤醒。
**无消息时哨兵永不退出**：因为每次退出都会烧掉一轮对话的固定开销，
只有「真有新消息」才值得唤醒。

### 3. 为什么消息不丢（即使哨兵不在线）

哨兵只负责「发现」，不负责「保存」。agent 处理消息的几分钟里哨兵是死的，
但企微连接在 VPS 上、消息持续落盘。agent 处理完重挂哨兵，
哨兵从 client/sentinel_cursor.json 记录的位置继续——中间到达的消息全部补上。

### 4. 轮询而非 WS 直连 VPS

VPS 网关提供的是 HTTP API。理论上可在本机与 VPS 之间再建一条 WS/SSE 下行推送，
但轮询 10s 已满足「秒级响应」且零改动零依赖；若未来需要亚秒级，
可给网关加 SSE 端点、哨兵改监听流。

### 5. stdout 契约（与任何 agent 框架对接的接口）

| 输出 | 含义 |
|---|---|
| `NEW_MSG count=<n> seq=<a>-<b> acked=<cursor> agent=<id>` | 发现 n 条新消息（seq 闭区间），进程即将退出；`agent` 是本机处理端标识；只算真消息，`enter_chat` 等事件不唤醒 |
| `NO_MSG ...` | 仅 `--once` 模式：无新消息 |

`--exec <command>` 允许在退出前执行任意命令（webhook/脚本），使哨兵能对接
任何具备「进程结束回调」能力的自动化系统，不限 WorkBuddy。

## 企微侧协议要点（实测/官方文档）

- 长连接地址 `wss://openws.work.weixin.qq.com`，订阅 `aibot_subscribe`（bot_id + secret，有频率保护）
- 群聊仅 @机器人 才推送；单聊消息只有 `from.userid`，群聊带 `chatid`
- 回复经 `aibot_respond_msg`（req_id 透传）；主动推送 `aibot_send_msg`
- 一个机器人**同一时间只允许一条有效长连接**，新连接踢旧连接；高可用用主备切换
- 官方 Node SDK：`@wecom/aibot-node-sdk`（心跳/重连/鉴权已封装）
- 发送限频：单会话 30 条/分钟、1000 条/小时

## 处理端在线状态（presence）

- 客户端对网关的每个请求都带 `X-Relay-Agent: <agent_id>` 头（`poll.mjs` 全程带；`sentinel.mjs` 只在长跑循环里带，
  `--once` / `--status` 是人手工执行的，不代表处理端在待命）。网关把它记成「处理端最近一次露面」，`/ack` 另记成「处理端在干活」。
- `agent_online_secs`（默认 300 秒）内有过露面或 ack 就算在线，否则离线；进程刚起来还没见过任何 agent 时是 `null`（未知），按在线处理。
  状态在 `/health` 里（`agent_online` / `agent_last_seen` / `last_agent` / `last_ack_at` / `pending`）；离线时企微的自动回复换成带离线时长的文案。
