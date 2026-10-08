/**
 * RSS 订阅令牌与私密频道访问控制：
 * - 私密/隐藏频道默认不可见（列表/单频道源/断言）
 * - 令牌：哈希存储（KV 无明文）、恒时校验、Bearer 头、轮换/吊销、错误限流
 * - 输出：带令牌 private 缓存、self 不带令牌、401 带 WWW-Authenticate
 */
import test from "node:test";
import assert from "node:assert/strict";

import { validateChannel } from "../src/store.js";
import { visibleChannels, assertVisible } from "../src/api/content.js";
import { extractRssToken, checkRssToken, rotateRssToken, revokeRssToken } from "../src/rss-auth.js";
import { mapRssError } from "../src/api/rss.js";
import { HttpError } from "../src/util.js";

const BASE = process.env.TEST_BASE || "http://localhost:8787";

function mockEnv() {
  const store = new Map();
  return {
    __store: store,
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

function mkReq(headers = {}) {
  const map = { "cf-connecting-ip": "203.0.113.50" };
  for (const [k, v] of Object.entries(headers)) map[k.toLowerCase()] = v;
  return { headers: { get: (k) => map[String(k).toLowerCase()] ?? null }, url: `${BASE}/rss.xml` };
}

async function serverUp() {
  try {
    const res = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

/** 管理员会话（dev-server 全新 KV 才能 setup） */
async function adminSession() {
  const ip = { "cf-connecting-ip": "198.51.100.88" };
  let res = await fetch(`${BASE}/api/admin/setup`, {
    method: "POST",
    headers: { "content-type": "application/json", ...ip },
    body: JSON.stringify({ username: "rssadmin", password: "rss-token-test-pw" }),
    signal: AbortSignal.timeout(10000),
  });
  if (res.status === 409) {
    res = await fetch(`${BASE}/api/admin/login`, {
      method: "POST",
      headers: { "content-type": "application/json", ...ip },
      body: JSON.stringify({ username: "rssadmin", password: "rss-token-test-pw" }),
      signal: AbortSignal.timeout(10000),
    });
  }
  assert.equal(res.status, 200, "应能拿到管理会话");
  const setCookie = res.headers.get("set-cookie") || "";
  const cookie = /tgrss_session=[^;]+/.exec(setCookie)?.[0];
  assert.ok(cookie, "应下发会话 Cookie");
  return cookie;
}

/* --------------------------------------------- 私密频道可见性（单元） */

test("私密频道即使未勾隐藏也按认证门控制", () => {
  const channels = [
    { key: "pub", name: "公开", type: "public", enabled: true },
    { key: "priv", name: "私密", type: "private", enabled: true, hidden: false },
    { key: "hid", name: "隐藏", type: "public", enabled: true, hidden: true },
  ];
  const anon = visibleChannels(channels, false).map((c) => c.key);
  assert.deepEqual(anon, ["pub"], "未认证只能看到公开频道");

  const authed = visibleChannels(channels, true).map((c) => c.key);
  assert.deepEqual(authed.sort(), ["hid", "priv", "pub"], "认证后全部可见");

  const priv = channels[1];
  assert.throws(() => assertVisible(priv, false), (e) => e.code === "hidden_channel");
  assert.doesNotThrow(() => assertVisible(priv, true));
});

test("validateChannel：保存私密频道强制 hidden", () => {
  const { channel, error } = validateChannel({ type: "private", tgId: "-1001234567890", name: "Secret", hidden: false });
  assert.equal(error, undefined);
  assert.equal(channel.type, "private");
  assert.equal(channel.hidden, true, "私密频道必须强制隐藏");
});

/* ------------------------------------------------ 令牌（单元） */

test("extractRssToken：query 优先，其次 Bearer 头", () => {
  const url = new URL(`${BASE}/rss.xml?token=abc`);
  assert.equal(extractRssToken(mkReq(), url), "abc");
  const url2 = new URL(`${BASE}/rss.xml`);
  assert.equal(extractRssToken(mkReq({ authorization: "Bearer xyz" }), url2), "xyz");
  assert.equal(extractRssToken(mkReq({ authorization: "Basic abc" }), url2), "", "非 Bearer 不认");
  assert.equal(extractRssToken(mkReq(), new URL(`${BASE}/rss.xml?token=`)), "", "空参数视为未携带");
});

test("令牌只存哈希：KV 里找不到明文，校验恒时通过", async () => {
  const env = mockEnv();
  const t = await rotateRssToken(env, BASE);
  assert.ok(t.token && t.token.length >= 40, "令牌应为高熵随机串");
  assert.ok(t.url.includes(encodeURIComponent(t.token)), "返回的链接带令牌");
  assert.ok(t.masked.includes("…"), "掩码展示");

  // KV 明文扫描：任何键值里都不得出现令牌本体
  for (const [k, v] of env.__store) {
    assert.ok(!String(v).includes(t.token), `KV ${k} 泄露了明文令牌`);
  }

  const okReq = mkReq();
  const good = await checkRssToken(okReq, env, new URL(`${BASE}/rss.xml?token=${encodeURIComponent(t.token)}`));
  assert.equal(good.state, "valid");

  const bad = await checkRssToken(okReq, env, new URL(`${BASE}/rss.xml?token=wrong-token`));
  assert.equal(bad.state, "invalid");

  const none = await checkRssToken(okReq, env, new URL(`${BASE}/rss.xml`));
  assert.equal(none.state, "none", "不带令牌走公开视图");
});

test("吊销/轮换后旧令牌立即失效（即便站点已无令牌）", async () => {
  const env = mockEnv();
  const t = await rotateRssToken(env, BASE);
  await revokeRssToken(env);
  const r = await checkRssToken(mkReq(), env, new URL(`${BASE}/rss.xml?token=${t.token}`));
  assert.equal(r.state, "invalid", "吊销后旧令牌必须无效");
});

test("错误令牌限流：同 IP 超过 20 次 → 429", async () => {
  const env = mockEnv();
  await rotateRssToken(env, BASE);
  const req = mkReq({ "cf-connecting-ip": "198.51.100.200" });
  let limited = false;
  for (let i = 1; i <= 25 && !limited; i += 1) {
    try {
      await checkRssToken(req, env, new URL(`${BASE}/rss.xml?token=guess${i}`));
    } catch (err) {
      if (err.status === 429) {
        limited = true;
        assert.ok(err.retryAfter > 0);
        assert.equal(i > 20, true, "应在第 21 次左右触发");
      } else {
        throw err;
      }
    }
  }
  assert.ok(limited, "必须触发 429");
});

/* ------------------------------------------------ 错误映射（单元） */

test("mapRssError：隐藏频道 → 401 带 WWW-Authenticate；上游故障 → 503 可重试", () => {
  const hidden = mapRssError(new HttpError(403, "该频道需要登录或有效令牌后查看", "hidden_channel"));
  assert.equal(hidden.status, 401);
  assert.equal(hidden.code, "rss_token_required");
  assert.ok(hidden.headers["www-authenticate"].includes("Bearer"));

  const upstream = mapRssError(new HttpError(502, "上游请求失败", "upstream_error"));
  assert.equal(upstream.status, 503);
  assert.equal(upstream.retryAfter, 60);

  const notFound = mapRssError(new HttpError(404, "频道不存在", "channel_not_found"));
  assert.equal(notFound.status, 404, "404 保持原状");
});

/* ------------------------------------------------ 集成（需服务） */

test("RSS 令牌集成：401/200、private 缓存、self 不带令牌、吊销", async (t) => {
  if (!(await serverUp())) { t.skip("开发服务器未启动"); return; }
  const cookie = await adminSession();
  const auth = { cookie, "cf-connecting-ip": "198.51.100.88" };

  // 1) 未登录拿令牌状态 → 401
  const anon = await fetch(`${BASE}/api/admin/rss-token`, { signal: AbortSignal.timeout(10000) });
  assert.equal(anon.status, 401);

  // 2) 初始状态（KV 跨次保留，先清理可能存在的令牌）
  let st = await (await fetch(`${BASE}/api/admin/rss-token`, { headers: auth, signal: AbortSignal.timeout(10000) })).json();
  if (st.enabled) {
    await fetch(`${BASE}/api/admin/rss-token`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ action: "revoke" }),
      signal: AbortSignal.timeout(10000),
    });
    st = await (await fetch(`${BASE}/api/admin/rss-token`, { headers: auth, signal: AbortSignal.timeout(10000) })).json();
  }
  assert.equal(st.enabled, false);

  // 3) 轮换 → 明文只出现这一次
  const rotated = await (await fetch(`${BASE}/api/admin/rss-token`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ action: "rotate" }),
    signal: AbortSignal.timeout(10000),
  })).json();
  assert.equal(rotated.enabled, true);
  assert.ok(rotated.token && rotated.url.includes(rotated.token));

  const token = rotated.token;

  // 4) 错令牌 → 401 + WWW-Authenticate（独立 IP，错误限流桶不与其它用例互扰）
  const bad = await fetch(`${BASE}/rss.xml?token=definitely-wrong`, {
    headers: { "cf-connecting-ip": "198.51.100.99" },
    signal: AbortSignal.timeout(30000),
  });
  assert.equal(bad.status, 401);
  assert.match(bad.headers.get("www-authenticate") || "", /Bearer/);
  assert.equal((await bad.json()).code, "rss_token_invalid");

  // 5) 正确令牌（query）→ 200、private 缓存、self 无 token
  const good = await fetch(`${BASE}/rss.xml?token=${encodeURIComponent(token)}`, { signal: AbortSignal.timeout(30000) });
  assert.equal(good.status, 200);
  assert.match(good.headers.get("cache-control") || "", /^private/);
  const xml = await good.text();
  assert.ok(xml.includes("<?xml"), "应为 XML");
  const selfMatch = /<atom:link href="([^"]+)"/.exec(xml);
  if (selfMatch) assert.ok(!selfMatch[1].includes("token="), "self 链接不得携带令牌");

  // 6) Bearer 头同样有效
  const bearer = await fetch(`${BASE}/rss.xml`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30000),
  });
  assert.equal(bearer.status, 200);

  // 7) 不带令牌 → 公开视图 200 + public 缓存
  const pub = await fetch(`${BASE}/rss.xml`, { signal: AbortSignal.timeout(30000) });
  assert.equal(pub.status, 200);
  assert.match(pub.headers.get("cache-control") || "", /^public/);

  // 8) 吊销 → 旧令牌立即401
  const rev = await fetch(`${BASE}/api/admin/rss-token`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ action: "revoke" }),
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(rev.status, 200);
  const afterRevoke = await fetch(`${BASE}/rss.xml?token=${encodeURIComponent(token)}`, { signal: AbortSignal.timeout(30000) });
  assert.equal(afterRevoke.status, 401, "吊销后旧令牌必须 401");
});

test("私密频道集成：列表隐藏、无令牌 401、带令牌过授权（到桥接检查为止）", async (t) => {
  if (!(await serverUp())) { t.skip("开发服务器未启动"); return; }
  const cookie = await adminSession();
  const auth = { cookie, "cf-connecting-ip": "198.51.100.88" };

  // 管理员保存一个私密频道（无桥接也能保存；内容抓取会失败，但授权门可验证）
  const save = await fetch(`${BASE}/api/admin/settings`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ channels: [{ type: "private", tgId: "-1001234567890", name: "SecretFeed" }] }),
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(save.status, 200, "保存私密频道应成功");
  const saved = await save.json();
  const priv = (saved.channels || []).find((c) => c.type === "private");
  assert.ok(priv, "应包含私密频道");
  assert.equal(priv.hidden, true, "保存时强制 hidden");

  // 未登录：列表里看不到
  const list = await (await fetch(`${BASE}/api/channels`, { signal: AbortSignal.timeout(10000) })).json();
  assert.ok(!(list.channels || []).some((c) => c.key === priv.key), "匿名列表不得出现私密频道");

  // 无令牌：单频道源 → 401（需要凭据），且带 WWW-Authenticate
  const noTok = await fetch(`${BASE}/api/rss?channel=${encodeURIComponent(priv.key)}`, { signal: AbortSignal.timeout(30000) });
  assert.equal(noTok.status, 401, "私密频道无令牌必须 401");
  assert.match(noTok.headers.get("www-authenticate") || "", /Bearer/);
  assert.equal((await noTok.json()).code, "rss_token_required");

  // 生成令牌后带令牌访问：授权应通过（内容层因未配桥接返回 400/502，绝不能是 401）
  const rotated = await (await fetch(`${BASE}/api/admin/rss-token`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ action: "rotate" }),
    signal: AbortSignal.timeout(10000),
  })).json();
  const withTok = await fetch(
    `${BASE}/api/rss?channel=${encodeURIComponent(priv.key)}&token=${encodeURIComponent(rotated.token)}`,
    { signal: AbortSignal.timeout(30000) },
  );
  assert.notEqual(withTok.status, 401, "带有效令牌不应被授权拦截");
  assert.notEqual(withTok.status, 403, "带有效令牌不应被授权拦截");

  // 带令牌的聚合源：私密频道进入抓取流程。
  // 桥接未配置 → 该频道抓取失败且没有任何帖子 → 503（空源保护，阅读器会重试）；
  // 若站内另有可用公开频道 → 200。两者都证明授权已放行（不是 401/403）。
  const agg = await fetch(`${BASE}/rss.xml?token=${encodeURIComponent(rotated.token)}&limit=5`, { signal: AbortSignal.timeout(60000) });
  assert.ok([200, 503].includes(agg.status), `聚合源状态应为 200 或 503，实际 ${agg.status}`);
  if (agg.status === 503) {
    assert.equal((await agg.json()).code, "upstream_busy", "503 应是空源保护的 upstream_busy");
  }
});
