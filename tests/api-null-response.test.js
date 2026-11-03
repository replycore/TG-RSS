/**
 * request() 空响应回归：2xx 但 body 为空/非 JSON 时必须抛 ApiError（empty_response），
 * 不能把 null 返回给调用方——此前 views.js/media.js 的 `data.cursors` 直接炸
 * "null is not an object"，用户看到的是看不懂的 TypeError 而不是可重试的提示。
 */
import test from "node:test";
import assert from "node:assert/strict";

// 最小浏览器垫片（api.js 只用 localStorage/document/window.dispatchEvent + fetch）
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
globalThis.document = { querySelectorAll: () => [], documentElement: {} };
globalThis.window = { dispatchEvent: () => true };

const { api, ApiError } = await import(`../public/api.js?v=${Date.now()}`);

function mockRes({ ok = true, status = 200, contentType = "application/json", jsonImpl = null }) {
  return {
    ok,
    status,
    headers: { get: (k) => (/content-type/i.test(String(k)) ? contentType : null) },
    json: jsonImpl || (async () => { throw new SyntaxError("Unexpected end of JSON input"); }),
  };
}

const realFetch = globalThis.fetch;

test("request：200 + 空 body（json 解析失败）→ 抛 empty_response 而非返回 null", async () => {
  globalThis.fetch = async () => mockRes({});
  try {
    await assert.rejects(
      () => api.feed({}, null),
      (err) => {
        assert.ok(err instanceof ApiError, "应为 ApiError");
        assert.equal(err.code, "empty_response", "code 应为 empty_response");
        assert.ok(/空响应|empty response/i.test(err.message), `提示应可读，实际: ${err.message}`);
        return true;
      },
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("request：200 + 非 JSON content-type → 抛 empty_response", async () => {
  globalThis.fetch = async () => mockRes({ contentType: "text/html" });
  try {
    await assert.rejects(
      () => api.media({ type: "video" }),
      (err) => {
        assert.ok(err instanceof ApiError, "应为 ApiError");
        assert.equal(err.code, "empty_response");
        return true;
      },
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("request：200 + 正常 JSON → 照常返回 data", async () => {
  const payload = { posts: [], cursors: { a: "1" } };
  globalThis.fetch = async () =>
    mockRes({ jsonImpl: async () => payload });
  try {
    const data = await api.feed({}, null);
    assert.deepEqual(data, payload, "正常响应不受影响");
  } finally {
    globalThis.fetch = realFetch;
  }
});
