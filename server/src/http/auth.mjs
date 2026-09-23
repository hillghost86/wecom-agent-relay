/**
 * HTTP 鉴权的纯判定：取 token、比对、决定放行 / 401 / 403。不写日志、不碰响应，由 server.mjs 处理结果。
 * http.api_token = 管理员，任意 bot；bots[].api_token 只能访问自己。
 */
import { timingSafeEqual } from 'node:crypto';

/** 配了管理员 token 或任一 bot token 才开鉴权；都没配就是本机免 token */
export const authEnabled = (adminToken, bots) => !!adminToken || bots.some((b) => b.conf.apiToken);

/** Authorization: Bearer 优先，其次 ?token= */
export const tokenFrom = (authorization, searchParams) => {
  const auth = authorization || '';
  return auth.startsWith('Bearer ') ? auth.slice(7) : searchParams.get('token');
};

export const sameToken = (tok, expect) => {
  if (!tok || !expect) return false;
  const a = Buffer.from(String(tok)), b = Buffer.from(expect);
  return a.length === b.length && timingSafeEqual(a, b);
};

/**
 * 返回 null 表示放行；{ status: 401 } 是 token 不认识；{ status: 403, own } 是 bot token 越权（own 是它自己的 bot）。
 * bot 是请求路径指向的 bot（不存在的 key 为 undefined），listAll 是 GET /bots 总览。
 * bot token 只管自己：总览、别的 bot、不存在的 key 一律 403（不透露 key 是否存在）
 */
export function checkAccess({ tok, adminToken, bots, bot, listAll }) {
  const admin = sameToken(tok, adminToken);
  const own = admin ? null : bots.find((b) => sameToken(tok, b.conf.apiToken));
  if (!admin && !own) return { status: 401 };
  if (!admin && (listAll || own !== bot)) return { status: 403, own };
  return null;
}
