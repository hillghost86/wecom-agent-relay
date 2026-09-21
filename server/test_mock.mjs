/**
 * 协议自测：起一个模拟企微网关，拉起 index.mjs，验证
 *   1. 订阅帧带正确 bot_id/secret，并处理 errcode=0 回包
 *   2. 心跳 ping 定期到达
 *   3. 推 aibot_msg_callback 后，5 秒内收到同 req_id 的 aibot_respond_msg（finish=true）
 *   4. 重复 msgid 仍回帧但不落盘
 *   5. 服务端断开后客户端自动重连并重新订阅
 *   6. 消息落盘到 JSONL
 *   7. HTTP API：/health、/messages、/ack 游标、鉴权、/send 透传
 *   8. client/：poll.mjs --ack 不带 seq、sentinel.mjs 以游标起步与 --exec 单参数
 */
import { WebSocketServer } from 'ws';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

const BOT_ID = 'aibTEST', SECRET = 'sec-TEST';
const tmpLog = path.join(os.tmpdir(), `wecom-msgs-${process.pid}.jsonl`);
let pass = 0, fail = 0;
const check = (ok, label, extra = '') => { console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${extra ? '  ' + extra : ''}`); ok ? pass++ : fail++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = (fn, ms = 5000) => new Promise((res, rej) => {
  const t0 = Date.now();
  const iv = setInterval(() => { if (fn()) { clearInterval(iv); res(); } else if (Date.now() - t0 > ms) { clearInterval(iv); rej(new Error('timeout')); } }, 20);
});

const httpPort = await new Promise((r) => { const srv = net.createServer(); srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => r(p)); }); });
const API_TOKEN = 'test-token';
const wss = new WebSocketServer({ port: 0 });
const port = wss.address().port;
const conns = [];           // 每次连接的记录 { ws, frames[] }
wss.on('connection', (ws) => {
  const rec = { ws, frames: [] };
  conns.push(rec);
  ws.on('message', (raw) => {
    const f = JSON.parse(raw.toString());
    rec.frames.push(f);
    if (f.cmd === 'aibot_subscribe') {
      const ok = f.body?.bot_id === BOT_ID && f.body?.secret === SECRET;
      ws.send(JSON.stringify({ headers: { req_id: f.headers.req_id }, errcode: ok ? 0 : 40001, errmsg: ok ? 'ok' : 'invalid secret' }));
    } else if (f.cmd === 'ping') {
      ws.send(JSON.stringify({ headers: { req_id: f.headers.req_id }, errcode: 0, errmsg: 'ok' }));
    } else if (f.cmd === 'aibot_send_msg' && f.body?.chatid === 'NOACK') {
      ws.close(1001, 'noack'); // 让 pending 被拒绝，模拟发出后连接断开
    } else if (f.cmd === 'aibot_send_msg' && f.body?.msgtype === 'text') {
      ws.send(JSON.stringify({ headers: { req_id: f.headers.req_id }, errcode: 40008, errmsg: 'invalid msgtype' }));
    } else if (f.cmd === 'aibot_respond_msg' || f.cmd === 'aibot_send_msg') {
      ws.send(JSON.stringify({ headers: { req_id: f.headers.req_id }, errcode: 0, errmsg: 'ok' }));
    }
  });
});

fs.writeFileSync(tmpLog + '.alive', String(Date.now() - 120000)); // 伪造上次在线时刻：120s 前
const child = spawn(process.execPath, ['index.mjs'], {
  cwd: new URL('.', import.meta.url).pathname,
  env: { ...process.env, WECOM_BOT_ID: BOT_ID, WECOM_BOT_SECRET: SECRET, WECOM_WS_URL: `ws://127.0.0.1:${port}`, MSG_LOG: tmpLog, PING_INTERVAL_MS: '300', REPLY_TEXT: '已收到', HTTP_HOST: '127.0.0.1', HTTP_PORT: String(httpPort), API_TOKEN, ADMIN_USERID: 'admin1', OUTAGE_MIN_SECS: '0', OUTAGE_REPORT_MIN_MS: '0' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let childOut = '';
child.stdout.on('data', (d) => { childOut += d; });
child.stderr.on('data', (d) => { childOut += d; });

try {
  // 1. 订阅
  await waitFor(() => conns[0]?.frames.some((f) => f.cmd === 'aibot_subscribe'));
  const sub = conns[0].frames.find((f) => f.cmd === 'aibot_subscribe');
  check(sub.body.bot_id === BOT_ID && sub.body.secret === SECRET && typeof sub.headers.req_id === 'string', '订阅帧 bot_id/secret/req_id 正确');

  // 1b. 启动后的断线自报（进程重启空窗 ≈120s）
  await waitFor(() => conns[0].frames.some((f) => f.cmd === 'aibot_send_msg'));
  const rep1 = conns[0].frames.find((f) => f.cmd === 'aibot_send_msg');
  check(rep1.body.chatid === 'admin1' && rep1.body.chat_type === 1 && rep1.body.msgtype === 'markdown' && /离线 \*\*1[12]\d 秒\*\*（进程重启）/.test(rep1.body.markdown.content),
    '启动后按 .alive 文件自报「进程重启」空窗', rep1.body.markdown.content.split('\n')[0]);

  // 2. 心跳
  await waitFor(() => conns[0].frames.filter((f) => f.cmd === 'ping').length >= 2, 3000);
  check(true, '心跳 ping 定期到达', `${conns[0].frames.filter((f) => f.cmd === 'ping').length} 次`);

  // 3. 推消息，期待回复
  const reqId = 'REQ-MSG-1';
  const msg = { cmd: 'aibot_msg_callback', headers: { req_id: reqId }, body: { msgid: 'MSG1', aibotid: BOT_ID, chatid: 'CHAT1', chattype: 'group', from: { userid: 'u1' }, msgtype: 'text', response_url: 'https://qyapi.weixin.qq.com/cgi-bin/aibot/response?response_code=RC1', text: { content: '@机器人 记一笔 5台盒子' } } };
  const before = Date.now();
  conns[0].ws.send(JSON.stringify(msg));
  await waitFor(() => conns[0].frames.some((f) => f.cmd === 'aibot_respond_msg'));
  const resp = conns[0].frames.find((f) => f.cmd === 'aibot_respond_msg');
  const dt = Date.now() - before;
  check(resp.headers.req_id === reqId && resp.body.msgtype === 'stream' && resp.body.stream.finish === true && resp.body.stream.content === '已收到' && dt < 5000,
    '收到消息后用同 req_id 回 stream(finish=true)', `${dt}ms`);

  // 4. 重复 msgid
  conns[0].ws.send(JSON.stringify({ ...msg, headers: { req_id: 'REQ-MSG-1-DUP' } }));
  await sleep(300);
  const dupResp = conns[0].frames.find((f) => f.cmd === 'aibot_respond_msg' && f.headers.req_id === 'REQ-MSG-1-DUP');
  check(!!dupResp && dupResp.body.stream.finish === true, '重复 msgid 仍用新 req_id 回帧（企微重推需要回应）');

  // 5. 服务端断开 → 重连 + 重新订阅
  conns[0].ws.close(1001, 'kicked');
  await waitFor(() => conns.length >= 2 && conns[1].frames.some((f) => f.cmd === 'aibot_subscribe'), 8000);
  check(true, '断开后自动重连并重新订阅');
  await waitFor(() => conns[1].frames.some((f) => f.cmd === 'aibot_send_msg' && /连接中断/.test(f.body?.markdown?.content || '')));
  check(true, '重连后自报「连接中断」', conns[1].frames.find((f) => f.cmd === 'aibot_send_msg').body.markdown.content.split('\n')[0]);
  // 新连接上再推一条，确认可用
  conns[1].ws.send(JSON.stringify({ cmd: 'aibot_msg_callback', headers: { req_id: 'REQ-MSG-2' }, body: { msgid: 'MSG2', chattype: 'single', from: { userid: 'u2' }, msgtype: 'text', text: { content: 'hi' } } }));
  await waitFor(() => conns[1].frames.some((f) => f.cmd === 'aibot_respond_msg' && f.headers.req_id === 'REQ-MSG-2'));
  check(true, '重连后的连接可正常收发');

  // 6. 落盘
  const lines = fs.readFileSync(tmpLog, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
  check(lines.length === 2 && lines[0].body.msgid === 'MSG1' && lines[1].body.msgid === 'MSG2' && lines[0].seq === 1 && lines[1].seq === 2, '消息落盘 JSONL（带 seq，重复消息未落盘）', `${lines.length} 条`);
  check(!childOut.includes('https://qyapi.weixin.qq.com/cgi-bin/aibot/response') && lines[0].body.response_url.includes('response_code=RC1'),
    '日志里 response_url 只留尾部，落盘保留完整');

  // 7. HTTP API
  const base = `http://127.0.0.1:${httpPort}`;
  const H = { authorization: `Bearer ${API_TOKEN}` };
  const j = async (p, opt = {}) => { const r = await fetch(base + p, { ...opt, headers: { ...H, ...(opt.headers || {}) } }); return { status: r.status, body: await r.json() }; };

  const noauth = await fetch(base + '/health');
  check(noauth.status === 401, 'HTTP 无 token 被拒 401');
  const viaQuery = await fetch(base + `/health?token=${API_TOKEN}`);
  check(viaQuery.status === 200, 'HTTP ?token= 鉴权可用');

  const h = await j('/health');
  check(h.status === 200 && h.body.subscribed === true && h.body.connected === true && h.body.seq === 2 && h.body.cursor === 0, 'GET /health', JSON.stringify(h.body));

  const m1 = await j('/messages');
  check(m1.body.messages.length === 2 && m1.body.messages[0].seq === 1 && m1.body.messages[0].body.text.content.includes('5台盒子') && m1.body.messages[0].body.response_url?.includes('RC1') && m1.body.next === 2,
    'GET /messages 默认从游标 0 起返回全部（含 response_url）');

  const one = await j('/messages/2');
  check(one.status === 200 && one.body.message.seq === 2 && one.body.message.body.msgid === 'MSG2', 'GET /messages/<seq> 按 seq 取单条');
  const none = await j('/messages/99');
  check(none.status === 404 && none.body.ok === false, 'GET /messages/<seq> 不存在返回 404');
  const m2 = await j('/messages?after=1&limit=10');
  check(m2.body.messages.length === 1 && m2.body.messages[0].seq === 2, 'GET /messages?after=1 只返回 seq>1');

  const a = await j('/ack?seq=1');
  check(a.body.cursor === 1, 'GET /ack?seq=1 推进游标');
  const m3 = await j('/messages');
  check(m3.body.after === 1 && m3.body.messages.length === 1 && m3.body.messages[0].seq === 2, '/ack 后 /messages 默认从游标起');
  const stateFile = JSON.parse(fs.readFileSync(tmpLog + '.state.json', 'utf-8'));
  check(stateFile.cursor === 1, '游标持久化到 .state.json');
  const badAfter = await j('/messages?after=abc');
  const badLimit = await j('/messages?limit=all');
  check(badAfter.status === 400 && badLimit.status === 400, 'GET /messages 的 after/limit 非数字返回 400');
  const clamp = await j('/ack?seq=999999');
  check(clamp.body.cursor === 2, 'GET /ack 超过最大 seq 时钳到当前 seq', `cursor=${clamp.body.cursor}`);

  const sendBody = { chatid: 'CHAT1', chat_type: 1, msgtype: 'markdown', markdown: { content: '**主动推送**' } };
  const sd = await j('/send', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(sendBody) });
  const sentFrame = conns[1].frames.find((f) => f.cmd === 'aibot_send_msg' && f.body?.chatid === 'CHAT1');
  check(sd.status === 200 && sd.body.ok === true && sentFrame && sentFrame.body.chatid === 'CHAT1' && sentFrame.body.markdown.content === '**主动推送**' && typeof sentFrame.headers.req_id === 'string',
    'POST /send 透传为 aibot_send_msg 并返回回执');
  const bad = await j('/send', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chatid: 'u1', chat_type: 1, msgtype: 'text', text: { content: 'x' } }) });
  check(bad.status === 200 && bad.body.ok === false && bad.body.resp.errcode === 40008, 'POST /send 被企微拒绝时返回 200 + ok:false 并带回 errcode（不返回 5xx）', JSON.stringify(bad.body.resp));

  // 8. client/ 脚本：复制到临时目录跑，避免在仓库里生成 sentinel_cursor.json
  const { execFileSync } = await import('node:child_process');
  const cdir = fs.mkdtempSync(path.join(os.tmpdir(), 'wecom-client-'));
  for (const f of ['poll.mjs', 'sentinel.mjs']) fs.copyFileSync(new URL(`../client/${f}`, import.meta.url), path.join(cdir, f));
  const runClient = (script, ...a) => {
    try { return execFileSync(process.execPath, [path.join(cdir, script), ...a], { env: { ...process.env, WECOM_API_BASE: base, WECOM_API_TOKEN: API_TOKEN }, encoding: 'utf-8', timeout: 10000 }); }
    catch (e) { return (e.stdout || '') + (e.stderr || '') + `\n[exit ${e.status}]`; }
  };
  // 服务端此时 cursor=2、seq=2；再推一条形成积压（seq=3 > cursor）
  conns[1].ws.send(JSON.stringify({ cmd: 'aibot_msg_callback', headers: { req_id: 'REQ-MSG-3' }, body: { msgid: 'MSG3', chattype: 'single', from: { userid: 'u3' }, msgtype: 'text', text: { content: 'backlog' } } }));
  await waitFor(() => conns[1].frames.some((f) => f.cmd === 'aibot_respond_msg' && f.headers.req_id === 'REQ-MSG-3'));
  const s1 = runClient('sentinel.mjs', '--once');
  check(/NEW_MSG count=1 seq=3-3/.test(s1), 'sentinel 首次运行以游标起步，积压立刻触发 NEW_MSG', s1.trim().split('\n').pop());
  const p1 = runClient('poll.mjs', '--ack');
  const h2 = await j('/health');
  check(/已 ack 到 seq=3/.test(p1) && h2.body.cursor === 3, 'poll.mjs --ack 不带 seq：拉取后按最大 seq 确认', `cursor=${h2.body.cursor}`);
  conns[1].ws.send(JSON.stringify({ cmd: 'aibot_msg_callback', headers: { req_id: 'REQ-MSG-4' }, body: { msgid: 'MSG4', chattype: 'single', from: { userid: 'u4' }, msgtype: 'text', text: { content: 'exec' } } }));
  await waitFor(() => conns[1].frames.some((f) => f.cmd === 'aibot_respond_msg' && f.headers.req_id === 'REQ-MSG-4'));
  const s2 = runClient('sentinel.mjs', '--once', '--exec', 'echo EXEC_RAN', '--interval', '5');
  check(/^EXEC_RAN$/m.test(s2) && !/EXEC_RAN 5/.test(s2) && /NEW_MSG count=1 seq=4-4/.test(s2), 'sentinel --exec 只取紧跟的一个参数，后续 --interval 不混入命令');
  fs.rmSync(cdir, { recursive: true, force: true });

  // /send 发出后连接断开：预期失败也返回 200 + ok:false + error（放最后，因为会触发重连）
  const noack = await j('/send', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chatid: 'NOACK', msgtype: 'markdown', markdown: { content: 'x' } }) });
  check(noack.status === 200 && noack.body.ok === false && /connection closed/.test(noack.body.error || ''), 'POST /send 未拿到回执（连接断开）时返回 200 + ok:false + error，不返回 5xx', JSON.stringify(noack.body));
} catch (e) {
  check(false, '异常: ' + e.message);
  console.log('--- 客户端输出 ---\n' + childOut);
} finally {
  child.kill('SIGTERM');
  wss.close();
  try { fs.unlinkSync(tmpLog); } catch {}
  try { fs.unlinkSync(tmpLog + '.state.json'); } catch {}
  try { fs.unlinkSync(tmpLog + '.alive'); } catch {}
}
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail) console.log('--- 客户端输出 ---\n' + childOut);
process.exit(fail ? 1 : 0);
