---
name: wecom-agent-relay
description: 安装并运行 wecom-agent-relay——把企业微信智能机器人的消息接入 WorkBuddy（VPS 长连接落盘 + 本地哨兵事件唤醒 agent）。当用户提到「接入企微机器人」「安装/部署 wecom-agent-relay」「让企微 @机器人 能唤醒 WorkBuddy」「企微消息自动记账/自动处理」「wecom 长连接网关」时使用。覆盖：前置检查、克隆仓库、client 配置、VPS 网关部署指引、挂哨兵、消息处理闭环约定与故障排查。
agent_created: true
---

# wecom-agent-relay · 企微机器人 → WorkBuddy 事件桥

## Overview

本技能指导完成 wecom-agent-relay 的安装、配置与运行，使 WorkBuddy 能通过企业微信智能机器人接收并处理消息：
用户在群里 @机器人 或单聊发消息 → 10 秒内 WorkBuddy 被自动唤醒 → 按内容处理并回复企微 → 哨兵回到待命。
全程无需用户打开 WorkBuddy 界面下指令。

架构（详细原理见 `references/architecture.md`）：
VPS 网关 7×24 长连接企微并落盘（企微会静默丢弃机器人离线期间的消息，VPS 是唯一持久层）
→ 本机哨兵（agent 的后台任务，轮询发现新消息即退出）
→ 后台任务完成通知自动唤醒 WorkBuddy → 处理 → 回复 → 重挂哨兵。

## 安装流程

### 第 1 步：前置检查（逐项与用户确认）

1. **VPS 与域名**：是否有一台 VPS 和一个能解析到 VPS、可配 HTTPS 的域名？（网关必须 7×24 在线；长连接模式不需要备案，域名只用于给 HTTP API 套 HTTPS）
2. **企微智能机器人**：企微管理后台 → 管理工具 → 智能机器人 → API 模式 → 连接方式「长连接」，
   是否已拿到 **Bot ID** 和 **Secret**（Secret 只显示一次）？
3. **本机环境**：Node ≥ 18、git 可用。

缺 VPS/域名时：如实告知这两项无法由 WorkBuddy 代办，给出采购建议后暂停，等用户备齐再继续。
缺 Bot ID/Secret：给出一句话指引（企微后台路径如上），等用户提供。

### 第 2 步：克隆仓库并配置 client

```bash
git clone https://github.com/hillghost86/wecom-agent-relay.git && cd wecom-agent-relay
cp client/config.example.json client/config.json
```

编辑 `client/config.json`：`api_base` 填网关 HTTPS 地址（部署 server 后确定），`api_token` 填 server `config.json` 里的 `http.api_token`。
可选 `agent_id`：这台处理端在网关侧的标识，不填默认用本机主机名。
**token/Secret 是敏感值：只写进 client/config.json（已在 .gitignore），不得写入对话或任何会入库的文件。**

### 第 3 步：部署 VPS 网关

详细步骤见仓库 `server/README.md`。要点：

1. 上传 `server/`（index.mjs、package.json、config.example.json、wecom-bot.service）到 VPS `/opt/wecom-bot`
2. `cp config.example.json config.json`，填四个值：`bot_id`、`secret`、`http.api_token`（`openssl rand -hex 32` 生成）、`admin_userid`（收断线自报的人）；然后 `chmod 600 config.json`。systemd 单元的 `ExecStart` 已经带 `--config /opt/wecom-bot/config.json`，不用再配环境变量
3. `npm i`，装 systemd 单元：`sudo cp wecom-bot.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now wecom-bot`，用 `journalctl -u wecom-bot -f` 确认「订阅成功」
4. nginx/Caddy 把域名反代到 `http://127.0.0.1:8788` 并配 HTTPS

如用户提供 SSH 访问方式并明确授权，可代为执行以上命令；否则给出命令清单由用户自行执行。
一个机器人同时只允许一条 WS 连接——**不要在本机另起与企微的长连接**。

### 第 4 步：验证

```bash
node client/poll.mjs --health      # 期望 connected: true, subscribed: true
node client/sentinel.mjs --once    # 期望输出 NO_MSG（或 NEW_MSG）
```

任一失败按 `references/troubleshooting.md` 排查。

### 第 5 步：挂哨兵并约定处理闭环

1. 用后台任务方式挂起哨兵（WorkBuddy 中即 run_in_background）：
   `node client/sentinel.mjs --interval 10`
2. 向用户说明并固化闭环约定（写入项目记忆或用户记忆）：
   - 哨兵输出 `NEW_MSG count=<n> seq=<a>-<b> acked=<cursor> agent=<id>` 后退出 → WorkBuddy 被唤醒 →
     `GET /messages?after=<a-1>&kind=message` 一次拉取（区间内可能夹着 `enter_chat` 等事件，加 `kind=message` 自动跳过，所以 count 可能小于 b-a+1）→
     按内容处理 → `client/poll.mjs --reply <seq> <markdown>` 回复 →
     `client/poll.mjs --ack <最大seq>` → **重挂哨兵（铁律，不重挂 = 后续消息无人发现）**
3. 让用户在企微里 @机器人 说一句话实测：预期 ≤10 秒收到回复。

### 第 6 步：日常使用与维护约定

- WorkBuddy 关闭/电脑关机期间消息在 VPS 攒着，不丢；下次会话用户说一句话即可补挂哨兵并补处理积压
- 每次会话开始时检查哨兵是否在挂（后台任务列表），未挂则补挂
- 处理消息时：有歧义（金额、客户名对不上）在群里追问，不要猜着办
- 哨兵长跑时网关就知道处理端在线；哨兵没挂（电脑关机、忘了重挂）时用户发消息会收到「已收到。处理端已离线 X，上线后会处理」，带实际离线时长

## 参考

- `references/architecture.md` —— 架构与设计理由（为什么需要 VPS、为什么哨兵靠退出唤醒、stdout 契约）
- `references/troubleshooting.md` —— 故障排查（401、连接失败、回复失败、唤醒失败等）
- 仓库根 `README.md` —— HTTP API 全表与快速开始
