// 日志与文案格式化：带 ISO 时间戳的 log / warn、多 bot 前缀、时长与时间的中文说法、日志脱敏
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

// 日志里的 response_url 只留尾部：它是一次性的回复凭证，进了 journal 就等于泄露
export const maskBody = (b) => (b && b.response_url ? { ...b, response_url: '…' + String(b.response_url).slice(-8) } : b);
