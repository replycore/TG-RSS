/**
 * 服务端 bug 猎杀回归（2026-10-14 批量修复）：
 *  - getFeed / getMediaList 出错时恢复原游标（不写 null=已翻完）
 *  - proxyMedia：缓存 TTL、存缓存去 content-length + 打 x-cache-stored-at、416 透传 content-range
 *  - fetcher：瞬态 404 不删 stale 条目（留给后续 429 兜底）、上游单飞去重
 *  - proxy-sign：签名带 exp，缺/非法/过期拒绝（breaking change：旧无 exp URL 直接 403）
 *  - rss：聚合 limit 有效范围 10..120；stale 响应 max-age=0 + Warning 110
 *  - htmlToText：&amp; 最后解码，不双重解码
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getFeed } from "../src/api/content.js";
import { getMediaList, proxyMedia } from "../src/api/media.js";
import { fetchPublicChannelPage, proxyUrlFor } from "../src/tg/fetcher.js";
import { signProxyU, verifyProxySig } from "../src/proxy-sign.js";
import { xmlResponse, rssFeed } from "../src/api/rss.js";
import { htmlToText, b64urlEncode, encodeState } from "../src/util.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const fixture = await readFile(path.join(dir, "fixtures", "channel-page.html"), "utf8");

/* ---------------- 通用 mock ---------------- */

function mockKV(map = new Map()) {
  return {
    async get(key, type) {
      const raw = map.has(key) ? map.get(key) : null;
      if (raw == null) return null;
      if (type === "json" && typeof raw === "string") {
        try { return JSON.parse(raw); } catch { return null; }
      }
      return raw;
    },
    async put(key, value) { map.set(key, value); },
    async delete(key) { map.delete(key); },
  };
}

function mockEnv(channels, general = null) {
  const map = new Map();
  map.set("settings:channels", JSON.stringify(channels));
  if (general) map.set("settings:general", JSON.stringify(general));
  return { TG_RSS_KV: mockKV(map) };
}

function mockCache() {
  const store = new Map();
  const keyOf = (req) => (typeof req === "string" ? req : req.url);
  return {
    store,
    async match(req) { const hit = store.get(keyOf(req)); return hit ? hit.clone() : undefined; },
    async put(req, res) {
      const body = Buffer.from(await res.arrayBuffer());
      store.set(keyOf(req), new Response(body, { status: res.status, headers: res.headers }));
    },
    async delete(req) { store.delete(keyOf(req)); },
  };
}

const realFetch = globalThis.fetch;
const hadCaches = "caches" in globalThis;
const realCaches = globalThis.caches;
function useGlobals(fetchImpl, cacheImpl) {
  if (cacheImpl === undefined) delete globalThis.caches;
  else globalThis.caches = cacheImpl;
  globalThis.fetch = fetchImpl;
}
function restoreGlobals() {
  if (!hadCaches) delete globalThis.caches;
  else globalThis.caches = realCaches;
  globalThis.fetch = realFetch;
}

function channelPage(username, ids) {
  const blocks = ids
    .map((id) => `<div class="tgme_widget_message js-widget_message" data-post="${username}/${id}" data-view="eyJjIjoxfQ">
  <time datetime="2024-06-01T10:00:00+00:00"></time>
  <div class="tgme_widget_message_text js-message_text">post ${id}</div>
</div>`)
    .join("\n");
  return `<html><body>${blocks}</body></html>`;
}

/* ---------------- 1. 游标恢复 ---------------- */

test("getFeed：频道抓取抛错时恢复原游标，不写 null（瞬时错误不丢分页）", async () => {
  const channels = [{ key: "chana", type: "public", username: "chana", name: "A", order: 0 }];
  const env = mockEnv(channels, { pageSize: 20 });
  useGlobals(async () => { throw new Error("upstream boom"); }, undefined);
  try {
    // 有原游标 → 恢复原游标
    const c1 = encodeState({ chana: "100" });
    const r1 = await getFeed({}, env, {}, new URL(`https://x/api/feed?c=${c1}`), false);
    assert.equal(r1.cursors.chana, "100", "出错应恢复原游标 '100'，而不是 null（已翻完）");
    assert.equal(r1.posts.length, 0);
    assert.equal(r1.errors.length, 1, "错误应记录在 errors 里");
    // 无原游标 → 键删除（保持「未开始」语义）
    const r2 = await getFeed({}, env, {}, new URL("https://x/api/feed"), false);
    assert.ok(!("chana" in r2.cursors), "无原游标时键应删除，而非写 null");
  } finally {
    restoreGlobals();
  }
});

test("getMediaList：频道抓取抛错时恢复原游标，不写 null", async () => {
  const channels = [{ key: "chana", type: "public", username: "chana", name: "A", order: 0 }];
  const env = mockEnv(channels, { pageSize: 20 });
  useGlobals(async () => { throw new Error("upstream boom"); }, undefined);
  try {
    const c = encodeState({ chana: "55" });
    const r = await getMediaList({}, env, {}, new URL(`https://x/api/media?type=video&c=${c}`), false);
    assert.equal(r.cursors.chana, "55", "出错应恢复原游标 '55'，而不是 null");
  } finally {
    restoreGlobals();
  }
});

/* ---------------- 2. proxyMedia 缓存 ---------------- */

const proxyReq = () => ({ headers: { get: () => null } });
const proxyTarget = "https://cdn1.telesco.pe/file/t.jpg";
const proxyUrlForTarget = () =>
  new URL(`https://x/api/media/proxy?u=${b64urlEncode(proxyTarget)}`);
// proxyMedia 内部 cacheKey：https://tg-rss-media.invalid/<b64url(target)>
const proxyCacheKey = `https://tg-rss-media.invalid/${b64urlEncode(new URL(proxyTarget).toString())}`;

function seedMediaCache(cache, { ageSec = 0, contentLength = "4" } = {}) {
  const headers = new Headers({
    "content-type": "image/jpeg",
    "content-length": contentLength,
    "x-cache-stored-at": String(Date.now() - ageSec * 1000),
  });
  cache.store.set(proxyCacheKey, new Response(new Uint8Array([1, 2, 3, 4]), { status: 200, headers }));
}

test("proxyMedia：超龄缓存（>86400s）视为未命中走回源，并删旧条目", async () => {
  const cache = mockCache();
  seedMediaCache(cache, { ageSec: 90000 }); // 25 小时前
  let upstreamCalls = 0;
  useGlobals(async () => {
    upstreamCalls += 1;
    return new Response(new Uint8Array([9, 9]), {
      status: 200,
      headers: { "content-type": "image/jpeg", "content-length": "2" },
    });
  }, { default: cache });
  try {
    const res = await proxyMedia(proxyReq(), mockEnv([]), {}, proxyUrlForTarget());
    assert.equal(res.status, 200);
    assert.equal(upstreamCalls, 1, "超龄命中必须回源");
    const stored = cache.store.get(proxyCacheKey);
    assert.ok(stored, "回源后应写入新条目");
    assert.deepEqual([...new Uint8Array(await stored.arrayBuffer())], [9, 9], "旧条目应被新内容覆盖");
  } finally {
    restoreGlobals();
  }
});

test("proxyMedia：新鲜缓存命中不走回源", async () => {
  const cache = mockCache();
  seedMediaCache(cache, { ageSec: 60 });
  let upstreamCalls = 0;
  useGlobals(async () => {
    upstreamCalls += 1;
    return new Response(new Uint8Array([9, 9]), { status: 200, headers: { "content-type": "image/jpeg" } });
  }, { default: cache });
  try {
    const res = await proxyMedia(proxyReq(), mockEnv([]), {}, proxyUrlForTarget());
    assert.equal(res.status, 200);
    assert.equal(upstreamCalls, 0, "新鲜命中不得回源");
    assert.deepEqual([...new Uint8Array(await res.arrayBuffer())], [1, 2, 3, 4], "应返回缓存字节");
  } finally {
    restoreGlobals();
  }
});

test("proxyMedia：存缓存去 content-length、打 x-cache-stored-at", async () => {
  const cache = mockCache();
  useGlobals(async () => new Response(new Uint8Array([1, 2, 3, 4]), {
    status: 200,
    // 上游 gzip 场景：fetch 已解压 body，但 content-length 仍是压缩后大小
    headers: { "content-type": "image/jpeg", "content-length": "1200", "content-encoding": "gzip" },
  }), { default: cache });
  try {
    await proxyMedia(proxyReq(), mockEnv([]), {}, proxyUrlForTarget());
    const stored = cache.store.get(proxyCacheKey);
    assert.ok(stored, "应写入缓存");
    assert.equal(stored.headers.get("content-length"), null, "缓存条目不得带过期 content-length");
    const storedAt = Number(stored.headers.get("x-cache-stored-at"));
    assert.ok(Number.isFinite(storedAt) && Date.now() - storedAt < 60000, "应带 x-cache-stored-at");
  } finally {
    restoreGlobals();
  }
});

test("proxyMedia：上游 416 时透传 content-range（播放器续传需要文件总大小）", async () => {
  const cache = mockCache();
  useGlobals(async () => new Response("range not satisfiable", {
    status: 416,
    headers: { "content-range": "bytes */1000" },
  }), { default: cache });
  try {
    await assert.rejects(
      () => proxyMedia({ headers: { get: (k) => (k === "range" ? "bytes=99999-" : null) } }, mockEnv([]), {}, proxyUrlForTarget()),
      (err) => {
        assert.equal(err.status, 416);
        assert.equal(err.code, "upstream_status");
        assert.equal(err.headers && err.headers["content-range"], "bytes */1000", "416 必须透传 content-range");
        return true;
      },
      "416 应抛错且带 content-range",
    );
  } finally {
    restoreGlobals();
  }
});

/* ---------------- 3. fetcher：404 保留 stale + 单飞 ---------------- */

test("fetcher：瞬态 404 不删 stale 条目，后续 429 仍能兜底", async () => {
  const cache = mockCache();
  let mode = "ok";
  useGlobals(async () => {
    if (mode === "gone") return new Response("gone", { status: 404 });
    if (mode === "rate") return new Response("rate limited", { status: 429 });
    return new Response(fixture, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
  }, { default: cache });
  try {
    const first = await fetchPublicChannelPage({}, {}, "tgtest", null, 120);
    assert.equal(first.cacheStatus, "MISS");
    assert.ok(first.posts.length > 0);

    // 条目过期（1 小时），上游一次瞬态 404
    const key = [...cache.store.keys()][0];
    const old = cache.store.get(key);
    const headers = new Headers(old.headers);
    headers.set("x-cache-stored-at", String(Date.now() - 3600 * 1000));
    cache.store.set(key, new Response(Buffer.from(await old.arrayBuffer()), { status: old.status, headers }));

    mode = "gone";
    await assert.rejects(
      () => fetchPublicChannelPage({}, {}, "tgtest", null, 120),
      (err) => err.code === "channel_not_found",
      "404 照常抛错",
    );
    assert.equal(cache.store.size, 1, "404 不得删除 stale 条目（修复前这里是 0）");

    // 之后上游变 429 → 旧条目兜底
    mode = "rate";
    const staleRes = await fetchPublicChannelPage({}, {}, "tgtest", null, 120);
    assert.equal(staleRes.cacheStatus, "STALE", "404 之后 429 仍应走 stale 兜底");
    assert.ok(staleRes.posts.length > 0);
  } finally {
    restoreGlobals();
  }
});

test("fetcher：并发同 URL 请求单飞，只打一次上游", async () => {
  const cache = mockCache();
  let upstreamCalls = 0;
  useGlobals(async () => {
    upstreamCalls += 1;
    await new Promise((r) => setTimeout(r, 30)); // 拉开并发窗口
    return new Response(fixture, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
  }, { default: cache });
  try {
    const [a, b] = await Promise.all([
      fetchPublicChannelPage({}, {}, "tgtest", null, 120),
      fetchPublicChannelPage({}, {}, "tgtest", null, 120),
    ]);
    assert.equal(upstreamCalls, 1, "并发同 URL 只应回源一次");
    assert.ok(a.posts.length > 0 && b.posts.length > 0, "两路都应拿到可解析内容");
  } finally {
    restoreGlobals();
  }
});

/* ---------------- 4. proxy-sign exp ---------------- */

test("proxy-sign：无 exp/过期/篡改 exp 的代理 URL 被 proxyMedia 403（breaking change）", async () => {
  const token = "exp-test-token";
  const map = new Map();
  map.set("settings:bridge", JSON.stringify({ url: "https://bridge.example.com", enabled: true, token }));
  const env = { TG_RSS_KV: mockKV(map) };
  const cache = mockCache();
  const { responseSignatureHeaders } = await import("../bridge/auth.js");
  const bridgePath = "/media?ch=-1001&m=1";
  useGlobals(async () => new Response(new Uint8Array([1]), {
    status: 200,
    headers: {
      "content-type": "image/jpeg",
      ...responseSignatureHeaders({ token, status: 200, method: "GET", pathWithQuery: bridgePath, windowSec: 300 }),
    },
  }), { default: cache });
  try {
    const target = "https://bridge.example.com/media?ch=-1001&m=1";
    const u = b64urlEncode(target);
    const exp = String(Math.floor(Date.now() / 1000) + 3600);

    // 合法：proxyUrlFor 产出的 URL 带 sig+exp，应放行（200）
    const good = await proxyUrlFor(target, { proxyAll: true, _bridgeToken: token, _bridgeHost: "bridge.example.com" });
    assert.ok(good.includes("sig=") && good.includes("exp="), "签发 URL 应带 sig+exp");
    const goodRes = await proxyMedia(proxyReq(), env, {}, new URL(good, "https://x"));
    assert.equal(goodRes.status, 200, "合法签名 URL 应放行");

    // 无 exp（旧版本签发形态）→ 403
    const sigNoExp = await signProxyU(token, u, exp);
    const noExpUrl = new URL(`https://x/api/media/proxy?u=${u}&sig=${sigNoExp}`);
    await assert.rejects(
      () => proxyMedia(proxyReq(), env, {}, noExpUrl),
      (err) => { assert.equal(err.code, "bad_proxy_sig"); return true; },
      "无 exp 的旧 URL 必须 403（breaking change）",
    );

    // 过期 → 403
    const past = String(Math.floor(Date.now() / 1000) - 10);
    const sigPast = await signProxyU(token, u, past);
    const pastUrl = new URL(`https://x/api/media/proxy?u=${u}&sig=${sigPast}&exp=${past}`);
    await assert.rejects(
      () => proxyMedia(proxyReq(), env, {}, pastUrl),
      (err) => { assert.equal(err.code, "bad_proxy_sig"); return true; },
      "过期的签名必须 403",
    );
  } finally {
    restoreGlobals();
  }
});

test("proxy-sign：verify 恒时比较仍有效，篡改 u/exp 拒绝", async () => {
  const token = "t";
  const u = b64urlEncode("https://bridge.example.com/m");
  const exp = String(Math.floor(Date.now() / 1000) + 3600);
  const sig = await signProxyU(token, u, exp);
  assert.equal(await verifyProxySig(token, u, sig, exp), true);
  assert.equal(await verifyProxySig(token, b64urlEncode("https://bridge.example.com/evil"), sig, exp), false);
  assert.equal(await verifyProxySig(token, u, sig, String(Number(exp) + 1)), false, "exp+1 载荷对不上");
});

/* ---------------- 5. rss：limit 与 stale 头 ---------------- */

test("rss：聚合 limit 有效范围 10..120（?limit=5 取 10 条，?limit=200 全取）", async () => {
  const channels = [
    { key: "ra", type: "public", username: "ra", name: "RA", order: 0 },
    { key: "rb", type: "public", username: "rb", name: "RB", order: 1 },
  ];
  const env = mockEnv(channels, { pageSize: 20, siteTitle: "T", cacheTtl: 120 });
  const ids = (s) => [6, 5, 4, 3, 2, 1].map((i) => s * 100 + i);
  useGlobals(async (url) => {
    const u = String(url);
    const html = channelPage(u.includes("/s/rb") ? "rb" : "ra", u.includes("/s/rb") ? ids(2) : ids(1));
    return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
  }, undefined);
  const countItems = (xml) => (xml.match(/<item>/g) || []).length;
  try {
    const r5 = await rssFeed(new Request("https://x/api/rss?limit=5"), env, {}, new URL("https://x/api/rss?limit=5"));
    assert.equal(countItems(await r5.text()), 10, "?limit=5 应被 clamp 到 10（修复前返回 10 也是对的，但 rss.js 曾写 5..200 误导）");
    const r200 = await rssFeed(new Request("https://x/api/rss?limit=200"), env, {}, new URL("https://x/api/rss?limit=200"));
    assert.equal(countItems(await r200.text()), 12, "?limit=200 应 clamp 到 120，12 条全取（修复前下游二次 clamp 到 120，语义一致）");
  } finally {
    restoreGlobals();
  }
});

test("rss：stale 兜底时 cache-control max-age=0 + Warning 110", () => {
  const stale = xmlResponse("<rss/>", 120, false, true);
  assert.match(stale.headers.get("cache-control"), /max-age=0/, "stale 响应 max-age=0");
  assert.equal(stale.headers.get("warning"), '110 - "Response is Stale"');
  const fresh = xmlResponse("<rss/>", 120, false, false);
  assert.match(fresh.headers.get("cache-control"), /max-age=120/);
  assert.equal(fresh.headers.get("warning"), null, "新鲜响应不带 Warning");
  const priv = xmlResponse("<rss/>", 120, true, true);
  assert.match(priv.headers.get("cache-control"), /private, max-age=0/);
});

/* ---------------- 6. htmlToText ---------------- */

test("htmlToText：&amp; 最后解码，不双重解码字面实体", async () => {
  const { htmlToText: h } = await import("../src/util.js");
  assert.equal(h("a &amp;#65; b"), "a &#65; b", "&amp;#65; 是字面文本 &#65;，不得解成 A");
  assert.equal(h("&amp;lt;tag&amp;gt;"), "&lt;tag&gt;", "&amp;lt; 应解成字面 &lt;");
  assert.equal(h("&#65;&#x42;"), "AB", "正常数字引用仍解码");
  assert.equal(h("a &amp; b"), "a & b", "普通 &amp; 仍解码");
  assert.equal(h("&lt;b&gt;"), "<b>", "普通 &lt;/&gt; 仍解码");
});
