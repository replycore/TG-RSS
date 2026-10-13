/**
 * TG-RSS Worker → bridge 的请求签名（与 bridge/auth.js 的约定一致）：
 *   x-timestamp : Unix 秒
 *   x-signature : base64(HMAC-SHA256(token, `${ts}\n${METHOD}\n${path}?${query}`))
 *
 * token 从不放进 URL/查询串——它只作为 HMAC 密钥参与签名，请求本身不携带 token 值。
 * 时间窗 ±300s 且路径绑定，单次请求在网络/日志泄露也无法跨路径或过窗重放。
 */

export const BRIDGE_SIGN_WINDOW_SEC = 300;

/**
 * 校验 bridge 的响应签名（双向校验的反向方向）。
 * bridge 对每个响应回签：x-bridge-timestamp + x-bridge-signature
 *   = base64(HMAC-SHA256(token, `${ts}\n${status}\n${METHOD}\n${path}?${query}`))
 *
 * 挡的是「伪造的 bridge / 中间人篡改响应」：没持 token 就签不出合法头。
 * 时间窗复用请求侧的窗口配置。
 */
export async function verifyBridgeResponse(bridge, res, method, pathWithQuery) {
  const token = String((bridge && bridge.token) || "");
  if (!token) return { ok: false, reason: "no_token" };
  const ts = res.headers.get("x-bridge-timestamp");
  const sig = res.headers.get("x-bridge-signature");
  if (!ts || !sig) return { ok: false, reason: "unsigned" };
  const tsNum = Number(ts);
  const now = Math.floor(Date.now() / 1000);
  // 窗口对称（v1.2.6 在请求方向修过同类问题）：bridge 侧窗口可配 60~3600，
  // 这里写死 300 会在「大窗口 + 较大时钟差」时误报（请求能过、响应过不了）。
  // 策略：bridge 可通过 x-bridge-window-sec 自报窗口，取 max(默认, 本值)，但 cap 到 3600——
  // H-2：该值已纳入签名载荷（改 header 就验不过），cap 到 3600 防中间人借超大窗口做重放。
  const declaredRaw = Number(res.headers.get("x-bridge-window-sec"));
  const declared = Number.isFinite(declaredRaw) && declaredRaw > 0 ? Math.min(declaredRaw, 3600) : 0;
  const windowSec = Math.max(BRIDGE_SIGN_WINDOW_SEC, declared);
  // 把 bridge 时间戳带回来：stale 时调用方可算 drift（= bridge 时钟 - 本机时钟），给 NTP 指引
  const out = { bridgeTime: tsNum, windowSec };
  if (!Number.isFinite(tsNum) || Math.abs(now - tsNum) > windowSec) {
    return { ok: false, reason: "stale", ...out };
  }
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(token), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const payload = `${ts}\n${res.status}\n${String(method).toUpperCase()}\n${pathWithQuery}\n${declared || ""}`;
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac)));
  // 恒定时间比较：避免按响应时间逐字节爆破 token 派生的签名
  if (expected.length !== sig.length) return { ok: false, reason: "bad_signature" };
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0 ? { ok: true } : { ok: false, reason: "bad_signature" };
}

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
