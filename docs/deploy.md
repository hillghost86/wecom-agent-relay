# 部署与升级

网关跑在 VPS 上，以 systemd 常驻。下文假设安装目录是 `/opt/wecom-bot`，与 `server/wecom-bot.service` 一致。

> **重启 = 几秒空窗。** 企微会静默丢掉机器人离线期间的消息，发送方还显示「发送成功」。任何会重启服务的操作都挑没人用的时候做。

## 首次部署

1. 企微后台 → 管理工具 → 智能机器人 → 开启 API 模式 → 连接方式选「长连接」，记下 Bot ID 和 Secret（Secret 只显示一次）。
2. VPS 装 Node ≥ 18。
3. 上传 `server/` 下的 `index.mjs`、`package.json`、`config.example.json`、`wecom-bot.service` 到 `/opt/wecom-bot/`。
4. 在 VPS 上：

```bash
cd /opt/wecom-bot && npm i
cp config.example.json config.json && chmod 600 config.json
# 编辑 config.json：bot_id、secret、http.api_token（openssl rand -hex 32）、admin_userid
sudo cp wecom-bot.service /etc/systemd/system/ && sudo systemctl daemon-reload
sudo systemctl enable --now wecom-bot
journalctl -u wecom-bot -f      # 看到「订阅成功，开始心跳」即成功
```

5. 配反代（见下），然后在本机验证：

```bash
curl -s -H "Authorization: Bearer <api_token>" https://your-domain.example.com/health
```

`subscribed: true` 就通了。配置项含义见 [config.md](config.md)。

### node 是 nvm 装的

systemd 不加载 nvm 的环境，`/usr/bin/env node` 找不到。把 `wecom-bot.service` 的 `ExecStart` 改成 `which node` 给出的绝对路径。

## 反代与 HTTPS

进程只在 `127.0.0.1:8788` 说明文 HTTP，证书、域名、对外端口全交给反代。长连接模式不需要域名备案，域名只用来给 API 套 HTTPS。

Caddy：

```
your-domain.example.com {
    reverse_proxy 127.0.0.1:8788
}
```

nginx：

```nginx
location / {
    proxy_pass http://127.0.0.1:8788;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

宝塔：网站 → 添加站点 → 反向代理，目标 `http://127.0.0.1:8788`，SSL 里申请 Let's Encrypt。

要求：原样透传 `Authorization` 头（nginx 和 Caddy 默认会）。前面再套 Cloudflare 也可以，网关的业务失败都返回 200，不会被 Cloudflare 的错误页吞掉。

## 升级

大多数升级只换 `index.mjs`：

```bash
scp server/index.mjs <vps>:/opt/wecom-bot/index.mjs
ssh <vps> 'sudo systemctl restart wecom-bot && sleep 5 && journalctl -u wecom-bot -n 15 --no-pager'
```

日志里应有「消息存储已加载」和「订阅成功」。`messages.jsonl`、`.state.json`、`.alive` 都保留，seq 和游标接着走。

`wecom-bot.service` 有变化时（看 CHANGELOG），多做一步 `sudo cp wecom-bot.service /etc/systemd/system/ && sudo systemctl daemon-reload`。`package.json` 依赖有变化时再跑一次 `npm i`。

## 加一个机器人

多个机器人跑在同一个进程里，共用一个端口和反代，接口用前缀 `/bots/<key>/` 区分（见 [api.md § 多 bot 路由](api.md#多-bot-路由)）。

1. 企微后台再建一个智能机器人，同样开 API 模式、选长连接，记下它的 Bot ID 和 Secret。
2. 编辑 VPS 上的 `config.json`，在 `bots` 里加一项，写上 `key`（如 `sales`）、`bot_id`、`secret`，以及给接这个机器人的 agent 用的 `api_token`（`openssl rand -hex 32`，不能和 `http.api_token` 或别的 bot 相同）。原来那个机器人要是还没写 `key`，补上 `"key": "default"`，它的数据文件仍是 `messages.jsonl`，不用迁移。字段说明见 [config.md § 配置多个机器人](config.md#配置多个机器人)。
3. 重启：`sudo systemctl restart wecom-bot`。**所有机器人都会有几秒空窗**，挑没人用的时候做。日志里每个机器人各有一行 `[<key>] 订阅成功，开始心跳`。
4. 接这个机器人的客户端，`client/config.json` 的 `api_base` 填 `https://your-domain.example.com/bots/<key>`，`api_token` 填第 2 步那个 token。客户端代码不用改。

验证（管理员 token 能看到所有机器人的状态）：

```bash
curl -s -H "Authorization: Bearer <http.api_token>" https://your-domain.example.com/bots
```

## 从 .env 迁移到 config.json

v0.2.0 起配置改为 `config.json`。本机可以用下面的脚本把旧 `.env` 转成 `config.json`，也可以照 [config.md § 兼容期](config.md#兼容期环境变量) 的对照表手填：

```bash
cd /opt/wecom-bot && set -a && . ./.env && set +a && node -e '
const e=process.env, c={http:{host:e.HTTP_HOST||"127.0.0.1",port:Number(e.HTTP_PORT||8788),api_token:e.API_TOKEN||""},
tz:e.TZ||"Asia/Shanghai",bots:[{key:"default",bot_id:e.WECOM_BOT_ID,secret:e.WECOM_BOT_SECRET,
reply_text:e.REPLY_TEXT??"已收到",admin_userid:e.ADMIN_USERID||""}]};
if(e.MSG_LOG)c.bots[0].msg_log=e.MSG_LOG;
require("fs").writeFileSync("config.json",JSON.stringify(c,null,2));' && chmod 600 config.json
```

然后换上新的 `wecom-bot.service`（`ExecStart` 带 `--config`、去掉了 `EnvironmentFile=`），`daemon-reload` 后重启。日志里**不应**出现「已从环境变量加载」的警告。确认无误后 `.env` 可以删。

## 断线自报

配了 `admin_userid` 后，每次重连成功，网关会给这个人发一条：离线了多少秒、起止时间、原因是「连接中断」还是「进程重启」，提醒期间的消息已丢需要重发。

- 进程重启的空窗靠 `messages.jsonl.alive` 推算：心跳每 30 秒写一次当前时刻，下次启动读它。所以 VPS 整机宕机也能报出来。
- 短于 `outage_min_secs`（3 秒）不报；抖动时最多每 `outage_report_min_ms`（1 分钟）报一次。
- 被另一处连接踢下线时，`messages.jsonl` 里会多一条 `eventtype: disconnected_event` 的事件，看到它说明有两处在跑同一个机器人。

## 数据文件

都在 `msg_log` 旁边（默认工作目录）。多个机器人时，key 不是 `default` 的那些文件名是 `messages.<key>.jsonl` 及其 `.state.json` / `.alive`：

| 文件 | 内容 | 能不能删 |
|---|---|---|
| `messages.jsonl` | 全部消息与事件，一行一条，只追加 | 删了 seq 从 0 重来，历史丢失 |
| `messages.jsonl.state.json` | 游标、处理端最后露面时刻与 id | 删了游标归零，agent 会重拉全部历史 |
| `messages.jsonl.alive` | 最后一次心跳的时刻 | 可以删，只影响下一次断线自报 |

启动时整份文件读进内存；运行中内存超过 10000 条后，每来一条新的就丢掉内存里最早的一条（文件里仍在，但 `/messages` 查不到，重启后又能查到）。文件目前不做轮转，长期运行可自行按月归档（先停服务）。

## 自测

```bash
cd server && node test_mock.mjs
```

起一个假的企微网关，把服务端和两个客户端脚本整套跑一遍（协议、HTTP API、断线自报、presence、配置加载、哨兵只对真消息唤醒）。不连真网关、不需要任何凭证。改了代码必跑。

## 注意

- **一个机器人同一时刻只能有一条连接**，新的踢旧的。本地调试时别和 VPS 同时跑 `index.mjs`。
- 本地要跑真连接，先停 VPS 上的服务，调完再起来，并接受这段时间的消息会丢。
