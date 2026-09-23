/**
 * 协议自测：起一个模拟企微网关，拉起 index.mjs，验证
 *   1. 订阅帧带正确 bot_id/secret，并处理 errcode=0 回包
 *   2. 心跳 ping 定期到达
 *   3. 推 aibot_msg_callback 后，5 秒内收到同 req_id 的 aibot_respond_msg（finish=true）
 *   4. 重复 msgid 仍回帧但不落盘
 *   5. 服务端断开后客户端自动重连并重新订阅
 *   6. 消息落盘到 JSONL
 *   7. HTTP API：/health、/messages、/ack 游标、鉴权、/send 透传
 *   8. client/：poll.mjs --ack 不带 seq、sentinel.mjs 以游标起步与 --exec 单参数、只有事件时不唤醒、pending 不计事件
 *   9. presence：X-Relay-Agent 记在线、/health 带出状态、离线时自动回复分档、管理员离线告警
 *  10. 配置：config.json 校验失败退出、没有 config.json 时从环境变量兼容加载、msg_log=off 启动警告
 *  12. 多 bot：另起一个两 bot 的服务端进程，验证各自连接与落盘、/bots/<key>/ 前缀路由、两级 token（401/403/404）、
 *      GET /bots 总览、presence 按 bot 分开、client 零改动接 /bots/<key>、多 bot 配置校验、日志 [key] 前缀、
 *      不写 msg_log 时默认落到工作目录下 bots/<key>/messages.jsonl（目录启动时自动建）、msg_log 为空串等同于没写
 */
import { WebSocketServer } from 'ws';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

const BOT_ID = 'aibTEST', SECRET = 'sec-TEST';
const BOT2_ID = 'aibTEST2', SECRET2 = 'sec-TEST2';   // 第 12 节多 bot 的第二个机器人
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
const conns = [];           // 每次连接的记录 { ws, frames[], path, botId }
// path 区分是哪个服务端进程连来的（多 bot 进程用 /multi），botId 记订阅成功的是哪个机器人
wss.on('connection', (ws, req) => {
  const rec = { ws, frames: [], path: req.url, botId: null };
  conns.push(rec);
  ws.on('message', (raw) => {
    const f = JSON.parse(raw.toString());
    rec.frames.push(f);
    if (f.cmd === 'aibot_subscribe') {
      const ok = (f.body?.bot_id === BOT_ID && f.body?.secret === SECRET) || (f.body?.bot_id === BOT2_ID && f.body?.secret === SECRET2);
      if (ok) rec.botId = f.body.bot_id;
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
const serverDir = new URL('.', import.meta.url).pathname;
const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wecom-cfg-'));
const cfgFile = path.join(cfgDir, 'config.json');
fs.writeFileSync(cfgFile, JSON.stringify({
  http: { host: '127.0.0.1', port: httpPort, api_token: API_TOKEN },
  ws_url: `ws://127.0.0.1:${port}`,
  ping_interval_ms: 300,
  outage_min_secs: 0,
  outage_report_min_ms: 0,
  agent_online_secs: 1,          // 1 秒没露面就算处理端离线，便于测分档回复
  bots: [{ bot_id: BOT_ID, secret: SECRET, reply_text: '已收到', admin_userid: 'admin1', msg_log: tmpLog, offline_alert_mins: 0.01 }],
}, null, 2));
const child = spawn(process.execPath, ['index.mjs', '--config', cfgFile], {
  cwd: serverDir,
  env: { ...process.env },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let childOut = '';
child.stdout.on('data', (d) => { childOut += d; });
child.stderr.on('data', (d) => { childOut += d; });
let multiChild = null, multiDir = null, multiOut = '';   // 第 12 节，finally 里清理

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
    '收到消息后用同 req_id 回 stream(finish=true)（此时还没有 agent 露过面，在线状态未知按在线处理）', `${dt}ms`);

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
  // 带 X-Relay-Agent：模拟 agent 来访，服务端据此记在线状态
  const j = async (p, opt = {}) => { const r = await fetch(base + p, { ...opt, headers: { ...H, 'x-relay-agent': 'test-agent', ...(opt.headers || {}) } }); return { status: r.status, body: await r.json() }; };

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
    try { return execFileSync(process.execPath, [path.join(cdir, script), ...a], { env: { ...process.env, WECOM_API_BASE: base, WECOM_API_TOKEN: API_TOKEN, WECOM_AGENT_ID: 'test-agent' }, encoding: 'utf-8', timeout: 10000 }); }
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
  // 事件（enter_chat）也占 seq，但不该唤醒 agent、不算积压；先 ack 掉 seq=4，让积压只剩这条事件
  await j('/ack?seq=4');
  conns[1].ws.send(JSON.stringify({ cmd: 'aibot_event_callback', headers: { req_id: 'REQ-EV-1' }, body: { msgid: 'ev1', chattype: 'single', from: { userid: 'u1' }, msgtype: 'event', create_time: 1, event: { eventtype: 'enter_chat' } } }));
  await waitFor(() => fs.readFileSync(tmpLog, 'utf-8').includes('"ev1"'));
  const s3 = runClient('sentinel.mjs', '--once');
  const sc3 = JSON.parse(fs.readFileSync(path.join(cdir, 'sentinel_cursor.json'), 'utf-8'));
  check(/NO_MSG/.test(s3) && !/NEW_MSG/.test(s3) && sc3.last_seen === 5, 'sentinel 新 seq 只有事件时不唤醒（NO_MSG），last_seen 推进到事件 seq', `${s3.trim().split('\n').pop()} last_seen=${sc3.last_seen}`);
  const h4 = await j('/health');
  check(h4.body.pending === 0 && h4.body.seq - h4.body.cursor === 1, '/health 的 pending 不计事件', `pending=${h4.body.pending} seq=${h4.body.seq} cursor=${h4.body.cursor}`);
  conns[1].ws.send(JSON.stringify({ cmd: 'aibot_msg_callback', headers: { req_id: 'REQ-MSG-C' }, body: { msgid: 'MSG-C', chattype: 'single', from: { userid: 'u1' }, msgtype: 'text', text: { content: 'after event' } } }));
  await waitFor(() => conns[1].frames.some((f) => f.cmd === 'aibot_respond_msg' && f.headers.req_id === 'REQ-MSG-C'));
  const s4 = runClient('sentinel.mjs', '--once');
  check(/NEW_MSG count=1 seq=6-6 /.test(s4), '事件之后来真消息：NEW_MSG 只数真消息，seq 区间不含事件', s4.trim().split('\n').find((l) => l.startsWith('NEW_MSG')));
  fs.rmSync(cdir, { recursive: true, force: true });

  // 9. presence：处理端在线状态 + 分档自动回复 + 管理员离线告警（配置 agent_online_secs=1）
  const cur = () => conns[conns.length - 1];
  const push = async (n, content) => {
    cur().ws.send(JSON.stringify({ cmd: 'aibot_msg_callback', headers: { req_id: `REQ-MSG-${n}` }, body: { msgid: `MSG${n}`, chattype: 'single', from: { userid: `u${n}` }, msgtype: 'text', text: { content } } }));
    await waitFor(() => cur().frames.some((f) => f.cmd === 'aibot_respond_msg' && f.headers.req_id === `REQ-MSG-${n}`));
    return cur().frames.find((f) => f.cmd === 'aibot_respond_msg' && f.headers.req_id === `REQ-MSG-${n}`).body.stream.content;
  };
  const h3 = await j('/health');
  // 此时游标 4 之后是 seq5 事件 + seq6 真消息：pending 只数真消息
  const unacked = (await j('/messages?kind=message')).body.messages.length;
  check(h3.body.bot === 'default' && h3.body.last_agent === 'test-agent' && h3.body.agent_online === true && unacked === 1 && h3.body.pending === unacked,
    '/health 带出 bot / agent_online / last_agent / pending',
    JSON.stringify({ bot: h3.body.bot, agent_online: h3.body.agent_online, last_agent: h3.body.last_agent, pending: h3.body.pending, seq: h3.body.seq, cursor: h3.body.cursor }));
  const st2 = JSON.parse(fs.readFileSync(tmpLog + '.state.json', 'utf-8'));
  check(typeof st2.agent_last_seen === 'number' && st2.agent_last_seen > 0 && st2.last_agent === 'test-agent', 'presence 和游标一起持久化到 .state.json', JSON.stringify(st2));

  await sleep(1300); // 超过 agent_online_secs 没有带头的请求 → 判定处理端离线
  const offText = await push(5, 'offline?');
  check(/处理端已离线/.test(offText) && /秒/.test(offText), '处理端离线时回帧换成离线文案（{duration} 已替换）', offText);
  await j('/health'); // 处理端回来了
  const onText = await push(6, 'online?');
  check(onText === '已收到', '处理端重新露面后回帧恢复「已收到」', onText);

  // 离线告警：offline_alert_mins=0.01（0.6 秒）；上面这次 /health 会让告警状态先归位
  await sleep(200);
  const mark = cur().frames.length;
  const alertOf = (re) => cur().frames.slice(mark).find((f) => f.cmd === 'aibot_send_msg' && f.body?.chatid === 'admin1' && re.test(f.body?.markdown?.content || ''));
  let alerted = true;
  try { await waitFor(() => !!alertOf(/处理端已离线/), 8000); } catch { alerted = false; }
  const alertMsg = alertOf(/处理端已离线/);
  check(alerted && /积压/.test(alertMsg?.body.markdown.content || ''), '处理端离线且有积压时给管理员发告警', alertMsg?.body.markdown.content);
  const mark2 = cur().frames.length;
  await j('/health');
  let recovered = true;
  try { await waitFor(() => cur().frames.slice(mark2).some((f) => f.cmd === 'aibot_send_msg' && f.body?.chatid === 'admin1' && /已恢复/.test(f.body?.markdown?.content || '')), 5000); } catch { recovered = false; }
  check(recovered, '处理端恢复后给管理员发恢复通知',
    cur().frames.slice(mark2).find((f) => f.cmd === 'aibot_send_msg' && /已恢复/.test(f.body?.markdown?.content || ''))?.body.markdown.content);

  // /send 发出后连接断开：预期失败也返回 200 + ok:false + error（放最后，因为会触发重连）
  const noack = await j('/send', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chatid: 'NOACK', msgtype: 'markdown', markdown: { content: 'x' } }) });
  check(noack.status === 200 && noack.body.ok === false && /connection closed/.test(noack.body.error || ''), 'POST /send 未拿到回执（连接断开）时返回 200 + ok:false + error，不返回 5xx', JSON.stringify(noack.body));

  // 10. 配置校验失败直接退出
  const { spawnSync } = await import('node:child_process');
  const badCfg = path.join(cfgDir, 'bad-config.json');
  fs.writeFileSync(badCfg, JSON.stringify({ http: { port: 0 }, bots: [] }));
  const badRun = spawnSync(process.execPath, ['index.mjs', '--config', badCfg], { cwd: serverDir, encoding: 'utf-8', timeout: 5000 });
  check(badRun.status !== 0 && /bots/.test(badRun.stderr || ''), '配置非法（bots 为空）时非 0 退出并打印原因', `exit=${badRun.status} ${(badRun.stderr || '').trim().split('\n')[0]}`);

  // 11. 兼容期：没有 config.json 时从环境变量加载（ws_url 也走环境变量，否则只能连真实网关）
  const envDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wecom-env-'));
  const connsBefore = conns.length;
  const envChild = spawn(process.execPath, [path.join(serverDir, 'index.mjs')], {
    cwd: envDir,
    env: { ...process.env, WECOM_BOT_ID: BOT_ID, WECOM_BOT_SECRET: SECRET, WECOM_WS_URL: `ws://127.0.0.1:${port}`, HTTP_PORT: '0', MSG_LOG: 'off' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let envOut = '';
  envChild.stdout.on('data', (d) => { envOut += d; });
  envChild.stderr.on('data', (d) => { envOut += d; });
  let envOk = true;
  try { await waitFor(() => conns.length > connsBefore && conns[connsBefore].frames.some((f) => f.cmd === 'aibot_subscribe'), 8000); } catch { envOk = false; }
  check(envOk && /环境变量方式将在下个版本移除/.test(envOut), '无 config.json 时从环境变量兼容加载并给出迁移警告', envOut.split('\n').find((l) => /环境变量/.test(l)) || envOut.slice(0, 200));
  check(/msg_log=off：消息只放内存，重启即丢，不要在生产使用/.test(envOut), 'msg_log=off（MSG_LOG=off）时启动打印只放内存的警告', envOut.split('\n').find((l) => /msg_log=off/.test(l)) || '无警告');
  envChild.kill('SIGTERM');
  fs.rmSync(envDir, { recursive: true, force: true });

  // 12. 多 bot：另起一个进程，两个 bot（default 用 BOT_ID，test 用 BOT2_ID），test 有自己的 token，顶层是管理员 token
  // realpath：macOS 的 tmpdir 是软链，子进程 process.cwd() 返回的是真实路径，不统一的话 msg_log 重名校验对不上
  multiDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wecom-multi-')));
  const mPort = await new Promise((r) => { const srv = net.createServer(); srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => r(p)); }); });
  const ADMIN_TOKEN = 'multi-admin-token', TEST_TOKEN = 'multi-test-token';
  // default 写空串、test 不写，都应走默认路径（空串曾被当成 off，静默不存盘）
  const mLogDefault = path.join(multiDir, 'bots', 'default', 'messages.jsonl'), mLogTest = path.join(multiDir, 'bots', 'test', 'messages.jsonl');
  const mBots = [
    { key: 'default', bot_id: BOT_ID, secret: SECRET, msg_log: '' },
    { key: 'test', bot_id: BOT2_ID, secret: SECRET2, api_token: TEST_TOKEN },
  ];
  const mCfg = (over = {}) => ({ http: { host: '127.0.0.1', port: mPort, api_token: ADMIN_TOKEN }, ws_url: `ws://127.0.0.1:${port}/multi`, bots: mBots, ...over });
  const mCfgFile = path.join(multiDir, 'config.json');
  fs.writeFileSync(mCfgFile, JSON.stringify(mCfg(), null, 2));
  multiChild = spawn(process.execPath, [path.join(serverDir, 'index.mjs'), '--config', mCfgFile], { cwd: multiDir, stdio: ['ignore', 'pipe', 'pipe'] });
  multiChild.stdout.on('data', (d) => { multiOut += d; });
  multiChild.stderr.on('data', (d) => { multiOut += d; });
  const mConn = (id) => conns.find((c) => c.path === '/multi' && c.botId === id);
  await waitFor(() => mConn(BOT_ID) && mConn(BOT2_ID), 8000);
  check(conns.filter((c) => c.path === '/multi' && c.botId).length === 2, '多 bot：两个 bot 各自一条连接，订阅帧的 bot_id 各自正确');
  // 还没收到任何消息：bots/<key>/ 目录得在启动时就建好，否则订阅成功时写 .alive 会静默失败
  await waitFor(() => fs.existsSync(mLogDefault + '.alive') && fs.existsSync(mLogTest + '.alive'), 3000).catch(() => {});
  check(fs.existsSync(mLogDefault + '.alive') && fs.existsSync(mLogTest + '.alive') && !fs.existsSync(mLogDefault) && !/写游标失败|写消息日志失败/.test(multiOut),
    '默认路径：收消息前 bots/<key>/ 下已写出两个 bot 的 .alive，无写文件报错', fs.existsSync(path.join(multiDir, 'bots')) ? fs.readdirSync(path.join(multiDir, 'bots')).join(',') : 'bots/ 不存在');

  const mBase = `http://127.0.0.1:${mPort}`;
  const mj = async (p, token, headers = {}) => { const r = await fetch(mBase + p, { headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } }); return { status: r.status, body: await r.json() }; };
  const mPush = async (id, msgid) => {
    mConn(id).ws.send(JSON.stringify({ cmd: 'aibot_msg_callback', headers: { req_id: `REQ-${msgid}` }, body: { msgid, chattype: 'single', from: { userid: 'u1' }, msgtype: 'text', text: { content: msgid } } }));
    await waitFor(() => mConn(id).frames.some((f) => f.cmd === 'aibot_respond_msg' && f.headers.req_id === `REQ-${msgid}`));
  };

  await mPush(BOT2_ID, 'MSG-T1');
  const readLog = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf-8') : '');
  check(readLog(mLogTest).includes('MSG-T1') && !readLog(mLogDefault).includes('MSG-T1'), '多 bot：推给 test 的消息只落 test 的 msg_log');
  const mt = await mj('/bots/test/messages', ADMIN_TOKEN), md = await mj('/bots/default/messages', ADMIN_TOKEN);
  check(mt.body.messages?.length === 1 && mt.body.messages[0].body.msgid === 'MSG-T1' && md.body.messages?.length === 0, '多 bot：/bots/test/messages 拿得到，/bots/default/messages 拿不到',
    `test=${mt.body.messages?.length} default=${md.body.messages?.length}`);

  const tOwn = await mj('/bots/test/health', TEST_TOKEN);
  check(tOwn.status === 200 && tOwn.body.bot === 'test', 'bot token 访问自己的 /bots/test/health 200');
  const tOther = await mj('/bots/default/health', TEST_TOKEN), tAll = await mj('/bots', TEST_TOKEN), tBare = await mj('/health', TEST_TOKEN);
  check([tOther, tAll, tBare].every((x) => x.status === 403 && x.body.error === 'forbidden'), 'bot token 访问别的 bot / GET /bots / 无前缀 /health（指向 default）都是 403',
    `${tOther.status} ${tAll.status} ${tBare.status}`);

  const aAll = await mj('/bots', ADMIN_TOKEN);
  check(aAll.status === 200 && aAll.body.bots?.length === 2 && aAll.body.bots[0].bot === 'default' && aAll.body.bots[1].bot === 'test' && aAll.body.bots[1].subscribed === true,
    '管理员 GET /bots 返回两个 bot 的 /health', JSON.stringify(aAll.body.bots?.map((b) => ({ bot: b.bot, seq: b.seq, subscribed: b.subscribed }))));
  const aBare = await mj('/health', ADMIN_TOKEN);
  check(aBare.status === 200 && aBare.body.bot === 'default', '管理员访问无前缀 /health 指向第一个 bot（default）');

  const wrong = await mj('/bots/test/health', 'wrong-token');
  check(wrong.status === 401, '错误 token 401');
  const nope = await mj('/bots/nope/health', ADMIN_TOKEN);
  check(nope.status === 404 && nope.body.error === 'unknown bot', '管理员访问不存在的 bot 返回 404 unknown bot');
  const nopeAnon = await mj('/bots/nope/health');
  check(nopeAnon.status === 401, '无 token 访问不存在的 bot 是 401 而不是 404（不暴露 key 是否存在）', `status=${nopeAnon.status}`);

  await mj('/bots/test/health', TEST_TOKEN, { 'x-relay-agent': 't-agent' });
  const pAll = (await mj('/bots', ADMIN_TOKEN)).body.bots;
  check(pAll[1].last_agent === 't-agent' && pAll[1].agent_online === true && pAll[0].last_agent === null && pAll[0].agent_online === null,
    'X-Relay-Agent 只记到请求路径指向的 bot', JSON.stringify(pAll.map((b) => ({ bot: b.bot, last_agent: b.last_agent, agent_online: b.agent_online }))));

  // client 零改动：api_base 带 /bots/test，拿 test 的消息、推进 test 的游标；default 那边有一条消息，游标不该动
  await mPush(BOT2_ID, 'MSG-T2');
  await mPush(BOT_ID, 'MSG-D1');
  const rootLeft = fs.readdirSync(multiDir).filter((f) => /^messages.*\.jsonl/.test(f));
  const msgDirLeft = fs.existsSync(path.join(multiDir, 'messages')) ? fs.readdirSync(path.join(multiDir, 'messages')) : [];
  check(readLog(mLogDefault).includes('MSG-D1') && readLog(mLogTest).includes('MSG-T2') && rootLeft.length === 0 && msgDirLeft.length === 0,
    '默认路径：不写 msg_log 时落到 bots/default/messages.jsonl 和 bots/test/messages.jsonl，根目录和 messages/ 下都没有消息文件', [...rootLeft, ...msgDirLeft].join(',') || '根目录与 messages/ 干净');
  check(readLog(mLogDefault).includes('MSG-D1') && !/msg_log=off/.test(multiOut), 'msg_log 为空串时按没写处理：落到 bots/default/messages.jsonl，不当成 off');
  const mcdir = fs.mkdtempSync(path.join(multiDir, 'client-'));
  for (const f of ['poll.mjs', 'sentinel.mjs']) fs.copyFileSync(new URL(`../client/${f}`, import.meta.url), path.join(mcdir, f));
  const mRun = (script, ...a) => {
    try { return execFileSync(process.execPath, [path.join(mcdir, script), ...a], { env: { ...process.env, WECOM_API_BASE: `${mBase}/bots/test`, WECOM_API_TOKEN: TEST_TOKEN, WECOM_AGENT_ID: 't-agent' }, encoding: 'utf-8', timeout: 10000 }); }
    catch (e) { return (e.stdout || '') + (e.stderr || '') + `\n[exit ${e.status}]`; }
  };
  const ms1 = mRun('sentinel.mjs', '--once');
  check(/NEW_MSG count=2 seq=1-2/.test(ms1), 'client 零改动：sentinel 用 api_base=…/bots/test 拿到 test 的消息', ms1.trim().split('\n').pop());
  const mp1 = mRun('poll.mjs', '--ack');
  const cAll = (await mj('/bots', ADMIN_TOKEN)).body.bots;
  check(/已 ack 到 seq=2/.test(mp1) && cAll[1].cursor === 2 && cAll[0].cursor === 0 && cAll[0].seq === 1, 'client 零改动：poll.mjs --ack 只推进 test 的游标，default 游标不变',
    `test cursor=${cAll[1].cursor} default cursor=${cAll[0].cursor} seq=${cAll[0].seq}`);

  // 多 bot 配置校验：都在加载配置时退出，不会连网关
  const badCases = [
    ['bot token 与顶层 token 相同', mCfg({ bots: [mBots[0], { ...mBots[1], api_token: ADMIN_TOKEN }] }), /api_token 不能和 http\.api_token 相同/],
    ['两个 bot 的 bot token 相同', mCfg({ bots: [{ ...mBots[0], api_token: TEST_TOKEN }, mBots[1]] }), /api_token 和别的机器人重复/],
    ['两个 bot 的 msg_log 指向同一文件', mCfg({ bots: [mBots[0], { ...mBots[1], msg_log: mLogDefault }] }), /msg_log .*同一个文件/],
    ['对外监听时 bot token 不足 32 字符', mCfg({ http: { host: '0.0.0.0', port: mPort, api_token: 'a'.repeat(32) } }), /（test）: http\.host 对外监听时 api_token 必须至少 32 字符/],
  ];
  for (const [label, cfg, re] of badCases) {
    const f = path.join(multiDir, 'bad.json');
    fs.writeFileSync(f, JSON.stringify(cfg));
    const r = spawnSync(process.execPath, [path.join(serverDir, 'index.mjs'), '--config', f], { cwd: multiDir, encoding: 'utf-8', timeout: 5000 });
    check(r.status !== 0 && re.test(r.stderr || ''), `多 bot 配置校验：${label}时启动失败`, `exit=${r.status} ${(r.stderr || '').trim().split('\n').pop()}`);
  }

  check(/\[test\] 订阅成功，开始心跳/.test(multiOut) && /\[default\] 订阅成功/.test(multiOut) && /Z 订阅成功，开始心跳/.test(childOut) && !/\[default\]/.test(childOut),
    '多 bot 时日志带 [key] 前缀，单 bot 时不带', multiOut.split('\n').find((l) => /\[test\] 订阅成功/.test(l)));
} catch (e) {
  check(false, '异常: ' + e.message);
  console.log('--- 客户端输出 ---\n' + childOut);
  if (multiOut) console.log('--- 多 bot 进程输出 ---\n' + multiOut);
} finally {
  child.kill('SIGTERM');
  // 等它退出再删目录：退出时会写 .state.json / .alive，和删除赛跑会 ENOTEMPTY
  if (multiChild && multiChild.exitCode === null) { const exited = new Promise((r) => multiChild.once('exit', r)); multiChild.kill('SIGTERM'); await exited; }
  if (multiDir) fs.rmSync(multiDir, { recursive: true, force: true });
  wss.close();
  try { fs.unlinkSync(tmpLog); } catch {}
  try { fs.unlinkSync(tmpLog + '.state.json'); } catch {}
  try { fs.unlinkSync(tmpLog + '.alive'); } catch {}
  fs.rmSync(cfgDir, { recursive: true, force: true });
}
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail) console.log('--- 客户端输出 ---\n' + childOut);
process.exit(fail ? 1 : 0);
