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

export function authorized(url, req, token) {
  if (!token) return true; // requireConfig 已强制必须配置 token，这里只是兜底
  const header = String(req.headers.get("authorization") || "");
  if (header && equalString(header, `Bearer ${token}`)) return true;
  const xToken = req.headers.get("x-token");
  if (xToken && equalString(String(xToken), token)) return true;
  const q = url.searchParams.get("token");
  if (q && equalString(q, token)) return true;
  return false;
}
