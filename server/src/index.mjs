#!/usr/bin/env node
/**
 * 企业微信智能机器人 · 长连接客户端（VPS 常驻进程）入口
 *
 * 只有这个文件有副作用：解析 --config、加载配置，为每个 bot 建存储 / 连接 / 离线告警 / 媒体清理，起 HTTP API，处理退出信号。
 * 各模块：config.mjs 配置 · wecom.mjs 企微长连接 · bot.mjs 单个机器人运行时 · store.mjs 消息存储
 *         notify.mjs 管理员通知 · media.mjs 图片下载 · http/ HTTP API · log.mjs 日志与格式化
 *
 * 运行：npm i && npm start（即 node src/index.mjs，读工作目录下的 config.json；别处的用 --config <路径>）
 */
import { log } from './log.mjs';
import { argConfigPath, loadConfig, ConfigError } from './config.mjs';
import { Bot } from './bot.mjs';
import { getWebSocketCtor, BotConnection } from './wecom.mjs';
import { startOfflineAlert } from './notify.mjs';
import { startHttpServer } from './http/server.mjs';

let config;
try {
  config = loadConfig(argConfigPath(process.argv));
} catch (e) {
  if (!(e instanceof ConfigError)) throw e;
  console.error(e.message);
  process.exit(1);
}
const { gw, bots: botConfigs } = config;
// 仅自测用：缩短图片下载的重试间隔（逗号分隔的毫秒数），生产不要设
if (process.env.RELAY_TEST_MEDIA_RETRY_MS) gw.mediaRetryMs = process.env.RELAY_TEST_MEDIA_RETRY_MS.split(',').map(Number);

const WS = await getWebSocketCtor();
const bots = botConfigs.map((c) => new Bot(c, gw));
const timers = [];   // 离线告警与媒体清理，退出时一起清掉
for (const bot of bots) {
  bot.conn = new BotConnection(WS, bot, gw);
  bot.conn.start();
  const t = startOfflineAlert(bot);
  if (t) timers.push(t);
  const c = bot.media.startCleanup();
  if (c) timers.push(c);
}
const httpServer = startHttpServer(bots, gw);

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log(`收到 ${sig}，退出`);
    for (const bot of bots) {
      if (bot.conn?.subscribed) bot.writeAlive();
      bot.saveState();
      bot.conn?.stop();
    }
    for (const t of timers) clearInterval(t);
    if (httpServer) httpServer.close();
    setTimeout(() => process.exit(0), 300);
  });
}
