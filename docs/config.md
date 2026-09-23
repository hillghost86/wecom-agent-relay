# 配置参考

## 服务端 `server/config.json`

启动时用 `--config <路径>` 指定，不给就读工作目录下的 `config.json`。缺必填项、`bots` 为空、key 不合法都会打印原因后退出。模板在 `server/config.example.json`。**文件里有 Secret 和 token，`chmod 600`，绝不入库。**

```json
{
  "http": { "host": "127.0.0.1", "port": 8788, "api_token": "…" },
  "tz": "Asia/Shanghai",
  "agent_online_secs": 300,
  "bots": [ { "key": "default", "bot_id": "…", "secret": "…", … } ]
}
```

### 顶层

| 项 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `http.host` | 否 | `127.0.0.1` | 只监听本机，HTTPS 和对外端口交给反代。不要改成 `0.0.0.0` |
| `http.port` | 否 | `8788` | 反代转发的目标端口 |
| `http.api_token` | 是 | 空 | agent 调 API 的凭证，`openssl rand -hex 32` 生成。留空则不鉴权，只适合纯本机调试 |
| `tz` | 否 | `Asia/Shanghai` | 断线自报里时间的显示时区 |
| `agent_online_secs` | 否 | `300` | 处理端多少秒没露面就算离线，见 [presence.md](presence.md) |
| `ws_url` | 否 | `wss://openws.work.weixin.qq.com` | 企微长连接地址。只有自测假网关时才改 |
| `ping_interval_ms` | 否 | `30000` | 心跳间隔。连续两次没回包判定连接死了重连 |
| `outage_min_secs` | 否 | `3` | 断线短于这个秒数不自报 |
| `outage_report_min_ms` | 否 | `60000` | 抖动时自报最多每分钟一次 |

### `bots[]`

本版本只允许一个元素，多于一个启动即退出（多 bot 见 [roadmap.md](roadmap.md)）。

| 项 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `key` | 单 bot 可省 | `default` | 机器人标识，小写字母 / 数字 / 下划线 / 减号。`/health` 的 `bot` 字段就是它 |
| `bot_id` | 是 | | 企微后台 → 管理工具 → 智能机器人 → API 模式 → 长连接 |
| `secret` | 是 | | 同上，只显示一次，丢了要重新生成 |
| `reply_text` | 否 | `已收到` | 收到消息 5 秒内的秒回文案；配成空字符串则不回帧，离线文案也一并不回 |
| `reply_text_offline` | 否 | `已收到。处理端已离线 {duration}，上线后会处理` | 处理端离线时的秒回文案，`{duration}` 替换成实际离线时长 |
| `admin_userid` | 否 | 空 | 收断线自报和离线告警的人的 userid。不填就不发 |
| `offline_alert_mins` | 否 | `0` | 处理端离线超过这么多分钟且有积压就给管理员发告警，`0` 关闭。默认关，因为处理端那台电脑每晚休眠就会每晚报一次 |
| `msg_log` | 否 | `<工作目录>/messages.jsonl` | 消息落盘文件。`"off"` 只放内存（重启即丢，别在生产用）。旁边会生成 `.state.json`（游标 + 在线状态）和 `.alive`（心跳时间戳，用来推算进程重启空窗） |

### 兼容期：环境变量

没有 `config.json` 但设了 `WECOM_BOT_ID` / `WECOM_BOT_SECRET` 时，仍能从环境变量启动并打一条迁移警告。对应关系：

| 环境变量 | config.json |
|---|---|
| `WECOM_BOT_ID` / `WECOM_BOT_SECRET` | `bots[0].bot_id` / `bots[0].secret` |
| `API_TOKEN` | `http.api_token` |
| `HTTP_HOST` / `HTTP_PORT` | `http.host` / `http.port` |
| `TZ` | `tz` |
| `REPLY_TEXT` | `bots[0].reply_text` |
| `ADMIN_USERID` | `bots[0].admin_userid` |
| `MSG_LOG` | `bots[0].msg_log` |
| `WECOM_WS_URL` | `ws_url` |

**下个版本移除**，尽快迁移。迁移步骤见 [deploy.md § 从 .env 迁移](deploy.md#从-env-迁移到-configjson)。

## 客户端 `client/config.json`

`sentinel.mjs` 和 `poll.mjs` 读同目录下的 `config.json`，环境变量优先级更高。模板 `client/config.example.json`。

| config.json | 环境变量 | 必填 | 说明 |
|---|---|---|---|
| `api_base` | `WECOM_API_BASE` | 是 | 网关的 HTTPS 地址，如 `https://your-domain.example.com`，末尾不带 `/` |
| `api_token` | `WECOM_API_TOKEN` | 是 | 服务端 `http.api_token` |
| `agent_id` | `WECOM_AGENT_ID` | 否 | 这台处理端的标识，默认本机主机名。会出现在 `/health` 的 `last_agent` 和哨兵的 `NEW_MSG` 行里 |

哨兵还会在同目录写 `sentinel_cursor.json`（本地已见到的 seq），已在 `.gitignore`。
