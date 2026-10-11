/**
 * API 健壮性回归：
 *  - Bug B（脏 bridge.url）：历史版本把 "https://" 存成 "https:"，proxyMedia 不得 500
 *  - Bug C（坏路由 key）：GET /api/channels/%E4/posts → 404（此前裸 decodeURIComponent 抛 URIError → 500）
 */
import test from "node:test";
import assert from "node:assert/strict";

import { proxyMedia } from "../src/api/media.js";
import { handleRequest } from "../src/router.js";
import { HttpError, b64urlEncode } from "../src/util.js";

class MockKV {
  constructor() { this.map = new Map(); }
  async get(key, type) {
    const raw = this.map.get(key);
    if (raw == null) return null;
    return type === "json" ? JSON.parse(raw) : raw;
  }
  async put(key, value) { this.map.set(key, String(value)); }
  async delete(key) { this.map.delete(key); }
}

test("proxyMedia：脏 bridge.url（https:）不 500，按白名单拒绝", async () => {
  const env = { TG_RSS_KV: new MockKV() };
  // 历史脏数据形态：合法前缀校验通过、strip 后只剩 "https:"
  env.TG_RSS_KV.map.set("settings:bridge", JSON.stringify({ url: "https:", enabled: true, token: "" }));
  const target = b64urlEncode("https://evil.example/x.jpg");
  const url = new URL(`https://x/api/media/proxy?u=${target}`);
  const request = { headers: { get: () => null } };
  await assert.rejects(
    () => proxyMedia(request, env, {}, url),
    (err) => {
      // 修复前：isBridge 处 new URL("https:") 抛 TypeError（非 HttpError，全局 500）
      assert.ok(err instanceof HttpError, `应为 HttpError，实际: ${err.constructor.name}: ${err.message}`);
      assert.equal(err.status, 403, "非白名单主机应 403 host_not_allowed");
      return true;
    },
  );
});

test("router：坏 key（%E4）返回 404 而非 500", async () => {
  const env = { TG_RSS_KV: new MockKV() };
  const request = new Request("https://x/api/channels/%E4/posts");
  const res = await handleRequest(request, env, {});
  // 修复前：decodeURIComponent 抛 URIError → 500 internal_error
  assert.equal(res.status, 404, "坏 key 应走 findChannel 404");
  const body = await res.json();
  assert.equal(body.code, "channel_not_found");
});
