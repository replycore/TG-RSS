/**
 * 桥接访问鉴权
 *
 * 认证方式（按优先级）：
 *   1. HMAC 签名 ← TG-RSS Worker 默认方式。token 不出现在任何请求/URL 中：
 *        x-timestamp : Unix 秒
 *        x-signature : base64(HMAC-SHA256(token, `${ts}\n${METHOD}\n${path}?${query}`))
 *      时间窗 ±300s 且绑定方法+完整路径——单次请求在网络/日志里泄露也无法跨路径或过窗重放。
 *   2. x-token 请求头 / Authorization: Bearer <token>（旧版 Worker 兼容、curl 调试）
 *   3. Origin 白名单（可选 BRIDGE_ALLOWED_ORIGINS）：仅约束「头认证」请求——
 *      签名请求已证明持有 token 不再要求；未配置则不限制
 *
 * 已移除 ?token= 查询参数支持：媒体/头像一律经 TG-RSS Worker 代理（服务端注入认证头），
 * 浏览器不再直连 bridge，token 从根上不进 HTML/URL。
 */
import crypto from "node:crypto";

/** 签名时间窗（秒） */
export const SIGN_WINDOW_SEC = 300;

/** 恒定时间比较，避免按响应时间逐字节爆破 token */
export function equalString(a, b) {
  const strA = String(a);
  const strB = String(b);
  if (strA.length !== strB.length) return false;
  let diff = 0;
  for (let i = 0; i < strA.length; i += 1) {
    diff |= strA.charCodeAt(i) ^ strB.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * 读请求头：同时兼容 Fetch API 的 Headers（.get）与 Node http 的普通对象 headers。
 * Node http.createServer 的 req.headers 是普通对象（键全小写，可能是字符串或数组），
 * 直接调 .get() 会抛 TypeError → 500（真实桥接请求全挂，单测 mock 掩盖了这一点）。
 */
function headerValue(req, name) {
  const headers = req && req.headers;
  if (!headers) return "";
  if (typeof headers.get === "function") return headers.get(name) || "";
  const value = headers[String(name).toLowerCase()];
  if (Array.isArray(value)) return value.join(", ");
  return value == null ? "" : String(value);
}

/** 签名载荷：`${ts}\n${METHOD}\n${path}?query`（与 Worker 端 src/bridge-sign.js 约定一致） */
export function signPayload(token, timestamp, method, pathWithQuery) {
  return crypto
    .createHmac("sha256", String(token))
    .update(`${timestamp}\n${method}\n${pathWithQuery}`)
    .digest("base64");
}

export function verifySignature(url, req, token, opts = {}) {
  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const windowSec = Number(opts.windowSec) > 0 ? Number(opts.windowSec) : SIGN_WINDOW_SEC;
  const tsRaw = headerValue(req, "x-timestamp");
  const sig = headerValue(req, "x-signature");
  if (!tsRaw || !sig || !token) return false;
  const ts = Number(tsRaw);
  if (!Number.isFinite(ts) || Math.abs(nowSec - ts) > windowSec) return false;
  const method = String((req && req.method) || "GET").toUpperCase();
  const expected = Buffer.from(signPayload(token, tsRaw, method, url.pathname + url.search));
  const actual = Buffer.from(sig);
  // 等长才比较（timingSafeEqual 对不等长抛错）
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

/** 任意载荷的 HMAC-SHA256(base64)，token 只作密钥不出现在任何输出里 */
function hmacB64(token, payload) {
  return crypto.createHmac("sha256", String(token)).update(payload).digest("base64");
}

/**
 * 响应签名（双向校验的反向方向）：TG-RSS 用同一 token 作密钥验证 bridge 确实持有它——
 * 挡住「伪造的 bridge 返回假数据/假媒体」，也挡住中间人篡改响应。
 *
 *   x-bridge-timestamp : Unix 秒
 *   x-bridge-signature : base64(HMAC-SHA256(token, `${ts}\n${status}\n${method}\n${path}?${query}`))
 *
 * 不签 body：媒体走 Range 流式传输，签 body 需整包缓冲（几百 MB）。
 * 时间窗 + 路径/状态绑定已足够：改内容不改状态码无法得到新签名。
 */
export function responseSignatureHeaders({ token, status, method, pathWithQuery }) {
  if (!token) return {};
  const ts = String(Math.floor(Date.now() / 1000));
  const payload = `${ts}\n${status}\n${String(method || "GET").toUpperCase()}\n${pathWithQuery}`;
  return {
    "x-bridge-timestamp": ts,
    "x-bridge-signature": hmacB64(token, payload),
  };
}

/** Origin 白名单（仅头认证请求使用）：比较 URL 的 origin（scheme://host[:port]） */
function originAllowed(req, allowedOrigins) {
  if (!allowedOrigins || !allowedOrigins.length) return true;
  const raw = headerValue(req, "origin") || headerValue(req, "referer");
  if (!raw) return false;
  let origin;
  try {
    origin = new URL(raw).origin;
  } catch {
    return false;
  }
  return allowedOrigins.includes(origin);
}

export function authorized(url, req, token, opts = {}) {
  if (!token) return true; // requireConfig 已强制必须配置 token，这里只是兜底
  if (verifySignature(url, req, token, opts)) return true;
  const allowed = opts.allowedOrigins || [];
  const header = headerValue(req, "authorization");
  if (header && equalString(header, `Bearer ${token}`) && originAllowed(req, allowed)) return true;
  const xToken = headerValue(req, "x-token");
  if (xToken && equalString(xToken, token) && originAllowed(req, allowed)) return true;
  return false;
}
