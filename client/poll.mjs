/**
 * wecom-agent-relay · agent 侧客户端
 *
 * 对消息做处理的命令行工具：拉取 / 单条取 / 下载图片 / 回复 / 推送 / 推进游标。
 *
 * 用法：
 *   node client/poll.mjs                    # 拉取新消息（默认从服务端游标起，不拉历史）
 *   node client/poll.mjs --after <seq>      # 从指定 seq 之后拉取
 *   node client/poll.mjs --get <seq>        # 按 seq 取单条（404 = 不存在）
 *   node client/poll.mjs --health           # 连接状态
 *   node client/poll.mjs --download <seq> [目录]         # 下载该消息里的图片（默认存到脚本旁的 downloads/）
 *        刚收到（280 秒内）先直连企微下载并本机解密，不行再从网关取它收到时已下好的那份；
 *        文件名 <seq>-<n>.<ext>，每张图一行结果，有一张失败就退出 1
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
import crypto from 'node:crypto';
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

/* ---- 图片：找图、解密、认格式，与 server/src/media.mjs 保持一致（client 零依赖、单文件，所以复制一份） ---- */
function imagesOf(body) {
  if (!body || typeof body !== 'object') return [];
  if (body.msgtype === 'image') return [{ n: 1, url: body.image?.url, aeskey: body.image?.aeskey }];
  if (body.msgtype !== 'mixed' || !Array.isArray(body.mixed?.msg_item)) return [];
  const out = [];
  for (const it of body.mixed.msg_item) {
    if (it?.msgtype === 'image') out.push({ n: out.length + 1, url: it.image?.url, aeskey: it.image?.aeskey });
  }
  return out;
}
// AES-256-CBC，key = base64(aeskey + '=')，iv = key 前 16 字节；PKCS#7 但块长 32，内置去填充按 16 算所以关掉
function decryptMedia(buf, aeskey) {
  const key = Buffer.from(String(aeskey) + '=', 'base64');
  if (key.length !== 32) throw new Error('aeskey 长度不对');
  if (!buf.length || buf.length % 16) throw new Error('密文长度不是 16 的倍数');
  const d = crypto.createDecipheriv('aes-256-cbc', key, key.subarray(0, 16));
  d.setAutoPadding(false);
  const out = Buffer.concat([d.update(buf), d.final()]);
  const pad = out[out.length - 1];
  if (!(pad >= 1 && pad <= 32) || pad > out.length) throw new Error('解密失败：填充不合法');
  for (let i = out.length - pad; i < out.length; i++) if (out[i] !== pad) throw new Error('解密失败：填充不合法');
  return out.subarray(0, out.length - pad);
}
function detectExt(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length >= 4 && buf.subarray(0, 4).toString('latin1') === 'GIF8') return 'gif';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return 'bin';
}
const MAX_BYTES = 20 * 1024 * 1024;
// 读响应体并限大小；报错文字里不带 url（签名地址就是下载凭证）
async function readCapped(res) {
  const len = Number(res.headers.get('content-length'));
  if (len > MAX_BYTES) { res.body?.cancel().catch(() => {}); throw new Error(`文件 ${len} 字节，超过 20MB`); }
  const chunks = [];
  let total = 0;
  for await (const c of res.body) {
    total += c.length;
    if (total > MAX_BYTES) throw new Error('文件超过 20MB，已中止');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}
const fetchErr = (e) => (e?.name === 'TimeoutError' ? '超时（30 秒）' : e?.cause?.code ? `网络错误（${e.cause.code}）` : e?.message || '未知错误');

if (args.includes('--download')) {
  const i = args.indexOf('--download');
  const seq = args[i + 1];
  const dirArg = args[i + 2] && !args[i + 2].startsWith('--') ? args[i + 2] : path.join(__dirname, 'downloads');
  const dir = path.resolve(dirArg);
  const getMsg = async () => {
    const r = await api(`/messages/${seq}`);
    if (r.status === 404) { console.error(`seq=${seq} 不存在`); process.exit(1); }
    if (r.status !== 200) {
      console.error(`取消息失败 HTTP ${r.status}: ${(typeof r.body === 'string' ? r.body : JSON.stringify(r.body)).slice(0, 300)}`);
      process.exit(1);
    }
    return r.body?.message || {};
  };
  let msg = await getMsg();
  const imgs = imagesOf(msg.body);
  if (!imgs.length) { console.error(`seq=${seq} 没有图片`); process.exit(1); }
  fs.mkdirSync(dir, { recursive: true });
  // 企微 URL 300 秒失效，留 20 秒余量；过了就直接找网关
  const fresh = Date.now() - Date.parse(msg.received_at) < 280000;
  const save = (n, ext, buf, from) => {
    const f = path.join(dir, `${seq}-${n}.${ext}`);
    fs.writeFileSync(f, buf);
    console.log(`已保存 ${f}（${from}）`);
  };
  const mediaOf = (m, n) => (Array.isArray(m.media) ? m.media.find((x) => x.n === n) : undefined);
  let failed = 0;
  for (const img of imgs) {
    let direct = fresh ? '' : '已超过 280 秒，未直连';
    if (fresh) {
      try {
        if (!img.url || !img.aeskey) throw new Error('消息里没有 url 或 aeskey');
        const res = await fetch(img.url, { signal: AbortSignal.timeout(30000) });
        if (!res.ok) { res.body?.cancel().catch(() => {}); throw new Error(`HTTP ${res.status}`); }
        const plain = decryptMedia(await readCapped(res), img.aeskey);
        const ext = detectExt(plain);
        // 认不出格式多半是解错了（填充碰巧合法），按失败处理，交给网关那份
        if (ext === 'bin') throw new Error('解密结果不是可识别的图片');
        save(img.n, ext, plain, '企微直连');
        continue;
      } catch (e) {
        direct = `直连失败：${fetchErr(e)}`;
      }
    }
    // 兜底：网关收到消息时已经下过；还在下就每 2 秒再看一次，最多 30 秒
    let st = mediaOf(msg, img.n);
    const t0 = Date.now();
    while (st?.status === 'pending' && Date.now() - t0 < 30000) {
      await new Promise((r) => setTimeout(r, 2000));
      msg = await getMsg();
      st = mediaOf(msg, img.n);
    }
    let why;
    if (!st) why = '网关没有返回这张图的下载状态（网关版本过旧或未开启落盘）';
    else if (st.status === 'ok') {
      try {
        const res = await fetch(`${BASE}/files/${st.file}`, { headers: H, signal: AbortSignal.timeout(30000) });
        if (!res.ok) { res.body?.cancel().catch(() => {}); throw new Error(`HTTP ${res.status}`); }
        save(img.n, st.type || path.extname(st.file).slice(1), await readCapped(res), '网关兜底');
        continue;
      } catch (e) {
        why = `从网关取文件失败：${fetchErr(e)}`;
      }
    } else if (st.status === 'pending') why = '网关 30 秒内仍未下载完';
    else if (st.status === 'failed') why = `网关下载也失败了：${st.error || '未知原因'}`;
    else if (st.status === 'deleted') why = '网关上的文件已过保留期被清理';
    else if (st.status === 'missing') why = '网关没有这张图的下载记录（可能下载途中网关重启）';
    else why = `网关状态 ${st.status}`;
    failed++;
    console.error(`第 ${img.n} 张失败：${direct}；${why}`);
  }
  process.exit(failed ? 1 : 0);
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
  // 图片只报张数：url 是下载凭证、aeskey 能解开图片，不往终端打
  const imgN = imagesOf(b).length;
  const content = imgN ? `[图片 x${imgN}]（用 --download ${m.seq} 下载）` : b.text?.content || JSON.stringify(b.text || b.voice || {});
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
