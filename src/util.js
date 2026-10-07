/**
 * 通用工具：HTTP 响应、编码、HTML 凝固、密码学、Cookie。
 * 仅使用 Web 标准 API（Workers / Pages / Node 20+ 通用），不依赖 Buffer。
 */

export class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code || statusText(code) || "error";
  }
}

function statusText(code) {
  switch (code) {
    case 400: return "bad_request";
    case 401: return "unauthorized";
    case 403: return "forbidden";
    case 404: return "not_found";
    case 409: return "conflict";
    case 429: return "rate_limited";
    case 502: return "upstream_error";
    default: return null;
  }
}

export function json(data, init = {}) {
  const headers = new Headers(init.headers || {});
  if (!headers.has("content-type")) headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data), {
    status: init.status || 200,
    headers,
  });
}

export function jsonError(status, message, code, extraHeaders = {}) {
  const headers = new Headers(extraHeaders);
  return json({ error: message, code: code || statusText(status) || "error" }, { status, headers });
}

export function textResponse(body, init = {}) {
  const headers = new Headers(init.headers || {});
  if (!headers.has("content-type")) headers.set("content-type", "text/plain; charset=utf-8");
  return new Response(body, { status: init.status || 200, headers });
}

/* ------------------------------------------------------------------ 编解码 */

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function b64urlEncode(input) {
  const bytes = typeof input === "string" ? textEncoder.encode(input) : input;
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function b64urlDecodeToString(input) {
  const padded = String(input).replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  const binary = atob(padded + pad);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return textDecoder.decode(bytes);
}

export function encodeState(value) {
  return b64urlEncode(JSON.stringify(value));
}

export function decodeState(value, fallback = null) {
  if (!value) return fallback;
  try {
    return JSON.parse(b64urlDecodeToString(value));
  } catch {
    return fallback;
  }
}

export function randomToken(bytes = 32) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return b64urlEncode(buf);
}

export function isValidToken(token) {
  return typeof token === "string" && /^[A-Za-z0-9_-]{22,88}$/.test(token);
}

/* ------------------------------------------------------------------ 密码学 */

export async function sha256Hex(input) {
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(String(input)));
  return bytesToHex(new Uint8Array(digest));
}

export function bytesToHex(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i += 1) out += bytes[i].toString(16).padStart(2, "0");
  return out;
}

/**
 * workerd 对 PBKDF2 迭代次数有硬限制：>100000 会直接抛错
 * （"iteration counts above 100000 are not supported"）
 */
export const MAX_PBKDF2_ITERATIONS = 100000;

export async function pbkdf2Hex(password, saltHex, iterations) {
  const rounds = Math.min(
    Math.max(1, Number(iterations) || 1),
    MAX_PBKDF2_ITERATIONS,
  );
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(String(password)),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: hexToBytes(saltHex),
      iterations: rounds,
    },
    keyMaterial,
    256,
  );
  return bytesToHex(new Uint8Array(bits));
}

export function hexToBytes(hex) {
  const clean = String(hex).replace(/^0x/, "");
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

export function randomHex(bytes = 16) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return bytesToHex(buf);
}

/** 定长比较，避免时序侧信道 */
export function timingSafeEqual(a, b) {
  const strA = String(a);
  const strB = String(b);
  if (strA.length !== strB.length) return false;
  let diff = 0;
  for (let i = 0; i < strA.length; i += 1) diff |= strA.charCodeAt(i) ^ strB.charCodeAt(i);
  return diff === 0;
}

/* -------------------------------------------------------------------- Cookie */

export function parseCookies(request) {
  const header = request.headers.get("cookie") || "";
  const out = {};
  header.split(";").forEach((part) => {
    const idx = part.indexOf("=");
    if (idx < 0) return;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}

export function serializeCookie(name, value, opts = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (opts.maxAge != null) parts.push(`Max-Age=${Math.floor(opts.maxAge)}`);
  parts.push(`Path=${opts.path || "/"}`);
  if (opts.domain) parts.push(`Domain=${opts.domain}`);
  if (opts.httpOnly !== false) parts.push("HttpOnly");
  parts.push(`SameSite=${opts.sameSite || "Lax"}`);
  if (opts.secure) parts.push("Secure");
  return parts.join("; ");
}

export function getClientIp(request) {
  return (
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown"
  );
}

/* -------------------------------------------------------------- HTML 安全化 */

const ALLOWED_TAGS = new Set([
  "a", "b", "strong", "i", "em", "u", "s", "del", "code", "pre",
  "br", "blockquote", "span", "sub", "sup", "mark", "small", "tg-spoiler",
]);

// 这些标签连同内容一起丢弃（脚本/样式等可执行或可注入内容）
const DROP_WITH_CONTENT = new Set([
  "script", "style", "iframe", "object", "embed", "svg", "math", "template",
  "noscript", "link", "meta", "base", "form", "input", "textarea", "select", "button",
]);

function escapeText(segment) {
  return segment.replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function safeHref(raw) {
  if (!raw) return null;
  let href = raw.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
  if (/^(https?:\/\/|tg:\/\/|mailto:)/i.test(href)) return href;
  if (/^\/\//.test(href)) return `https:${href}`;
  return null;
}

function sanitizeAttrs(tag, rawAttrs) {
  if (tag === "a") {
    const m = /(?:^|\s)href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(rawAttrs || "");
    const href = safeHref(m ? (m[2] ?? m[3] ?? m[4]) : null);
    if (!href) return "";
    return ` href="${escapeAttr(href)}" target="_blank" rel="noopener noreferrer nofollow"`;
  }
  if (tag === "span" || tag === "mark" || tag === "sub" || tag === "sup") {
    const m = /(?:^|\s)class\s*=\s*("([^"]*)"|'([^']*)')/i.exec(rawAttrs || "");
    const cls = (m ? (m[2] ?? m[3]) : "") || "";
    if (/^[a-zA-Z0-9_\-\s]{1,64}$/.test(cls.trim())) return ` class="${cls.trim()}"`;
  }
  return "";
}

function escapeAttr(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * 清洗 Telegram 文本 HTML：仅保留白名单标签，a 强制新窗口打开，去掉所有事件属性/样式。
 */
export function sanitizeHtml(input) {
  if (!input) return "";
  const source = String(input);
  const re = /<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
  let out = "";
  let last = 0;
  let m;
  while ((m = re.exec(source)) !== null) {
    out += escapeText(source.slice(last, m.index));
    const isClose = m[0][1] === "/";
    const tag = m[1].toLowerCase();

    if (!isClose && DROP_WITH_CONTENT.has(tag)) {
      const closeIdx = source.toLowerCase().indexOf(`</${tag}`, re.lastIndex);
      if (closeIdx === -1) break;
      const closeEnd = source.indexOf(">", closeIdx);
      re.lastIndex = closeEnd === -1 ? source.length : closeEnd + 1;
      last = re.lastIndex;
      continue;
    }

    last = m.index + m[0].length;
    if (!ALLOWED_TAGS.has(tag)) continue;
    if (isClose) {
      if (tag === "br") continue;
      out += `</${tag}>`;
    } else if (tag === "br") {
      out += "<br>";
    } else {
      out += `<${tag}${sanitizeAttrs(tag, m[2])}>`;
    }
  }
  out += escapeText(source.slice(last));
  return out;
}

export function htmlToText(input) {
  if (!input) return "";
  return String(input)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|blockquote|pre|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function escapeHtml(input) {
  return String(input ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/* ------------------------------------------------------------------ 杂项 */

export function styleUrl(style) {
  if (!style) return null;
  const m = /url\(\s*(['"]?)(.*?)\1\s*\)/.exec(style);
  return m ? m[2] : null;
}

export function decodeDataView(value) {
  if (!value) return {};
  try {
    return JSON.parse(b64urlDecodeToString(value));
  } catch {
    return {};
  }
}

export function absoluteUrl(value) {
  if (!value) return null;
  const v = String(value).trim();
  if (!v || /\s/.test(v)) return null; // 含空白的字符串视为非法地址
  try {
    return new URL(v, "https://t.me").toString();
  } catch {
    return null;
  }
}

export function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function nowSec() {
  return Math.floor(Date.now() / 1000);
}

/** 简单并发池，避免一次性打爆上游 */
export async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = new Array(Math.max(1, Math.min(limit, items.length))).fill(0).map(async () => {
    while (cursor < items.length) {
      const idx = cursor;
      cursor += 1;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

/* -------------------------------------------------- 输入规范化（分享链接） */

/**
 * 把用户粘贴的内容规范成公开频道用户名。
 * 返回：
 *   ""    → 空输入
 *   null  → 认得出来但不支持（私密邀请 / 私密预览链接）
 *   字符串 → 合法用户名
 * 支持：@name、name、https://t.me/name、t.me/name、t.me/s/name、
 *       t.me/name/12345（带消息号）、telegram.me/name、tg://resolve?domain=name
 */
export function normalizeChannelInput(raw) {
  const input = String(raw ?? "").trim();
  if (!input) return "";
  // tg://resolve?domain=xxx / tg://xxx?domain=xxx
  const tg = /tg:\/\/(?:resolve)?\?[^#]*\bdomain=([^&#]+)/i.exec(input);
  if (tg) return cleanUsername(tg[1]);
  let s = input;
  // 去协议（含 tg:// 之外的任意 scheme，如 https://）
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  // 去常见域名前缀
  s = s.replace(/^(?:www\.)?(?:t\.me|telegram\.me|telegram\.dog)\.?/i, "");
  // 先剥掉剥完主机后残留的前导斜杠（/telegram、/joinchat/xxx 都从这里过），
  // 否则下面的私密邀请判断会漏掉 /joinchat/…，被误当成公开频道名 joinchat
  s = s.replace(/^\/+/, "");
  // 私密邀请 / 贴纸包 / 列表邀请：不能按公开频道抓取
  if (/^(?:\+|joinchat\/|addstickers\/|addlist\/|share\/)/i.test(s)) return null;
  // t.me/c/1234567890/42 这种私密预览路径同样不可用
  if (/^c\/\d+/i.test(s)) return null;
  // t.me/s/username 公开预览页
  s = s.replace(/^s\//i, "");
  // 去掉查询串 / 锚点 / 消息号
  s = s.split(/[?#]/)[0];
  s = s.split("/").filter(Boolean)[0] || "";
  s = s.replace(/^@+/, "");
  return cleanUsername(s);
}

function cleanUsername(v) {
  const value = String(v || "").trim().replace(/^@+/, "");
  return /^[A-Za-z0-9_]{4,64}$/.test(value) ? value : null;
}

/** 抽取消息正文里的 #话题 标签（支持中文、字母、数字、下划线），大小写不敏感去重 */
export function extractTags(text) {
  const out = [];
  const seen = new Set();
  // 前一个字符不能是文字/数字（避免把 C# 之类当标签），其余标点后都算标签起点
  const re = /(?<![\p{L}\p{N}_])#([\p{L}\p{N}_]{1,32})/gu;
  const str = String(text ?? "");
  let m;
  while ((m = re.exec(str)) !== null) {
    const tag = m[1].replace(/[.,;:!?，。；：！？、]+$/, "");
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= 16) break;
  }
  return out;
}
