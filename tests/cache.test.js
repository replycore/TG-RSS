/**
 * N-2 缓存语义回归 + x-tgrss-up 调试标：
 *  - mock 缓存模拟 Cloudflare Cache API 语义：Cache-Control 含 private/no-store/no-cache 时 put 抛 413
 *  - cachedFetch 必须写 public（否则第二发拿不到 HIT，测试红）
 *  - MISS→HIT 链路与 fetchPublicChannelPage 的 cacheStatus 标
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchPublicChannelPage } from "../src/tg/fetcher.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const pageHtml = await readFile(path.join(dir, "fixtures", "channel-page.html"), "utf8");

/** 复现 CF Cache API 关键语义：拒存不可缓存的响应（413） */
function makeCFCache() {
  const store = new Map();
  const keyOf = (req) => (typeof req === "string" ? req : req.url);
  return {
    store,
    async match(req) {
      const hit = store.get(keyOf(req));
      return hit ? hit.clone() : undefined;
    },
    async put(req, res) {
      const cc = res.headers.get("cache-control") || "";
      if (/\bprivate\b|no-store|no-cache/i.test(cc)) {
        throw new Error(`413 cache.put: Cache-Control instructs not to cache ("${cc}")`);
      }
      const body = Buffer.from(await res.arrayBuffer());
      store.set(keyOf(req), new Response(body, { status: res.status, headers: res.headers }));
    },
  };
}

/** 装配/还原 globalThis.caches 与 fetch mock */
function withGlobals(cachesValue, fetchImpl, fn) {
  const oldCaches = globalThis.caches;
  const oldFetch = globalThis.fetch;
  globalThis.caches = cachesValue;
  globalThis.fetch = fetchImpl;
  return Promise.resolve(fn()).finally(() => {
    if (oldCaches === undefined) delete globalThis.caches;
    else globalThis.caches = oldCaches;
    globalThis.fetch = oldFetch;
  });
}

test("N-2：写 public 且 MISS→HIT（mock 拒存 private，复现 CF 413）", async () => {
  const cfCache = makeCFCache();
  let upstreamCalls = 0;
  await withGlobals({ default: cfCache }, async () => {
    upstreamCalls += 1;
    return new Response(pageHtml, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
  }, async () => {
    const first = await fetchPublicChannelPage({}, {}, "tgtest", null, 120);
    assert.equal(first.cacheStatus, "MISS", "首次请求应 MISS");
    assert.ok(first.posts.length > 0, "fixture 应解析出帖子");

    // 若代码写回 private，下面的 put 会像 CF 一样 413，store.size 会是 0 → 断言失败
    assert.equal(cfCache.store.size, 1, "缓存条目应已写入（写 private 会被 413 拒存）");
    const stored = [...cfCache.store.values()][0];
    const cc = stored.headers.get("cache-control") || "";
    assert.match(cc, /^public, max-age=\d+$/, `cache-control 必须 public：${cc}`);

    const second = await fetchPublicChannelPage({}, {}, "tgtest", null, 120);
    assert.equal(second.cacheStatus, "HIT", "第二次应命中");
    assert.equal(upstreamCalls, 1, "命中后不得回源");
  });
});

test("N-2：ttl=0 标 BYPASS 且不写缓存", async () => {
  const cfCache = makeCFCache();
  let upstreamCalls = 0;
  await withGlobals({ default: cfCache }, async () => {
    upstreamCalls += 1;
    return new Response(pageHtml, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
  }, async () => {
    const r = await fetchPublicChannelPage({}, {}, "tgtest", null, 0);
    assert.equal(r.cacheStatus, "BYPASS", "ttl=0 应标 BYPASS");
    assert.equal(upstreamCalls, 1);
    assert.equal(cfCache.store.size, 0, "ttl=0 不应写缓存");
  });
});

/** 把 store 里的条目改成已过期（age=1h）但仍在7天兜底窗内（保留原 body） */
async function expireEntry(cfCache, ageMs) {
  const key = [...cfCache.store.keys()][0];
  const old = cfCache.store.get(key);
  const body = Buffer.from(await old.arrayBuffer());
  const headers = new Headers(old.headers);
  headers.set("x-cache-stored-at", String(Date.now() - ageMs));
  cfCache.store.set(key, new Response(body, { status: old.status, headers }));
  return key;
}

test("stale-if-error：上游429时服旧缓存（STALE），冷却期内二次请求直接 HIT 不再打上游", async () => {
  const cfCache = makeCFCache();
  let upstreamCalls = 0;
  let upstreamMode = "ok";
  await withGlobals({ default: cfCache }, async () => {
    upstreamCalls += 1;
    if (upstreamMode === "rate") return new Response("rate limited", { status: 429 });
    return new Response(pageHtml, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
  }, async () => {
    const first = await fetchPublicChannelPage({}, {}, "tgtest", null, 120);
    assert.equal(first.cacheStatus, "MISS");

    await expireEntry(cfCache, 3600 * 1000); // 过期1小时（ttl 120s → 需回源）
    upstreamMode = "rate";

    const staleRes = await fetchPublicChannelPage({}, {}, "tgtest", null, 120);
    assert.equal(staleRes.cacheStatus, "STALE", "上游429时应返回旧缓存并标 STALE");
    assert.ok(staleRes.posts.length > 0, "旧内容应完整可解析");
    assert.equal(upstreamCalls, 2, "此时回源过一次");

    // 冷却期（60s）内：旧副本被重新写入为新鲜 → HIT，不得再打上游
    const cooled = await fetchPublicChannelPage({}, {}, "tgtest", null, 120);
    assert.equal(cooled.cacheStatus, "HIT", "冷却期内二次请求应 HIT");
    assert.equal(upstreamCalls, 2, "冷却期内不得再打上游（防快速切换连环限流）");
  });
});

test("stale-if-error：上游404不走兜底（频道不存在必须如实报错）", async () => {
  const cfCache = makeCFCache();
  let upstreamMode = "ok";
  await withGlobals({ default: cfCache }, async () => {
    if (upstreamMode === "gone") return new Response("gone", { status: 404 });
    return new Response(pageHtml, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
  }, async () => {
    await fetchPublicChannelPage({}, {}, "tgtest", null, 120);
    await expireEntry(cfCache, 3600 * 1000);
    upstreamMode = "gone";
    await assert.rejects(
      () => fetchPublicChannelPage({}, {}, "tgtest", null, 120),
      (err) => err.status === 404 && err.code === "channel_not_found",
      "404 不得被 stale 兜底掩盖",
    );
  });
});

test("stale-if-error：网络级失败也走兜底（502→旧内容）", async () => {
  const cfCache = makeCFCache();
  let upstreamMode = "ok";
  await withGlobals({ default: cfCache }, async () => {
    if (upstreamMode === "dead") throw new TypeError("fetch failed");
    return new Response(pageHtml, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
  }, async () => {
    await fetchPublicChannelPage({}, {}, "tgtest", null, 120);
    await expireEntry(cfCache, 3600 * 1000);
    upstreamMode = "dead";
    const res = await fetchPublicChannelPage({}, {}, "tgtest", null, 120);
    assert.equal(res.cacheStatus, "STALE", "网络失败时应返回旧缓存");
    assert.ok(res.posts.length > 0);
  });
});

test("stale-if-error：7天上限按内容原始时间算，冷却回写不重置上限", async () => {
  const cfCache = makeCFCache();
  let upstreamMode = "ok";
  await withGlobals({ default: cfCache }, async () => {
    if (upstreamMode === "rate") return new Response("rate limited", { status: 429 });
    return new Response(pageHtml, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
  }, async () => {
    const setAges = async (storedAgoMs, originalAgoMs) => {
      const key = [...cfCache.store.keys()][0];
      const old = cfCache.store.get(key);
      const body = Buffer.from(await old.arrayBuffer());
      const headers = new Headers(old.headers);
      headers.set("x-cache-stored-at", String(Date.now() - storedAgoMs));
      if (originalAgoMs != null) headers.set("x-cache-original-at", String(Date.now() - originalAgoMs));
      else headers.delete("x-cache-original-at");
      cfCache.store.set(key, new Response(body, { status: old.status, headers }));
    };

    const DAY = 86400 * 1000;

    // 1) 内容6天前（无 original 头，判定回退 stored-at）→ 上游故障应兜底
    await fetchPublicChannelPage({}, {}, "tgtest", null, 120);
    await setAges(6 * DAY, null);
    upstreamMode = "rate";
    const r1 = await fetchPublicChannelPage({}, {}, "tgtest", null, 120);
    assert.equal(r1.cacheStatus, "STALE", "6天前内容应兜底");

    // 2) 兜底回写必须继承原始时间（否则冷却刷新 stored-at 会绕过7天上限）
    const key = [...cfCache.store.keys()][0];
    const stored = cfCache.store.get(key);
    const origHeader = stored.headers.get("x-cache-original-at");
    assert.ok(origHeader, "回写条目必须带 x-cache-original-at");
    assert.ok(Date.now() - Number(origHeader) > 5 * DAY, "original-at 应保留约6天前的原始时间");

    // 3) stored-at 过期（冷却已过）、original 仍6天 → 继续兜底
    const origTs = Number(origHeader); // 绝对时间戳 → setAges 要的是"多久以前"的时长
    await setAges(6 * DAY + 120 * 1000, Date.now() - origTs);
    const r2 = await fetchPublicChannelPage({}, {}, "tgtest", null, 120);
    assert.equal(r2.cacheStatus, "STALE", "original 6天<7天，仍应兜底");

    // 4) original 到8天（时间流逝）→ 上限触发，不再兜底，如实报错
    await setAges(8 * DAY + 120 * 1000, 8 * DAY);
    await assert.rejects(
      () => fetchPublicChannelPage({}, {}, "tgtest", null, 120),
      (err) => err.status === 429 && err.code === "rate_limited",
      "超过7天的内容不得兜底，应透传上游错误",
    );
  });
});
