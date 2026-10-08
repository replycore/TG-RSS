/**
 * 安全回归：Turnstile 人机验证、代理重定向/内容类型安检、
 * Cookie 解码容错、登录限流、admin/state 不泄露、查询参数容错。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { parseCookies } from "../src/util.js";
import { verifyTurnstile, turnstileSiteKey } from "../src/turnstile.js";
import { assertRedirectAllowed, checkProxyContentType, proxyRateConsume } from "../src/api/media.js";
import { consumeRateLimit, resetRateLimit } from "../src/store.js";

const BASE = process.env.TEST_BASE || "http://localhost:8787";

function mkReq(headers = {}) {
  const map = {};
  for (const [k, v] of Object.entries(headers)) map[k.toLowerCase()] = v;
  return { headers: { get: (k) => map[String(k).toLowerCase()] ?? null } };
}

/** 内存 KV：形状与 store 的 kv() 读写约定一致 */
function mockEnv() {
  const store = new Map();
  return {
    TG_RSS_KV: {
      async get(key, type) {
        const raw = store.has(key) ? store.get(key) : null;
        if (raw == null) return null;
        if (type === "json" && typeof raw === "string") {
          try { return JSON.parse(raw); } catch { return null; }
        }
        return raw;
      },
      async put(key, value) { store.set(key, value); },
      async delete(key) { store.delete(key); },
    },
  };
}

async function serverUp() {
  try {
    const res = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------ Cookie 容错 */

test("parseCookies：畸形百分号编码不炸整个请求", () => {
  const req = mkReq({ cookie: "a=%E4%B8%AD; bad=%zz; ok=1; weird=%E4" });
  const out = parseCookies(req);
  assert.equal(out.ok, "1");
  assert.equal(out.a, "中");
  assert.equal(out.bad, "%zz", "解码失败应退回原值而不是抛错");
  assert.equal(out.weird, "%E4", "截断序列同样容错");
});

/* ---------------------------------------------------------- Turnstile */

test("Turnstile：未配置 secret 时整体跳过（向后兼容）", async () => {
  const r = await verifyTurnstile(mkReq(), {}, {});
  assert.equal(r.enabled, false);
  assert.equal(r.ok, true);
});

test("Turnstile：配置 secret 后缺令牌直接 403", async () => {
  await assert.rejects(
    () => verifyTurnstile(mkReq(), { TURNSTILE_SECRET: "s3cret" }, {}),
    (err) => err.status === 403 && err.code === "turnstile_required",
  );
});

test("Turnstile：siteverify 成功/失败/网络故障", async () => {
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({ json: async () => ({ success: false }) });
    await assert.rejects(
      () => verifyTurnstile(mkReq(), { TURNSTILE_SECRET: "s" }, { turnstileToken: "tok" }),
      (err) => err.code === "turnstile_failed",
    );

    globalThis.fetch = async () => ({ json: async () => ({ success: true }) });
    const ok = await verifyTurnstile(mkReq(), { TURNSTILE_SECRET: "s" }, { turnstileToken: "tok" });
    assert.equal(ok.enabled, true);

    // fail-closed：验证服务挂了也不能放行
    globalThis.fetch = async () => { throw new Error("network down"); };
    await assert.rejects(
      () => verifyTurnstile(mkReq(), { TURNSTILE_SECRET: "s" }, { turnstileToken: "tok" }),
      (err) => err.code === "turnstile_error",
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("Turnstile：sitekey 只在启用时下发", () => {
  assert.equal(turnstileSiteKey({}), null, "没配 secret 不下发 sitekey");
  assert.equal(turnstileSiteKey({ TURNSTILE_SECRET: "s" }), null, "配了 secret 但没 sitekey 也不下发");
  assert.equal(turnstileSiteKey({ TURNSTILE_SECRET: "s", TURNSTILE_SITE_KEY: "0xSITE" }), "0xSITE");
});

/* ------------------------------------------------------ 代理重定向安检 */

test("代理重定向：逐跳过白名单，默认 follow 的绕过路径已封死", () => {
  // 白名单外的落点（SSRF/白名单绕过）→ 拒绝
  assert.throws(
    () => assertRedirectAllowed("https://169.254.169.254/meta", "https://t.me/x", null),
    (err) => err.code === "redirect_not_allowed",
  );
  assert.throws(
    () => assertRedirectAllowed("https://evil.example.com/steal", "https://t.me/x", null),
    (err) => err.code === "redirect_not_allowed",
  );
  // 白名单内 → 放行
  const ok = assertRedirectAllowed("https://cdn4.telesco.pe/img.webp", "https://t.me/x", null);
  assert.equal(ok.hostname, "cdn4.telesco.pe");
  // 相对重定向按当前 URL 解析（当前 host 在白名单内）
  const rel = assertRedirectAllowed("/img", "https://t.me/x", null);
  assert.equal(rel.toString(), "https://t.me/img");
  // 明文 http（且不是桥接）→ 拒绝
  assert.throws(
    () => assertRedirectAllowed("http://t.me/x", "https://t.me/x", null),
    (err) => err.code === "bad_redirect_scheme",
  );
});

/* -------------------------------------------------- 代理内容类型安检 */

test("代理内容类型：HTML 拒绝、SVG 沙箱、图片直通", () => {
  assert.throws(() => checkProxyContentType("text/html; charset=utf-8"), (e) => e.code === "html_not_allowed");
  assert.throws(() => checkProxyContentType("TEXT/HTML"), (e) => e.code === "html_not_allowed");
  assert.throws(() => checkProxyContentType("application/xhtml+xml"), (e) => e.code === "html_not_allowed");
  assert.equal(checkProxyContentType("image/svg+xml; charset=utf-8"), "sandbox");
  assert.equal(checkProxyContentType("application/xml"), "sandbox");
  assert.equal(checkProxyContentType("image/webp"), "plain");
  assert.equal(checkProxyContentType("video/mp4"), "plain");
  assert.equal(checkProxyContentType(""), "plain");
});

/* ------------------------------------------------------------ 代理限速 */

test("代理限速：同 IP 每分钟 120 次后 429，其它 IP 不受影响", () => {
  for (let i = 0; i < 120; i += 1) proxyRateConsume("198.51.100.10");
  assert.throws(
    () => proxyRateConsume("198.51.100.10"),
    (err) => err.status === 429 && err.code === "proxy_rate_limited" && err.retryAfter > 0,
  );
  const other = proxyRateConsume("198.51.100.11");
  assert.equal(other, undefined, "其它 IP 正常放行");
});

/* -------------------------------------------------------------- 限流 */

test("登录限流：预扣计数，第 9 次 429，reset 后恢复", async () => {
  const env = mockEnv();
  const ip = "203.0.113.9";
  for (let i = 1; i <= 8; i += 1) {
    const r = await consumeRateLimit(env, ip);
    assert.equal(r.allowed, true, `第 ${i} 次尝试应放行`);
  }
  const denied = await consumeRateLimit(env, ip);
  assert.equal(denied.allowed, false, "第 9 次必须被拦");
  assert.ok(denied.retryAfter > 0, "需要给出 retryAfter");
  await resetRateLimit(env, ip);
  const again = await consumeRateLimit(env, ip);
  assert.equal(again.allowed, true, "reset 后应恢复");
});

/* ------------------------------------------------------- 集成（需服务） */

test("GET /api/admin/state 不泄露用户名", async (t) => {
  if (!(await serverUp())) { t.skip("开发服务器未启动"); return; }
  const res = await fetch(`${BASE}/api/admin/state`, { signal: AbortSignal.timeout(10000) });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.username, null, "未登录时 username 必须为 null");
  assert.equal(data.credential, undefined, "不能出现凭据对象");
  assert.ok(
    !JSON.stringify(data).toLowerCase().includes("password"),
    "响应里不能有密码字段",
  );
});

test("GET /api/config 带 turnstileSiteKey 字段", async (t) => {
  if (!(await serverUp())) { t.skip("开发服务器未启动"); return; }
  const res = await fetch(`${BASE}/api/config`, { signal: AbortSignal.timeout(10000) });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok("turnstileSiteKey" in data, "配置接口必须带 sitekey 字段");
  assert.equal(data.turnstileSiteKey, null, "未配置环境变量时为 null");
});

test("登录口限流：9 次快速失败后 429（独立 IP 头）", async (t) => {
  if (!(await serverUp())) { t.skip("开发服务器未启动"); return; }
  const ip = "198.51.100.77";
  let got429 = false;
  for (let i = 1; i <= 9; i += 1) {
    const res = await fetch(`${BASE}/api/admin/login`, {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": ip },
      body: JSON.stringify({ username: "nobody", password: "wrong-password" }),
      signal: AbortSignal.timeout(10000),
    });
    if (res.status === 429) {
      got429 = true;
      assert.ok(res.headers.get("retry-after"), "429 要带 retry-after");
      break;
    }
  }
  assert.ok(got429, "9 次内必须触发 429");
});

test("查询参数容错：limit 非法/越界不 500", async (t) => {
  if (!(await serverUp())) { t.skip("开发服务器未启动"); return; }
  const feed = await fetch(`${BASE}/api/feed?limit=abc`, { signal: AbortSignal.timeout(60000) });
  assert.equal(feed.status, 200, "limit=abc 应回退默认值");
  const feed2 = await fetch(`${BASE}/api/feed?limit=999999`, { signal: AbortSignal.timeout(60000) });
  assert.equal(feed2.status, 200, "limit 越界应被钳制");
  const media = await fetch(`${BASE}/api/media?limit=-5&type=video`, { signal: AbortSignal.timeout(60000) });
  assert.equal(media.status, 200, "负数 limit 应被钳制");
});
