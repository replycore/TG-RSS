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

export async function resolvePeer(value) {
  const client = await getClient();
  return client.getEntity(toEntityArg(value));
}

export async function fetchMessages(peer, { before = null, limit = 20 } = {}) {
  const client = await getClient();
  const options = { limit: Math.max(1, Math.min(50, limit)) };
  if (before && /^\d+$/.test(String(before))) options.offsetId = Number(before);

  const out = [];
  for await (const msg of client.iterMessages(peer, options)) {
    out.push(msg);
    if (out.length >= options.limit) break;
  }
  return out;
}

/** 下载媒体到本地缓存，返回绝对路径 */
export async function downloadMediaToCache(peer, msg) {
  const client = await getClient();
  const channelId = String(peer.id ?? peer);
  const base = `${channelId}_${msg.id}`;
  const dir = config.cacheDir;
  fs.mkdirSync(dir, { recursive: true });

  const existing = fs.readdirSync(dir).find((f) => f.startsWith(`${base}.`));
  if (existing) return path.join(dir, existing);

  const ext = guessExtension(msg);
  const tmp = path.join(dir, `${base}.${ext}.part`);
  const target = path.join(dir, `${base}.${ext}`);

  let buffer;
  try {
    buffer = await client.downloadMedia(msg.media ?? msg, {});
  } catch {
    buffer = await client.downloadMedia(msg, {});
  }
  if (!buffer || !buffer.length) throw new Error("媒体下载失败");

  fs.writeFileSync(tmp, buffer);
  fs.renameSync(tmp, target);
  return target;
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
