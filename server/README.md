# server · VPS 长连接网关

常驻 VPS 的 WebSocket 客户端：连企业微信智能机器人的长连接网关收消息，落盘到 `messages.jsonl`，
通过 HTTP API 供本机 agent 拉取。企微会静默丢弃机器人离线期间的消息，这台 7×24 在线的 VPS 是唯一持久层。
整体架构和客户端用法见[仓库根 README](../README.md)。

## 快速开始

1. 企微后台 → 管理工具 → 智能机器人 → API 模式 → 连接方式「使用长连接」，拿 **Bot ID** 和 **Secret**（Secret 只显示一次）。
2. 配置并运行（Node ≥ 18）：

```bash
npm i
cp .env.example .env     # 填 WECOM_BOT_ID、WECOM_BOT_SECRET、API_TOKEN（openssl rand -hex 32）、ADMIN_USERID（收断线通知的人）
node --env-file=.env index.mjs
```

看到 `订阅成功，开始心跳` 后在企微里 @机器人 说话，终端会打印明文，企微收到自动回复「已收到」。

## 部署到 VPS

```bash
# 上传 index.mjs package.json .env wecom-bot.service 到 /opt/wecom-bot，然后：
cd /opt/wecom-bot && npm i && chmod 600 .env
sudo cp wecom-bot.service /etc/systemd/system/ && sudo systemctl daemon-reload
sudo systemctl enable --now wecom-bot
journalctl -u wecom-bot -f
```

用 nginx、Caddy 或宝塔把域名反代到 `http://127.0.0.1:8788` 并开 HTTPS，证书交给反代管。
一个机器人同时只能有一条连接，别在两台机器上同时跑。

如果 VPS 上的 node 是 nvm 装的，systemd 找不到它：把 `wecom-bot.service` 的 `ExecStart` 改成 `which node` 给出的绝对路径。

## agent 接口

请求头带 `Authorization: Bearer <API_TOKEN>`。

| 接口 | 作用 |
|---|---|
| `GET /health` | 连接状态、最新 seq、游标 |
| `GET /messages?after=<seq>&limit=50&kind=message` | 拉 seq 大于 after 的消息；不带 after 时从游标起；`limit` 默认 50、最多 500，一次一条就传 `limit=1` |
| `GET /messages/<seq>` | 按 seq 取单条，不存在返回 404 |
| `GET /ack?seq=<seq>` | 游标推进到 seq；超过当前最大 seq 会钳到最大 seq，防止误传大数把后续消息全跳过 |
| `POST /send` | 透传 `aibot_send_msg` 主动推送（response_url 过期后才用）。`msgtype` 只支持 `markdown`/`template_card`/`file`/`image`/`voice`/`video`，**没有 `text`**；`chatid` 单聊填 userid、群聊填群 chatid；`chat_type` 1=单聊 2=群聊，不填自动兼容。企微拒绝时返回 200 且 `ok:false`，errcode 在 `resp` 里；网关未订阅、等回执超时也返回 200 且 `ok:false`，原因在 `error` 里。不返回 5xx，因为反代/Cloudflare 会用自己的错误页覆盖响应体 |

标准循环：

```bash
curl -s -H "Authorization: Bearer $BOT_TOKEN" "$BOT_API/messages?kind=message"
```

处理完，用消息自带的 `response_url` 回复，见下一节。

然后确认游标：

```bash
curl -s -H "Authorization: Bearer $BOT_TOKEN" "$BOT_API/ack?seq=<seq>"
```

## 通过 response_url 回复

每条消息的 `body.response_url` 是企微给这条消息专用的回复地址，直接 POST 即可，不经过本进程：

```bash
curl -s -w '\nhttp_status=%{http_code}\n' "<response_url>" \
  -H 'Content-Type: application/json' \
  -d '{"msgtype":"markdown","markdown":{"content":"已记账：5 台盒子 → 马海龙"}}'
```

规则：

- **1 小时内有效，只能调一次。** 过期或已用过的再调会返回非 0 errcode。
- **`msgtype` 用 `markdown`**，也支持 `template_card`；`text` 不支持，会被拒。
- **成功返回** `{"errcode":0,"errmsg":"ok"}`；失败 HTTP 仍可能是 200，必须看 body 里的 `errcode`。
- 群聊里回复会自动引用触发的那条用户消息；单聊直接显示。
- 和进程秒回的「已收到」互不影响，用户会看到两条。
- 超过 1 小时才改用 `POST /send` 主动推送（单聊 `chatid` 填 userid，群聊填群 chatid）。

一条完整的处理示例，取游标之后的第一条消息、回复、再 ack：

```bash
M=$(curl -s -H "Authorization: Bearer $BOT_TOKEN" "$BOT_API/messages?kind=message&limit=1")
SEQ=$(echo "$M" | python3 -c 'import json,sys; m=json.load(sys.stdin)["messages"]; print(m[0]["seq"] if m else "")')
URL=$(echo "$M" | python3 -c 'import json,sys; m=json.load(sys.stdin)["messages"]; print(m[0]["body"]["response_url"] if m else "")')
[ -n "$URL" ] && curl -s "$URL" -H 'Content-Type: application/json' -d '{"msgtype":"markdown","markdown":{"content":"处理结果"}}' \
  && curl -s -H "Authorization: Bearer $BOT_TOKEN" "$BOT_API/ack?seq=$SEQ"
```

## 数据与行为

- `messages.jsonl` 每行一条，带递增 `seq`，`body` 是企微原始消息体；游标存在 `messages.jsonl.state.json`。
- 单聊消息只有 `from.userid`，群聊才有 `chatid`。
- 心跳 30 秒，断线指数退避重连，凭证错误退避 60 秒。重复 `msgid`（企微重推）仍回「已收到」帧但不再落盘。
- **断线期间的消息企微不补发，直接丢，且用户端显示发送成功**（2026-09-22 实测：停服务 → 发消息 → 启服务，日志无该消息）。所以连接在线率就是消息可靠性，重启服务尽量挑没人用的时候。
- **断线自报**：`.env` 里填 `ADMIN_USERID=<你的 userid>` 后，每次重连成功进程会给这个人推一条离线时段（起止时间、秒数、原因是连接中断还是进程重启），提醒期间的消息要重发。进程重启的空窗靠心跳每 30 秒写一次的 `messages.jsonl.alive` 文件推算，所以 VPS 宕机也能报出来。3 秒以内不报，抖动时每分钟最多报一次。
- 收到消息后 5 秒内自动回「已收到」（`REPLY_TEXT`，留空则不回），和 agent 之后的 `response_url` 回复互不影响。

## 自测

```bash
node test_mock.mjs     # 起假网关，28 项断言（含 client/ 两个脚本）
```

## 文件

`index.mjs` 主程序　`test_mock.mjs` 自测　`wecom-bot.service` systemd 单元　`.env.example` 配置模板
