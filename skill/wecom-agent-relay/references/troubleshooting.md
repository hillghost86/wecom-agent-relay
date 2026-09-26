# wecom-agent-relay 故障排查

症状 → 原因 → 处理。

## 哨兵 / 拉取

### `401 token 无效`
- `client/config.json` 的 `api_token` 与 server `config.json` 的 `http.api_token` 不一致，或环境变量覆盖了错误值
- 检查优先级：环境变量 `WECOM_API_TOKEN` > config.json

### `403 forbidden`
- 用的是某个机器人自己的 token（`bots[].api_token`），却访问了别的机器人：检查 `api_base` 末尾的 `/bots/<key>` 是不是这个 token 对应的机器人
- 不带 `/bots/<key>` 前缀时指向配置里的第一个机器人，bot token 不是它的也会 403
- `GET /bots` 只有管理员 token（`http.api_token`）能调

### `sentinel --once` 一直 HTTP 5xx / 超时
- 网关进程挂了：VPS 上 `systemctl status wecom-bot`，`journalctl -u wecom-bot -n 50`
- 反代没配好：直接 curl `https://域名/health`（带 Bearer）看是否 200
- HTTPS 证书过期

### `/health` 返回 `connected: false`
- VPS 无法出网到 `wss://openws.work.weixin.qq.com`
- Bot ID / Secret 错误（`journalctl` 里看订阅失败原因）
- Secret 被重置过：企微后台重新生成后更新 server `config.json` 的 `secret` 并重启服务

### 哨兵从未唤醒过 agent
1. 确认哨兵以**后台任务**方式挂起（不是普通前台命令跑一下就结束）
2. 确认 agent 框架开启了「后台任务完成通知」（WorkBuddy 默认开启）
3. 手动 `node client/sentinel.mjs --status` 看本地 last_seen 与服务端 seq：
   若 last_seen ≥ 服务端 seq，说明没有新消息（哨兵无错，等消息即可）；
   seq 涨了但没唤醒，可能新来的只是 `enter_chat` 等事件（用户点开聊天窗就会推），哨兵按设计不唤醒；
   last_seen 大于服务端 seq 多半是服务端数据被重置或迁移，哨兵下一轮会自动以服务端游标重新同步，日志里有「重新起步」
4. 若 last_seen 被误推进（比如有人跑过 `--once`/`--status` 之外又手动改了游标），
   可删 `client/sentinel_cursor.json` 重挂哨兵（会以服务端已确认游标重新起步，有未 ack 的积压会立刻唤醒一次）

### 用户收到「已收到。处理端已离线 X」的回复
- 说明网关在 `agent_online_secs`（默认 300 秒）内没见过处理端：哨兵没在挂（电脑关机 / 处理完忘了重挂），
  或 agent 超过这个时长没调过任何接口
- 查 `/health` 的 `agent_last_seen`（最后一次露面时刻）和 `last_agent`（是哪台处理端），确认后重挂哨兵即可恢复
- 注意 `sentinel.mjs --once` / `--status` 不报在线（它们常由人手工执行），只有长跑的哨兵和 `poll.mjs` 才算

### `/health` 的 `agent_online` 是 `null`
- 不是故障：网关刚重启，进程起来后还没见过任何 agent，状态「未知」，此时按在线处理
- 挂上哨兵（或跑一次 `poll.mjs`）后就会变成 `true`

### 同一批消息反复唤醒 / 漏消息
- last_seen 只在「发现新消息」与「初始化」时写盘；手动删除游标文件会导致重复消费一批
- 服务端游标（/ack）与哨兵游标（client/sentinel_cursor.json）是两套：
  处理闭环必须做 `--ack`，否则重挂哨兵后 `--once`/对账会出现「已处理但未确认」的假象

## 回复 / 推送

### `--reply` 报「找不到 response_url」
- 该消息超过 1 小时或已被消费过（response_url 一次性）
- 解决：改用 `--send <chatid>` 主动推送（单聊 chatid 填 userid，群聊填群 chatid）

### `--reply` HTTP 200 但 `errcode=60140`
- response_url 已过期（1 小时）或已使用过——同上，改走 `--send`

### 回复发出但企微没收到、HTTP 200
- 用了 `text` 格式：企微只认 `markdown` / `template_card`，text 会被拒
- 只看 HTTP 状态码不看 body：必须校验 `errcode == 0`（poll.mjs 已内置校验）

### `--send` 返回 `ok:false` 且 `error` 是 `not subscribed` / `connection closed`
- 网关正在重连，帧没发出去；等几秒再试，或看 `/health` 的 `subscribed`

### `--send` 报失败但确实想确认
- 企微拒绝时返回 200 且 `ok:false`，errcode 在 `resp` 里；按 errcode 查企微文档
- 频率限制：单会话 30 条/分钟、1000 条/小时
- msgtype 只有 `markdown`/`template_card`/`file`/`image`/`voice`/`video`，没有 `text`

## 部署

### 网关频繁掉线重连
- 两处跑了这个网关（新连接踢旧连接）：`systemctl status wecom-bot` 只留一处。被踢时 `bots/<key>/messages.jsonl` 里会多一条 `kind=event`、`eventtype=disconnected_event` 的记录，看到它就是这个原因
- VPS 出网被防火墙拦 wss

### 收不到群消息
- 群聊只有 **@机器人** 才推送；检查消息是否真的 @ 了机器人
- 机器人必须已在群里

### 部署后 `/health` 401
- 反代没透传 Authorization 头（nginx 默认会透传，检查自定义配置）
- API_TOKEN 前后有空格/引号

## agent 闭环

### agent 处理完忘了重挂哨兵
- 症状：之后的消息没人响应，但 VPS 的 bots/<key>/messages.jsonl 在涨
- 处理：重新挂起哨兵即可，消息会从哨兵游标继续发现；已处理确认靠服务端 /ack 游标
