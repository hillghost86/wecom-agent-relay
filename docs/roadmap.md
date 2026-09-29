# 路线图

已定下来的方向和结论。未开始的事项不承诺时间。

## 下一步：多媒体（文件 / 视频）

- 图片已完成（见下文「已完成」）。文件、视频消息**等真实样本**：先各发一次实测字段是否和图片一样带 `url` + `aeskey`，一样的话沿用图片的下载、`media` 字段和 `/files` 接口。
- 语音已经是文字，不需要处理。
- 可借用官方 SDK 的 `downloadFile` / `decryptFile`，不换连接层。

## 以后

- **Cloudflare Durable Object 免费版**：普通 Worker 不能维持 WebSocket，Durable Object 加定时唤醒可以；按估算免费额度（每天约 13000 GB·秒）够一个 bot 用。VPS 版跑稳之后再做。
- **移除环境变量兼容**：v0.2.0 之后的下一个版本删掉 `.env` 启动方式。
- **小改进**（代码审核时记下、暂未做）：连接关闭用 `terminate()` 代替 `close()` 避免半开连接；启动时加载 `bots/<key>/messages.jsonl` 限定读取量；消息文件按月轮转。

## 已完成

- **图片下载**（多媒体第一、二步）：网关收到图片（含 mixed 里的图片）立即下载解密，存到 `bots/<key>/files/`，消息记录返回时附 `media` 状态，新增 `GET /files/…` 接口，按 `media_keep_days` 清理；`poll.mjs --download <seq>` 先直连企微、失败再从网关兜底。见 [api.md § media 字段](api.md#media-字段)、[agent-integration.md](agent-integration.md#pollmjs-命令)。
- **多 bot**：`config.json` 的 `bots` 可以配多个，同一个进程里每个 bot 各自一条连接、各自的 `bots/<key>/messages.jsonl` 和游标、各自的在线状态与断线自报。接口加前缀 `/bots/<key>/…`，无前缀接口指向 `bots` 里第一个；token 分管理员和 bot 两级；管理员可用 `GET /bots` 看全部状态。约定一个 agent 对应一个 bot。见 [config.md § 配置多个机器人](config.md#配置多个机器人)、[api.md § 多 bot 路由](api.md#多-bot-路由)。

## 已决定不做

- **不引入官方 SDK 的连接层**：原因见 [protocol.md § 官方 SDK](protocol.md#官方-sdk)。
- **不做回调 URL 模式**：需要备案域名。早期方案已归档，不维护。
- **网关不自动推进游标**：保持「至少一次」，由 agent 处理完显式 ack。
