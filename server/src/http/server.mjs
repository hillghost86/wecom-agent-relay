/**
 * HTTP API 服务：监听、统一鉴权、按路由分发到 api.mjs、写 JSON 响应、读请求体。
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
 * 路由：/bots/<key>/… 指定 bot；/bots 是管理员总览；其余无前缀路径沿用 bots[0]，老客户端不用改。
 * 鉴权判定顺序 401 → 403 → 404，unknown bot 的 404 放在鉴权之后，免得未鉴权的人拿它探测 key 是否存在。
 */
import http from 'node:http';
import { log, warn } from '../log.mjs';
import { isLoopback } from '../config.mjs';
import { authEnabled, tokenFrom, checkAccess } from './auth.mjs';
import * as api from './api.mjs';

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

/** gw 取 httpHost / httpPort / apiToken；httpPort 为 0 时不起服务 */
export function startHttpServer(bots, gw) {
  if (!gw.httpPort) return null;
  // 正常部署不应走到这里：对外应由反代做 HTTPS。token 强度已在加载配置时校验，这里只警告。
  if (!isLoopback(gw.httpHost)) warn(`HTTP API 以明文 HTTP 对外监听 ${gw.httpHost}，token 和 response_url 会在链路上裸奔；请改为 127.0.0.1 并用反代做 HTTPS`);
  const byKey = new Map(bots.map((b) => [b.key, b]));
  const authOn = authEnabled(gw.apiToken, bots);

  const handler = async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const prefixed = url.pathname.match(/^\/bots\/([^/]+)(\/.*)$/);
    const listAll = url.pathname === '/bots';
    const bot = prefixed ? byKey.get(prefixed[1]) : listAll ? null : bots[0];
    const pathname = prefixed ? prefixed[2] : url.pathname;
    if (authOn) {
      const tok = tokenFrom(req.headers.authorization, url.searchParams);
      const denied = checkAccess({ tok, adminToken: gw.apiToken, bots, bot, listAll });
      if (denied?.status === 401) {
        warn(`API 鉴权失败 ip=${clientIp(req)} path=${url.pathname}`);
        return json(res, 401, { ok: false, error: 'unauthorized' });
      }
      if (denied?.status === 403) {
        warn(`API 越权访问 ip=${clientIp(req)} token=${denied.own.key} path=${url.pathname}`);
        return json(res, 403, { ok: false, error: 'forbidden' });
      }
    }
    if (prefixed && !bot) return json(res, 404, { ok: false, error: 'unknown bot' });
    // 鉴权过了才认这个头：处理端每次来访都刷新请求所指那个 bot 的在线状态
    const agentId = req.headers['x-relay-agent'];
    if (agentId && bot) bot.touchAgent(agentId);
    try {
      if (req.method === 'GET' && listAll) return json(res, ...api.listBots(bots));
      if (!bot) return json(res, 404, { ok: false, error: 'not found' });
      if (req.method === 'GET' && pathname === '/health') return json(res, ...api.health(bot));
      if (req.method === 'GET' && pathname === '/messages') return json(res, ...api.listMessages(bot, url.searchParams));
      const one = req.method === 'GET' && pathname.match(/^\/messages\/(\d+)$/);
      if (one) return json(res, ...api.getMessage(bot, Number(one[1])));
      if ((req.method === 'GET' || req.method === 'POST') && pathname === '/ack') return json(res, ...api.ack(bot, url.searchParams));
      if (req.method === 'POST' && pathname === '/send') return json(res, ...(await api.send(bot, () => readBody(req))));
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
