# server · VPS 长连接网关

常驻 VPS 的 WebSocket 客户端：连企业微信智能机器人的长连接网关收消息，落盘到 `bots/<key>/messages.jsonl`，
通过 HTTP API 供本机 agent 拉取。企微会静默丢弃机器人离线期间的消息，这台 7×24 在线的 VPS 是唯一持久层。
整体架构和客户端用法见[仓库根 README](../README.md)；每个接口的字段、每个配置项的含义、升级与迁移步骤见 [docs/](../docs/README.md)。

## 快速开始

1. 企微后台 → 管理工具 → 智能机器人 → API 模式 → 连接方式「使用长连接」，拿 **Bot ID** 和 **Secret**（Secret 只显示一次）。
2. 配置并运行（Node ≥ 18）：

```bash
npm i
cp config.example.json config.json   # 填 bot_id、secret、http.api_token（openssl rand -hex 32）、admin_userid（收断线通知的人）
npm start                            # 即 node src/index.mjs；默认读工作目录下的 config.json，别的位置用 --config <路径>
```

配置项和默认值见 `config.example.json`。`bots` 里可以配多个机器人，写法见 [docs/config.md § 配置多个机器人](../docs/config.md#配置多个机器人)。

看到 `订阅成功，开始心跳` 后在企微里 @机器人 说话，终端会打印明文，企微收到自动回复「已收到」。

## 部署到 VPS

```bash
# 上传 package.json、src/ 整个目录、config.json、wecom-bot.service 到 /opt/wecom-bot（确认文件属主和运行用户一致），然后：
cd /opt/wecom-bot && npm i && chmod 600 config.json
sudo cp wecom-bot.service /etc/systemd/system/ && sudo systemctl daemon-reload
sudo systemctl enable --now wecom-bot
journalctl -u wecom-bot -f
```

用 nginx、Caddy 或宝塔把域名反代到 `http://127.0.0.1:8788` 并开 HTTPS，证书交给反代管。
一个机器人同时只能有一条连接，别在两台机器上同时跑。

如果 VPS 上的 node 是 nvm 装的，systemd 找不到它：把 `wecom-bot.service` 的 `ExecStart` 改成 `which node` 给出的绝对路径。

## agent 接口

请求头带 `Authorization: Bearer <api_token>`。再带一个 `X-Relay-Agent: <agent_id>`，
网关就把这次请求记成「处理端露了一面」，用来判在线（见下文「处理端在线状态」）；不带也能正常调，只是不算在线。

配了多个机器人时，下表每个接口都可加前缀 `/bots/<key>` 指定机器人，不带前缀指向 `bots` 里第一个；管理员 token（`http.api_token`）另有 `GET /bots` 看全部机器人状态，bot token（`bots[].api_token`）只能访问自己那个。详见 [docs/api.md § 多 bot 路由](../docs/api.md#多-bot-路由)。

| 接口 | 作用 |
|---|---|
| `GET /health` | 连接状态、最新 seq、游标，外加 `bot`（配置里的 key）、`agent_online`（true/false/null）、`agent_last_seen`、`last_agent`、`last_ack_at`、`pending`（未 ack 的真消息数，事件不计） |
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

- `bots/<key>/messages.jsonl` 每行一条（单 bot 是 `bots/default/messages.jsonl`），带递增 `seq`，`body` 是企微原始消息体；游标存在同名的 `.state.json`。
- 单聊消息只有 `from.userid`，群聊才有 `chatid`。
- 事件（如用户点开聊天窗时的 `enter_chat`）也会落盘（`kind: "event"`）并占 `seq`，但不计入 `pending`、不唤醒哨兵；`/messages` 加 `kind=message` 可过滤掉。
- 心跳 30 秒，断线指数退避重连，凭证错误退避 60 秒。重复 `msgid`（企微重推）仍回「已收到」帧但不再落盘。
- **断线期间的消息企微不补发，直接丢，且用户端显示发送成功**（2026-09-22 实测：停服务 → 发消息 → 启服务，日志无该消息）。所以连接在线率就是消息可靠性，重启服务尽量挑没人用的时候。
- **断线自报**：配置里填 `admin_userid: "<你的 userid>"` 后，每次重连成功进程会给这个人推一条离线时段（起止时间、秒数、原因是连接中断还是进程重启），提醒期间的消息要重发。进程重启的空窗靠心跳每 30 秒写一次的 `bots/<key>/messages.jsonl.alive` 文件推算，所以 VPS 宕机也能报出来。3 秒以内不报，抖动时每分钟最多报一次。
- 收到消息后 5 秒内自动回「已收到」（`reply_text`，留空则不回），和 agent 之后的 `response_url` 回复互不影响。
- **处理端在线状态**：任何带 `X-Relay-Agent: <agent_id>` 头的请求都算处理端露了一面，`/ack` 则算处理端在干活；
  `agent_online_secs`（默认 300 秒）内有过其中之一就算在线。进程刚起来还没见过任何 agent 时状态是 `null`（未知），按在线处理。
  状态在 `/health` 里看：`agent_online` / `agent_last_seen` / `last_agent` / `last_ack_at` / `pending`（未 ack 的真消息数，事件不计），和游标一起持久化。
  处理端离线时，自动回复换成 `reply_text_offline`（默认「已收到。处理端已离线 {duration}，上线后会处理」，`{duration}` 会替换成实际离线时长），
  用户不会以为消息马上有人处理。
- **管理员离线告警**（`offline_alert_mins`，默认 `0` = 关闭）：填正数分钟后，处理端离线超过这个时长且有积压时给 `admin_userid` 推一条告警，恢复后再推一条。
  默认关是因为处理端一般跑在会休眠的电脑上，每晚睡一次就会报一次，噪音大于价值；想要夜间也盯着才打开。

## 自测

```bash
npm test               # 即 node --test test/*.test.mjs：起假网关，76 项断言（含 client/ 两个脚本、presence、配置加载、多 bot）
```

## 文件

`src/index.mjs` 入口，`src/` 下其余模块的分工见 [docs/README.md § 功能速查](../docs/README.md#功能速查)　`test/mock.test.mjs` 自测　`wecom-bot.service` systemd 单元　`config.example.json` 配置模板
