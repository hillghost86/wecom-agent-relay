// 日志与文案格式化：带 ISO 时间戳的 log / warn、多 bot 前缀、时长与时间的中文说法、日志脱敏（response_url、图片 url / aeskey）
export const log = (...a) => console.log(new Date().toISOString(), ...a);
export const warn = (...a) => console.warn(new Date().toISOString(), ...a);
// 多 bot 时日志前面带 [key]；单 bot 时原样，老部署的日志和以前逐字相同
export const tagged = (tag) => (tag ? { log: (...a) => log(tag, ...a), warn: (...a) => warn(tag, ...a) } : { log, warn });

/** 按配置的时区把毫秒时间戳格式化成自报里显示的时间 */
export const makeFmtTime = (tz) => (ms) => new Date(ms).toLocaleString('zh-CN', { timeZone: tz, hour12: false });

/** 离线时长的中文说法：一分钟内说秒，一小时内说分钟，再往上说小时（一位小数，整数不带小数点） */
export function fmtDuration(secs) {
  if (secs < 60) return `${secs} 秒`;
  if (secs < 3600) return `${Math.floor(secs / 60)} 分钟`;
  const h = Math.round((secs / 3600) * 10) / 10;
  return `${Number.isInteger(h) ? h : h.toFixed(1)} 小时`;
}

// 日志里的 response_url 和图片 url 只留尾部、aeskey 整个遮掉：前两个是一次性凭证，aeskey 能解开图片，进了日志就等于泄露
// 返回拷贝：落盘和 API 要保留完整值（--download 直连要用）
const tail = (u) => '…' + String(u).slice(-8);
const maskImage = (img) => (img && typeof img === 'object'
  ? { ...img, ...(img.url != null ? { url: tail(img.url) } : {}), ...(img.aeskey != null ? { aeskey: '***' } : {}) }
  : img);
export const maskBody = (b) => {
  if (!b || typeof b !== 'object') return b;
  const out = { ...b };
  if (b.response_url) out.response_url = tail(b.response_url);
  if (b.image) out.image = maskImage(b.image);
  if (Array.isArray(b.mixed?.msg_item)) out.mixed = { ...b.mixed, msg_item: b.mixed.msg_item.map((it) => (it?.image ? { ...it, image: maskImage(it.image) } : it)) };
  return out;
};
