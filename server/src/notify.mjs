// 发给管理员的通知：断线自报（重连后报离线时段）和处理端离线告警，都走当前连接的 aibot_send_msg 单聊
import { fmtDuration } from './log.mjs';

/** 断线自报的内容与发送；空窗计算和节流在 BotConnection.reportOutage */
export async function sendOutageReport(conn, { since, now, secs, reason }) {
  const content = `⚠️ 机器人离线 **${secs} 秒**（${reason}）\n${conn.fmtTime(since)} → ${conn.fmtTime(now)}\n期间发给机器人的消息已丢失，请重发。`;
  try {
    const resp = await conn.request({ cmd: 'aibot_send_msg', body: { chatid: conn.conf.adminUserId, chat_type: 1, msgtype: 'markdown', markdown: { content } } }, 10000);
    if (resp.errcode === 0) conn.bot.log(`断线自报已发送：离线 ${secs}s（${reason}）`);
    else conn.bot.warn(`断线自报被拒 errcode=${resp.errcode} errmsg=${resp.errmsg}`);
  } catch (e) {
    conn.bot.warn('断线自报失败:', e.message);
  }
}

/* ---------- 管理员离线告警（offline_alert_mins > 0 且配了 admin_userid 才开） ---------- */
export function startOfflineAlert(bot) {
  const mins = bot.conf.offlineAlertMins;
  if (!(mins > 0) || !bot.conf.adminUserId) return null;
  const tick = async () => {
    const conn = bot.conn;
    if (!conn || !conn.subscribed) return; // 未订阅时发不出去，跳过本轮
    const online = bot.agentOnline();
    const pending = bot.pending();
    let content = '';
    if (online === false && bot.offlineSecs() >= mins * 60 && pending > 0 && !bot.offlineAlerted) {
      bot.offlineAlerted = true;
      content = `⚠️ 处理端已离线 ${fmtDuration(bot.offlineSecs())}，积压 ${pending} 条消息无人处理`;
    } else if (online === true && bot.offlineAlerted) {
      bot.offlineAlerted = false;
      content = `✅ 处理端已恢复（${bot.presence.lastAgent || '未知'}），当前积压 ${pending} 条`;
    }
    if (!content) return;
    try {
      const resp = await conn.request({ cmd: 'aibot_send_msg', body: { chatid: bot.conf.adminUserId, chat_type: 1, msgtype: 'markdown', markdown: { content } } }, 10000);
      if (resp.errcode === 0) bot.log('离线告警已发送:', content);
      else bot.warn(`离线告警被拒 errcode=${resp.errcode} errmsg=${resp.errmsg}`);
    } catch (e) {
      bot.warn('离线告警失败:', e.message);
    }
  };
  return setInterval(tick, Math.min(10000, mins * 60000));
}
