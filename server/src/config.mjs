/**
 * 配置加载与校验：读 config.json（或兼容期的环境变量），补默认值，拼成 { gw, bots }。
 * 出错时抛 ConfigError（消息即要打印的原文），由入口打印到 stderr 并以退出码 1 退出。
 *
 * 配置：JSON 文件，`--config <路径>` 指定，默认取工作目录下的 config.json。
 *   {
 *     "http": { "host": "127.0.0.1", "port": 8788, "api_token": "<openssl rand -hex 32>" },
 *     "tz": "Asia/Shanghai",              // 自报里的时间显示时区
 *     "agent_online_secs": 300,           // 处理端多久没来访就算离线
 *     "bots": [{ "key": "default", "bot_id": "...", "secret": "...", "api_token": "...",
 *                "reply_text": "已收到", "reply_text_offline": "...{duration}...",
 *                "admin_userid": "...", "offline_alert_mins": 0, "msg_log": "..." }]
 *   }
 *   可选项与默认值见 config.example.json。bots 可以配多个，每个各自一条连接、各自的数据文件和在线状态。
 *   兼容期：没有 config.json 且有 WECOM_BOT_ID / WECOM_BOT_SECRET 时从环境变量拼配置，下个版本移除。
 */
import fs from 'node:fs';
import path from 'node:path';
import { warn } from './log.mjs';

export const DEFAULT_REPLY_OFFLINE = '已收到。处理端已离线 {duration}，上线后会处理';

export const isLoopback = (host) => host === '127.0.0.1' || host === 'localhost' || host === '::1';

/** 配置问题：message 就是原样打印给用户看的那段文字 */
export class ConfigError extends Error {}

export function argConfigPath(argv) {
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--config') return argv[i + 1] || '';
    if (argv[i].startsWith('--config=')) return argv[i].slice('--config='.length);
  }
  return '';
}

/** 兼容期：老部署用环境变量配置，拼成和 config.json 一样的结构。下个版本移除。
 *  WECOM_WS_URL 也在这里映射：不映射的话兼容路径只能连默认的真实网关，自测 / 自建网关无从指向。 */
export function configFromEnv() {
  const port = process.env.HTTP_PORT;
  return {
    http: { host: process.env.HTTP_HOST, port: port === undefined ? undefined : Number(port), api_token: process.env.API_TOKEN },
    tz: process.env.TZ,
    ws_url: process.env.WECOM_WS_URL,
    bots: [{
      key: 'default',
      bot_id: process.env.WECOM_BOT_ID,
      secret: process.env.WECOM_BOT_SECRET,
      reply_text: process.env.REPLY_TEXT,
      admin_userid: process.env.ADMIN_USERID,
      msg_log: process.env.MSG_LOG,
    }],
  };
}

/** argPath 是命令行 --config 给的路径，没给就是空串 */
export function loadConfig(argPath) {
  const file = argPath || path.join(process.cwd(), 'config.json');
  if (fs.existsSync(file)) {
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch (e) {
      throw new ConfigError(`配置文件 ${file} 解析失败：${e.message}`);
    }
    return normalizeConfig(raw, file);
  }
  // 指名道姓给了 --config 却找不到，多半是路径写错，不要悄悄退回环境变量
  if (argPath) throw new ConfigError(`找不到配置文件 ${file}`);
  if (process.env.WECOM_BOT_ID && process.env.WECOM_BOT_SECRET) {
    warn('未找到 config.json，已从环境变量加载；环境变量方式将在下个版本移除，请迁移到 config.json');
    return normalizeConfig(configFromEnv(), '环境变量');
  }
  throw new ConfigError(`找不到配置文件 ${file}，也没有 WECOM_BOT_ID / WECOM_BOT_SECRET 环境变量；请参照 config.example.json 建一份 config.json`);
}

export function normalizeConfig(raw, source) {
  const errs = [];
  if (!raw || typeof raw !== 'object') errs.push('配置内容必须是一个 JSON 对象');
  const r = raw && typeof raw === 'object' ? raw : {};
  const h = r.http && typeof r.http === 'object' ? r.http : {};
  const gw = {
    httpHost: h.host ?? '127.0.0.1',
    httpPort: Number(h.port ?? 8788),
    apiToken: h.api_token ?? '',
    tz: r.tz ?? 'Asia/Shanghai',
    agentOnlineSecs: Number(r.agent_online_secs ?? 300),
    wsUrl: r.ws_url ?? 'wss://openws.work.weixin.qq.com',
    pingIntervalMs: Number(r.ping_interval_ms ?? 30000),
    outageMinSecs: Number(r.outage_min_secs ?? 3),            // 低于这个秒数不报
    outageReportMinMs: Number(r.outage_report_min_ms ?? 60000), // 抖动时最多每分钟报一次
    subscribeTimeoutMs: 10000,
    backoffMinMs: 1000,
    backoffMaxMs: 60000,
  };

  const list = Array.isArray(r.bots) ? r.bots : [];
  if (!list.length) errs.push('bots 不能为空，至少要配一个机器人');
  const seenKeys = new Set();
  const bots = list.map((b0, i) => {
    const b = b0 && typeof b0 === 'object' ? b0 : {};
    const key = b.key ?? (list.length === 1 ? 'default' : '');
    const at = `bots[${i}]${key ? `（${key}）` : ''}`;
    if (!key) errs.push(`${at}: 配了多个机器人时每个都必须有 key`);
    else if (!/^[a-z0-9_-]+$/.test(key)) errs.push(`${at}: key 只允许小写字母、数字、下划线和减号`);
    else if (seenKeys.has(key)) errs.push(`${at}: key 重复`);
    seenKeys.add(key);
    if (!b.bot_id) errs.push(`${at}: 缺少 bot_id`);
    if (!b.secret) errs.push(`${at}: 缺少 secret`);
    // 默认数据文件：每个 bot 一个目录 bots/<key>/，以后媒体下载的 files/ 也放在这个目录下
    // 空串 / 纯空白按没写处理：曾被当成 off，网关静默只放内存，重启后数据全无
    const msgLog = b.msg_log == null || String(b.msg_log).trim() === '' ? path.join(process.cwd(), 'bots', key, 'messages.jsonl') : b.msg_log;
    return {
      key,
      botId: b.bot_id || '',
      secret: b.secret || '',
      replyText: b.reply_text ?? '已收到',
      replyTextOffline: b.reply_text_offline ?? DEFAULT_REPLY_OFFLINE,
      adminUserId: b.admin_userid ?? '',
      offlineAlertMins: Number(b.offline_alert_mins ?? 0),
      msgLog,
      apiToken: b.api_token ?? '',
      tag: list.length > 1 ? `[${key}]` : '',
      at,
    };
  });

  // bot token 与管理员 token 或彼此相同，就分不清请求者能访问哪个 bot
  const seenTokens = new Set();
  for (const b of bots) {
    if (!b.apiToken) continue;
    if (b.apiToken === gw.apiToken) errs.push(`${b.at}: api_token 不能和 http.api_token 相同`);
    else if (seenTokens.has(b.apiToken)) errs.push(`${b.at}: api_token 和别的机器人重复`);
    seenTokens.add(b.apiToken);
  }
  // 两个 bot 写同一个文件会互相覆盖 seq 和游标
  const seenLogs = new Map();
  for (const b of bots) {
    if (!b.msgLog || b.msgLog === 'off') continue;
    const f = path.resolve(b.msgLog);
    if (seenLogs.has(f)) errs.push(`${b.at}: msg_log 和 ${seenLogs.get(f)} 指向同一个文件 ${f}`);
    else seenLogs.set(f, b.at);
  }
  // 对外监听时明文 HTTP 上跑 token，弱 token 等于没设
  if (gw.httpPort && !isLoopback(gw.httpHost)) {
    if (!gw.apiToken || gw.apiToken.length < 32) errs.push('http.host 对外监听时必须设置至少 32 字符的 http.api_token（建议 openssl rand -hex 32）');
    for (const b of bots) if (b.apiToken && b.apiToken.length < 32) errs.push(`${b.at}: http.host 对外监听时 api_token 必须至少 32 字符（建议 openssl rand -hex 32）`);
  }

  if (errs.length) throw new ConfigError(`配置有误（来源：${source}）：\n- ${errs.join('\n- ')}`);
  return { gw, bots };
}
