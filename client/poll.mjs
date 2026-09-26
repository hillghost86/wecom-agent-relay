/**
 * wecom-agent-relay · agent 侧客户端
 *
 * 对消息做处理的命令行工具：拉取 / 单条取 / 回复 / 推送 / 推进游标。
 *
 * 用法：
 *   node client/poll.mjs                    # 拉取新消息（默认从服务端游标起，不拉历史）
 *   node client/poll.mjs --after <seq>      # 从指定 seq 之后拉取
 *   node client/poll.mjs --get <seq>        # 按 seq 取单条（404 = 不存在）
 *   node client/poll.mjs --health           # 连接状态
 *   node client/poll.mjs --reply <seq> <markdown 文本>   # 用该消息的 response_url 回复
 *   node client/poll.mjs --send <chatid> <markdown 文本> # 主动推送（response_url 过期后的备选）
 *   node client/poll.mjs --ack <seq>        # 推进服务端游标
 *
 * 配置（优先级：环境变量 > config.json）：
 *   WECOM_API_BASE / WECOM_API_TOKEN / WECOM_AGENT_ID（可选，默认本机主机名）
 *   或同目录 config.json: { "api_base": "...", "api_token": "...", "agent_id": "..." }
 *
 * 企微侧注意事项（踩过的坑）：
 * - response_url 在消息的 body.response_url（1 小时内有效、只能调一次，群聊自动引用原消息）
 * - 回复 msgtype 只支持 markdown / template_card，text 会被拒；HTTP 200 不代表成功，必须看 body.errcode
 * - /send 的字段是 chatid（单聊填 userid、群聊填群 chatid）；企微拒绝时返回 200 且 ok:false，errcode 在 resp 里
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cfgFile = path.join(__dirname, 'config.json');
const fileCfg = fs.existsSync(cfgFile) ? JSON.parse(fs.readFileSync(cfgFile, 'utf-8')) : {};
const BASE = String(process.env.WECOM_API_BASE || fileCfg.api_base || '').replace(/\/+$/, '');
const TOKEN = String(process.env.WECOM_API_TOKEN || fileCfg.api_token || '');
if (!BASE || !TOKEN) {
  console.error('缺少配置：设置环境变量 WECOM_API_BASE / WECOM_API_TOKEN，或在同目录 config.json 填 api_base / api_token');
  process.exit(1);
}
const AGENT_ID = String(process.env.WECOM_AGENT_ID || fileCfg.agent_id || os.hostname() || 'unknown');
// 本脚本由 agent 执行，跑一次就等于处理端在干活；这个头让网关记下在线状态
const H = { Authorization: `Bearer ${TOKEN}`, 'X-Relay-Agent': AGENT_ID };

function usage() {
  console.log(fs.readFileSync(__filename, 'utf-8').split('*/')[0].replace(/^\/\*\*/, '').trim());
}

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) { usage(); process.exit(0); }

async function api(p, opts = {}) {
  const res = await fetch(BASE + p, { headers: H, ...opts });
  const text = await res.text();
  let body = text;
  try { body = JSON.parse(text); } catch { /* 保留原文 */ }
  return { status: res.status, body };
}

// /send /response_url 的成功判定：HTTP 200 且没有显式失败标记
// （企微拒绝时返回 200 + ok:false 或 errcode != 0，不能只看 HTTP 状态码）
function callOk(status, body) {
  if (status !== 200) return false;
  if (body && typeof body === 'object') {
    if (body.ok === false) return false;
    if (typeof body.errcode === 'number' && body.errcode !== 0) return false;
  }
  return true;
}

if (args.includes('--health')) {
  const r = await api('/health');
  console.log(JSON.stringify(r.body, null, 2));
  process.exit(r.status === 200 ? 0 : 1);
}

if (args.includes('--get')) {
  const seq = args[args.indexOf('--get') + 1];
  const r = await api(`/messages/${seq}`);
  if (r.status === 404) { console.error(`seq=${seq} 不存在`); process.exit(1); }
  if (r.status !== 200) { console.error(`失败 HTTP ${r.status}: ${JSON.stringify(r.body)}`); process.exit(1); }
  console.log(JSON.stringify(r.body, null, 2));
  process.exit(0);
}

// --ack <seq> 显式推进；--ack 不带数字则落到下面的「拉取后按最大 seq 确认」
const ackIdx = args.indexOf('--ack');
if (ackIdx >= 0 && /^\d+$/.test(args[ackIdx + 1] ?? '')) {
  const seq = args[ackIdx + 1];
  const r = await api(`/ack?seq=${seq}`);
  // 服务端会把超过最大 seq 的请求钳住，打印实际游标，别让人以为推进到了请求值
  const c = r.body?.cursor;
  console.log(r.status === 200 ? `游标已推进到 ${c}${c < Number(seq) ? `（请求 ${seq}，已钳到当前最大 seq）` : ''}` : `失败 ${r.status}: ${JSON.stringify(r.body)}`);
  process.exit(r.status === 200 ? 0 : 1);
}

if (args.includes('--reply')) {
  const i = args.indexOf('--reply');
  const seq = args[i + 1];
  const text = args.slice(i + 2).join(' ');
  // 单条取该消息拿 response_url（比拉一段再过滤干净）
  const r0 = await api(`/messages/${seq}`);
  if (r0.status === 404) { console.error(`seq=${seq} 不存在`); process.exit(1); }
  // 401 / 502 等失败体不是消息，不能当成「没有 response_url」
  if (r0.status !== 200) {
    console.error(`取消息失败 HTTP ${r0.status}: ${(typeof r0.body === 'string' ? r0.body : JSON.stringify(r0.body)).slice(0, 300)}`);
    process.exit(1);
  }
  const msg = r0.body?.message || r0.body;
  const replyUrl = msg?.body?.response_url || msg?.response_url;
  // 网关不删存下的 URL；过期要等 POST 时企微返回 errcode 才知道，这里只可能是消息本身没带
  if (!replyUrl) {
    console.error(`seq=${seq} 没有 response_url`);
    process.exit(1);
  }
  const res = await fetch(replyUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ msgtype: 'markdown', markdown: { content: text } }),
  });
  const resText = await res.text();
  let resBody = null;
  try { resBody = JSON.parse(resText); } catch {}
  if (callOk(res.status, resBody)) {
    console.log(`已回复 seq=${seq}（errcode=0，企微已接收）`);
    process.exit(0);
  }
  console.error(`回复失败 HTTP ${res.status} errcode=${resBody?.errcode}: ${resText.slice(0, 300)}`);
  process.exit(1);
}

if (args.includes('--send')) {
  const i = args.indexOf('--send');
  const chatid = args[i + 1];
  const text = args.slice(i + 2).join(' ');
  const res = await fetch(BASE + '/send', {
    method: 'POST',
    headers: { ...H, 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatid, msgtype: 'markdown', markdown: { content: text } }),
  });
  const resText = await res.text();
  let resBody = null;
  try { resBody = JSON.parse(resText); } catch {}
  if (callOk(res.status, resBody)) {
    console.log(`已推送到 ${chatid}`);
    process.exit(0);
  }
  console.error(`推送失败 HTTP ${res.status}: ${resText.slice(0, 300)}`);
  process.exit(1);
}

// ---- 默认：拉取新消息 ----
// 默认从服务端游标（acked）起，不拉历史；--after 可覆盖
let after = null;
const ai = args.indexOf('--after');
if (ai >= 0) after = args[ai + 1];
if (after === null) {
  const h = await api('/health');
  after = h.body?.cursor ?? 0;
}
const r = await api(`/messages?after=${after}&limit=50&kind=message`);
if (r.status !== 200) {
  console.error(`拉取失败 HTTP ${r.status}: ${JSON.stringify(r.body)}`);
  process.exit(1);
}

const msgs = r.body.messages || [];
console.log(`服务端游标: ${r.body.cursor}，本次拉到 ${msgs.length} 条（after=${after}）`);

let maxSeq = Number(after);
for (const m of msgs) {
  const b = m.body || {};
  const isGroup = !!b.chatid;
  const who = b.from?.userid || '?';
  const content = b.text?.content || JSON.stringify(b.text || b.voice || b.image || {});
  // 企微消息体不带时间，用网关收到的时刻
  const when = m.received_at ? new Date(m.received_at).toLocaleString('zh-CN', { hour12: false }) : '';
  console.log(`\n[seq=${m.seq}] ${isGroup ? '群聊 ' + b.chatid : '单聊'} 来自 ${who} @ ${when}`);
  console.log(`  内容: ${content}`);
  if (b.response_url) console.log(`  response_url: 可回复（1小时内）`);
  maxSeq = Math.max(maxSeq, Number(m.seq));
}

if (msgs.length && args.includes('--ack')) {
  const r2 = await api(`/ack?seq=${maxSeq}`);
  console.log(`\n已 ack 到 seq=${maxSeq}: ${r2.status === 200 ? 'OK' : JSON.stringify(r2.body)}`);
} else if (msgs.length) {
  console.log(`\n（加 --ack 确认游标；最新 seq=${maxSeq}）`);
}
