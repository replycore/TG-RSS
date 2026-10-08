/**
 * KV 存储层：设置、频道、管理员凭据、会话、限流计数。
 * 所有 KV 读写都做 JSON 容错 + 默认值合并。
 */
import { normalizeChannelInput, pbkdf2Hex, randomHex, nowSec, timingSafeEqual, sha256Hex } from "./util.js";

export const KEYS = {
  general: "settings:general",
  channels: "settings:channels",
  media: "settings:media",
  bridge: "settings:bridge",
  cred: "admin:cred",
  session: "auth:sess:",
  rateLimit: "auth:limit:",
  meta: "channel:meta:",
  sync: "channel:sync:",
};

export const DEFAULTS = {
  general: {
    siteTitle: "TG-RSS",
    pageSize: 20,
    cacheTtl: 120,
    feedChannels: 6,
    showViews: true,
    showDate: true,
    theme: "auto",
  },
  media: {
    video: true,
    image: true,
    audio: true,
    file: true,
    pageSize: 24,
    proxyAll: true,
  },
  channels: [],
  bridge: {
    url: "",
    token: "",
    enabled: false,
  },
};

export const SESSION_TTL = 7 * 24 * 3600; // 7 天
export const PBKDF2_ITERATIONS = 100000;

function kv(env) {
  const store = env && env.TG_RSS_KV;
  if (!store) throw new Error("Missing KV binding TG_RSS_KV");
  return store;
}

export async function readJSON(env, key, fallback) {
  try {
    const raw = await kv(env).get(key, "json");
    if (raw == null) return fallback;
    return raw;
  } catch (err) {
    if (err instanceof Error && /Missing KV binding/.test(err.message)) throw err;
    return fallback;
  }
}

export async function writeJSON(env, key, value, opts = {}) {
  const store = kv(env);
  const init = { type: "json" };
  if (opts.expirationTtl) init.expirationTtl = opts.expirationTtl;
  await store.put(key, JSON.stringify(value), init);
}

export async function deleteKey(env, key) {
  await kv(env).delete(key);
}

export function mergeDefaults(kind, value) {
  const base = DEFAULTS[kind];
  if (Array.isArray(base)) return Array.isArray(value) ? value : base;
  if (value && typeof value === "object") return { ...base, ...value };
  return base;
}

export const getGeneral = (env) => readJSON(env, KEYS.general, null).then((v) => mergeDefaults("general", v));
export const getMediaSettings = (env) => readJSON(env, KEYS.media, null).then((v) => mergeDefaults("media", v));
export const getBridgeSettings = (env) => readJSON(env, KEYS.bridge, null).then((v) => mergeDefaults("bridge", v));

export async function getChannels(env) {
  const list = await readJSON(env, KEYS.channels, null);
  const arr = Array.isArray(list) ? list : [];
  return arr.map(normalizeChannel).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

export async function saveChannels(env, channels) {
  const normalized = channels.map((ch, idx) => ({ ...normalizeChannel(ch), order: idx }));
  await writeJSON(env, KEYS.channels, normalized);
  return normalized;
}

export function normalizeChannel(input) {
  const type = input.type === "private" ? "private" : "public";
  const username = type === "public" ? String(input.username || "").replace(/^@/, "") : "";
  const tgId = type === "private" ? String(input.tgId || "").replace(/^\+/, "") : "";
  const key = type === "public" ? username.toLowerCase() : `p${tgId.replace(/^-/, "")}`;
  return {
    key,
    type,
    username,
    tgId,
    name: String(input.name || username || tgId || "未命名频道").slice(0, 80),
    order: Number.isFinite(input.order) ? input.order : 0,
    hidden: !!input.hidden,
    mediaOnly: !!input.mediaOnly,
    enabled: input.enabled !== false,
    addedAt: input.addedAt || nowSec(),
    note: String(input.note || "").slice(0, 200),
  };
}

export function validateChannel(input) {
  const type = input.type === "private" ? "private" : "public";
  if (type === "public") {
    // 兼容分享链接：t.me/xxx、t.me/s/xxx、@xxx、tg://resolve?domain=xxx 等
    const username = normalizeChannelInput(input.username);
    if (username === null) {
      return {
        error: "该链接不是公开频道：私密邀请（t.me/+…/joinchat）无法按公开频道抓取，改用「私密频道」方式添加",
      };
    }
    if (!username) {
      return { error: "请输入频道用户名或 t.me 分享链接（如 t.me/telegram、@telegram）" };
    }
    return { channel: normalizeChannel({ ...input, type, username }) };
  }
  const tgId = String(input.tgId || "").trim();
  if (!/^-?\d{5,25}$/.test(tgId)) {
    return { error: "私密频道需要数字 ID（形如 -1001234567890）" };
  }
  return { channel: normalizeChannel({ ...input, type, tgId }) };
}

/* ------------------------------------------------------------ 频道元信息缓存 */

export async function getChannelMeta(env, key) {
  return readJSON(env, KEYS.meta + key, null);
}

export async function putChannelMeta(env, key, meta) {
  await writeJSON(env, KEYS.meta + key, meta, { expirationTtl: 30 * 24 * 3600 });
}

export async function getSyncState(env, key) {
  return readJSON(env, KEYS.sync + key, null);
}

export async function putSyncState(env, key, state) {
  await writeJSON(env, KEYS.sync + key, state, { expirationTtl: 7 * 24 * 3600 });
}

/* -------------------------------------------------------------- 管理员凭据 */

/**
 * 凭据优先级：环境变量 > KV 首次初始化 > 未初始化
 * @returns {{source:'env'|'kv'|null, username?:string, ...}}
 */
export async function getAdminCredential(env) {
  const envPassword = env && env.ADMIN_PASSWORD;
  if (envPassword) {
    return {
      source: "env",
      username: (env.ADMIN_USERNAME || "admin").trim(),
      password: String(envPassword),
    };
  }
  const cred = await readJSON(env, KEYS.cred, null);
  if (cred && cred.salt && cred.hash) {
    return {
      source: "kv",
      username: cred.username || "admin",
      salt: cred.salt,
      hash: cred.hash,
      iterations: cred.iterations || PBKDF2_ITERATIONS,
      updatedAt: cred.updatedAt || 0,
    };
  }
  return { source: null };
}

export async function createAdminCredential(env, username, password) {
  const salt = randomHex(16);
  const iterations = PBKDF2_ITERATIONS;
  const hash = await pbkdf2Hex(password, salt, iterations);
  const cred = { username: username || "admin", salt, hash, iterations, updatedAt: nowSec() };
  await writeJSON(env, KEYS.cred, cred);
  return cred;
}

export async function verifyPassword(credential, password) {
  if (!credential || credential.source == null) return false;
  if (credential.source === "env") {
    const [a, b] = await Promise.all([sha256Hex(password), sha256Hex(credential.password)]);
    return timingSafeEqual(a, b);
  }
  const hash = await pbkdf2Hex(password, credential.salt, credential.iterations);
  return timingSafeEqual(hash, credential.hash);
}

export function isInitialized(credential) {
  return !!credential && credential.source != null;
}

/* ------------------------------------------------------------------- 会话 */

export async function createSession(env, payload = {}) {
  const token = randomHex(32);
  const record = {
    ...payload,
    role: "admin",
    createdAt: nowSec(),
    exp: nowSec() + SESSION_TTL,
  };
  await writeJSON(env, KEYS.session + token, record, { expirationTtl: SESSION_TTL });
  return token;
}

export async function getSession(env, token) {
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const record = await readJSON(env, KEYS.session + token, null);
  if (!record) return null;
  if (record.exp && record.exp < nowSec()) {
    await deleteKey(env, KEYS.session + token);
    return null;
  }
  return { token, ...record };
}

export async function destroySession(env, token) {
  if (token) await deleteKey(env, KEYS.session + token);
}

/* --------------------------------------------------------------- 登录限流 */

/* 登录/初始化限流：8 次 / 5 分钟（KV 为跨实例兜底）
   第一层是进程内内存桶：同 isolate 内无竞态、零网络开销；
   第二层 KV 计数采用「先记账后放行」的预扣语义，
   避免旧实现「先检查、失败后才记账」窗口里并发请求绕过计数。 */
const RATE_WINDOW = 300; // 5 分钟
const RATE_MAX = 8;
const memoryBuckets = new Map();

export async function checkRateLimit(env, ip) {
  const key = KEYS.rateLimit + ip;
  const rec = await readJSON(env, key, null);
  if (!rec) return { allowed: true, remaining: RATE_MAX };
  if (rec.exp && rec.exp < nowSec()) return { allowed: true, remaining: RATE_MAX };
  if (rec.count >= RATE_MAX) return { allowed: false, remaining: 0, retryAfter: (rec.exp || 0) - nowSec() };
  return { allowed: true, remaining: RATE_MAX - rec.count };
}

function memoryConsume(ip) {
  const now = nowSec();
  if (memoryBuckets.size > 5000) {
    for (const [k, v] of memoryBuckets) if (v.exp <= now) memoryBuckets.delete(k);
  }
  let rec = memoryBuckets.get(ip);
  if (!rec || rec.exp <= now) {
    rec = { count: 0, exp: now + RATE_WINDOW };
    memoryBuckets.set(ip, rec);
  }
  rec.count += 1;
  if (rec.count > RATE_MAX) return { allowed: false, retryAfter: Math.max(1, rec.exp - now) };
  return { allowed: true, remaining: RATE_MAX - rec.count };
}

/**
 * 预扣一次尝试：任一层超限即拒。成功登录后用 resetRateLimit 归零。
 * 返回 { allowed, retryAfter? }。
 */
export async function consumeRateLimit(env, ip) {
  const mem = memoryConsume(ip);
  if (!mem.allowed) return mem;
  const rec = await bumpRateLimit(env, ip); // 记账（预扣）
  if (rec.count > RATE_MAX) return { allowed: false, retryAfter: Math.max(1, (rec.exp || 0) - nowSec()) };
  return { allowed: true, remaining: Math.max(0, RATE_MAX - rec.count) };
}

export async function bumpRateLimit(env, ip) {
  const key = KEYS.rateLimit + ip;
  const rec = (await readJSON(env, key, null)) || { count: 0, exp: nowSec() + RATE_WINDOW };
  if (rec.exp < nowSec()) {
    rec.count = 0;
    rec.exp = nowSec() + RATE_WINDOW;
  }
  rec.count += 1;
  await writeJSON(env, key, rec, { expirationTtl: RATE_WINDOW });
  return rec;
}

export async function resetRateLimit(env, ip) {
  memoryBuckets.delete(ip);
  await deleteKey(env, KEYS.rateLimit + ip);
}
