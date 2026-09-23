/**
 * wecom-agent-relay · 事件哨兵
 *
 * 轮询 VPS 网关，发现新消息即退出 —— 借「后台任务完成通知」机制唤醒
 * 对话式 agent（WorkBuddy / Claude Code 等）。无消息长跑待命，不浪费任何一轮对话。
 *
 * 用法：
 *   node client/sentinel.mjs                     常驻（默认 10s 一查，无消息不退出）
 *   node client/sentinel.mjs --interval 5        自定义轮询间隔（秒）
 *   node client/sentinel.mjs --once              只查一次就退出（验证用）
 *   node client/sentinel.mjs --status            打印本地/服务端 seq 后退出
 *   node client/sentinel.mjs --exec "<command>"  发现新消息时先执行外部命令再退出
 *                                         （只取紧跟的一个参数，命令含空格请整体加引号）
 *   node client/sentinel.mjs --help              帮助
 *
 * stdout 契约（供 agent / 自动化脚本解析）：
 *   NEW_MSG count=<n> seq=<a>-<b> acked=<cursor> agent=<id>   发现 n 条新消息（seq 闭区间；只算 kind=message，事件不唤醒）
 *   NO_MSG ...                                                --once 模式下无新消息
 *
 * 配置（优先级：环境变量 > config.json）：
 *   WECOM_API_BASE / WECOM_API_TOKEN / WECOM_AGENT_ID（可选，默认本机主机名）
 *   或同目录 config.json: { "api_base": "...", "api_token": "...", "agent_id": "..." }
 *
 * 游标：sentinel_cursor.json 记录已见过的最大 seq（与服务端 ack 游标无关），
 *       同一批消息只触发一次退出；首次运行以服务端已确认游标起步，
 *       所以有未处理的积压会立刻触发一次唤醒。
 *
 * 可靠性设计：
 * - 长跑型：网络错误、无消息都不退出（退出 = 唤醒 agent = 消耗一轮对话，
 *   只有「真有新消息」才允许退出）
 * - 哨兵不在线期间的消息由 VPS 网关落盘兜底，不会丢失；
 *   agent 处理完后从服务端游标补拉即可
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CONFIG_FILE = path.join(__dirname, 'config.json');
const CURSOR_FILE = path.join(__dirname, 'sentinel_cursor.json');

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(fs.readFileSync(__filename, 'utf-8').split('*/')[0].replace(/^\/\*\*/, '').trim());
  process.exit(0);
}

const getArg = (name, dft) => { const i = args.indexOf(name); return i >= 0 ? Number(args[i + 1]) || dft : dft; };
const INTERVAL_S = getArg('--interval', 10);
const ONCE = args.includes('--once');
const STATUS = args.includes('--status');
const execIdx = args.indexOf('--exec');
const EXEC_CMD = execIdx >= 0 ? (args[execIdx + 1] || '') : '';

const fileCfg = fs.existsSync(CONFIG_FILE) ? JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')) : {};
const BASE = String(process.env.WECOM_API_BASE || fileCfg.api_base || '').replace(/\/+$/, '');
const TOKEN = String(process.env.WECOM_API_TOKEN || fileCfg.api_token || '');
if (!BASE || !TOKEN) {
  console.error('缺少配置：设置环境变量 WECOM_API_BASE / WECOM_API_TOKEN，或在同目录 config.json 填 api_base / api_token');
  process.exit(1);
}
const AGENT_ID = String(process.env.WECOM_AGENT_ID || fileCfg.agent_id || os.hostname() || 'unknown');
const H = { Authorization: `Bearer ${TOKEN}` };
// 只有长跑循环才报「处理端在线」：--once / --status 常由人手工执行，不代表 agent 在待命
const POLL_H = ONCE || STATUS ? H : { ...H, 'X-Relay-Agent': AGENT_ID };

let lastSeen = null;
try { lastSeen = JSON.parse(fs.readFileSync(CURSOR_FILE, 'utf-8')).last_seen ?? null; } catch {}

const ts = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function probe() {
  const r = await fetch(`${BASE}/health`, { headers: POLL_H, signal: AbortSignal.timeout(10_000) });
  if (r.status === 401) throw new Error('401 token 无效');
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const h = await r.json();
  return { seq: Number(h.seq) || 0, connected: !!h.connected, cursor: Number(h.cursor) || 0, agentOnline: h.agent_online ?? null, lastAgent: h.last_agent || '' };
}

/**
 * 取 seq > after 的真消息（kind=message），enter_chat 等事件也占 seq，但不该唤醒 agent。
 * 请求失败返回 null，由调用方按「全是真消息」处理：宁可多唤醒一轮，也不漏处理。
 */
async function newMessages(after) {
  try {
    const r = await fetch(`${BASE}/messages?after=${after}&kind=message&limit=500`, { headers: POLL_H, signal: AbortSignal.timeout(10_000) });
    if (!r.ok) return null;
    const m = (await r.json()).messages;
    return Array.isArray(m) ? m : null;
  } catch { return null; }
}

async function loop() {
  if (lastSeen === null) {
    const h = await probe();
    // 以已确认游标起步：服务端有积压未处理时，第一轮就该唤醒 agent，而不是等下一条新消息
    lastSeen = h.cursor;
    fs.writeFileSync(CURSOR_FILE, JSON.stringify({ last_seen: lastSeen }));
    console.log(`[${ts()}] 哨兵启动：interval=${INTERVAL_S}s，last_seen 初始化为服务端游标 ${lastSeen}`);
  }

  while (true) {
    let h;
    try { h = await probe(); }
    catch (e) { console.log(`[${ts()}] ${e.message}，继续等`); await sleep(INTERVAL_S * 1000); continue; }

    if (h.seq > lastSeen) {
      const msgs = await newMessages(lastSeen);
      if (msgs && msgs.length === 0) {
        console.log(`[${ts()}] seq ${lastSeen + 1}-${h.seq} 只有事件，不唤醒`);
        lastSeen = h.seq;
        fs.writeFileSync(CURSOR_FILE, JSON.stringify({ last_seen: lastSeen }));
      } else {
        const n = msgs ? msgs.length : h.seq - lastSeen;
        const range = msgs ? `${msgs[0].seq}-${msgs[msgs.length - 1].seq}` : `${lastSeen + 1}-${h.seq}`;
        fs.writeFileSync(CURSOR_FILE, JSON.stringify({ last_seen: h.seq }));
        console.log(`NEW_MSG count=${n} seq=${range} acked=${h.cursor} agent=${AGENT_ID}`);
        if (EXEC_CMD) {
          console.log(`[${ts()}] 执行 --exec 命令：${EXEC_CMD}`);
          const p = spawnSync(EXEC_CMD, { shell: true, stdio: 'inherit' });
          if (p.status !== 0) console.log(`[${ts()}] --exec 命令退出码 ${p.status}（不影响哨兵退出）`);
        }
        console.log(`[${ts()}] 发现 ${n} 条新消息，退出以唤醒 agent`);
        process.exit(0);
      }
    }
    if (ONCE) { console.log(`NO_MSG server_seq=${h.seq} last_seen=${lastSeen} acked=${h.cursor} connected=${h.connected}`); process.exit(0); }
    await sleep(INTERVAL_S * 1000);
  }
}

if (STATUS) {
  const h = await probe().catch((e) => { console.error(e.message); process.exit(1); });
  const who = h.agentOnline === null ? '未知' : h.agentOnline ? '在线' : '离线';
  console.log(`本地 last_seen=${lastSeen ?? '未初始化'} | 服务端 seq=${h.seq} acked=${h.cursor} connected=${h.connected} | 处理端=${who}(${h.lastAgent || '未见过'})`);
  process.exit(0);
}

loop();
