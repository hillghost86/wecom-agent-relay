# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> 给 AI 助手看的硬规则 + 架构地图。动手前先读这份。

## 项目概览

企业微信智能机器人 → AI agent 的事件桥。两个部分，各自独立运行：

| 目录 | 运行位置 | 说明 |
|---|---|---|
| `server/` | VPS，systemd 常驻 | `index.mjs`：连企微 WebSocket 长连接收消息，落盘 `messages.jsonl`，对本机暴露 HTTP API（`/health` `/messages` `/messages/<seq>` `/ack` `/send`）。**唯一持久层**，它不在线消息就丢 |
| `client/` | agent 所在机器 | `sentinel.mjs` 哨兵：轮询发现新消息即退出以唤醒对话式 agent；`poll.mjs`：拉取 / 单条取 / 回复 / 推送 / ack 的命令行工具 |
| `skill/wecom-agent-relay/` | 随仓库分发 | WorkBuddy 技能：一句话安装引导 + 架构说明 + 排障手册。改接口、改部署步骤时要同步它 |
| `archive/` | 本地 | 早期 URL 回调 Worker 方案，已 `.gitignore`，不公开、不维护 |

纯 Node（≥ 18），无框架。`server/` 唯一依赖 `ws`；`client/` 零依赖。

- `client/` 和 `skill/` 最初由用户的另一个 agent（WorkBuddy）编写，现在全仓由这边维护，WorkBuddy 作为使用者兼贡献者（见文末协作流程）。改服务端接口的返回结构、改 `client/` 命令行参数时，回复结尾提醒用户同步告知 WorkBuddy。

## 常用命令

```bash
# —— server/ ——
cd server && node --check index.mjs      # 改完必做：语法检查
node test_mock.mjs                       # 必做：起假网关跑 39 项断言（协议 + HTTP API + 断线自报 + client 脚本 + presence + 配置加载）
node index.mjs                           # 本地跑一个真连接，读工作目录下的 config.json（注意：会踢掉 VPS 上的连接，只在用户同意时跑）

# —— client/ ——（只读验证，需要 WECOM_API_BASE / WECOM_API_TOKEN 环境变量或 client/config.json）
node client/poll.mjs --health            # 网关状态：subscribed:true 即在线
node client/sentinel.mjs --status        # 本地/服务端 seq 对照

# —— 部署（由用户在 VPS 上执行，我没有 VPS 的 SSH）——
scp server/index.mjs <vps>:/opt/wecom-bot/index.mjs
scp server/config.json <vps>:/opt/wecom-bot/config.json   # 只在首次从 .env 迁移时；单元文件的 ExecStart 要带 --config
sudo systemctl restart wecom-bot && journalctl -u wecom-bot -n 20 --no-pager
```

依赖安装（`npm i`）**不自动跑**，贴命令给用户执行（用户走国内镜像 `--registry=https://registry.npmmirror.com`）。

## 协议与部署事实（全部实测过，别按常识猜）

- 企微 API 模式二选一：长连接 or 回调 URL。本项目用长连接，不需要域名备案、不需要解密。
- **一个机器人同一时刻只能有一条 WS 连接**，新连接踢旧连接，被踢方收到 `disconnected_event`。所以本地绝不能和 VPS 同时跑 `server/index.mjs`。
- **机器人离线期间的消息企微直接丢，且发送方显示发送成功。** 重启服务就是一个几秒的空窗，改完代码要挑没人用的时候部署，并在回复里提醒。`ADMIN_USERID` 配了会在重连后自报离线时段。
- 收到消息 5 秒内必须回一帧；进程自动回 `stream(finish=true)` 的「已收到」占位。
- agent 回复走消息自带的 `response_url`：1 小时内有效、只能调一次、`msgtype` 只认 `markdown`（`text` 会被拒）、HTTP 200 不代表成功要看 body 的 `errcode`、群聊自动引用原消息。和「已收到」互不影响，用户看到两条。
- `/send` 主动推送同样没有 `text`；`chatid` 单聊填 userid、群聊填群 chatid；企微拒绝时返回 200 + `ok:false`，**不能返回 5xx**（Cloudflare 会用自己的错误页覆盖响应体，把 errcode 吞掉）。
- 单聊消息没有 `chatid`，只有 `from.userid`。
- 处理端（agent 那台机器）在线状态靠 HTTP 请求头 `X-Relay-Agent: <agent_id>` 判定，`/ack` 另算「在干活」；窗口是 `agent_online_secs`（默认 300 秒），没见过任何 agent 时为 `null`（未知）按在线处理。离线时给企微的自动回复换成带离线时长的 `reply_text_offline`；管理员离线告警 `offline_alert_mins` 默认 0（关），因为处理端所在电脑每晚休眠会每晚报一次。
- Node 内置 WebSocket 在部分代理环境下对企微网关握手失败，固定用 `ws` 包。
- 游标语义是「至少一次」：agent 处理完显式 `/ack`，服务端不自动推进；agent 侧按 `msgid` 幂等。
- HTTP API 只监听 `127.0.0.1`，HTTPS / 域名 / 证书 / 对外端口全归反代（nginx / Caddy / 宝塔），进程不碰证书。
- **官方 SDK `@wecom/aibot-node-sdk` 暂不引入**（2026-09-22 评估）：它只覆盖连接层，没有落盘、游标、HTTP API、去重、自报；换过去多三个依赖，且默认重连 10 次就放弃。等要做图片 / 语音 / 文件或模板卡片时再用，优先只 import 它的 `downloadFile` 等工具方法，不换连接层。

## 沟通方式

- 用户**非专业程序员**：少用编程英文术语，必须用时附**简短中文解释**。
- 涉及企微协议的结论，分清「文档说的」「实测过的」「我推断的」，别混着说。

## ⛔ 硬规则（必须遵守）

1. **私有信息不入仓**：Bot ID、Secret、`API_TOKEN`、VPS 域名与 IP、管理员 userid、局域网机器地址，一律只在 `server/config.json`、`client/config.json`、本机记忆里，**不得写进仓库任何文件**（含本文件、README、测试用例、注释、commit message）。仓库文档一律用 `your-domain.example.com`、`<userid>` 这类占位。这个仓库要开源。
2. **高风险改动先讲方案、等用户明确确认，再动手**：鉴权与 token 逻辑、对企微发消息的路径（自动回复、`/send`、断线自报）、会导致服务重启的部署、`config.json` 配置项的语义变更。这四类每个关键节点单独停下来说清做法和影响。
3. **改完 `server/index.mjs` 必跑** `node --check` 和 `node test_mock.mjs`，新行为必须在 `test_mock.mjs` 里有断言；改完 `client/*.mjs` 同样跑 `server/test_mock.mjs`（含 client 断言），再对真网关做一次只读验证。**只读验证用 `client/sentinel.mjs --status` 或不带 `X-Relay-Agent` 头的 curl**，不要用 `poll.mjs`：它带头会把这台机器记成处理端在线，污染线上 presence。跑不了要明说。
4. **不主动对企微发消息**：`/send`、`response_url`、`--reply` 这些会让企微里真的出现一条消息，只给用户命令让用户跑，或用户明确让我发时才发。只读接口（`/health` `/messages`）可以随时调。
5. **部署由用户执行**：我没有 VPS 的 SSH。改完给出 `scp` + `systemctl restart` 命令，并提醒重启会丢那几秒的消息。
6. **不覆盖用户未提交的改动**：`git status` / `git diff` 先看；禁止 `git checkout -- <路径>`、`git restore`、`git reset --hard`、`git clean -f`、未经同意的 `git stash`。要看历史版本用 `git show <ref>:<path>`。
7. **移动 / 改名 / 删除文件后全仓更新引用**：`grep -r '旧文件名'`，README、注释、systemd 单元、`.gitignore` 里的路径逐处改，零残留再收工。
8. **简单优先，每行改动可追溯**：只写解决问题的最少代码，每一行都能答上「对应用户的哪句话」；顺手看到的无关问题只在回复里提一句，不夹带进本次改动。但断线重连、心跳死线、幂等去重这类兜底是任务自带的，不算赘肉。
9. **Commit message 与 PR 正文一律不带 AI 协作署名**（不写 `Co-Authored-By: Claude`、`Generated with ...` 等），这条覆盖工具的默认行为。
10. **PR 不自动合并**：建完停下等用户确认。

## 代码规范

- 纯 ESM `.mjs`，无构建步骤，无 TypeScript；配置全部走 `config.json`（`server/` 的路径用 `--config` 指定，默认工作目录；`client/` 用同目录 config.json，环境变量可覆盖），启动时缺必填项直接报错退出。
- 注释只写「为什么」不写「是什么」，用中文，一两行说清；协议坑点写在函数头注释里而不是散落各处。
- 日志：`log` / `warn` 带 ISO 时间戳；不打印 Secret、token、完整 `response_url`（只打尾部几位）。
- 文档同步：改接口、改 `config.json` 配置项、发现新的协议事实，同一次改动里更新 `README.md`（总览）和 `server/README.md`（部署与接口），两份各管各的，别重复大段。
- 写代码风格对齐周边既有代码（命名、注释密度、惯用法）。

## 工作流

- **分模型分工**：主会话（Fable）只做方案、任务编排、审核与验收；写代码一律派 `coder` 子代理（Opus，定义在 `.claude/agents/coder.md`，缺失时按该文件重建）。派活前方案须已经用户确认；任务说明把方案、涉及文件、验证要求写全（子代理看不到对话历史）；同一时间只派一个写码代理；回来后主会话自己看 diff、复跑 `test_mock.mjs`，不以子代理的汇报代替验证。
- 一个改动做完的标准：语法检查过、mock 测试过、README 同步、给出部署命令、列出需要通知 WorkBuddy 的接口变化。
- 待办和已知问题记在回复里，用户说记录再写进文档；仓库暂无待办文件。

## 与 WorkBuddy 的协作和发布流程

仓库**全部内容由这边统一维护**，包括 `client/` 和 `skill/`。WorkBuddy 是使用者兼贡献者：它在自己的目录里改、本地提交；这边发布前拉取它的目录，逐条核对后决定采纳、调整或不采纳，并在回复里告诉用户结果。不存在"对方负责所以不能改"的文件。

WorkBuddy 保持的约定：目录布局和仓库一致；不改 `server/`；凭证与运行时文件不入库；改完跑只读验证再本地提交，提交信息写清改了什么。

发布步骤：
1. 从 WorkBuddy 的工作目录拉整个文件夹（位置和 SSH 方式在本机记忆里，不入仓）。看它的 `git log` 和相对上次的 diff，逐条核对：采纳的直接合入，需要改的按仓库风格改，不采纳的在回复里说明原因。`dist/`、`sentinel_cursor.json`、`config.json` 不带过来。
2. 跑 `server/test_mock.mjs` 和 `client/poll.mjs --health`。
3. 私有信息扫描：`grep -rniE '<域名关键字>|<userid>|<botid 前缀>|192\.168|[0-9a-f]{64}'`，零命中才能提交。
4. 更新 `CHANGELOG.md`：把「未发布」下的条目归到新版本号并标日期。
5. 提交、推送、打 tag；WorkBuddy 产出的 `dist/wecom-agent-relay.zip` 挂到 GitHub Release，不入库。
6. 回复里列出本次合并了 WorkBuddy 的哪些改动、改了什么、没采纳什么，供用户转告。

仓库上线后 WorkBuddy 改为从 GitHub 同步，拉取核对的方向不变。
