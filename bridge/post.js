/** GramJS 消息 → TG-RSS 统一帖子结构 */

import { Api } from "teleproto";
import { getClient, fileNameOf, guessExtension } from "./client.js";
import { baseUrl } from "./config.js";
import { escapeHtml } from "../src/util.js";

/**
 * peer.id → 实体解析可用的形式（放进 URL 的 ch= 参数）。
 * teleproto resolveId 按符号判类型：正数 → PeerUser（users.getUsers, accessHash 0），
 * 频道会判错 → 冷启动（实体缓存未命中）时 /media、/avatar 直接 500。
 * 数字必须带 -100 前缀才能判成 PeerChannel。
 */
export function peerKeyArg(peer) {
  const id = typeof peer === "object" && peer !== null ? peer.id : peer;
  const s = String(id ?? "");
  if (/^\d+$/.test(s)) return `-100${s}`;
  return s;
}
// 注：媒体/头像 URL 不再拼 ?token=——token 曾随 <img> 直链进 HTML 造成泄露。
// 现在一律经 TG-RSS Worker 代理（服务端注入签名头），浏览器不直连 bridge。

const VIDEO_EXT = ["mp4", "webm", "mov", "mkv", "m4v"];
const AUDIO_EXT = ["mp3", "m4a", "aac", "ogg", "oga", "opus", "wav", "flac"];
const IMAGE_EXT = ["jpg", "jpeg", "png", "gif", "webp", "bmp", "heic"];

const NO_MEDIA = new Set([
  "MessageMediaEmpty",
  "MessageMediaUnsupported",
  "MessageMediaWebPage",
  "MessageMediaPoll",
  "MessageMediaContact",
  "MessageMediaGeo",
  "MessageMediaVenue",
  "MessageMediaGame",
  "MessageMediaInvoice",
  "MessageMediaStory",
  "MessageMediaGiveaway",
]);

export function classifyMedia(msg) {
  if (msg.photo) return "image";
  if (msg.voice) return "audio";
  if (msg.audio) return "audio";
  if (msg.videoNote || msg.gif || msg.video) return "video";
  if (msg.sticker) return "image";
  const doc = msg.document;
  if (!doc) return null;
  const name = (fileNameOf(msg) || guessExtension(msg) || "").toLowerCase();
  const ext = name.includes(".") ? name.split(".").pop() : name;
  if (VIDEO_EXT.includes(ext)) return "video";
  if (AUDIO_EXT.includes(ext)) return "audio";
  if (IMAGE_EXT.includes(ext)) return "image";
  return "file";
}

export function formatSize(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return null;
  const units = ["B", "KB", "MB", "GB"];
  let value = n;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value >= 10 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

export function formatDuration(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (x) => String(x).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

function durationOf(msg) {
  const attrs = (msg.document && msg.document.attributes) || [];
  const attr = attrs.find((a) => a && typeof a.duration === "number" && a.duration > 0);
  return attr ? formatDuration(attr.duration) : null;
}

export function mediaOf(msg, peer) {
  if (!msg.media) return [];
  const cls = msg.media.className || "";
  if (NO_MEDIA.has(cls)) return [];
  const type = classifyMedia(msg);
  if (!type) return [];

  const base = baseUrl();
  const url = `${base}/media?ch=${encodeURIComponent(peerKeyArg(peer))}&m=${msg.id}`;
  return [
    {
      type,
      url,
      thumb: null,
      name: type === "file" || type === "audio" ? fileNameOf(msg) : null,
      size: msg.document ? formatSize(msg.document.size) : null,
      duration: durationOf(msg),
      permalink: null,
    },
  ];
}

export function messageToPost(msg, peer, extra = {}) {
  const username = extra.username || null;
  const text = msg.message || "";
  return {
    id: username ? `${username}/${msg.id}` : `${peer.id}/${msg.id}`,
    key: String(msg.id),
    postId: msg.id,
    url: username ? `https://t.me/${username}/${msg.id}` : null,
    date: msg.date ? new Date(msg.date).toISOString() : null,
    textHtml: text ? escapeHtml(text).replace(/\n/g, "<br>") : "",
    textPlain: text,
    views: msg.views ? String(msg.views) : null,
    comments: msg.replies && msg.replies.replies ? String(msg.replies.replies) : null,
    author: msg.fwdFrom
      ? { name: extra.forwardFromLabel || "转发", url: null }
      : null,
    media: mediaOf(msg, peer),
    channelId: `-${peer.id ?? ""}`,
  };
}

export async function peerInfo(entity) {
  const base = baseUrl();
  const info = {
    title: entity.title || entity.firstName || "频道",
    username: entity.usernames?.[0]?.activeUsername || entity.username || null,
    avatar: `${base}/avatar?ch=${encodeURIComponent(peerKeyArg(entity))}`,
    description: "",
    counters: {},
  };

  try {
    const client = await getClient();
    const full = await client.invoke(new Api.channels.GetFullChannel({ channel: entity }));
    const fullInfo = full.full || {};
    if (fullInfo.about) info.description = String(fullInfo.about);
    const count = fullInfo.participantsCount;
    if (typeof count === "number" && count > 0) info.counters = { subscribers: formatCount(count) };
  } catch {
    // 私密频道/权限不足时忽略
  }
  return info;
}

function formatCount(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}
