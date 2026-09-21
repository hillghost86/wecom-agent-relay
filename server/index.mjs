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
 * 环境变量：
 *   WECOM_BOT_ID       必填
 *   WECOM_BOT_SECRET   必填
 *   WECOM_WS_URL       可选，默认 wss://openws.work.weixin.qq.com
 *   MSG_LOG            可选，消息落盘路径，默认 ./messages.jsonl；设为 "off" 关闭
 *   REPLY_TEXT         可选，收到消息后自动回复的文本，默认 "已收到"；设为空串则不回复
 *   PING_INTERVAL_MS   可选，默认 30000
 *   HTTP_HOST          可选，HTTP API 监听地址，默认 127.0.0.1（对外开放请设 0.0.0.0 并务必配 API_TOKEN）
 *   HTTP_PORT          可选，默认 8788；设为 0 关闭 HTTP API
 *   API_TOKEN          可选，HTTP API 鉴权：Authorization: Bearer <token> 或 ?token=<token>
 *   ADMIN_USERID       可选，断线自报：重连成功后把离线时段推给这个 userid（含进程重启造成的空窗）
 *   TZ                 可选，自报里的时间显示时区，默认 Asia/Shanghai
 *
 * 部署形态：本进程只在 127.0.0.1 上说明文 HTTP；HTTPS、证书、域名、对外端口由前面的反代
 * （nginx / Caddy / 宝塔）负责，反代把请求转到 127.0.0.1:8788 并原样透传 Authorization 头。
 *
 * HTTP API（给 agent 用）：
 *   GET  /health                         连接状态
 *   GET  /messages?after=<seq>&limit=50  拉 seq 大于 after 的消息（默认 after=已确认游标，limit 默认 50 最多 500）
 *   GET  /messages/<seq>                 按 seq 取单条，不存在返回 404
 *   GET  /ack?seq=<seq>                  把游标推进到 seq（之后 /messages 不带 after 时从这里开始）
 *   POST /send  {body}                   透传为 aibot_send_msg 帧（主动推送），返回企微回执
 *        body 规则（官方文档）：msgtype 只支持 markdown/template_card/file/image/voice/video，没有 text；
 *        chatid 单聊填用户 userid、群聊填群 chatid；chat_type 1=单聊 2=群聊，0 或不填自动兼容
 *   回复用户：直接 POST 消息里的 response_url（1 小时内一次），不经过本进程
 *
 * 运行：npm i && node --env-file=.env index.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import http from 'node:http';

const cfg = {
  botId: process.env.WECOM_BOT_ID || '',
  secret: process.env.WECOM_BOT_SECRET || '',
  wsUrl: process.env.WECOM_WS_URL || 'wss://openws.work.weixin.qq.com',
  msgLog: process.env.MSG_LOG ?? path.join(process.cwd(), 'messages.jsonl'),
  replyText: process.env.REPLY_TEXT ?? '已收到',
  pingIntervalMs: Number(process.env.PING_INTERVAL_MS || 30000),
  httpHost: process.env.HTTP_HOST || '127.0.0.1',
  httpPort: Number(process.env.HTTP_PORT ?? 8788),
  apiToken: process.env.API_TOKEN || '',
  adminUserId: process.env.ADMIN_USERID || '',
  tz: process.env.TZ || 'Asia/Shanghai',
  outageMinSecs: Number(process.env.OUTAGE_MIN_SECS ?? 3),            // 低于这个秒数不报
  outageReportMinMs: Number(process.env.OUTAGE_REPORT_MIN_MS ?? 60000), // 抖动时最多每分钟报一次
  subscribeTimeoutMs: 10000,
  backoffMinMs: 1000,
  backoffMaxMs: 60000,
};

if (!cfg.botId || !cfg.secret) {
  console.error('缺少环境变量 WECOM_BOT_ID / WECOM_BOT_SECRET');
  process.exit(1);
}

const log = (...a) => console.log(new Date().toISOString(), ...a);
const warn = (...a) => console.warn(new Date().toISOString(), ...a);

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
  constructor(file) {
    this.file = file && file !== 'off' ? file : null;
    this.stateFile = this.file ? this.file + '.state.json' : null;
    this.items = [];
    this.seq = 0;
    this.cursor = 0;
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
        this.cursor = Number(JSON.parse(fs.readFileSync(this.stateFile, 'utf-8')).cursor) || 0;
      }
      log(`消息存储已加载：${this.items.length} 条，seq=${this.seq}，游标=${this.cursor}`);
    } catch (e) {
      warn('加载消息存储失败:', e.message);
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
        warn('写消息日志失败:', e.message);
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
    if (this.stateFile) {
      try { fs.writeFileSync(this.stateFile, JSON.stringify({ cursor: this.cursor })); } catch (e) { warn('写游标失败:', e.message); }
    }
    return this.cursor;
  }
}
const store = new MessageStore(cfg.msgLog);
const appendMsgLog = (record) => store.append(record);

/* ---------- 最后在线时刻：每次心跳写一次，重启后用来算空窗 ---------- */
const aliveFile = cfg.msgLog && cfg.msgLog !== 'off' ? cfg.msgLog + '.alive' : null;
function writeAlive() {
  if (!aliveFile) return;
  try { fs.writeFileSync(aliveFile, String(Date.now())); } catch {}
}
function readAlive() {
  if (!aliveFile) return null;
  try { const t = Number(fs.readFileSync(aliveFile, 'utf-8')); return Number.isFinite(t) && t > 0 ? t : null; } catch { return null; }
}
const fmtTime = (ms) => new Date(ms).toLocaleString('zh-CN', { timeZone: cfg.tz, hour12: false });
// 日志里的 response_url 只留尾部：它是一次性的回复凭证，进了 journal 就等于泄露
const maskBody = (b) => (b && b.response_url ? { ...b, response_url: '…' + String(b.response_url).slice(-8) } : b);

/* ---------- 去重（企微可能重推） ---------- */
const seenMsgIds = new Set();
function isDuplicate(msgid) {
  if (!msgid) return false;
  if (seenMsgIds.has(msgid)) return true;
  seenMsgIds.add(msgid);
  if (seenMsgIds.size > 5000) seenMsgIds.delete(seenMsgIds.values().next().value);
  return false;
}

/* ---------- 连接管理 ---------- */
class BotConnection {
  constructor(WS) {
    this.WS = WS;
    this.ws = null;
    this.backoffMs = cfg.backoffMinMs;
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
      const last = readAlive();
      if (last) { since = last; reason = '进程重启'; }
    }
    this.everSubscribed = true;
    this.downSince = null;
    writeAlive();
    if (!since || !cfg.adminUserId) return;
    const now = Date.now();
    const secs = Math.round((now - since) / 1000);
    if (secs < cfg.outageMinSecs) return; // 秒级抖动不打扰
    if (now - this.lastOutageReportAt < cfg.outageReportMinMs) { log(`离线 ${secs}s（${reason}），1 分钟内已报过，跳过`); return; }
    this.lastOutageReportAt = now;
    const content = `⚠️ 机器人离线 **${secs} 秒**（${reason}）\n${fmtTime(since)} → ${fmtTime(now)}\n期间发给机器人的消息已丢失，请重发。`;
    try {
      const resp = await this.request({ cmd: 'aibot_send_msg', body: { chatid: cfg.adminUserId, chat_type: 1, msgtype: 'markdown', markdown: { content } } }, 10000);
      if (resp.errcode === 0) log(`断线自报已发送：离线 ${secs}s（${reason}）`);
      else warn(`断线自报被拒 errcode=${resp.errcode} errmsg=${resp.errmsg}`);
    } catch (e) {
      warn('断线自报失败:', e.message);
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
    log(`连接 ${cfg.wsUrl} ...`);
    const ws = new this.WS(cfg.wsUrl);
    this.ws = ws;
    this.subscribed = false;
    this.missedPongs = 0;

    ws.addEventListener('open', () => this.onOpen());
    ws.addEventListener('message', (ev) => this.onMessage(ev.data));
    ws.addEventListener('error', (ev) => warn('连接错误:', ev?.message || ev?.error?.message || 'unknown'));
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
    this.backoffMs = Math.min(this.backoffMs * 2, cfg.backoffMaxMs);
    log(`${delay / 1000}s 后重连`);
    setTimeout(() => this.connect(), delay);
  }

  onClose(ev) {
    warn(`连接关闭 code=${ev?.code} reason=${ev?.reason || ''}`);
    if (this.subscribed && !this.downSince) this.downSince = Date.now();
    this.subscribed = false;
    this.cleanup();
    this.scheduleReconnect();
  }

  async onOpen() {
    log('TCP/WS 已建立，发送订阅');
    try {
      const resp = await this.request({ cmd: 'aibot_subscribe', body: { bot_id: cfg.botId, secret: cfg.secret } }, cfg.subscribeTimeoutMs);
      if (resp.errcode !== 0) {
        warn(`订阅失败 errcode=${resp.errcode} errmsg=${resp.errmsg}；检查 BotID/Secret。为避免触发频率限制，退避到上限再重试`);
        this.backoffMs = cfg.backoffMaxMs;
        this.ws.close();
        return;
      }
      this.subscribed = true;
      this.backoffMs = cfg.backoffMinMs;
      log('订阅成功，开始心跳');
      this.pingTimer = setInterval(() => this.heartbeat(), cfg.pingIntervalMs);
      this.reportOutage();
    } catch (e) {
      warn('订阅异常:', e.message);
      if (this.ws) this.ws.close();
    }
  }

  async heartbeat() {
    try {
      const resp = await this.request({ cmd: 'ping' }, cfg.pingIntervalMs);
      if (resp.errcode !== 0) warn(`ping 回包异常 errcode=${resp.errcode} errmsg=${resp.errmsg}`);
      this.missedPongs = 0;
      writeAlive();
    } catch {
      this.missedPongs++;
      warn(`心跳无回包 (${this.missedPongs})`);
      if (this.missedPongs >= 2) {
        warn('连续两次心跳无回包，主动断开重连');
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
      warn('收到非 JSON 帧:', String(data).slice(0, 200));
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
      if (frame.errcode !== 0) warn(`回执异常 req_id=${reqId} errcode=${frame.errcode} errmsg=${frame.errmsg}`);
      return;
    }

    // 3. 企微推送
    switch (frame.cmd) {
      case 'aibot_msg_callback':
        return this.onMsgCallback(frame);
      case 'aibot_event_callback':
        log('【事件】', JSON.stringify(maskBody(frame.body)));
        appendMsgLog({ kind: 'event', req_id: reqId, body: frame.body });
        return;
      default:
        log('【其他帧】', JSON.stringify(frame).slice(0, 500));
    }
  }

  onMsgCallback(frame) {
    const b = frame.body || {};
    const reqId = frame.headers?.req_id;
    // 企微重推（同 msgid、新 req_id）多半是上次没在 5 秒内收到回帧：不再落盘，但这次一定要回帧
    if (isDuplicate(b.msgid)) {
      log('重复消息，只回帧不落盘', b.msgid);
    } else {
      this.lastMsgAt = new Date().toISOString();
      log('【收到消息】', JSON.stringify(maskBody(b)));
      log(`  类型=${b.msgtype} 会话=${b.chattype}${b.chatid ? ' chatid=' + b.chatid : ''} 发送人=${b.from?.userid}`);
      if (b.msgtype === 'text') log('  文本=', b.text?.content);
      appendMsgLog({ kind: 'message', req_id: reqId, body: b });
    }

    // 5 秒内必须回一帧；用同一个 req_id
    if (cfg.replyText) {
      const reply = {
        cmd: 'aibot_respond_msg',
        headers: { req_id: reqId },
        body: { msgtype: 'stream', stream: { id: randomUUID().replace(/-/g, ''), finish: true, content: cfg.replyText } },
      };
      try {
        this.send(reply);
        log('  已回复:', cfg.replyText);
      } catch (e) {
        warn('  回复失败:', e.message);
      }
    }
  }
}

/* ---------- HTTP API ---------- */
function startHttpServer(conn) {
  if (!cfg.httpPort) return null;
  const loopback = cfg.httpHost === '127.0.0.1' || cfg.httpHost === 'localhost' || cfg.httpHost === '::1';
  if (!loopback) {
    // 正常部署不应走到这里：对外应由反代做 HTTPS。允许但必须有强 token，并明确警告。
    if (!cfg.apiToken || cfg.apiToken.length < 32) {
      console.error('HTTP_HOST 对外监听时必须设置至少 32 字符的 API_TOKEN（建议 openssl rand -hex 32）');
      process.exit(1);
    }
    warn(`HTTP API 以明文 HTTP 对外监听 ${cfg.httpHost}，token 和 response_url 会在链路上裸奔；请改为 127.0.0.1 并用反代做 HTTPS`);
  }
  const tokenOk = (tok) => {
    if (!tok) return false;
    const a = Buffer.from(String(tok)), b = Buffer.from(cfg.apiToken);
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
  const readBody = (req) => new Promise((resolve, reject) => {
    let b = '';
    req.on('data', (d) => { b += d; if (b.length > 1e6) { reject(new Error('body too large')); req.destroy(); } });
    req.on('end', () => resolve(b));
    req.on('error', reject);
  });

  const handler = async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (cfg.apiToken) {
      const auth = req.headers.authorization || '';
      const tok = auth.startsWith('Bearer ') ? auth.slice(7) : url.searchParams.get('token');
      if (!tokenOk(tok)) {
        warn(`API 鉴权失败 ip=${clientIp(req)} path=${url.pathname}`);
        return json(res, 401, { ok: false, error: 'unauthorized' });
      }
    }
    try {
      if (req.method === 'GET' && url.pathname === '/health') {
        return json(res, 200, {
          ok: true,
          connected: !!conn.ws && conn.ws.readyState === 1,
          subscribed: conn.subscribed,
          last_msg_at: conn.lastMsgAt,
          seq: store.seq,
          cursor: store.cursor,
          count: store.items.length,
        });
      }
      if (req.method === 'GET' && url.pathname === '/messages') {
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
      const one = req.method === 'GET' && url.pathname.match(/^\/messages\/(\d+)$/);
      if (one) {
        const r = store.get(Number(one[1]));
        return r ? json(res, 200, { ok: true, message: r }) : json(res, 404, { ok: false, error: 'not found' });
      }
      if ((req.method === 'GET' || req.method === 'POST') && url.pathname === '/ack') {
        const seq = Number(url.searchParams.get('seq'));
        if (!Number.isFinite(seq)) return json(res, 400, { ok: false, error: 'seq required' });
        return json(res, 200, { ok: true, cursor: store.ack(seq) });
      }
      if (req.method === 'POST' && url.pathname === '/send') {
        let body;
        try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { ok: false, error: 'invalid json' }); }
        // 企微拒绝、未订阅、等回执超时都返回 200：反代/Cloudflare 会把 5xx 换成自己的错误页，吞掉原因
        let resp;
        try {
          resp = await conn.sendFrame({ cmd: 'aibot_send_msg', body });
        } catch (e) {
          warn(`/send 未能发出：${e.message}`);
          return json(res, 200, { ok: false, error: e.message });
        }
        if (resp.errcode !== 0) warn(`/send 被企微拒绝 errcode=${resp.errcode} errmsg=${resp.errmsg} body=${JSON.stringify(body).slice(0, 300)}`);
        return json(res, 200, { ok: resp.errcode === 0, resp });
      }
      return json(res, 404, { ok: false, error: 'not found' });
    } catch (e) {
      return json(res, 500, { ok: false, error: e.message });
    }
  };
  const server = http.createServer(handler);
  server.listen(cfg.httpPort, cfg.httpHost, () => {
    log(`HTTP API 监听 http://${cfg.httpHost}:${server.address().port}${cfg.apiToken ? '（需 token）' : '（无 token，仅限本机）'}`);
  });
  return server;
}

/* ---------- 入口 ---------- */
const WS = await getWebSocketCtor();
const conn = new BotConnection(WS);
conn.start();
const httpServer = startHttpServer(conn);

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log(`收到 ${sig}，退出`);
    if (conn.subscribed) writeAlive();
    conn.stop();
    if (httpServer) httpServer.close();
    setTimeout(() => process.exit(0), 300);
  });
}
