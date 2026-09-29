/**
 * 媒体下载：图片消息收到即下载解密，存到 bots/<key>/files/<YYYY-MM>/<seq>-<n>.<ext>，每个 bot 一份。
 *
 * 协议坑点（实测 2026-09-23，见 docs/protocol.md § 媒体文件加密）：
 * - body.image.url 是腾讯云 COS 签名地址，300 秒后失效，所以要在收到时就下载，agent 被唤醒再下多半已过期
 * - 下到的是密文：key = base64(aeskey + '=')（32 字节），iv = key 前 16 字节，AES-256-CBC，
 *   PKCS#7 但块长 32，Node 内置去填充按 16 字节算，必须关掉自己去
 * - mixed（图文混排）按文档是 mixed.msg_item[]，每项自带 msgtype 和同样的 image: { url, aeskey }（无真实样本）
 * 索引 files/index.jsonl 只追加；url 和 aeskey 是下载凭证，不进日志。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** 解密企微媒体文件；填充不合法抛错（多半是 aeskey 不对或下到的不是密文） */
export function decryptMedia(buf, aeskey) {
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

/** 按文件头认图片格式，认不出返回 bin */
export function detectExt(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length >= 4 && buf.subarray(0, 4).toString('latin1') === 'GIF8') return 'gif';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return 'bin';
}

/** 这条消息里的图片 [{ n, url, aeskey }]：单图 n=1；mixed 按出现顺序只数图片项 */
export function imagesOf(body) {
  if (!body || typeof body !== 'object') return [];
  if (body.msgtype === 'image') return [{ n: 1, url: body.image?.url, aeskey: body.image?.aeskey }];
  if (body.msgtype !== 'mixed' || !Array.isArray(body.mixed?.msg_item)) return [];
  const out = [];
  for (const it of body.mixed.msg_item) {
    if (it?.msgtype === 'image') out.push({ n: out.length + 1, url: it.image?.url, aeskey: it.image?.aeskey });
  }
  return out;
}

export const FILE_TYPES = { jpg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', bin: 'application/octet-stream' };

// 这类失败重试也一样，不浪费剩下的 300 秒窗口
class FinalError extends Error {}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const URL_TTL_MS = 280000;   // 企微 URL 300 秒失效，留 20 秒余量

export class MediaStore {
  /** storeFile 是消息文件路径，null（msg_log=off）时整个媒体功能关闭；gw 取 mediaKeepDays / mediaMaxMb / mediaRetryMs */
  constructor(storeFile, gw, logger) {
    this.L = logger;
    this.dir = storeFile ? path.join(path.dirname(storeFile), 'files') : null;
    this.indexFile = this.dir ? path.join(this.dir, 'index.jsonl') : null;
    this.maxBytes = gw.mediaMaxMb * 1024 * 1024;
    this.keepDays = gw.mediaKeepDays;
    this.retryMs = gw.mediaRetryMs;
    this.index = new Map();     // seq -> Map(n -> 最新一条索引)
    this.pending = new Set();   // `${seq}-${n}`，只在内存：进程重启后变成 missing
    this.load();
  }

  load() {
    if (!this.indexFile || !fs.existsSync(this.indexFile)) return;
    try {
      for (const line of fs.readFileSync(this.indexFile, 'utf-8').split('\n')) {
        if (!line.trim()) continue;
        try { this.remember(JSON.parse(line)); } catch {}
      }
    } catch (e) {
      this.L.warn('加载媒体索引失败:', e.message);
    }
  }

  remember(e) {
    if (!this.index.has(e.seq)) this.index.set(e.seq, new Map());
    this.index.get(e.seq).set(e.n, e);
  }

  writeIndex(e) {
    this.remember(e);
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.appendFileSync(this.indexFile, JSON.stringify(e) + '\n');
    } catch (err) {
      this.L.warn('写媒体索引失败:', err.message);
    }
  }

  /** 收到消息后调用：每张图各自异步下载，立即返回，不拖慢 5 秒内的回帧 */
  enqueue(record) {
    if (!this.dir) return;
    for (const img of imagesOf(record.body)) {
      this.pending.add(`${record.seq}-${img.n}`);
      this.download(record, img).catch((e) => this.L.warn(`图片下载异常 seq=${record.seq} n=${img.n}：${e.message}`));
    }
  }

  async download(record, img) {
    const { seq } = record, { n } = img;
    const t0 = Date.now();
    const born = Date.parse(record.received_at) || t0;
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          const plain = decryptOrFinal(await this.fetchCapped(img), img.aeskey);
          const type = detectExt(plain);
          const file = `${new Date(born).toISOString().slice(0, 7)}/${seq}-${n}.${type}`;
          fs.mkdirSync(path.join(this.dir, path.dirname(file)), { recursive: true });
          fs.writeFileSync(path.join(this.dir, file), plain);
          this.writeIndex({ seq, n, status: 'ok', file, bytes: plain.length, type, at: new Date().toISOString() });
          this.L.log(`图片已下载 seq=${seq} n=${n} ${plain.length} 字节 ${type} 耗时 ${Date.now() - t0}ms`);
          return;
        } catch (e) {
          const wait = this.retryMs[attempt];
          // URL 快过期了再试也是白试
          if (e instanceof FinalError || wait == null || Date.now() + wait - born > URL_TTL_MS) {
            this.writeIndex({ seq, n, status: 'failed', error: e.message, at: new Date().toISOString() });
            this.L.warn(`图片下载失败 seq=${seq} n=${n}：${e.message}（共 ${attempt + 1} 次，耗时 ${Date.now() - t0}ms）`);
            return;
          }
          this.L.warn(`图片下载失败 seq=${seq} n=${n}（第 ${attempt + 1} 次）：${e.message}，${wait / 1000}s 后重试`);
          await sleep(wait);
        }
      }
    } finally {
      this.pending.delete(`${seq}-${n}`);
    }
  }

  /** 下载密文：单次 30 秒超时；先看 Content-Length，读的时候再累计，超过 media_max_mb 就中止。报错文字里不带 url */
  async fetchCapped({ url, aeskey }) {
    if (!url || !aeskey) throw new FinalError('消息里没有 url 或 aeskey');
    const limitMb = this.maxBytes / 1024 / 1024;
    let res;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(30000) });
    } catch (e) {
      throw new Error(fetchErr(e));
    }
    if (!res.ok) { res.body?.cancel().catch(() => {}); throw new Error(`HTTP ${res.status}`); }
    const len = Number(res.headers.get('content-length'));
    if (len > this.maxBytes) { res.body?.cancel().catch(() => {}); throw new FinalError(`文件 ${len} 字节，超过上限 ${limitMb}MB`); }
    const chunks = [];
    let total = 0;
    try {
      for await (const c of res.body) {
        total += c.length;
        if (total > this.maxBytes) throw new FinalError(`文件超过上限 ${limitMb}MB，已中止`);
        chunks.push(c);
      }
    } catch (e) {
      if (e instanceof FinalError) throw e;
      throw new Error(fetchErr(e));
    }
    return Buffer.concat(chunks);
  }

  /** 给 API 用：这条消息每张图的状态；没有图片或媒体功能关闭返回 null（API 不附 media 字段） */
  statusOf(seq, record) {
    if (!this.dir) return null;
    const imgs = imagesOf(record.body);
    if (!imgs.length) return null;
    return imgs.map(({ n }) => {
      if (this.pending.has(`${seq}-${n}`)) return { n, status: 'pending' };
      const e = this.index.get(seq)?.get(n);
      if (!e) return { n, status: 'missing' };
      if (e.status !== 'ok') return { n, status: 'failed', error: e.error };
      if (!fs.existsSync(path.join(this.dir, e.file))) return { n, status: 'deleted' };
      return { n, status: 'ok', file: e.file, bytes: e.bytes, type: e.type };
    });
  }

  /** /files/<rel> 对应的绝对路径；媒体功能关闭或跳出 files/ 目录时返回 null */
  resolve(rel) {
    if (!this.dir) return null;
    const root = path.resolve(this.dir);
    const f = path.resolve(root, rel);
    return f.startsWith(root + path.sep) ? f : null;
  }

  /** 删 files/<YYYY-MM>/ 下 mtime 早于 media_keep_days 天的文件，再删空的月份目录；索引不动，API 据文件是否还在给 deleted */
  cleanup() {
    if (!this.dir || !(this.keepDays > 0) || !fs.existsSync(this.dir)) return;
    const cutoff = Date.now() - this.keepDays * 86400000;
    let removed = 0;
    try {
      for (const m of fs.readdirSync(this.dir)) {
        if (!/^\d{4}-\d{2}$/.test(m)) continue;
        const md = path.join(this.dir, m);
        if (!fs.statSync(md).isDirectory()) continue;
        for (const f of fs.readdirSync(md)) {
          const fp = path.join(md, f);
          const st = fs.statSync(fp);
          if (st.isFile() && st.mtimeMs < cutoff) { fs.unlinkSync(fp); removed++; }
        }
        if (!fs.readdirSync(md).length) fs.rmdirSync(md);
      }
    } catch (e) {
      this.L.warn('清理媒体文件失败:', e.message);
    }
    if (removed) this.L.log(`已清理 ${removed} 个超过 ${this.keepDays} 天的媒体文件`);
  }

  /** 启动时清理一次，之后每 24 小时一次；媒体关闭或 media_keep_days=0（永久保留）时返回 null */
  startCleanup() {
    if (!this.dir || !(this.keepDays > 0)) return null;
    this.cleanup();
    return setInterval(() => this.cleanup(), 86400000);
  }
}

// 解密失败换一次下载也不会好，不重试
function decryptOrFinal(buf, aeskey) {
  try { return decryptMedia(buf, aeskey); } catch (e) { throw new FinalError(e.message); }
}

// fetch 的错误只留类别和错误码：cause 的原文可能带主机名
function fetchErr(e) {
  if (e?.name === 'TimeoutError') return '下载超时（30 秒）';
  const code = e?.cause?.code || e?.code;
  return `下载出错${code ? `（${code}）` : ''}`;
}
