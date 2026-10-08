/**
 * RSS 订阅令牌（带 token 访问私密/隐藏频道）。
 *
 * 安全设计：
 * - 令牌为 32 字节随机数（43 字符 base64url），**只存 SHA-256 哈希**，明文仅轮换时返回一次；
 * - 校验用定长哈希 + timingSafeEqual 恒时比较（不比对可变长明文）；
 * - 校验同时支持 query `?token=` 与 `Authorization: Bearer`（阅读器可选其一）；
 * - 错误令牌按 IP 限流（20 次/分钟，进程内桶 + KV 兜底，先记账后放行）；
 * - 令牌只被 RSS 端点消费，不参与任何其它接口的鉴权，泄露面收敛在订阅输出；
 * - 未配置令牌时公开行为完全不变；配置后私密/隐藏频道才可能出现在带 token 的源里。
 */
import { readJSON, writeJSON, deleteKey, KEYS } from "./store.js";
import { sha256Hex, timingSafeEqual, randomToken, getClientIp, HttpError } from "./util.js";

const FAIL_MAX = 20; // 每 IP 每分钟允许的错误令牌次数
const FAIL_WINDOW = 60; // 秒
const failBuckets = new Map();

/** 从 query 或 Bearer 头提取令牌（都取不到返回 ""） */
export function extractRssToken(request, url) {
  const q = (url.searchParams.get("token") || "").trim();
  if (q) return q.slice(0, 200);
  const auth = request.headers.get("authorization") || "";
  const m = /^Bearer\s+(\S+)/i.exec(auth.trim());
  return m ? m[1].slice(0, 200) : "";
}

export async function getRssTokenInfo(env) {
  return readJSON(env, KEYS.rssToken, null); // { hash, masked, createdAt }
}

/** 生成新令牌并落库（旧令牌立即失效）。明文只在这一次返回。 */
export async function rotateRssToken(env, origin) {
  const token = randomToken(32);
  const hash = await sha256Hex(token);
  const masked = `${token.slice(0, 6)}…${token.slice(-4)}`;
  await writeJSON(env, KEYS.rssToken, { hash, masked, createdAt: Date.now() });
  const url = `${origin}/rss.xml?token=${encodeURIComponent(token)}`;
  return { token, masked, url };
}

export async function revokeRssToken(env) {
  await deleteKey(env, KEYS.rssToken);
}

function failConsumeMemory(ip) {
  const now = Date.now();
  if (failBuckets.size > 5000) {
    for (const [k, v] of failBuckets) if (now - v.start >= FAIL_WINDOW * 1000) failBuckets.delete(k);
  }
  let rec = failBuckets.get(ip);
  if (!rec || now - rec.start >= FAIL_WINDOW * 1000) {
    rec = { start: now, count: 0 };
    failBuckets.set(ip, rec);
  }
  rec.count += 1;
  if (rec.count > FAIL_MAX) {
    return { allowed: false, retryAfter: Math.max(1, Math.ceil((FAIL_WINDOW * 1000 - (now - rec.start)) / 1000)) };
  }
  return { allowed: true };
}

async function failConsume(env, ip) {
  const mem = failConsumeMemory(ip);
  if (!mem.allowed) return mem;
  const key = KEYS.rssTokenLimit + ip;
  const rec = (await readJSON(env, key, null)) || { count: 0, exp: Math.floor(Date.now() / 1000) + FAIL_WINDOW };
  const nowSec = Math.floor(Date.now() / 1000);
  if (rec.exp < nowSec) {
    rec.count = 0;
    rec.exp = nowSec + FAIL_WINDOW;
  }
  rec.count += 1;
  await writeJSON(env, key, rec, { expirationTtl: FAIL_WINDOW });
  if (rec.count > FAIL_MAX) {
    return { allowed: false, retryAfter: Math.max(1, rec.exp - nowSec) };
  }
  return { allowed: true };
}

/**
 * 校验请求里的 RSS 令牌。
 * 返回 { state: "none" | "valid" | "invalid", provided: boolean }。
 * - none：未携带令牌（或站点未配置令牌但也没带）→ 走公开视图
 * - valid：令牌正确 → 私密/隐藏频道可见
 * - invalid：带了但不对（含站点已禁用而仍携带旧令牌）→ 401；错误次数超限 → 429
 */
export async function checkRssToken(request, env, url) {
  const provided = extractRssToken(request, url);
  if (!provided) return { state: "none", provided: false };

  const info = await getRssTokenInfo(env);
  if (!info || !info.hash) {
    // 已吊销/未启用但请求仍带令牌：明确拒绝（也覆盖轮换后的旧令牌）
    await assertFailQuota(env, request);
    return { state: "invalid", provided: true };
  }

  const digest = await sha256Hex(provided);
  if (timingSafeEqual(digest, info.hash)) return { state: "valid", provided: true };

  await assertFailQuota(env, request);
  return { state: "invalid", provided: true };
}

async function assertFailQuota(env, request) {
  const ip = getClientIp(request);
  const r = await failConsume(env, ip);
  if (!r.allowed) {
    const err = new HttpError(429, "令牌尝试次数过多，请稍后再试", "rate_limited");
    err.retryAfter = Math.max(30, r.retryAfter || 60);
    throw err;
  }
}
