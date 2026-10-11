/**
 * 桥接访问鉴权
 *
 * 支持三种传法（都对应同一个 BRIDGE_TOKEN）：
 *   1. x-token 请求头        ← TG-RSS Worker 实际使用的方式（关键）
 *   2. Authorization: Bearer <token>
 *   3. ?token=<token> 查询参数（媒体 URL 需要能被 <img> 直接引用时用）
 */

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

export function authorized(url, req, token) {
  if (!token) return true; // requireConfig 已强制必须配置 token，这里只是兜底
  const header = headerValue(req, "authorization");
  if (header && equalString(header, `Bearer ${token}`)) return true;
  const xToken = headerValue(req, "x-token");
  if (xToken && equalString(xToken, token)) return true;
  const q = url.searchParams.get("token");
  if (q && equalString(q, token)) return true;
  return false;
}
