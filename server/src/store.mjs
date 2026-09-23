// 消息存储：JSONL 追加 + 内存索引 + 已确认游标（.state.json），每个 bot 一份
import fs from 'node:fs';
import path from 'node:path';

export class MessageStore {
  constructor(file, logger) {
    this.L = logger;
    this.file = file && file !== 'off' ? file : null;
    if (file === 'off') this.L.warn('msg_log=off：消息只放内存，重启即丢，不要在生产使用');
    this.stateFile = this.file ? this.file + '.state.json' : null;
    this.items = [];
    this.seq = 0;
    this.cursor = 0;
    this.loadedState = {};   // 游标之外的字段（presence）由 Bot 取用
    this.extraState = () => ({}); // Bot 注入：和 cursor 一起写进 .state.json
    // .state.json 和 .alive 用 writeFileSync 直接写，不会自己建目录；启动时先建好
    if (this.file) {
      try { fs.mkdirSync(path.dirname(this.file), { recursive: true }); } catch (e) { this.L.warn('创建消息目录失败:', e.message); }
    }
    this.load();
  }
  load() {
    if (!this.file) return;
    try {
      if (fs.existsSync(this.file)) {
        for (const line of fs.readFileSync(this.file, 'utf-8').split('\n')) {
          if (!line.trim()) continue;
          try {
            const r = JSON.parse(line);
            if (typeof r.seq !== 'number') r.seq = this.seq + 1; // 兼容旧格式
            this.seq = Math.max(this.seq, r.seq);
            this.items.push(r);
          } catch {}
        }
      }
      if (fs.existsSync(this.stateFile)) {
        this.loadedState = JSON.parse(fs.readFileSync(this.stateFile, 'utf-8')) || {};
        this.cursor = Number(this.loadedState.cursor) || 0;
      }
      this.L.log(`消息存储已加载：${this.items.length} 条，seq=${this.seq}，游标=${this.cursor}`);
    } catch (e) {
      this.L.warn('加载消息存储失败:', e.message);
    }
  }
  append(record) {
    const r = { seq: ++this.seq, received_at: new Date().toISOString(), ...record };
    this.items.push(r);
    if (this.items.length > 10000) this.items.shift();
    if (this.file) {
      try {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        fs.appendFileSync(this.file, JSON.stringify(r) + '\n');
      } catch (e) {
        this.L.warn('写消息日志失败:', e.message);
      }
    }
    return r;
  }
  get(seq) {
    return this.items.find((r) => r.seq === seq) || null;
  }
  list({ after, limit, kind }) {
    const out = [];
    for (const r of this.items) {
      if (r.seq <= after) continue;
      if (kind && r.kind !== kind) continue;
      out.push(r);
      if (out.length >= limit) break;
    }
    return out;
  }
  ack(seq) {
    // 钳到当前最大 seq：误传大数会让之后的消息全部落在游标之下被跳过
    this.cursor = Math.max(this.cursor, Math.min(seq, this.seq));
    return this.cursor;
  }
  saveState() {
    if (!this.stateFile) return;
    try { fs.writeFileSync(this.stateFile, JSON.stringify({ cursor: this.cursor, ...this.extraState() })); } catch (e) { this.L.warn('写游标失败:', e.message); }
  }
}
