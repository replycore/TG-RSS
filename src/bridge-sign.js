/**
 * TG-RSS Worker → bridge 的请求签名（与 bridge/auth.js 的约定一致）：
 *   x-timestamp : Unix 秒
 *   x-signature : base64(HMAC-SHA256(token, `${ts}\n${METHOD}\n${path}?${query}`))
 *
 * token 从不放进 URL/查询串——它只作为 HMAC 密钥参与签名，请求本身不携带 token 值。
 * 时间窗 ±300s 且路径绑定，单次请求在网络/日志泄露也无法跨路径或过窗重放。
 */

export const BRIDGE_SIGN_WINDOW_SEC = 300;

/** 生成 bridge 认证头。pathWithQuery 必须与 bridge 侧 req.url 的 path?query 完全一致 */
export async function bridgeSignedHeaders(bridge, method, pathWithQuery) {
  const ts = String(Math.floor(Date.now() / 1000));
  const token = String((bridge && bridge.token) || "");
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(token),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(`${ts}\n${method}\n${pathWithQuery}`));
  const bytes = new Uint8Array(mac);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
  return {
    "x-timestamp": ts,
    "x-signature": btoa(bin),
  };
}
