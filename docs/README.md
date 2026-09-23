# 文档索引

按「我想查什么」找文档。总览和快速开始在[仓库根 README](../README.md)，部署速查在 [server/README.md](../server/README.md)。

| 我想查… | 看这份 |
|---|---|
| 某个接口的参数、返回字段、错误码 | [api.md](api.md) —— HTTP API 完整参考，含消息记录的字段格式 |
| 服务端 `config.json` 某一项是什么意思、默认值多少 | [config.md](config.md) —— 服务端与客户端全部配置项 |
| 第一次部署、升级、从 `.env` 迁移、反代怎么配 | [deploy.md](deploy.md) —— 部署与升级手册 |
| 企微那边的规则：帧格式、限制、response_url、图片解密 | [protocol.md](protocol.md) —— 企微协议事实（分「文档说的 / 实测的 / 推断的」） |
| 「处理端已离线」是怎么判的、自动回复怎么分档、告警怎么开 | [presence.md](presence.md) —— 处理端在线状态 |
| 怎么把哨兵接到 WorkBuddy / Claude Code / 别的系统 | [agent-integration.md](agent-integration.md) —— 哨兵、stdout 契约、`poll.mjs` 命令、处理闭环 |
| 接下来打算做什么、哪些方向已经定了 | [roadmap.md](roadmap.md) —— 路线图与已定结论 |
| 出问题了：401、收不到、回复失败、没被唤醒 | [故障排查](../skill/wecom-agent-relay/references/troubleshooting.md)（随技能包分发，症状 → 原因 → 处理） |
| 为什么要这样设计 | [架构与设计理由](../skill/wecom-agent-relay/references/architecture.md) |
| 每个版本改了什么 | [CHANGELOG.md](../CHANGELOG.md) |

## 功能速查

| 功能 | 在哪实现 | 文档 |
|---|---|---|
| 连企微长连接、心跳、断线重连 | `server/src/wecom.mjs` `BotConnection` | [protocol.md](protocol.md) |
| 消息落盘、seq、游标 | `server/src/store.mjs` `MessageStore` | [api.md § 消息记录格式](api.md#消息记录格式) |
| 秒回「已收到」/ 离线文案 | `server/src/wecom.mjs` `replyTextNow` | [presence.md](presence.md) |
| 断线自报（重连后告诉管理员离线了多久） | `server/src/wecom.mjs` `reportOutage`（空窗与节流）、`server/src/notify.mjs` `sendOutageReport`（内容与发送） | [deploy.md § 断线自报](deploy.md#断线自报) |
| 管理员离线告警 | `server/src/notify.mjs` `startOfflineAlert` | [presence.md § 管理员离线告警](presence.md#管理员离线告警) |
| HTTP API 与鉴权 | `server/src/http/`：`server.mjs` `startHttpServer`（路由）、`auth.mjs`（鉴权判定）、`api.mjs`（各接口） | [api.md](api.md) |
| 哨兵（发现新消息即退出） | `client/sentinel.mjs` | [agent-integration.md](agent-integration.md) |
| 拉取 / 回复 / 推送 / ack 命令行 | `client/poll.mjs` | [agent-integration.md § poll.mjs](agent-integration.md#pollmjs-命令) |
| WorkBuddy 一句话安装 | `skill/wecom-agent-relay/SKILL.md` | 技能包自带 |
| 假网关自测 | `server/test/mock.test.mjs` | [deploy.md § 自测](deploy.md#自测) |

## 文档分工

- 根 `README.md`：一页看懂是什么、为什么、怎么开始。
- `server/README.md`：部署速查和接口一览表，字段级细节指到这里。
- `docs/`：参考手册，一个主题一份，力求完整。
- `skill/wecom-agent-relay/`：随技能包分发给 WorkBuddy 的文件，排障手册和架构说明只放这里，`docs/` 不重复。
