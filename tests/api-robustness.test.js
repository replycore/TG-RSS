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

test("findChannel：大小写不敏感（#/c/Xiaomi 匹配 key=xiaomi）", async () => {
  const { findChannel } = await import("../src/api/content.js");
  const channels = [
    { key: "xiaomi", name: "小米官方", type: "public" },
    { key: "telegram", name: "Telegram", type: "public" },
  ];
  // 频道 key 是 username.toLowerCase()，但帖子 channel 取自 t.me HTML 的 data-post（原始大小写）
  assert.equal(findChannel(channels, "Xiaomi")?.name, "小米官方");
  assert.equal(findChannel(channels, "xiaomi")?.name, "小米官方");
  assert.equal(findChannel(channels, "TELEGRAM")?.name, "Telegram");
  assert.equal(findChannel(channels, "nope"), null);
  assert.equal(findChannel(channels, 123), null, "非字符串 key 走精确匹配");
});

test("proxyAll=false：bridge 媒体仍恒走代理（裸 URL 无认证必 401），公开频道直链", async () => {
  const { normalizeBridgePost, decoratePostMedia } = await import("../src/tg/fetcher.js");
  const bridgePost = normalizeBridgePost(
    { postId: 5, textPlain: "x", media: [{ type: "image", url: "https://bridge.example.com/avatar?ch=-1001&m=5" }] },
    { key: "p1", username: null },
  );
  const settings = { proxyAll: false, types: {} };
  const decorated = await decoratePostMedia(bridgePost, settings);
  assert.equal(decorated.media[0].src.startsWith("/api/media/proxy?u="), true, "proxyAll=false 时 bridge 媒体也必须代理");
  assert.equal("forceProxy" in decorated.media[0], false, "内部标记不外泄到响应");

  // 公开频道（无 forceProxy）在 proxyAll=false 时保持直链
  const pub = await decoratePostMedia(
    { media: [{ type: "image", url: "https://cdn.example.com/a.jpg" }] },
    settings,
  );
  assert.equal(pub.media[0].src, "https://cdn.example.com/a.jpg");
});

test("fetchBridgeFeed 401：按 bridge 自报的 windowSec 判定时钟差，写死 300s 的场景不再漏提示", async () => {
  const { fetchBridgeFeed } = await import("../src/tg/fetcher.js");
  const { HttpError } = await import("../src/util.js");
  const now = Math.floor(Date.now() / 1000);
  const env = {
    TG_RSS_KV: {
      get: async (k, type) => {
        if (k !== "settings:bridge") return null;
        const raw = JSON.stringify({ url: "https://b.example.com", token: "t", enabled: true });
        return type === "json" ? JSON.parse(raw) : raw;
      },
      put: async () => {},
    },
  };
  const realFetch = globalThis.fetch;
  const mock401 = async (serverTime, windowSec) => ({
    ok: false,
    status: 401,
    headers: { get: () => "application/json" },
    json: async () => ({ error: "invalid_token", serverTime, windowSec }),
    text: async () => "",
  });
  try {
    // 场景：窗口配 60s、时钟差 100s —— 超窗被拒（drift < 300，旧写死阈值不会提示）
    globalThis.fetch = async () => mock401(now - 100, 60);
    await assert.rejects(
      () => fetchBridgeFeed(env, { username: "u", key: "u" }),
      // 时钟差按调用时刻的 Date.now() 计算，慢机/并发下可能比捕获的 now 多 1~2s → 容忍 99~102
      (err) => err instanceof HttpError && /时钟差约 -?(99|100|101|102)s/.test(err.message) && /±60s/.test(err.message) && /NTP/.test(err.message),
      "超窗时钟差必须提示 NTP",
    );
    // 窗口 60s、时钟差 50s：未超窗（401 另有原因）→ 不提示 NTP
    globalThis.fetch = async () => mock401(now - 50, 60);
    await assert.rejects(
      () => fetchBridgeFeed(env, { username: "u", key: "u" }),
      (err) => !/NTP/.test(err.message),
      "未超窗不得误报 NTP",
    );
    // 响应体无 windowSec（旧 bridge）→ 回退 300s
    globalThis.fetch = async () => mock401(now - 400, undefined);
    await assert.rejects(
      () => fetchBridgeFeed(env, { username: "u", key: "u" }),
      (err) => /NTP/.test(err.message),
      "无 windowSec 时按 300s 兜底",
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("H-1：代理 URL 签名往返 + 篡改/缺签/错 token 拒绝", async () => {
  const { signProxyU, verifyProxySig } = await import("../src/proxy-sign.js");
  const token = "bridge-token-abc";
  const u = Buffer.from("https://bridge.example.com/media?ch=-1001&m=5").toString("base64url");
  const sig = await signProxyU(token, u);
  assert.ok(sig, "应产出签名");
  assert.equal(await verifyProxySig(token, u, sig), true, "合法签名应通过");
  // 篡改 u（枚举改 ch/m）
  const tampered = Buffer.from("https://bridge.example.com/media?ch=-9999&m=1").toString("base64url");
  assert.equal(await verifyProxySig(token, tampered, sig), false, "篡改 u 后签名必须失效");
  // 错 token
  assert.equal(await verifyProxySig("wrong-token", u, sig), false, "错 token 必须拒绝");
  // 缺签名
  assert.equal(await verifyProxySig(token, u, null), false, "缺签名必须拒绝");
  assert.equal(await verifyProxySig(token, u, ""), false, "空签名必须拒绝");
  // token 空 → 不签名（返回空串），验签也拒绝
  assert.equal(await signProxyU("", u), "", "token 空不签名");
});

test("N-1 端到端：proxyUrlFor 生成的 URL 必须被 proxyMedia 放行（参数名 s/sig 一致性）", async () => {
  // 评审 N-1：生成端曾写 &s=、校验端读 get("sig") → 所有 bridge 媒体 403。
  // 纯函数单测抓不到这种两端字段漂移——本用例让 URL 真正走完整链路。
  const { proxyUrlFor } = await import("../src/tg/fetcher.js");
  const { responseSignatureHeaders } = await import("../bridge/auth.js");
  const token = "e2e-bridge-token";
  const env = { TG_RSS_KV: new MockKV() };
  env.TG_RSS_KV.map.set("settings:bridge", JSON.stringify({
    url: "https://bridge.example.com", enabled: true, token,
  }));
  const target = "https://bridge.example.com/media?ch=-1001&m=42";

  // 1) 生成端产出带签名的站内代理 URL
  const path = await proxyUrlFor(target, {
    proxyAll: true, _bridgeToken: token, _bridgeHost: "bridge.example.com",
  });
  assert.ok(path && path.includes("sig="), `代理 URL 必须带 sig 参数（与校验端一致）：${path}`);

  // 2) stub fetch：模拟 bridge 返回**带合法响应签名**的媒体（双向校验也要过）
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(Uint8Array.from([1, 2, 3, 4]), {
    status: 200,
    headers: {
      "content-type": "image/jpeg",
      ...responseSignatureHeaders({ token, status: 200, method: "GET", pathWithQuery: "/media?ch=-1001&m=42", windowSec: 300 }),
    },
  });
  try {
    const request = { headers: { get: () => null } };
    const url = new URL(path, "https://rss.example.com");
    const res = await proxyMedia(request, env, {}, url);
    assert.equal(res.status, 200, `合法签名 URL 应完整走通（非 403 bad_proxy_sig）：${res.status}`);
    assert.deepEqual([...new Uint8Array(await res.arrayBuffer())], [1, 2, 3, 4], "媒体字节应透传");
  } finally {
    globalThis.fetch = realFetch;
  }

  // 3) 篡改 u（枚举 ch/m）→ 必须 403（签名覆盖 u，改 u 即失效）
  const evil = new URL(path, "https://rss.example.com");
  evil.searchParams.set("u", b64urlEncode("https://bridge.example.com/media?ch=-9999&m=1"));
  await assert.rejects(
    () => proxyMedia({ headers: { get: () => null } }, env, {}, evil),
    (err) => {
      assert.equal(err.status, 403, "篡改 u 必须 403");
      assert.equal(err.code, "bad_proxy_sig", `应为 bad_proxy_sig：${err.code}`);
      return true;
    },
  );

  // 4) 完全不带签名 → 403
  const unsigned = new URL(`https://rss.example.com/api/media/proxy?u=${b64urlEncode(target)}`);
  await assert.rejects(
    () => proxyMedia({ headers: { get: () => null } }, env, {}, unsigned),
    (err) => {
      assert.equal(err.status, 403, "无签名必须 403");
      assert.equal(err.code, "bad_proxy_sig");
      return true;
    },
  );
});

test("H-2：响应验签窗口 cap 到 3600（防中间人借超大 x-bridge-window-sec 重放）", async () => {
  const { verifyBridgeResponse } = await import("../src/bridge-sign.js");
  const token = "t";
  // bridge 自报超大窗口 999999999（攻击者可篡改该头）
  const r = new Response("{}", { status: 200, headers: {
    "x-bridge-timestamp": String(Math.floor(Date.now() / 1000) - 4000),
    "x-bridge-signature": "x", // 签名本就不对，但先看窗口判定
    "x-bridge-window-sec": "999999999",
  } });
  const out = await verifyBridgeResponse({ token }, r, "GET", "/feed");
  // 窗口应被 cap 到 3600：4000s 前的戳 > 3600 → stale（而非借超大窗口放行）
  assert.equal(out.reason, "stale", `超大窗口应被 cap，过老的戳仍判 stale：${JSON.stringify(out)}`);
  assert.ok(out.windowSec <= 3600, `窗口不得超 3600，实际 ${out.windowSec}`);
});
