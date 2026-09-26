# 企微智能机器人协议事实

只记和本项目相关、影响实现的结论。每条标注来源：

- **〔文档〕** 企微官方文档写的
- **〔实测〕** 我们对真网关验证过的（带日期）
- **〔推断〕** 根据现象推出来的，未直接验证

官方文档入口：<https://developer.work.weixin.qq.com/document/path/101463>

## 连接方式

- 〔文档〕智能机器人的 API 模式二选一：**长连接**（本项目）或**回调 URL**。回调 URL 要求企业备案域名，长连接不需要域名、不需要公网 IP、消息体不加密。
- 〔文档〕地址 `wss://openws.work.weixin.qq.com`。连上后发 `aibot_subscribe { bot_id, secret }`，回执 `errcode=0` 即订阅成功。
- 〔实测 2026-09-21〕凭证错误返回 errcode `853000`。
- 〔文档〕每 30 秒发一次 `ping` 保活。本项目连续两次没收到回包就判连接死了并重连。
- 〔文档 + 实测〕**一个机器人同一时刻只允许一条连接**，新连接会把旧连接踢掉，被踢方收到 `aibot_event_callback`，`eventtype` 为 `disconnected_event`。
- 〔实测 2026-09-21〕Node 内置的 WebSocket（undici）在部分代理 / TUN 环境下握手失败，`ws` 包正常，所以固定用 `ws`。

## 帧类型

所有帧是 JSON，`cmd` 区分类型，`headers.req_id` 关联请求与回执。

| cmd | 方向 | 用途 |
|---|---|---|
| `aibot_subscribe` | 我方 → 企微 | 订阅（鉴权） |
| `ping` | 我方 → 企微 | 心跳 |
| `aibot_msg_callback` | 企微 → 我方 | 用户发来的消息，落盘为 `kind: "message"` |
| `aibot_event_callback` | 企微 → 我方 | 事件（`enter_chat`、`disconnected_event` 等），落盘为 `kind: "event"` |
| `aibot_respond_msg` | 我方 → 企微 | 回复某条消息，**用收到那一帧的 req_id** |
| `aibot_send_msg` | 我方 → 企微 | 主动推送，网关的 `/send`、断线自报、离线告警都走它 |

## 收消息

- 〔文档〕收到消息 **5 秒内**必须回一帧 `aibot_respond_msg`。本项目自动回一帧 `stream`（`finish: true`）的「已收到」。
- 〔推断〕同一 `msgid` 用新的 `req_id` 重推，多半是上次没在 5 秒内回帧。网关对重推仍回帧、但不重复落盘。
- 〔文档〕群聊只有 @机器人 才推送；单聊每条都推。
- 〔实测 2026-09-21〕单聊消息没有 `chatid`，只有 `from.userid`；群聊带 `chatid`。
- 〔实测 2026-09-23〕用户点开机器人的聊天窗会推一个 `enter_chat` 事件。
- 〔实测 2026-09-23〕企微会用相同 `msgid` 重推事件：同一个 `enter_chat` 相隔 86ms 推了两次。网关对事件也按 `msgid` 去重，重推的不落盘、不占 seq。

## 离线期间的消息

- 〔实测 2026-09-22〕**机器人不在线期间，用户发的消息企微直接丢弃，不补发，而发送方看到的是「发送成功」。** 方法：停服务 → 发消息 → 启服务，日志里没有这条。
- 这就是本项目必须有一台 7×24 VPS 的原因，也是断线自报存在的原因。

## response_url 回复

每条消息的 `body.response_url` 是企微给这条消息专用的回复地址，直接 POST，不经过网关。

- 〔文档〕1 小时内有效，只能用一次。
- 〔实测 2026-09-22〕`msgtype` 只认 `markdown`（文档说也支持 `template_card`）；`text` 会被拒。
- 〔实测 2026-09-22〕成功返回 `{"errcode":0,"errmsg":"ok"}`；**失败时 HTTP 也可能是 200**，必须看 body 的 `errcode`。过期返回 `60140`。
- 〔实测 2026-09-22〕和网关自动回的「已收到」互不影响，用户会看到两条。
- 〔实测 2026-09-22〕群聊里的回复会自动引用触发的那条用户消息。

## 主动推送 aibot_send_msg

- 〔文档〕`msgtype` 支持 `markdown` / `template_card` / `file` / `image` / `voice` / `video`，**没有 `text`**。
- 〔文档〕`chatid` 单聊填 userid、群聊填群 chatid；`chat_type` 1 单聊、2 群聊，0 或不填自动判断。
- 〔文档〕限频：单会话 30 条 / 分钟、1000 条 / 小时。

## 媒体消息

- 〔实测 2026-09-23〕**图片**：`body.image.url` 是腾讯云对象存储的签名下载地址，**300 秒后失效**；下载到的是密文，要用 `body.image.aeskey` 解密。
- 〔实测 2026-09-23〕**语音**：企微只推 `body.voice.content`，是转写后的文字，不给音频文件，无需解密。
- 〔文档〕图文混排是 `msgtype: "mixed"`，内容在 `body.mixed.msg_item[]`，每项有自己的 `msgtype`。
- 〔推断〕文件、视频消息大概率和图片一样带 `url` + `aeskey`，做媒体功能时要各发一次实测。

### 媒体文件加密

〔文档；用户 2026-09-23 实测解密成功〕

| 步骤 | 做法 |
|---|---|
| 密钥 | `aeskey` 是 43 字符的 Base64，末尾补一个 `=` 再解码，得到 32 字节 |
| IV | 取密钥前 16 字节 |
| 算法 | AES-256-CBC |
| 去填充 | PKCS#7，但块长是 **32 字节**：看最后一字节的值 n，去掉末尾 n 字节 |

Node 示例（关掉内置去填充，因为它按 16 字节块处理）：

```js
import crypto from 'node:crypto';
function decryptMedia(buf, aeskey) {
  const key = Buffer.from(aeskey + '=', 'base64');
  const d = crypto.createDecipheriv('aes-256-cbc', key, key.subarray(0, 16));
  d.setAutoPadding(false);
  const out = Buffer.concat([d.update(buf), d.final()]);
  const pad = out[out.length - 1];
  return pad >= 1 && pad <= 32 ? out.subarray(0, out.length - pad) : out;
}
```

URL 只有 300 秒，agent 被唤醒再下载可能已经过期，所以最终要由网关在收到时就下载（见 [roadmap.md](roadmap.md)）。

回调 URL 模式还多一层「消息体加密」（`EncodingAESKey` + SHA1 签名，明文里再包随机串、长度和企业 id）。长连接模式没有这一层。

## 官方 SDK

〔评估 2026-09-22〕`@wecom/aibot-node-sdk`（v1.0.7，依赖 axios / eventemitter3 / ws）只覆盖连接层，没有落盘、游标、HTTP API、去重、断线自报，默认重连 10 次就放弃。**暂不引入。** 做媒体功能时只借用它的 `downloadFile` / `decryptFile` 这类工具方法，不换连接层。
