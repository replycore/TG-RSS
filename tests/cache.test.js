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
