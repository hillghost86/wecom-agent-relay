# HTTP API 参考

VPS 网关（`server/src/index.mjs`，接口实现在 `server/src/http/`）在 `127.0.0.1:8788` 上提供的接口。对外的 HTTPS 地址由反代给出，下文用 `$BOT_API` 代指，token 用 `$BOT_TOKEN`。

## 鉴权与公共约定

- 每个请求带 `Authorization: Bearer <token>`；也接受 `?token=<token>`，但 token 会进反代日志，只在没法改请求头时用。
- token 分两级（配置见 [config.md § 两级 token](config.md#两级-token)）：**管理员 token**（`http.api_token`）能访问所有 bot 和 `GET /bots`；**bot token**（`bots[].api_token`）只能访问它自己那个 bot。两级都没配时不鉴权。
- token 比对是恒定时间比较；不认识的 token 返回 `401 {"ok":false,"error":"unauthorized"}`，bot token 访问了别的 bot 返回 `403 {"ok":false,"error":"forbidden"}`。两种都在服务端日志里记 IP 和路径（IP 取 `X-Forwarded-For` 第一段）。
- 可选请求头 `X-Relay-Agent: <agent_id>`：鉴权通过后，网关把这次请求记成请求路径所指那个 bot 的「处理端露了一面」，用于判在线（见 [presence.md](presence.md)）。**只读排查时不要带**，否则会把你这台机器记成处理端在线。
- 所有响应都是 JSON，都有 `ok` 字段。**业务失败返回 200 + `ok:false`**，不返回 5xx，因为 Cloudflare 一类的反代会用自己的错误页替换 5xx 响应体，把失败原因吞掉。只有代码异常才 500。
- 参数非法返回 400，路径不存在返回 404。

## 多 bot 路由

配了多个机器人时，下文每个接口都可以加前缀 `/bots/<key>` 指定机器人，如 `/bots/sales/messages`、`/bots/sales/ack?seq=3`。

- **不带前缀**的路径指向 `bots` 里的**第一个**机器人，单 bot 的老部署和老客户端不用改。
- 客户端接某个 bot 时，把 `api_base` 填成 `https://your-domain.example.com/bots/<key>` 即可，`client/` 不需要改代码。
- 判定顺序：先认 token（不认识 → 401），再看权限（bot token 访问别的 bot、`GET /bots`、或不存在的 key → 403），最后看 key 是否存在（管理员访问不存在的 key → `404 {"ok":false,"error":"unknown bot"}`）。key 不存在的 404 放在鉴权之后，没有 token 的人没法借它探测有哪些 bot。

### GET /bots

仅管理员 token。返回全部 bot 的状态，数组里每一项和该 bot 的 [`/health`](#get-health) 完全一样，顺序同配置：

```json
{ "ok": true, "bots": [ { "ok": true, "bot": "default", "subscribed": true, … }, { "ok": true, "bot": "sales", … } ] }
```

它本身不带 bot 前缀，所以带 `X-Relay-Agent` 请求它不会刷新任何 bot 的在线状态。

## GET /health

连接状态与处理端状态。哨兵每 10 秒调一次。

```json
{
  "ok": true,
  "connected": true,           // 与企微的 WebSocket 已建立
  "subscribed": true,          // 已订阅成功（这个才代表能收消息）
  "last_msg_at": "2026-09-23T12:48:15.312Z",   // 本次进程收到最后一条消息的时刻，没收过为 null
  "seq": 28,                   // 落盘的最大 seq
  "cursor": 27,                // 已确认（ack）到哪
  "count": 28,                 // 内存里的记录数
  "bot": "default",            // 配置里的 bot key（不带前缀时是 bots 里第一个）
  "agent_online": null,        // true / false / null（未知：进程起来后还没见过任何 agent）
  "agent_last_seen": null,     // 处理端最后一次露面（ISO 时间）
  "last_agent": null,          // 最后露面的 agent_id
  "last_ack_at": null,         // 最后一次 /ack 的时刻
  "pending": 1                 // 未 ack 的真消息数（kind=message），事件不计
}
```

`connected:true` 但 `subscribed:false` 表示连上了但订阅没成功（多半是 Bot ID / Secret 错），看服务端日志。

## GET /messages

拉取 `seq > after` 的记录，按 seq 升序。

| 参数 | 默认 | 说明 |
|---|---|---|
| `after` | 当前游标 | 非负整数；不带时从已确认游标之后开始，正好是「没处理过的」 |
| `limit` | 50 | 1 到 500，超出钳到 500 |
| `kind` | 不过滤 | `message` 只要真消息，`event` 只要事件。agent 处理消息时**永远加 `kind=message`** |

```json
{ "ok": true, "after": 27, "cursor": 27, "seq": 28, "next": 28, "messages": [ …记录… ] }
```

`next` 是本页最后一条的 seq，翻下一页就把它当 `after`；本页为空时等于 `after`。`after` / `limit` 不是非负整数返回 400。

## GET /messages/\<seq\>

按 seq 取单条：`{ "ok": true, "message": {…} }`，不存在返回 `404 {"ok":false,"error":"not found"}`。

## GET /ack?seq=\<seq\>

把游标推进到 seq（也接受 POST）。返回 `{ "ok": true, "cursor": <推进后的游标> }`。

- 游标只前进不后退：传比当前小的值不生效。
- **超过当前最大 seq 会钳到最大 seq**，防止误传大数把之后的消息全跳过。
- 调用会把 `last_ack_at` 更新为现在，算处理端「在干活」。
- 游标语义是「至少一次」：网关不会自动推进，agent 处理完再 ack；agent 侧按 `body.msgid` 幂等。

## POST /send

主动推送，原样透传为企微的 `aibot_send_msg` 帧。用于 `response_url` 过期（1 小时）之后。

```bash
curl -s -X POST "$BOT_API/send" -H "Authorization: Bearer $BOT_TOKEN" -H 'Content-Type: application/json' \
  -d '{"chatid":"<userid 或群 chatid>","chat_type":1,"msgtype":"markdown","markdown":{"content":"你好"}}'
```

- `chatid`：单聊填对方 userid，群聊填群 chatid（群消息记录里的 `body.chatid`）。字段名是 `chatid`，不是 `chat_id`。
- `chat_type`：1 单聊、2 群聊，不填或 0 由企微自动判断。
- `msgtype` 只支持 `markdown` / `template_card` / `file` / `image` / `voice` / `video`，**没有 `text`**。
- 返回：企微接受 `{ "ok": true, "resp": { "errcode": 0, … } }`；企微拒绝 `{ "ok": false, "resp": { "errcode": …, "errmsg": … } }`；帧没发出去（未订阅、连接断开、等回执超时 10 秒）`{ "ok": false, "error": "…" }`。三种都是 HTTP 200。
- 请求体不是合法 JSON 返回 400；超过 1 MB 拒绝。
- 企微限频：单会话 30 条 / 分钟、1000 条 / 小时（文档说的）。

## 消息记录格式

`bots/<key>/messages.jsonl` 每行一条，`/messages` 返回的就是这些行：

```json
{
  "seq": 26,                                   // 网关分配，单调递增，重启不重置
  "received_at": "2026-09-23T12:38:45.558Z",   // 网关收到的时刻
  "kind": "message",                           // message = 用户发的消息；event = 企微事件
  "req_id": "…",                               // 企微这一帧的 req_id
  "body": { …企微原始消息体，原样保存… }
}
```

`body` 是企微推过来的原样内容，常用字段：

| 字段 | 说明 |
|---|---|
| `msgid` | 企微消息 id，重推时不变，用来幂等 |
| `aibotid` | 机器人 id |
| `chattype` | `single` 单聊 / `group` 群聊 |
| `from.userid` | 发送人 userid。**单聊只有这个，没有 `chatid`** |
| `chatid` | 群聊才有，是 `/send` 群推时要填的值 |
| `msgtype` | `text` / `image` / `voice` / `mixed` / `event` 等 |
| `text.content` | 文本内容 |
| `image.url` + `image.aeskey` | 图片：加密文件的下载地址（300 秒过期）和解密密钥，见 [protocol.md § 媒体文件加密](protocol.md#媒体文件加密) |
| `voice.content` | 语音：企微只给转写后的文字，不给音频 |
| `mixed.msg_item[]` | 图文混排，每项各自带 `msgtype` |
| `event.eventtype` | 事件类型，如 `enter_chat`（用户点开聊天窗）、`disconnected_event`（连接被踢） |
| `create_time` | 企微侧时间戳（秒） |
| `response_url` | 这条消息专用的回复地址，1 小时内一次，见 [protocol.md § response_url](protocol.md#response_url-回复) |

事件记录（`kind: "event"`）也占 seq，但不计入 `pending`、不唤醒哨兵。

## 一个完整的处理循环

```bash
# 1. 拉未处理的真消息
curl -s -H "Authorization: Bearer $BOT_TOKEN" -H "X-Relay-Agent: my-agent" "$BOT_API/messages?kind=message"
# 2. 逐条处理，用 body.response_url 回复（直接 POST 企微，不经过网关）
curl -s "<response_url>" -H 'Content-Type: application/json' -d '{"msgtype":"markdown","markdown":{"content":"处理结果"}}'
# 3. 确认到最大 seq
curl -s -H "Authorization: Bearer $BOT_TOKEN" -H "X-Relay-Agent: my-agent" "$BOT_API/ack?seq=<最大 seq>"
```

用 `client/poll.mjs` 可以省掉手拼 curl，见 [agent-integration.md](agent-integration.md)。
