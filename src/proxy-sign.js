/**
 * 代理 URL 签名（H-1：防 bridge 私密媒体被枚举）。
 *
 * 问题：`/api/media/proxy?u=<base64url>` 本身无鉴权。私密频道媒体走该代理时，
 * URL 会出现在 RSS enclosure / 前端 DOM 里；攻击者拿到一个后，改 base64 里的
 * ch/m 字段即可枚举**任意**私密频道的媒体。
 *
 * 方案：出站时用 bridge token 对 `u` 值签名，代理入口验签。浏览器 `<img src>`
 * 无法带自定义头，所以签名必须内联在 URL 里（`&sig=<sig>&exp=<unix秒>`）。
 *
 *   sig = base64url(HMAC-SHA256(token, `proxy\n${u}\n${exp}`))
 *
 * 签名带过期时间：RSS 令牌轮换/吊销后，已发出的旧 URL 随 exp 过期而失效
 * （无 exp 或过期的 URL 直接拒绝——这是 breaking change，旧签发 URL 会立刻 403）。
 *
 * 只对**桥接主机**的媒体签名（公开频道媒体本就公开，无需保护）；token 为空则不签。
 */
const enc = new TextEncoder();

function b64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 对 base64url 的 u 值签名（载荷含过期时间）；token 空则返回空串（不签名） */
export async function signProxyU(token, u, exp) {
  if (!token || !u) return "";
  const key = await crypto.subtle.importKey("raw", enc.encode(String(token)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(`proxy\n${u}\n${exp}`));
  return b64url(new Uint8Array(mac));
}

/** 校验 u 的签名：恒定时间比较 + 过期拒绝（无 exp / 非法 / 已过期 → false） */
export async function verifyProxySig(token, u, sig, exp) {
  if (!token || !u || !sig || exp == null || exp === "") return false;
  const expNum = Number(exp);
  if (!Number.isFinite(expNum) || expNum <= Date.now() / 1000) return false;
  const expected = await signProxyU(token, u, exp);
  if (expected.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}
