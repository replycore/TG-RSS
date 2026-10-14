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
  rssToken: "auth:rssToken",
  rssTokenLimit: "auth:rssLimit:",
  // meta2：1.2.4 换前缀一次性作废旧缓存——旧缓存里的 bridge avatar URL 带 ?token=（泄露面）
  meta: "channel:meta2:",
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
    adTagsExtra: [],
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
  // Nit 3：Workers KV put 不需要/不识别 type 参数（那是 D1 的概念），移除
  const init = {};
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
  // 历史正数脏数据归一化：Telegram 频道 ID 为负数形式，正数会被桥接端判成 PeerUser
  // （validateChannel 已拒绝新增正数，这里兜住存量数据的读/存）
  const tgIdNormalized = type === "private" && /^\d+$/.test(tgId) ? `-${tgId}` : tgId;
  // 私密 key 带类型命名空间：旧格式 p<无符号数字> 会与公开用户名 p<数字> 撞 key
  // （如公开 p12345 vs 私密 -12345），新格式 priv:-100… 保留前导负号
  const key = type === "public" ? username.toLowerCase() : `priv:${tgIdNormalized}`;
  return {
    key,
    type,
    username,
    tgId: tgIdNormalized,
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
  // 必须带负号：Telegram 频道 ID 恒为负数形式（-100…）。正数发给桥接端
  // 会被 teleproto 判成 PeerUser，peer 解析必然失败
  if (!/^-\d{5,25}$/.test(tgId)) {
    return { error: "私密频道需要负数数字 ID（形如 -1001234567890）；正数会被桥接端误判为用户" };
  }
  const channel = normalizeChannel({ ...input, type, tgId });
  // 私密频道强制隐藏：只对管理员会话或持有 RSS token 的请求可见
  channel.hidden = true;
  return { channel };
}

/* ------------------------------------------------------------ 频道元信息缓存 */

export async function getChannelMeta(env, key) {
  return readJSON(env, KEYS.meta + key, null);
}

export async function putChannelMeta(env, key, meta) {
  await writeJSON(env, KEYS.meta + key, meta, { expirationTtl: 30 * 24 * 3600 });
}

/* ------------------------------------------------------ 存量私密 key 迁移 */

// 旧私密 key 格式：p<无符号数字>（如 p1001234567890），与公开用户名 p<数字> 撞命名空间。
// 新格式为 priv:-100…。迁移把该频道 key 下的全部 KV 数据拷贝到新 key 后删旧 key，
// 并更新频道列表。幂等：无 legacy key 时是 no-op。
const LEGACY_PRIVATE_KEY_RE = /^p\d+$/;
const META_TTL = 30 * 24 * 3600;

export async function migrateLegacyPrivateKeys(env) {
  const list = await readJSON(env, KEYS.channels, null);
  if (!Array.isArray(list) || list.length === 0) return { migrated: 0 };
  let migrated = 0;
  for (const ch of list) {
    if (!ch || ch.type !== "private" || typeof ch.key !== "string" || !LEGACY_PRIVATE_KEY_RE.test(ch.key)) {
      continue;
    }
    const newKey = normalizeChannel(ch).key; // priv:-100…（读路径同样归一化，保证一致）
    if (newKey === ch.key) continue;
    // 该频道 key 下的 KV 数据：目前只有 channel:meta2:（grep 全仓库确认无其它前缀）
    const oldMeta = await readJSON(env, KEYS.meta + ch.key, null);
    if (oldMeta != null) {
      await writeJSON(env, KEYS.meta + newKey, oldMeta, { expirationTtl: META_TTL });
      await deleteKey(env, KEYS.meta + ch.key);
    }
    ch.key = newKey;
    migrated += 1;
  }
  if (migrated > 0) await writeJSON(env, KEYS.channels, list);
  return { migrated };
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

/* 会话纪元：Workers KV 的 Worker API 没有 list()，无法枚举 session key 批量删除；
   改密码时 bump 纪元，让所有旧会话在下一次 getSession 时被判失效（惰性批量注销） */
const AUTH_EPOCH_KEY = "auth:epoch";

export async function getAuthEpoch(env) {
  const value = await readJSON(env, AUTH_EPOCH_KEY, 0);
  return Number(value) || 0;
}

export async function bumpAuthEpoch(env) {
  // 语义说明：epoch 只需单调变化（让旧会话在下次 getSession 时失效），不保证精确 +N。
  // 并发改密码时多次 bump 可能 collapse 成 +1，这是可接受的——失效旧会话的目的照样达到。
  const next = (await getAuthEpoch(env)) + 1;
  await writeJSON(env, AUTH_EPOCH_KEY, next);
  return next;
}

export async function createSession(env, payload = {}) {
  const token = randomHex(32);
  const record = {
    ...payload,
    role: "admin",
    epoch: await getAuthEpoch(env),
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
  // 纪元校验：改密码后 epoch 变了 → 旧会话全部失效（含本会话，登录页会要求重新登录）
  if ((Number(record.epoch) || 0) !== (await getAuthEpoch(env))) {
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
   第二层 KV 记账采用「每请求独立 key + list 聚合」：并发请求各自写
   auth:limit:{ip}:{随机}（TTL=窗口秒数），检查时按前缀 list 计数——
   不再做 read→+1→write，跨 isolate 并发也不会丢更新。
   保持「先记账后放行」的预扣语义，避免旧实现「先检查、失败后才记账」
   窗口里并发请求绕过计数。 */
const RATE_WINDOW = 300; // 5 分钟
const RATE_MAX = 8;
const memoryBuckets = new Map();

/**
 * 按前缀聚合独立记账 key：返回 { count, exp }。
 * exp 取最早到期 key 的 exp，用于 retryAfter；无 key 时回退为「窗口结束」。
 */
export async function countBucketKeys(env, prefix) {
  const store = kv(env);
  let count = 0;
  let earliestExp = 0;
  let cursor;
  for (;;) {
    const page = await store.list({ prefix, cursor });
    for (const k of page.keys || []) {
      count += 1;
      const v = await store.get(k.name, "json").catch(() => null);
      const exp = Number(v && v.exp) || 0;
      if (exp && (!earliestExp || exp < earliestExp)) earliestExp = exp;
    }
    if (page.list_complete) break;
    cursor = page.cursor;
    if (cursor == null) break;
  }
  return { count, exp: earliestExp || nowSec() + RATE_WINDOW };
}

export async function checkRateLimit(env, ip) {
  const { count, exp } = await countBucketKeys(env, KEYS.rateLimit + ip + ":");
  if (count >= RATE_MAX) return { allowed: false, remaining: 0, retryAfter: Math.max(1, exp - nowSec()) };
  return { allowed: true, remaining: RATE_MAX - count };
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
  // 跨 isolate 安全：每次记账写独立 key（随机后缀防并发同名），TTL=窗口秒数；
  // 返回值沿用 { count, exp } 形状，供 consumeRateLimit 判定
  const stamp = `${Date.now().toString(36)}-${randomHex(4)}`;
  await writeJSON(env, `${KEYS.rateLimit}${ip}:${stamp}`, { exp: nowSec() + RATE_WINDOW }, { expirationTtl: RATE_WINDOW });
  return countBucketKeys(env, KEYS.rateLimit + ip + ":");
}

export async function resetRateLimit(env, ip) {
  memoryBuckets.delete(ip);
  // 旧格式单 key（升级前数据）顺手清理
  await deleteKey(env, KEYS.rateLimit + ip).catch(() => {});
  const store = kv(env);
  let cursor;
  for (;;) {
    const page = await store.list({ prefix: KEYS.rateLimit + ip + ":", cursor });
    for (const k of page.keys || []) await store.delete(k.name).catch(() => {});
    if (page.list_complete) break;
    cursor = page.cursor;
    if (cursor == null) break;
  }
}
