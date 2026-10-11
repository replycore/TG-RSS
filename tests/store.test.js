import test from "node:test";
import assert from "node:assert/strict";

import {
  validateChannel,
  normalizeChannel,
  createAdminCredential,
  getAdminCredential,
  verifyPassword,
  isInitialized,
  createSession,
  getSession,
  destroySession,
  bumpAuthEpoch,
  checkRateLimit,
  bumpRateLimit,
  saveChannels,
  getChannels,
  DEFAULTS,
  mergeDefaults,
} from "../src/store.js";

/** 极简内存 KV，模拟 Cloudflare KV 接口 */
class MockKV {
  constructor() {
    this.map = new Map();
  }
  async get(key, type) {
    const raw = this.map.get(key);
    if (raw == null) return null;
    return type === "json" ? JSON.parse(raw) : raw;
  }
  async put(key, value, opts) {
    this.map.set(key, String(value));
    this.opts = opts;
  }
  async delete(key) {
    this.map.delete(key);
  }
}

const env = () => ({ TG_RSS_KV: new MockKV() });

test("validateChannel：公开频道", () => {
  const ok = validateChannel({ type: "public", username: "@Some_Channel", name: "测试" });
  assert.equal(ok.error, undefined);
  assert.equal(ok.channel.username, "Some_Channel");
  assert.equal(ok.channel.key, "some_channel");

  assert.ok(validateChannel({ type: "public", username: "ab" }).error);
  assert.ok(validateChannel({ type: "public", username: "bad name!" }).error);
});

test("validateChannel：私密频道", () => {
  const ok = validateChannel({ type: "private", tgId: "-1001234567890", name: "私密" });
  assert.equal(ok.error, undefined);
  assert.equal(ok.channel.tgId, "-1001234567890");
  assert.equal(ok.channel.key, "p1001234567890");

  assert.ok(validateChannel({ type: "private", tgId: "abc" }).error);
  assert.ok(validateChannel({ type: "private", tgId: "" }).error);
});

test("normalizeChannel：默认值与排序", () => {
  const ch = normalizeChannel({ type: "public", username: "u1" });
  assert.equal(ch.name, "u1");
  assert.equal(ch.hidden, false);
  assert.equal(ch.enabled, true);
  assert.ok(ch.addedAt > 0);
});

test("saveChannels / getChannels 保持顺序并归一化", async () => {
  const e = env();
  await saveChannels(e, [
    { type: "public", username: "bbb", name: "B" },
    { type: "private", tgId: "-100999", name: "私密", hidden: true },
    { type: "public", username: "aaa", name: "A" },
  ]);
  const list = await getChannels(e);
  assert.deepEqual(list.map((c) => c.name), ["B", "私密", "A"]);
  assert.deepEqual(list.map((c) => c.order), [0, 1, 2]);
  assert.equal(list[1].hidden, true);
  assert.equal(list[1].key, "p100999");
});

test("管理员凭据：初始化 + 校验", async () => {
  const e = env();
  const before = await getAdminCredential(e);
  assert.equal(before.source, null);
  assert.equal(isInitialized(before), false);

  await createAdminCredential(e, "root", "password-123");
  const after = await getAdminCredential(e);
  assert.equal(after.source, "kv");
  assert.equal(after.username, "root");
  assert.ok(await verifyPassword(after, "password-123"));
  assert.ok(!(await verifyPassword(after, "wrong")));
  assert.ok(!(await verifyPassword(null, "x")));
});

test("环境变量凭据优先于 KV", async () => {
  const e = env();
  await createAdminCredential(e, "root", "kv-password");
  const withEnv = { ...e, ADMIN_PASSWORD: "env-secret", ADMIN_USERNAME: "envuser" };
  const cred = await getAdminCredential(withEnv);
  assert.equal(cred.source, "env");
  assert.equal(cred.username, "envuser");
  assert.ok(await verifyPassword(cred, "env-secret"));
  assert.ok(!(await verifyPassword(cred, "kv-password")));
});

test("会话：创建 / 校验 / 销毁 / 过期", async () => {
  const e = env();
  const token = await createSession(e, { username: "root" });
  assert.match(token, /^[a-f0-9]{64}$/);

  const session = await getSession(e, token);
  assert.equal(session.username, "root");
  assert.equal(session.role, "admin");
  assert.ok(session.exp > Date.now() / 1000);

  assert.equal(await getSession(e, "not-a-token"), null);

  await destroySession(e, token);
  assert.equal(await getSession(e, token), null);
});

test("登录限流：连续失败后拒绝", async () => {
  const e = env();
  const ip = "1.2.3.4";
  assert.equal((await checkRateLimit(e, ip)).allowed, true);
  for (let i = 0; i < 8; i += 1) await bumpRateLimit(e, ip);
  const blocked = await checkRateLimit(e, ip);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.remaining, 0);
  assert.equal((await checkRateLimit(e, "5.6.7.8")).allowed, true, "不影响其他 IP");
});

test("mergeDefaults 保底", () => {
  assert.deepEqual(mergeDefaults("general", { siteTitle: "X" }).theme, DEFAULTS.general.theme);
  assert.equal(mergeDefaults("general", null).siteTitle, "TG-RSS");
  assert.equal(mergeDefaults("media", { video: false }).video, false);
  assert.equal(mergeDefaults("media", null).image, true);
  assert.deepEqual(mergeDefaults("channels", null), []);
});

test("validateChannel：公开频道兼容分享链接", () => {
  const ok = validateChannel({ type: "public", username: "https://t.me/telegram" });
  assert.ok(!ok.error, ok.error);
  assert.equal(ok.channel.username, "telegram");

  const at = validateChannel({ type: "public", username: "@telegram" });
  assert.ok(!at.error);
  assert.equal(at.channel.username, "telegram");

  const priv = validateChannel({ type: "public", username: "https://t.me/+AbCdEfGhIjKlM" });
  assert.ok(priv.error && /私密/.test(priv.error), "私密邀请应给出明确提示");

  const empty = validateChannel({ type: "public", username: "" });
  assert.ok(empty.error);
});

test("validateChannel：私密 tgId 必须负数（防 ± 同 key 的形同校验）", () => {
  const bad = validateChannel({ type: "private", tgId: "1001234567890" });
  assert.ok(bad.error && /负数/.test(bad.error), "正数 id 应拒绝");
  const zero = validateChannel({ type: "private", tgId: "0" });
  assert.ok(zero.error, "0 应拒绝");
  const ok1 = validateChannel({ type: "private", tgId: "-1001234567890" });
  assert.equal(ok1.channel.key, "p1001234567890");
  assert.equal(ok1.channel.hidden, true, "私密频道强制隐藏");
});

test("会话纪元：bump 后所有旧会话失效（改密码批量注销）", async () => {
  const e = env();
  const token = await createSession(e, { username: "root" });
  const tOther = await createSession(e, { username: "root" });
  assert.ok(await getSession(e, token));
  assert.ok(await getSession(e, tOther));
  await bumpAuthEpoch(e); // 模拟改密码
  assert.equal(await getSession(e, token), null, "旧会话 1 必须失效");
  assert.equal(await getSession(e, tOther), null, "旧会话 2（攻击者持有）也必须失效");
  const fresh = await createSession(e, { username: "root" });
  assert.ok(await getSession(e, fresh), "纪元 bump 后新建的会话有效");
});

test("normalizeChannel：历史正数 tgId 读时归一化为负数（存量脏数据迁移）", () => {
  // 正数与负数同 key（p<无符号>），存量行的 key 不变，但 tgId 字段必须转负——
  // 否则发给 bridge 依然被判成 PeerUser
  const norm = normalizeChannel({ type: "private", tgId: "1001234567890", name: "旧频道" });
  assert.equal(norm.tgId, "-1001234567890");
  assert.equal(norm.key, "p1001234567890", "key 与负数版一致，迁移无破坏");
  // 负数原样、非数字原样
  assert.equal(normalizeChannel({ type: "private", tgId: "-1001234567890" }).tgId, "-1001234567890");
});
