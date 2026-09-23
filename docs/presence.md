# 处理端在线状态

「处理端」指跑 agent 的那台机器（装着 `client/` 的电脑）。网关判断它在不在，用来：给用户一句诚实的秒回、在 `/health` 里暴露积压、可选地告警。

## 怎么判

- 任何通过鉴权、且带 `X-Relay-Agent: <agent_id>` 头的请求，都记为「处理端露了一面」（`agent_last_seen`、`last_agent`）。
- 任何 `/ack` 记为「处理端在干活」（`last_ack_at`），带不带头都算。
- 两者取较晚的一个，距今不超过 `agent_online_secs`（默认 300 秒）为在线 `true`，否则离线 `false`。
- 网关从没见过任何 agent（全新部署、或状态文件被删）时为 `null`（未知），**按在线处理**。
- 状态和游标一起存在 `messages.jsonl.state.json`，网关重启不丢。露面时间在内存里实时更新，写盘最多每 60 秒一次。

## 谁会带头

| 调用方 | 带不带 `X-Relay-Agent` | 原因 |
|---|---|---|
| `sentinel.mjs` 长跑循环 | 带 | 它挂着就说明处理端在待命，每 10 秒一次，足以保持在线 |
| `sentinel.mjs --once` / `--status` | 不带 | 通常是人手工排查，不代表处理端在线 |
| `poll.mjs` 全部命令 | 带 | 它由 agent 执行，跑一次就是在干活 |
| 自己写的 curl | 自己决定 | agent 用就带；只读排查**不要带**，否则会把排查的机器记成处理端 |

`agent_id` 默认是主机名，建议在 `client/config.json` 里显式配置（如 `workbuddy`），见 [config.md](config.md#客户端-clientconfigjson)。

## 秒回分档

收到消息 5 秒内网关自动回一帧：

| 处理端状态 | 回复 |
|---|---|
| 在线或未知 | `reply_text`（默认「已收到」） |
| 离线 | `reply_text_offline`（默认「已收到。处理端已离线 {duration}，上线后会处理」），`{duration}` 替换为实际离线时长，如「2 小时 5 分钟」 |

`reply_text` 配成空字符串时两档都不回。

## 管理员离线告警

`offline_alert_mins` 大于 0 且配了 `admin_userid` 时开启：

- 处理端离线超过这么多分钟、**且有积压**（`pending > 0`），给管理员发一条「处理端已离线 X，积压 N 条消息无人处理」。每次离线只发一次。
- 处理端恢复在线后，再发一条「处理端已恢复（agent_id），当前积压 N 条」。
- 检查频率为每 10 秒（阈值小于 10 秒时按阈值）。网关自己未订阅时跳过。
- `pending` 只数真消息，`enter_chat` 这类事件不会触发告警。

默认 `0` 关闭：处理端一般是会休眠的个人电脑，每晚睡一次就报一次，噪音大于价值。想夜里也盯着再打开。

## 在 /health 里看三层状态

| 字段 | 回答的问题 |
|---|---|
| `subscribed` | 网关和企微连着吗？false 时消息正在丢 |
| `agent_online` / `agent_last_seen` / `last_agent` | 处理端在吗？是哪台？最后一次什么时候来的？ |
| `pending` | 积压了几条没处理的真消息？ |

## 与多 agent 的关系

在线状态按 bot 各自记录、各自持久化（每个 bot 自己的 `.state.json`）。`X-Relay-Agent` 只记到请求路径指向的那个 bot：请求 `/bots/sales/health` 只刷新 `sales` 的在线状态，不带前缀的请求只刷新 `bots` 里第一个，`GET /bots` 不刷新任何一个。秒回分档和离线告警也按各自 bot 的状态判断。

约定一个 agent 对应一个 bot，`agent_id` 只是标签，不做路由；路由靠客户端 `api_base` 里的 `/bots/<key>`。
