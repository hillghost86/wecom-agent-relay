// HTTP API 各路由的处理函数：只算结果，返回 [状态码, 响应对象]，由 server.mjs 写成 JSON
import fs from 'node:fs';
import path from 'node:path';
import { FILE_TYPES } from '../media.mjs';

const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
// 含图片的记录在顶层附 media；返回拷贝，内存里的原记录不能被改（它就是落盘的那一行）
const withMedia = (bot, r) => {
  const media = bot.media.statusOf(r.seq, r);
  return media ? { ...r, media } : r;
};

export const healthOf = (bot) => ({
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

/** GET /bots（仅管理员） */
export const listBots = (bots) => [200, { ok: true, bots: bots.map(healthOf) }];

/** GET /health */
export const health = (bot) => [200, healthOf(bot)];

/** GET /messages?after=&limit=&kind= */
export function listMessages(bot, searchParams) {
  const store = bot.store;
  const afterRaw = searchParams.get('after'), limitRaw = searchParams.get('limit');
  if ((afterRaw !== null && !/^\d+$/.test(afterRaw)) || (limitRaw !== null && !/^\d+$/.test(limitRaw))) {
    return [400, { ok: false, error: 'after/limit must be non-negative integers' }];
  }
  const after = afterRaw !== null ? Number(afterRaw) : store.cursor;
  const limit = Math.min(Math.max(Number(limitRaw || 50), 1), 500);
  const kind = searchParams.get('kind') || '';
  const messages = store.list({ after, limit, kind }).map((r) => withMedia(bot, r));
  return [200, { ok: true, after, cursor: store.cursor, seq: store.seq, messages, next: messages.length ? messages[messages.length - 1].seq : after }];
}

/** GET /messages/<seq> */
export function getMessage(bot, seq) {
  const r = bot.store.get(seq);
  return r ? [200, { ok: true, message: withMedia(bot, r) }] : [404, { ok: false, error: 'not found' }];
}

/**
 * GET /files/<YYYY-MM>/<文件名>：成功返回 [200, null, { file, type, size }]，由 server.mjs 流式写出文件。
 * rel 不做 URL 解码：合法文件名只有数字和扩展名，%2F 之类原样落到正则上被拒
 */
export function mediaFile(bot, rel) {
  if (!bot.media.dir) return [404, { ok: false, error: 'file not found' }];   // msg_log=off 的 bot 没有媒体功能
  if (!/^\d{4}-\d{2}\/\d+-\d+\.(jpg|png|gif|webp|bin)$/.test(rel)) return [400, { ok: false, error: 'bad file path' }];
  const file = bot.media.resolve(rel);
  if (!file) return [400, { ok: false, error: 'bad file path' }];
  let st;
  try { st = fs.statSync(file); } catch { st = null; }
  if (!st?.isFile()) return [404, { ok: false, error: 'file not found' }];
  return [200, null, { file, type: FILE_TYPES[path.extname(file).slice(1)], size: st.size }];
}

/** GET|POST /ack?seq= */
export function ack(bot, searchParams) {
  // 缺参时 Number(null) 是 0，小数、负数也能过 isFinite；非法请求不能刷新 lastAckAt，否则处理端被误判在线
  const raw = searchParams.get('seq');
  if (!/^\d+$/.test(raw ?? '')) return [400, { ok: false, error: 'seq must be a non-negative integer' }];
  bot.presence.lastAckAt = Date.now();
  const cursor = bot.store.ack(Number(raw));
  bot.saveState();
  return [200, { ok: true, cursor }];
}

/**
 * POST /send：body 原样透传为 aibot_send_msg 帧。readRaw 读请求体原文（超长会 reject，按 invalid json 处理）。
 * 企微拒绝、未订阅、等回执超时都返回 200：反代/Cloudflare 会把 5xx 换成自己的错误页，吞掉原因
 */
export async function send(bot, readRaw) {
  let body;
  try { body = JSON.parse(await readRaw()); } catch { return [400, { ok: false, error: 'invalid json' }]; }
  let resp;
  try {
    resp = await bot.conn.sendFrame({ cmd: 'aibot_send_msg', body });
  } catch (e) {
    bot.warn(`/send 未能发出：${e.message}`);
    return [200, { ok: false, error: e.message }];
  }
  if (resp.errcode !== 0) bot.warn(`/send 被企微拒绝 errcode=${resp.errcode} errmsg=${resp.errmsg} body=${JSON.stringify(body).slice(0, 300)}`);
  return [200, { ok: resp.errcode === 0, resp }];
}
