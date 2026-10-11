/**
 * 桥接鉴权回归（独立成文件：不 import bridge/post.js → 不依赖 teleproto，
 * 缺依赖的离线环境也能跑——关键鉴权测试必须可离线验证）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import { authorized, equalString, signPayload, verifySignature, SIGN_WINDOW_SEC } from "../bridge/auth.js";
import { bridgeSignedHeaders } from "../src/bridge-sign.js";

const mkReq = (headers = {}, method = "GET") => ({
  method,
  headers: { get: (k) => headers[String(k).toLowerCase()] ?? null },
});
// 真实 Node http 形态：普通对象、键小写、无 .get
const realReq = (headers = {}, method = "GET") => ({ headers, method });

test("桥接鉴权：x-token / Bearer 仍然有效，错误令牌拒绝", () => {
  const token = "bridge-token-abc";
  assert.equal(authorized(new URL("http://b/feed"), mkReq({ "x-token": token }), token), true);
  assert.equal(authorized(new URL("http://b/feed"), mkReq({ authorization: `Bearer ${token}` }), token), true);
  assert.equal(authorized(new URL("http://b/feed"), mkReq({ "x-token": "nope" }), token), false);
  assert.equal(authorized(new URL("http://b/feed"), mkReq(), token), false);
  assert.equal(equalString("abc", "abc"), true);
  assert.equal(equalString("abc", "abd"), false);
});

test("桥接鉴权：?token= 查询参数已移除（token 不进 URL/HTML）", () => {
  const token = "bridge-token-abc";
  // 修复前这行返回 true——媒体 URL 曾把 token 拼进 <img>，泄露面直达页面源码
  assert.equal(authorized(new URL(`http://b/media?ch=-1001&m=2&token=${token}`), mkReq(), token), false);
});

test("桥接鉴权：HMAC 签名（Worker 端 ↔ bridge 端往返）", async () => {
  const token = "hmac-shared-secret";
  const url = new URL("http://b/feed?channel=-100123&limit=20");
  // Worker 端（src/bridge-sign.js，crypto.subtle）生成
  const headers = await bridgeSignedHeaders({ token }, "GET", url.pathname + url.search);
  // bridge 端（bridge/auth.js，node:crypto）验证
  assert.equal(verifySignature(url, mkReq({ ...headers }), token), true, "往返通过");
  assert.equal(authorized(url, mkReq({ ...headers }), token), true, "authorized 认签名");

  // 真实 Node http 普通对象形态同样通过
  assert.equal(authorized(url, realReq({ ...headers }), token), true);

  // 路径绑定：同签名打别的路径必须失败
  const otherPath = new URL("http://b/avatar?ch=-100123");
  assert.equal(verifySignature(otherPath, mkReq({ ...headers }), token), false, "换路径失效");

  // 错 token 签名失败
  const forged = await bridgeSignedHeaders({ token: "evil" }, "GET", url.pathname + url.search);
  assert.equal(verifySignature(url, mkReq({ ...forged }), token), false, "错密钥失效");

  // 时间窗外失效
  const staleTs = String(Math.floor(Date.now() / 1000) - (SIGN_WINDOW_SEC + 10));
  const staleSig = signPayload(token, staleTs, "GET", url.pathname + url.search);
  assert.equal(verifySignature(url, mkReq({ "x-timestamp": staleTs, "x-signature": staleSig }), token), false, "过窗失效");

  // 未来时间同样拒（防时钟前移重放）
  const futureTs = String(Math.floor(Date.now() / 1000) + SIGN_WINDOW_SEC + 10);
  const futureSig = signPayload(token, futureTs, "GET", url.pathname + url.search);
  assert.equal(verifySignature(url, mkReq({ "x-timestamp": futureTs, "x-signature": futureSig }), token), false, "未来时间失效");

  // 缺头不通过
  assert.equal(verifySignature(url, mkReq({ "x-timestamp": String(Date.now()) }), token), false);
  // 签名载荷本身稳定可复算（防两端约定漂移）
  assert.equal(
    signPayload("t", "1700000000", "GET", "/feed?x=1"),
    crypto.createHmac("sha256", "t").update("1700000000\nGET\n/feed?x=1").digest("base64"),
  );
});

test("桥接鉴权：时间窗可通过 opts.windowSec 放宽（时钟偏差场景）", () => {
  const token = "window-token";
  const url = new URL("http://b/feed");
  const oldTs = String(Math.floor(Date.now() / 1000) - 600); // 10 分钟前（默认窗外）
  const sig = signPayload(token, oldTs, "GET", url.pathname + url.search);
  const req = mkReq({ "x-timestamp": oldTs, "x-signature": sig });
  assert.equal(verifySignature(url, req, token), false, "默认 300s 窗外拒绝");
  assert.equal(verifySignature(url, req, token, { windowSec: 900 }), true, "放宽到 900s 后通过");
  assert.equal(authorized(url, req, token, { windowSec: 900 }), true, "authorized 透传 windowSec");
});

test("桥接鉴权：真实 Node http headers（普通对象，无 .get）不抛错", () => {
  const token = "bridge-token-real";
  assert.equal(authorized(new URL("http://b/feed"), realReq({ "x-token": token }), token), true);
  assert.equal(authorized(new URL("http://b/feed"), realReq({ authorization: `Bearer ${token}` }), token), true);
  assert.equal(authorized(new URL("http://b/feed"), realReq({ "x-token": ["nope"] }), token), false);
  // 数组形式（重复头）：join 后应拒绝
  assert.equal(authorized(new URL("http://b/feed"), realReq({ "x-token": [token, token] }), token), false, "拼接值不等于单 token");
  // 无头 + 无 query
  assert.equal(authorized(new URL("http://b/feed"), realReq({}), token), false);
  // 完全没有 headers 字段也不炸
  assert.equal(authorized(new URL("http://b/feed"), {}, token), false);
});

test("桥接鉴权：Origin 白名单（可选）只约束头认证，签名不受限", () => {
  const token = "origin-token";
  const opts = { allowedOrigins: ["https://rss.example.com"] };
  const url = new URL("http://b/feed");
  // 头认证 + 白名单 Origin → 通过
  assert.equal(authorized(url, mkReq({ "x-token": token, origin: "https://rss.example.com" }), token, opts), true);
  // Referer 也可以（部署形态差异）
  assert.equal(authorized(url, mkReq({ "x-token": token, referer: "https://rss.example.com/c/xxx" }), token, opts), true);
  // 头认证 + 陌生 Origin → 拒绝
  assert.equal(authorized(url, mkReq({ "x-token": token, origin: "https://evil.example.com" }), token, opts), false);
  // 头认证 + 无 Origin → 拒绝（配置了白名单就要求）
  assert.equal(authorized(url, mkReq({ "x-token": token }), token, opts), false);
  // 签名请求不受 Origin 约束（已证明持有 token）
  return bridgeSignedHeaders({ token }, "GET", url.pathname + url.search).then((headers) => {
    assert.equal(authorized(url, mkReq({ ...headers }), token, opts), true);
    // 未配置白名单：行为同旧（头认证无 Origin 也放行）
    assert.equal(authorized(url, mkReq({ "x-token": token }), token), true);
  });
});
