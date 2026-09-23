/**
 * 企微长连接：连接、订阅、心跳、断线重连、收发帧、收到消息 5 秒内回帧。
 *
 * 协议：https://developer.work.weixin.qq.com/document/path/101463
 *   1. 连接 wss://openws.work.weixin.qq.com
 *   2. 发 aibot_subscribe { bot_id, secret }，errcode=0 即订阅成功
 *   3. 每 30s 发 ping 保活；连续两次没收到回包就判定连接死了，重连
 *   4. 收到 aibot_msg_callback：打印 + 追加到 JSONL；5 秒内用同一个 req_id 回一帧 stream
 *   5. 断线：指数退避重连（1s → 60s 上限），永不放弃
 */
import { randomUUID } from 'node:crypto';
import { warn, fmtDuration, maskBody, makeFmtTime } from './log.mjs';
import { sendOutageReport } from './notify.mjs';

/* ---------- WebSocket 实现：优先 ws 包，否则内置 ----------
 * 实测 Node 内置 WebSocket（undici）在某些代理/TUN 环境下对企微网关握手失败（non-101），
 * ws 包同环境下正常，所以优先用 ws。
 */
export async function getWebSocketCtor() {
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

/* ---------- 连接管理 ---------- */
export class BotConnection {
  constructor(WS, bot, gw) {
    this.WS = WS;
    this.bot = bot;
    this.conf = bot.conf;
    this.gw = gw;
    this.fmtTime = makeFmtTime(gw.tz);
    this.ws = null;
    this.backoffMs = this.gw.backoffMinMs;
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

  /** 断线自报：订阅成功后调用。这里算空窗、做节流，组内容和发送在 notify.mjs */
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
    if (secs < this.gw.outageMinSecs) return; // 秒级抖动不打扰
    if (now - this.lastOutageReportAt < this.gw.outageReportMinMs) { this.bot.log(`离线 ${secs}s（${reason}），1 分钟内已报过，跳过`); return; }
    this.lastOutageReportAt = now;
    await sendOutageReport(this, { since, now, secs, reason });
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
    this.bot.log(`连接 ${this.gw.wsUrl} ...`);
    const ws = new this.WS(this.gw.wsUrl);
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
    this.backoffMs = Math.min(this.backoffMs * 2, this.gw.backoffMaxMs);
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
      const resp = await this.request({ cmd: 'aibot_subscribe', body: { bot_id: this.conf.botId, secret: this.conf.secret } }, this.gw.subscribeTimeoutMs);
      if (resp.errcode !== 0) {
        this.bot.warn(`订阅失败 errcode=${resp.errcode} errmsg=${resp.errmsg}；检查 BotID/Secret。为避免触发频率限制，退避到上限再重试`);
        this.backoffMs = this.gw.backoffMaxMs;
        this.ws.close();
        return;
      }
      this.subscribed = true;
      this.backoffMs = this.gw.backoffMinMs;
      this.bot.log('订阅成功，开始心跳');
      this.pingTimer = setInterval(() => this.heartbeat(), this.gw.pingIntervalMs);
      this.reportOutage();
    } catch (e) {
      this.bot.warn('订阅异常:', e.message);
      if (this.ws) this.ws.close();
    }
  }

  async heartbeat() {
    try {
      const resp = await this.request({ cmd: 'ping' }, this.gw.pingIntervalMs);
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
