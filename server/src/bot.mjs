// 一个机器人的全部运行时：存储、去重、处理端在线状态、.alive 心跳时刻；连接对象由入口挂到 bot.conn
import fs from 'node:fs';
import { tagged } from './log.mjs';
import { MessageStore } from './store.mjs';

export class Bot {
  constructor(conf, gw) {
    this.key = conf.key;
    this.conf = conf;
    this.agentOnlineSecs = gw.agentOnlineSecs;
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
    return Date.now() - last < this.agentOnlineSecs * 1000;
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
