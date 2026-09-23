#!/usr/bin/env node
/**
 * 企业微信智能机器人 · 长连接客户端（VPS 常驻进程）
 *
 * 协议：https://developer.work.weixin.qq.com/document/path/101463
 *   1. 连接 wss://openws.work.weixin.qq.com
 *   2. 发 aibot_subscribe { bot_id, secret }，errcode=0 即订阅成功
 *   3. 每 30s 发 ping 保活；连续两次没收到回包就判定连接死了，重连
 *   4. 收到 aibot_msg_callback：打印 + 追加到 JSONL；5 秒内用同一个 req_id 回一帧 stream
 *   5. 断线：指数退避重连（1s → 60s 上限），永不放弃
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
 *
 * 部署形态：本进程只在 127.0.0.1 上说明文 HTTP；HTTPS、证书、域名、对外端口由前面的反代
 * （nginx / Caddy / 宝塔）负责，反代把请求转到 127.0.0.1:8788 并原样透传 Authorization 头。
 *
 * HTTP API（给 agent 用）：路径可带前缀 /bots/<key>/ 指定机器人，不带前缀指向 bots 里的第一个
 *   鉴权：http.api_token 是管理员 token，可访问任意 bot；bots[].api_token 只能访问自己那个 bot
 *   GET  /bots                           （仅管理员）全部 bot 的 /health 汇总
 *   GET  /health                         连接状态 + 处理端在线状态
 *   GET  /messages?after=<seq>&limit=50  拉 seq 大于 after 的消息（默认 after=已确认游标，limit 默认 50 最多 500）
 *   GET  /messages/<seq>                 按 seq 取单条，不存在返回 404
 *   GET  /ack?seq=<seq>                  把游标推进到 seq（之后 /messages 不带 after 时从这里开始）
 *   POST /send  {body}                   透传为 aibot_send_msg 帧（主动推送），返回企微回执
 *        body 规则（官方文档）：msgtype 只支持 markdown/template_card/file/image/voice/video，没有 text；
 *        chatid 单聊填用户 userid、群聊填群 chatid；chat_type 1=单聊 2=群聊，0 或不填自动兼容
 *   请求头 X-Relay-Agent: <agent_id> 会被记成「处理端最近一次露面」，用来判在线和分档自动回复
 *   回复用户：直接 POST 消息里的 response_url（1 小时内一次），不经过本进程
 *
 * 运行：npm i && node index.mjs --config /opt/wecom-bot/config.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import http from 'node:http';

const log = (...a) => console.log(new Date().toISOString(), ...a);
const warn = (...a) => console.warn(new Date().toISOString(), ...a);
// 多 bot 时日志前面带 [key]；单 bot 时原样，老部署的日志和以前逐字相同
const tagged = (tag) => (tag ? { log: (...a) => log(tag, ...a), warn: (...a) => warn(tag, ...a) } : { log, warn });
const isLoopback = (host) => host === '127.0.0.1' || host === 'localhost' || host === '::1';

const DEFAULT_REPLY_OFFLINE = '已收到。处理端已离线 {duration}，上线后会处理';

/* ---------- 配置加载 ---------- */
function argConfigPath(argv) {
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--config') return argv[i + 1] || '';
    if (argv[i].startsWith('--config=')) return argv[i].slice('--config='.length);
  }
  return '';
}

/** 兼容期：老部署用环境变量配置，拼成和 config.json 一样的结构。下个版本移除。
 *  WECOM_WS_URL 也在这里映射：不映射的话兼容路径只能连默认的真实网关，自测 / 自建网关无从指向。 */
function configFromEnv() {
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

function loadConfig() {
  const argPath = argConfigPath(process.argv);
  const file = argPath || path.join(process.cwd(), 'config.json');
  if (fs.existsSync(file)) {
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch (e) {
      console.error(`配置文件 ${file} 解析失败：${e.message}`);
      process.exit(1);
    }
    return normalizeConfig(raw, file);
  }
  // 指名道姓给了 --config 却找不到，多半是路径写错，不要悄悄退回环境变量
  if (argPath) {
    console.error(`找不到配置文件 ${file}`);
    process.exit(1);
  }
  if (process.env.WECOM_BOT_ID && process.env.WECOM_BOT_SECRET) {
    warn('未找到 config.json，已从环境变量加载；环境变量方式将在下个版本移除，请迁移到 config.json');
    return normalizeConfig(configFromEnv(), '环境变量');
  }
  console.error(`找不到配置文件 ${file}，也没有 WECOM_BOT_ID / WECOM_BOT_SECRET 环境变量；请参照 config.example.json 建一份 config.json`);
  process.exit(1);
}

function normalizeConfig(raw, source) {
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
    // 默认数据文件：统一放 messages/ 目录，按 key 命名（default 也一样）
    const msgLog = b.msg_log ?? path.join(process.cwd(), 'messages', `messages.${key}.jsonl`);
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

  if (errs.length) {
    console.error(`配置有误（来源：${source}）：\n- ${errs.join('\n- ')}`);
    process.exit(1);
  }
  return { gw, bots };
}

const { gw, bots: botConfigs } = loadConfig();

const fmtTime = (ms) => new Date(ms).toLocaleString('zh-CN', { timeZone: gw.tz, hour12: false });
/** 离线时长的中文说法：一分钟内说秒，一小时内说分钟，再往上说小时（一位小数，整数不带小数点） */
function fmtDuration(secs) {
  if (secs < 60) return `${secs} 秒`;
  if (secs < 3600) return `${Math.floor(secs / 60)} 分钟`;
  const h = Math.round((secs / 3600) * 10) / 10;
  return `${Number.isInteger(h) ? h : h.toFixed(1)} 小时`;
}
// 日志里的 response_url 只留尾部：它是一次性的回复凭证，进了 journal 就等于泄露
const maskBody = (b) => (b && b.response_url ? { ...b, response_url: '…' + String(b.response_url).slice(-8) } : b);

/* ---------- WebSocket 实现：优先 ws 包，否则内置 ----------
 * 实测 Node 内置 WebSocket（undici）在某些代理/TUN 环境下对企微网关握手失败（non-101），
 * ws 包同环境下正常，所以优先用 ws。
 */
async function getWebSocketCtor() {
  try {
    return (await import('ws')).default;
  } catch {
    if (typeof globalThis.WebSocket === 'function') {
      warn('未安装 ws 包，退回 Node 内置 WebSocket；如握手失败请 npm i ws');
      return globalThis.WebSocket;
    }
    console.error('请先安装依赖：npm i ws');
    process.exit(1);
  }
}

/* ---------- 消息存储：JSONL 追加 + 内存索引 + 已确认游标 ---------- */
class MessageStore {
  constructor(file, logger) {
    this.L = logger;
    this.file = file && file !== 'off' ? file : null;
    this.stateFile = this.file ? this.file + '.state.json' : null;
    this.items = [];
    this.seq = 0;
    this.cursor = 0;
    this.loadedState = {};   // 游标之外的字段（presence）由 Bot 取用
    this.extraState = () => ({}); // Bot 注入：和 cursor 一起写进 .state.json
    // .state.json 和 .alive 用 writeFileSync 直接写，不会自己建目录；启动时先建好
    if (this.file) {
      try { fs.mkdirSync(path.dirname(this.file), { recursive: true }); } catch (e) { this.L.warn('创建消息目录失败:', e.message); }
    }
    this.load();
  }
  load() {
    if (!this.file) return;
    try {
      if (fs.existsSync(this.file)) {
        for (const line of fs.readFileSync(this.file, 'utf-8').split('\n')) {
          if (!line.trim()) continue;
          try {
            const r = JSON.parse(line);
            if (typeof r.seq !== 'number') r.seq = this.seq + 1; // 兼容旧格式
            this.seq = Math.max(this.seq, r.seq);
            this.items.push(r);
          } catch {}
        }
      }
      if (fs.existsSync(this.stateFile)) {
        this.loadedState = JSON.parse(fs.readFileSync(this.stateFile, 'utf-8')) || {};
        this.cursor = Number(this.loadedState.cursor) || 0;
      }
      this.L.log(`消息存储已加载：${this.items.length} 条，seq=${this.seq}，游标=${this.cursor}`);
    } catch (e) {
      this.L.warn('加载消息存储失败:', e.message);
    }
  }
  append(record) {
    const r = { seq: ++this.seq, received_at: new Date().toISOString(), ...record };
    this.items.push(r);
    if (this.items.length > 10000) this.items.shift();
    if (this.file) {
      try {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        fs.appendFileSync(this.file, JSON.stringify(r) + '\n');
      } catch (e) {
        this.L.warn('写消息日志失败:', e.message);
      }
    }
    return r;
  }
  get(seq) {
    return this.items.find((r) => r.seq === seq) || null;
  }
  list({ after, limit, kind }) {
    const out = [];
    for (const r of this.items) {
      if (r.seq <= after) continue;
      if (kind && r.kind !== kind) continue;
      out.push(r);
      if (out.length >= limit) break;
    }
    return out;
  }
  ack(seq) {
    // 钳到当前最大 seq：误传大数会让之后的消息全部落在游标之下被跳过
    this.cursor = Math.max(this.cursor, Math.min(seq, this.seq));
    return this.cursor;
  }
  saveState() {
    if (!this.stateFile) return;
    try { fs.writeFileSync(this.stateFile, JSON.stringify({ cursor: this.cursor, ...this.extraState() })); } catch (e) { this.L.warn('写游标失败:', e.message); }
  }
}

/* ---------- 一个机器人的全部运行时：存储、去重、在线状态、连接 ---------- */
class Bot {
  constructor(conf) {
    this.key = conf.key;
    this.conf = conf;
    const logger = tagged(conf.tag);
    Object.assign(this, logger);   // this.log / this.warn，BotConnection 和告警也用它
    this.store = new MessageStore(conf.msgLog, logger);
    // 最后在线时刻：每次心跳写一次，重启后用来算空窗
    this.aliveFile = conf.msgLog && conf.msgLog !== 'off' ? conf.msgLog + '.alive' : null;
    this.seenMsgIds = new Set();
    this.conn = null;
    // 处理端（agent）在线状态：毫秒时间戳，0 = 没见过
    const st = this.store.loadedState || {};
    this.presence = {
      lastSeen: Number(st.agent_last_seen) || 0,
      lastAgent: String(st.last_agent || ''),
      lastAckAt: Number(st.last_ack_at) || 0,
    };
    this.store.extraState = () => ({
      agent_last_seen: this.presence.lastSeen,
      last_agent: this.presence.lastAgent,
      last_ack_at: this.presence.lastAckAt,
    });
    this.lastStateSaveAt = 0;
    this.offlineAlerted = false;
  }

  saveState() {
    this.lastStateSaveAt = Date.now();
    this.store.saveState();
  }

  /** HTTP 请求带了 X-Relay-Agent 就算处理端露了一面 */
  touchAgent(agentId) {
    const now = Date.now();
    this.presence.lastSeen = now;
    if (agentId) this.presence.lastAgent = String(agentId).slice(0, 64);
    // agent 每 10 秒来一次，不能每次都写盘；超过 60 秒才落一次
    if (now - this.lastStateSaveAt > 60000) this.saveState();
  }

  lastAgentSeenAt() {
    return Math.max(this.presence.lastSeen, this.presence.lastAckAt);
  }

  /** true 在线 / false 离线 / null 未知（进程起来后还没见过任何 agent） */
  agentOnline() {
    const last = this.lastAgentSeenAt();
    if (!last) return null;
    return Date.now() - last < gw.agentOnlineSecs * 1000;
  }

  offlineSecs() {
    const last = this.lastAgentSeenAt();
    return last ? Math.round((Date.now() - last) / 1000) : 0;
  }

  // 只数真消息：enter_chat 等事件也占 seq，算进积压会让离线告警误报
  pending() {
    let n = 0;
    for (const r of this.store.items) if (r.seq > this.store.cursor && r.kind === 'message') n++;
    return n;
  }

  /** 企微可能重推同一条消息 */
  isDuplicate(msgid) {
    if (!msgid) return false;
    if (this.seenMsgIds.has(msgid)) return true;
    this.seenMsgIds.add(msgid);
    if (this.seenMsgIds.size > 5000) this.seenMsgIds.delete(this.seenMsgIds.values().next().value);
    return false;
  }

  writeAlive() {
    if (!this.aliveFile) return;
    try { fs.writeFileSync(this.aliveFile, String(Date.now())); } catch {}
  }
  readAlive() {
    if (!this.aliveFile) return null;
    try { const t = Number(fs.readFileSync(this.aliveFile, 'utf-8')); return Number.isFinite(t) && t > 0 ? t : null; } catch { return null; }
  }
}

/* ---------- 连接管理 ---------- */
class BotConnection {
  constructor(WS, bot) {
    this.WS = WS;
    this.bot = bot;
    this.conf = bot.conf;
    this.ws = null;
    this.backoffMs = gw.backoffMinMs;
    this.pingTimer = null;
    this.missedPongs = 0;
    this.pending = new Map(); // req_id -> { resolve, reject, timer }
    this.subscribed = false;
    this.stopped = false;
    this.lastMsgAt = null;
    this.everSubscribed = false;   // 本进程内是否成功订阅过
    this.downSince = null;         // 最早的断开时刻（进程内）
    this.lastOutageReportAt = 0;
  }

  /** 断线自报：订阅成功后调用 */
  async reportOutage() {
    let since = this.downSince;
    let reason = '连接中断';
    if (!this.everSubscribed) {
      // 进程刚启动：用上次心跳写的在线时刻算重启空窗
      const last = this.bot.readAlive();
      if (last) { since = last; reason = '进程重启'; }
    }
    this.everSubscribed = true;
    this.downSince = null;
    this.bot.writeAlive();
    if (!since || !this.conf.adminUserId) return;
    const now = Date.now();
    const secs = Math.round((now - since) / 1000);
    if (secs < gw.outageMinSecs) return; // 秒级抖动不打扰
    if (now - this.lastOutageReportAt < gw.outageReportMinMs) { this.bot.log(`离线 ${secs}s（${reason}），1 分钟内已报过，跳过`); return; }
    this.lastOutageReportAt = now;
    const content = `⚠️ 机器人离线 **${secs} 秒**（${reason}）\n${fmtTime(since)} → ${fmtTime(now)}\n期间发给机器人的消息已丢失，请重发。`;
    try {
      const resp = await this.request({ cmd: 'aibot_send_msg', body: { chatid: this.conf.adminUserId, chat_type: 1, msgtype: 'markdown', markdown: { content } } }, 10000);
      if (resp.errcode === 0) this.bot.log(`断线自报已发送：离线 ${secs}s（${reason}）`);
      else this.bot.warn(`断线自报被拒 errcode=${resp.errcode} errmsg=${resp.errmsg}`);
    } catch (e) {
      this.bot.warn('断线自报失败:', e.message);
    }
  }

  /** 给 HTTP API 用：发一帧并等回执 */
  sendFrame(frame, timeoutMs = 10000) {
    if (!this.subscribed) return Promise.reject(new Error('not subscribed'));
    return this.request(frame, timeoutMs);
  }

  start() {
    this.connect();
  }

  stop() {
    this.stopped = true;
    this.cleanup();
    if (this.ws) this.ws.close();
  }

  connect() {
    if (this.stopped) return;
    this.bot.log(`连接 ${gw.wsUrl} ...`);
    const ws = new this.WS(gw.wsUrl);
    this.ws = ws;
    this.subscribed = false;
    this.missedPongs = 0;

    ws.addEventListener('open', () => this.onOpen());
    ws.addEventListener('message', (ev) => this.onMessage(ev.data));
    ws.addEventListener('error', (ev) => this.bot.warn('连接错误:', ev?.message || ev?.error?.message || 'unknown'));
    ws.addEventListener('close', (ev) => this.onClose(ev));
  }

  cleanup() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('connection closed'));
    }
    this.pending.clear();
  }

  scheduleReconnect() {
    if (this.stopped) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, gw.backoffMaxMs);
    this.bot.log(`${delay / 1000}s 后重连`);
    setTimeout(() => this.connect(), delay);
  }

  onClose(ev) {
    this.bot.warn(`连接关闭 code=${ev?.code} reason=${ev?.reason || ''}`);
    if (this.subscribed && !this.downSince) this.downSince = Date.now();
    this.subscribed = false;
    this.cleanup();
    this.scheduleReconnect();
  }

  async onOpen() {
    this.bot.log('TCP/WS 已建立，发送订阅');
    try {
      const resp = await this.request({ cmd: 'aibot_subscribe', body: { bot_id: this.conf.botId, secret: this.conf.secret } }, gw.subscribeTimeoutMs);
      if (resp.errcode !== 0) {
        this.bot.warn(`订阅失败 errcode=${resp.errcode} errmsg=${resp.errmsg}；检查 BotID/Secret。为避免触发频率限制，退避到上限再重试`);
        this.backoffMs = gw.backoffMaxMs;
        this.ws.close();
        return;
      }
      this.subscribed = true;
      this.backoffMs = gw.backoffMinMs;
      this.bot.log('订阅成功，开始心跳');
      this.pingTimer = setInterval(() => this.heartbeat(), gw.pingIntervalMs);
      this.reportOutage();
    } catch (e) {
      this.bot.warn('订阅异常:', e.message);
      if (this.ws) this.ws.close();
    }
  }

  async heartbeat() {
    try {
      const resp = await this.request({ cmd: 'ping' }, gw.pingIntervalMs);
      if (resp.errcode !== 0) this.bot.warn(`ping 回包异常 errcode=${resp.errcode} errmsg=${resp.errmsg}`);
      this.missedPongs = 0;
      this.bot.writeAlive();
    } catch {
      this.missedPongs++;
      this.bot.warn(`心跳无回包 (${this.missedPongs})`);
      if (this.missedPongs >= 2) {
        this.bot.warn('连续两次心跳无回包，主动断开重连');
        this.ws.close();
      }
    }
  }

  /** 发一帧并等待同 req_id 的回包 */
  request(frame, timeoutMs) {
    const reqId = randomUUID();
    const payload = { ...frame, headers: { ...(frame.headers || {}), req_id: reqId } };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        reject(new Error(`timeout waiting ${frame.cmd}`));
      }, timeoutMs);
      this.pending.set(reqId, { resolve, reject, timer });
      this.send(payload);
    });
  }

  send(obj) {
    if (!this.ws || this.ws.readyState !== 1) throw new Error('socket not open');
    this.ws.send(JSON.stringify(obj));
  }

  onMessage(data) {
    let frame;
    try {
      frame = JSON.parse(typeof data === 'string' ? data : data.toString());
    } catch {
      this.bot.warn('收到非 JSON 帧:', String(data).slice(0, 200));
      return;
    }
    const reqId = frame?.headers?.req_id;

    // 1. 我方请求的回包（subscribe / ping / respond / send）
    if (!frame.cmd && reqId && this.pending.has(reqId)) {
      const p = this.pending.get(reqId);
      clearTimeout(p.timer);
      this.pending.delete(reqId);
      p.resolve(frame);
      return;
    }

    // 2. 对 aibot_respond_msg 等的回执（req_id 复用了回调的 id，不在 pending 里）
    if (!frame.cmd && typeof frame.errcode === 'number') {
      if (frame.errcode !== 0) this.bot.warn(`回执异常 req_id=${reqId} errcode=${frame.errcode} errmsg=${frame.errmsg}`);
      return;
    }

    // 3. 企微推送
    switch (frame.cmd) {
      case 'aibot_msg_callback':
        return this.onMsgCallback(frame);
      case 'aibot_event_callback':
        this.bot.log('【事件】', JSON.stringify(maskBody(frame.body)));
        this.bot.store.append({ kind: 'event', req_id: reqId, body: frame.body });
        return;
      default:
        this.bot.log('【其他帧】', JSON.stringify(frame).slice(0, 500));
    }
  }

  /** 自动回复文案：处理端在线或状态未知用 reply_text，确认离线时换成带离线时长的那句 */
  replyTextNow() {
    const { replyText, replyTextOffline } = this.conf;
    if (!replyText) return '';                       // 配成空串就是不回帧
    if (this.bot.agentOnline() === false) {
      return String(replyTextOffline || '').replace(/\{duration\}/g, fmtDuration(this.bot.offlineSecs()));
    }
    return replyText;
  }

  onMsgCallback(frame) {
    const b = frame.body || {};
    const reqId = frame.headers?.req_id;
    // 企微重推（同 msgid、新 req_id）多半是上次没在 5 秒内收到回帧：不再落盘，但这次一定要回帧
    if (this.bot.isDuplicate(b.msgid)) {
      this.bot.log('重复消息，只回帧不落盘', b.msgid);
    } else {
      this.lastMsgAt = new Date().toISOString();
      this.bot.log('【收到消息】', JSON.stringify(maskBody(b)));
      this.bot.log(`  类型=${b.msgtype} 会话=${b.chattype}${b.chatid ? ' chatid=' + b.chatid : ''} 发送人=${b.from?.userid}`);
      if (b.msgtype === 'text') this.bot.log('  文本=', b.text?.content);
      this.bot.store.append({ kind: 'message', req_id: reqId, body: b });
    }

    // 5 秒内必须回一帧；用同一个 req_id
    const text = this.replyTextNow();
    if (text) {
      const reply = {
        cmd: 'aibot_respond_msg',
        headers: { req_id: reqId },
        body: { msgtype: 'stream', stream: { id: randomUUID().replace(/-/g, ''), finish: true, content: text } },
      };
      try {
        this.send(reply);
        this.bot.log('  已回复:', text);
      } catch (e) {
        this.bot.warn('  回复失败:', e.message);
      }
    }
  }
}

/* ---------- 管理员离线告警（offline_alert_mins > 0 且配了 admin_userid 才开） ---------- */
function startOfflineAlert(bot) {
  const mins = bot.conf.offlineAlertMins;
  if (!(mins > 0) || !bot.conf.adminUserId) return null;
  const tick = async () => {
    const conn = bot.conn;
    if (!conn || !conn.subscribed) return; // 未订阅时发不出去，跳过本轮
    const online = bot.agentOnline();
    const pending = bot.pending();
    let content = '';
    if (online === false && bot.offlineSecs() >= mins * 60 && pending > 0 && !bot.offlineAlerted) {
      bot.offlineAlerted = true;
      content = `⚠️ 处理端已离线 ${fmtDuration(bot.offlineSecs())}，积压 ${pending} 条消息无人处理`;
    } else if (online === true && bot.offlineAlerted) {
      bot.offlineAlerted = false;
      content = `✅ 处理端已恢复（${bot.presence.lastAgent || '未知'}），当前积压 ${pending} 条`;
    }
    if (!content) return;
    try {
      const resp = await conn.request({ cmd: 'aibot_send_msg', body: { chatid: bot.conf.adminUserId, chat_type: 1, msgtype: 'markdown', markdown: { content } } }, 10000);
      if (resp.errcode === 0) bot.log('离线告警已发送:', content);
      else bot.warn(`离线告警被拒 errcode=${resp.errcode} errmsg=${resp.errmsg}`);
    } catch (e) {
      bot.warn('离线告警失败:', e.message);
    }
  };
  return setInterval(tick, Math.min(10000, mins * 60000));
}

/* ---------- HTTP API ----------
 * 路由：/bots/<key>/… 指定 bot；/bots 是管理员总览；其余无前缀路径沿用 bots[0]，老客户端不用改。
 * 鉴权：http.api_token = 管理员，任意 bot；bots[].api_token 只能访问自己。判定顺序 401 → 403 → 404，
 * unknown bot 的 404 放在鉴权之后，免得未鉴权的人拿它探测 key 是否存在。
 */
function startHttpServer(bots) {
  if (!gw.httpPort) return null;
  // 正常部署不应走到这里：对外应由反代做 HTTPS。token 强度已在加载配置时校验，这里只警告。
  if (!isLoopback(gw.httpHost)) warn(`HTTP API 以明文 HTTP 对外监听 ${gw.httpHost}，token 和 response_url 会在链路上裸奔；请改为 127.0.0.1 并用反代做 HTTPS`);
  const byKey = new Map(bots.map((b) => [b.key, b]));
  const authOn = !!gw.apiToken || bots.some((b) => b.conf.apiToken);
  const sameToken = (tok, expect) => {
    if (!tok || !expect) return false;
    const a = Buffer.from(String(tok)), b = Buffer.from(expect);
    return a.length === b.length && timingSafeEqual(a, b);
  };
  // 在反代后面时，真实来源在 X-Forwarded-For 第一段；直连时用 socket 地址
  const clientIp = (req) => {
    const xff = req.headers['x-forwarded-for'];
    return (typeof xff === 'string' && xff.split(',')[0].trim()) || req.socket.remoteAddress;
  };
  const json = (res, code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
  };
  const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
  const readBody = (req) => new Promise((resolve, reject) => {
    let b = '';
    req.on('data', (d) => { b += d; if (b.length > 1e6) { reject(new Error('body too large')); req.destroy(); } });
    req.on('end', () => resolve(b));
    req.on('error', reject);
  });

  const healthOf = (bot) => ({
    ok: true,
    connected: !!bot.conn?.ws && bot.conn.ws.readyState === 1,
    subscribed: !!bot.conn?.subscribed,
    last_msg_at: bot.conn?.lastMsgAt ?? null,
    seq: bot.store.seq,
    cursor: bot.store.cursor,
    count: bot.store.items.length,
    bot: bot.key,
    agent_online: bot.agentOnline(),
    agent_last_seen: iso(bot.presence.lastSeen),
    last_agent: bot.presence.lastAgent || null,
    last_ack_at: iso(bot.presence.lastAckAt),
    pending: bot.pending(),
  });

  const handler = async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const prefixed = url.pathname.match(/^\/bots\/([^/]+)(\/.*)$/);
    const listAll = url.pathname === '/bots';
    const bot = prefixed ? byKey.get(prefixed[1]) : listAll ? null : bots[0];
    const pathname = prefixed ? prefixed[2] : url.pathname;
    if (authOn) {
      const auth = req.headers.authorization || '';
      const tok = auth.startsWith('Bearer ') ? auth.slice(7) : url.searchParams.get('token');
      const admin = sameToken(tok, gw.apiToken);
      const own = admin ? null : bots.find((b) => sameToken(tok, b.conf.apiToken));
      if (!admin && !own) {
        warn(`API 鉴权失败 ip=${clientIp(req)} path=${url.pathname}`);
        return json(res, 401, { ok: false, error: 'unauthorized' });
      }
      // bot token 只管自己：总览、别的 bot、不存在的 key 一律 403（不透露 key 是否存在）
      if (!admin && (listAll || own !== bot)) {
        warn(`API 越权访问 ip=${clientIp(req)} token=${own.key} path=${url.pathname}`);
        return json(res, 403, { ok: false, error: 'forbidden' });
      }
    }
    if (prefixed && !bot) return json(res, 404, { ok: false, error: 'unknown bot' });
    // 鉴权过了才认这个头：处理端每次来访都刷新请求所指那个 bot 的在线状态
    const agentId = req.headers['x-relay-agent'];
    if (agentId && bot) bot.touchAgent(agentId);
    try {
      if (req.method === 'GET' && listAll) return json(res, 200, { ok: true, bots: bots.map(healthOf) });
      if (!bot) return json(res, 404, { ok: false, error: 'not found' });
      const store = bot.store;
      if (req.method === 'GET' && pathname === '/health') return json(res, 200, healthOf(bot));
      if (req.method === 'GET' && pathname === '/messages') {
        const afterRaw = url.searchParams.get('after'), limitRaw = url.searchParams.get('limit');
        if ((afterRaw !== null && !/^\d+$/.test(afterRaw)) || (limitRaw !== null && !/^\d+$/.test(limitRaw))) {
          return json(res, 400, { ok: false, error: 'after/limit must be non-negative integers' });
        }
        const after = afterRaw !== null ? Number(afterRaw) : store.cursor;
        const limit = Math.min(Math.max(Number(limitRaw || 50), 1), 500);
        const kind = url.searchParams.get('kind') || '';
        const messages = store.list({ after, limit, kind });
        return json(res, 200, { ok: true, after, cursor: store.cursor, seq: store.seq, messages, next: messages.length ? messages[messages.length - 1].seq : after });
      }
      const one = req.method === 'GET' && pathname.match(/^\/messages\/(\d+)$/);
      if (one) {
        const r = store.get(Number(one[1]));
        return r ? json(res, 200, { ok: true, message: r }) : json(res, 404, { ok: false, error: 'not found' });
      }
      if ((req.method === 'GET' || req.method === 'POST') && pathname === '/ack') {
        const seq = Number(url.searchParams.get('seq'));
        if (!Number.isFinite(seq)) return json(res, 400, { ok: false, error: 'seq required' });
        bot.presence.lastAckAt = Date.now();
        const cursor = store.ack(seq);
        bot.saveState();
        return json(res, 200, { ok: true, cursor });
      }
      if (req.method === 'POST' && pathname === '/send') {
        let body;
        try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { ok: false, error: 'invalid json' }); }
        // 企微拒绝、未订阅、等回执超时都返回 200：反代/Cloudflare 会把 5xx 换成自己的错误页，吞掉原因
        let resp;
        try {
          resp = await bot.conn.sendFrame({ cmd: 'aibot_send_msg', body });
        } catch (e) {
          bot.warn(`/send 未能发出：${e.message}`);
          return json(res, 200, { ok: false, error: e.message });
        }
        if (resp.errcode !== 0) bot.warn(`/send 被企微拒绝 errcode=${resp.errcode} errmsg=${resp.errmsg} body=${JSON.stringify(body).slice(0, 300)}`);
        return json(res, 200, { ok: resp.errcode === 0, resp });
      }
      return json(res, 404, { ok: false, error: 'not found' });
    } catch (e) {
      return json(res, 500, { ok: false, error: e.message });
    }
  };
  const server = http.createServer(handler);
  server.listen(gw.httpPort, gw.httpHost, () => {
    log(`HTTP API 监听 http://${gw.httpHost}:${server.address().port}${authOn ? '（需 token）' : '（无 token，仅限本机）'}`);
  });
  return server;
}

/* ---------- 入口 ---------- */
const WS = await getWebSocketCtor();
const bots = botConfigs.map((c) => new Bot(c));
const alertTimers = [];
for (const bot of bots) {
  bot.conn = new BotConnection(WS, bot);
  bot.conn.start();
  const t = startOfflineAlert(bot);
  if (t) alertTimers.push(t);
}
const httpServer = startHttpServer(bots);

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log(`收到 ${sig}，退出`);
    for (const bot of bots) {
      if (bot.conn?.subscribed) bot.writeAlive();
      bot.saveState();
      bot.conn?.stop();
    }
    for (const t of alertTimers) clearInterval(t);
    if (httpServer) httpServer.close();
    setTimeout(() => process.exit(0), 300);
  });
}
