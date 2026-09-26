# 接入 agent

## 思路

对话式 agent（WorkBuddy、Claude Code 等）两轮对话之间不存在，没法常驻监听。但它们都支持「后台任务结束时唤醒 agent」。所以：

1. 把 `client/sentinel.mjs` 作为后台任务挂起。它每 10 秒查一次网关，没有新消息就一直睡。
2. 发现新的真消息就打印一行 `NEW_MSG ...` 然后退出。进程退出触发 agent 被唤醒。
3. agent 取消息、处理、回复、ack，**然后重新挂起哨兵**。

agent 处理期间哨兵不在，但消息照样落在 VPS 上，重挂后从上次位置接着发现，不会漏。

网关配了多个机器人时，一个 agent 接一个机器人：把 `client/config.json` 的 `api_base` 填成 `https://your-domain.example.com/bots/<key>`，`api_token` 填这个机器人的 token，哨兵和 `poll.mjs` 就只看这个机器人的消息和游标，代码不用改（见 [config.md § 客户端](config.md#客户端-clientconfigjson)）。

## 哨兵 sentinel.mjs

```bash
node client/sentinel.mjs                     # 常驻，默认 10 秒一查
node client/sentinel.mjs --interval 5        # 自定义间隔（秒）
node client/sentinel.mjs --once              # 只查一次就退出（验证用）
node client/sentinel.mjs --status            # 打印本地 / 服务端 seq 和处理端状态后退出，只读
node client/sentinel.mjs --exec "<命令>"      # 发现新消息时先执行命令再退出（只取一个参数，整体加引号）
```

行为要点：

- 本地游标存在同目录 `sentinel_cursor.json`（`last_seen`）。首次运行以服务端**已确认游标**起步，有未 ack 的积压会立刻唤醒一次。
- 服务端 seq 小于本地 `last_seen`（服务端数据被重置或迁移）时，打一行「重新起步」日志，自动以服务端游标重新起步，同一轮就判断积压。
- seq 涨了之后，用一次 `/messages?after=<last_seen>&kind=message` 查真消息。全是事件（如 `enter_chat`）就推进 `last_seen`、继续睡，不唤醒。这次查询失败时按全是真消息处理，宁可多唤醒一次。
- 网关连不上时打一行日志继续等，不退出。
- 长跑循环带 `X-Relay-Agent`，让网关知道处理端在线；`--once` / `--status` 不带。

### stdout 契约

自动化脚本只依赖这两行：

| 输出 | 含义 |
|---|---|
| `NEW_MSG count=<n> seq=<a>-<b> acked=<cursor> agent=<id>` | 有 n 条新的真消息，seq 在闭区间 a 到 b 内，进程随即退出 |
| `NO_MSG server_seq=<s> last_seen=<l> acked=<c> connected=<bool>` | 仅 `--once`：没有新消息 |

- `count` 可能小于 `b - a + 1`：区间里可能夹着事件。取消息请用 `GET /messages?after=<a-1>&kind=message`，不要逐条 `GET /messages/<seq>`。
- 其余带时间戳的行是给人看的日志，格式不保证。

## poll.mjs 命令

agent 处理消息的工具。所有请求都带 `X-Relay-Agent`。

| 命令 | 作用 |
|---|---|
| `node client/poll.mjs` | 拉已确认游标之后的真消息（最多 50 条）并打印摘要，不推进游标 |
| `node client/poll.mjs --after <seq>` | 从指定 seq 之后拉 |
| `node client/poll.mjs --ack` | 拉取后把游标推进到本次最大 seq |
| `node client/poll.mjs --ack <seq>` | 直接把游标推进到 seq |
| `node client/poll.mjs --get <seq>` | 取单条完整 JSON |
| `node client/poll.mjs --health` | 打印 `/health` |
| `node client/poll.mjs --reply <seq> <markdown>` | 用这条消息的 `response_url` 回复，检查 `errcode` 后报成败 |
| `node client/poll.mjs --send <chatid> <markdown>` | 经网关 `/send` 主动推送（`response_url` 过期后用） |

退出码 0 成功、1 失败，失败原因打到 stderr。

## 标准处理闭环

```
哨兵退出，输出 NEW_MSG count=2 seq=31-33 …
  → GET /messages?after=30&kind=message         一次取完
  → 逐条处理（按 body.msgid 幂等，重复的跳过）
  → poll.mjs --reply <seq> "<结果>"              每条各回一次，1 小时内
  → poll.mjs --ack 33                            确认到区间终点
  → 重新挂起 sentinel.mjs                         必须做，否则之后的消息没人发现
```

注意：

- **先处理再 ack。** ack 之后网关就认为处理完了，中途崩溃会丢。
- 回复超过 1 小时，改用 `--send`：单聊 `chatid` 填 `body.from.userid`，群聊填 `body.chatid`。
- 需要追问用户时，直接回复一条 markdown 问句，下一条用户消息会作为新消息进来。
- 图片要在 300 秒内下载并解密，见 [protocol.md § 媒体文件加密](protocol.md#媒体文件加密)。

## 平台示例

**WorkBuddy**：装仓库自带的技能包（`skill/wecom-agent-relay/`），对它说「接入企微机器人」，它会引导完成全部步骤。

**Claude Code**：用 Bash 工具的 `run_in_background` 运行 `node client/sentinel.mjs`，后台任务结束时会收到通知。

**其他系统**：用 `--exec` 在发现消息时触发 webhook 或脚本：

```bash
node client/sentinel.mjs --exec "curl -s -X POST https://your-hook.example.com -d new_message"
```

也可以完全不用哨兵，定时调 `/health` 比较 `seq`，逻辑一样。
