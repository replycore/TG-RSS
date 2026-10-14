/** GramJS 连接封装：会话、实体解析、消息读取、媒体下载缓存 */

import fs from "node:fs";
import path from "node:path";
import { TelegramClient } from "teleproto";
import { StringSession } from "teleproto/sessions";
import { config, requireConfig } from "./config.js";

let clientPromise = null;

export async function getClient() {
  if (clientPromise) return clientPromise;
  requireConfig();
  clientPromise = (async () => {
    const c = new TelegramClient(new StringSession(config.session), config.apiId, config.apiHash, {
      connectionRetries: 5,
      autoReconnect: true,
      useWSS: false,
    });
    await c.connect();
    const ok = await c.checkAuthorization().catch(() => false);
    if (!ok) {
      await c.disconnect().catch(() => {});
      throw new Error("TG_SESSION 已失效，请重新执行 npm run login");
    }
    return c;
  })().catch((err) => {
    clientPromise = null;
    throw err;
  });
  return clientPromise;
}

export function toEntityArg(value) {
  const s = String(value ?? "").trim();
  if (!s) throw new Error("缺少 channel 参数");
  if (/^-?\d+$/.test(s)) return Number(s);
  return s.replace(/^@/, "");
}

// 仅供测试注入假 client（避免测试连真实 Telegram）
export function __setClientForTest(c) {
  clientPromise = c ? Promise.resolve(c) : null;
}

export async function resolvePeer(value) {
  const client = await getClient();
  return client.getEntity(toEntityArg(value));
}

export async function fetchMessages(peer, { before = null, limit = 20 } = {}) {
  const client = await getClient();
  const rawLimit = Number(limit);
  // N-3：上界 51（Telegram 单次上限 50 + handleFeed 判 next 多取的 1 条）。
  // 原来 clamp 到 50 时，limit=50 的请求拿到恰好 50 条，`fetched.length > limit` 永假 → next 恒 null。
  const options = { limit: Number.isFinite(rawLimit) ? Math.max(1, Math.min(51, rawLimit)) : 20 };
  if (before && /^\d+$/.test(String(before))) options.offsetId = Number(before);

  const out = [];
  for await (const msg of client.iterMessages(peer, options)) {
    out.push(msg);
    if (out.length >= options.limit) break;
  }
  return out;
}

/** 下载媒体到本地缓存，返回绝对路径 */
// 并发单飞：同一媒体的并发下载共享同一个 promise。否则两路同时下载会共用
// 同一个 tmp 路径（无锁），后完成的 rename 会覆盖/截断先完成的文件，永久
// serve 坏缓存；或一方在 existsSync/renameSync 间隙看到中间态而 500。
const inflightDownloads = new Map();

/** 下载媒体到本地缓存，返回绝对路径 */
export async function downloadMediaToCache(peer, msg) {
  const client = await getClient();
  const channelId = String(peer.id ?? peer);
  const base = `${channelId}_${msg.id}`;
  const dir = config.cacheDir;
  fs.mkdirSync(dir, { recursive: true });

  // 已完成缓存判定：排除 .part（下载中断残留，命中它会永久 serving 截断内容）
  // 且必须 size > 0（与 downloadAvatarToCache 同标准）
  const existing = fs.readdirSync(dir).find((f) => {
    if (!f.startsWith(`${base}.`) || f.endsWith(".part")) return false;
    try {
      return fs.statSync(path.join(dir, f)).size > 0;
    } catch {
      return false;
    }
  });
  if (existing) return path.join(dir, existing);

  const inflightKey = `${dir}/${base}`;
  const ongoing = inflightDownloads.get(inflightKey);
  if (ongoing) return ongoing;
  const task = (async () => {
    const ext = guessExtension(msg);
    // tmp 加随机后缀：退化并发（单飞间隙/多进程）下也不互相覆盖 tmp
    const tmp = path.join(dir, `${base}.${ext}.${Math.random().toString(36).slice(2, 10)}.part`);
    const target = path.join(dir, `${base}.${ext}`);

    // L-2：把 downloadMedia 的 outputFile 指向临时文件，让 teleproto 直接流式写盘，
    // 而不是把整个视频装进内存 Buffer（几百 MB 视频会 OOM / GC 抖动）。
    let result;
    try {
      result = await client.downloadMedia(msg.media ?? msg, { outputFile: tmp });
    } catch {
      result = await client.downloadMedia(msg, { outputFile: tmp });
    }
    // 某些媒体类型（小图等）仍可能返回 Buffer；统一落到 tmp 再原子 rename
    if (Buffer.isBuffer(result)) fs.writeFileSync(tmp, result);

    if (!fs.existsSync(tmp) || fs.statSync(tmp).size === 0) throw new Error("媒体下载失败");
    // 若等待期间已有完整目标（另一路先落盘），直接复用，不覆盖
    if (fs.existsSync(target)) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* 忽略清理错误 */
      }
      return target;
    }
    fs.renameSync(tmp, target);
    // L-3：落盘后触发一次后台淘汰（不阻塞返回）
    evictCacheAsync(dir);
    return target;
  })();
  inflightDownloads.set(inflightKey, task);
  try {
    return await task;
  } finally {
    inflightDownloads.delete(inflightKey);
  }
}

/**
 * 下载消息缩略图到缓存（<video poster> 用）。
 * teleproto downloadMedia 内部已处理 PhotoCachedSize（内嵌字节）与
 * InputDocumentFileLocation(thumbSize) 下载两条路径。
 */
// L-3：媒体缓存淘汰——上限 2GB / 单文件 7 天过期。后台异步执行，不阻塞请求。
const CACHE_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const CACHE_MAX_AGE_MS = 7 * 24 * 3600 * 1000;

let evicting = false;
function evictCacheAsync(dir) {
  if (evicting) return; // 避免并发重复清理
  evicting = true;
  setImmediate(() => {
    try {
      evictCacheSync(dir);
    } catch {
      /* 忽略清理错误 */
    } finally {
      evicting = false;
    }
  });
}

export function evictCacheSync(dir) {
  const now = Date.now();
  const files = [];
  let total = 0;
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith(".part")) continue;
    const p = path.join(dir, f);
    try {
      const st = fs.statSync(p);
      if (!st.isFile()) continue;
      files.push({ p, mtime: st.mtimeMs, size: st.size });
      total += st.size;
    } catch {
      /* 文件可能已被并发删除 */
    }
  }
  // 1) 过期文件先删
  for (const f of files) {
    if (now - f.mtime > CACHE_MAX_AGE_MS) {
      try { fs.rmSync(f.p, { force: true }); f.size = 0; } catch { /* ignore */ }
    }
  }
  // 2) 仍超上限则按最旧优先删到上限内
  const alive = files.filter((f) => f.size > 0).sort((a, b) => a.mtime - b.mtime);
  let sum = alive.reduce((s, f) => s + f.size, 0);
  for (const f of alive) {
    if (sum <= CACHE_MAX_BYTES) break;
    try { fs.rmSync(f.p, { force: true }); sum -= f.size; } catch { /* ignore */ }
  }
}

export async function downloadThumbToCache(peer, msg, size) {
  const dir = config.cacheDir;
  fs.mkdirSync(dir, { recursive: true });
  const base = `thumb_${peer?.id ?? "x"}_${msg.id}`;
  // 与 downloadMediaToCache 同标准：排除 .part 中断残留，且必须 size > 0
  const existing = fs.readdirSync(dir).find((f) => {
    if (!f.startsWith(`${base}.`) || f.endsWith(".part")) return false;
    try {
      return fs.statSync(path.join(dir, f)).size > 0;
    } catch {
      return false;
    }
  });
  if (existing) return path.join(dir, existing);
  const client = await getClient();
  // teleproto 的 downloadMedia(messageOrMedia, downloadParams) 只接受两参：
  // 位置式第三参会静默丢弃（thumb 变 undefined → 下载完整视频）。thumb 必须走对象形式。
  const buf = await client.downloadMedia(msg, { thumb: size });
  if (!buf || !buf.length) throw new Error("thumb_empty");
  // .part + rename 原子写入：中断不留截断文件（截断 .jpg 会被 size>0 判定永久命中）
  const tmp = path.join(dir, `${base}.jpg.part`);
  const file = path.join(dir, `${base}.jpg`);
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, file);
  return file;
}

export async function downloadAvatarToCache(peer) {
  const client = await getClient();
  const dir = config.cacheDir;
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `avatar_${peer.id ?? peer}.jpg`);
  if (fs.existsSync(target) && fs.statSync(target).size > 0) return target;

  const buf = await client.downloadProfilePhoto(peer, {});
  if (!buf || !buf.length) return null;
  fs.writeFileSync(target, buf);
  return target;
}

export function guessExtension(msg) {
  const fileName = fileNameOf(msg);
  if (fileName && fileName.includes(".")) {
    const ext = fileName.split(".").pop().toLowerCase().replace(/[^a-z0-9]/g, "");
    if (ext && ext.length <= 5) return ext;
  }
  const mime = (msg.document && msg.document.mimeType) || "";
  const map = {
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/quicktime": "mov",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "audio/ogg": "ogg",
    "audio/flac": "flac",
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "application/pdf": "pdf",
    "application/zip": "zip",
  };
  if (map[mime]) return map[mime];
  if (msg.photo) return "jpg";
  return "bin";
}

export function fileNameOf(msg) {
  const attrs = (msg.document && msg.document.attributes) || [];
  const attr = attrs.find((a) => a && a.fileName);
  return attr ? attr.fileName : null;
}

export async function getMe() {
  const client = await getClient();
  return client.getMe();
}

export async function disconnect() {
  if (clientPromise) {
    const c = await clientPromise.catch(() => null);
    if (c) await c.disconnect().catch(() => {});
    clientPromise = null;
  }
}

/** 读取单条消息（媒体代理用） */
export async function getMessageById(peer, id) {
  const client = await getClient();
  if (!/^\d+$/.test(String(id))) throw new Error("消息 ID 非法");
  for await (const msg of client.iterMessages(peer, { limit: 1, ids: Number(id) })) {
    return msg;
  }
  return null;
}
