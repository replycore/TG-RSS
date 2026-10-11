/**
 * 桥接鉴权回归（独立成文件：不 import bridge/post.js → 不依赖 teleproto，
 * 缺依赖的离线环境也能跑——关键鉴权测试必须可离线验证）。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { authorized, equalString } from "../bridge/auth.js";

test("桥接鉴权：x-token / Bearer / ?token= 都认，错误令牌拒绝", () => {
  const token = "bridge-token-abc";
  const mkReq = (headers = {}) => ({ headers: { get: (k) => headers[String(k).toLowerCase()] ?? null } });
  // TG-RSS Worker 走的是 x-token 头（关键路径）
  assert.equal(authorized(new URL("http://b/feed"), mkReq({ "x-token": token }), token), true);
  // curl 调试友好：Bearer
  assert.equal(authorized(new URL("http://b/feed"), mkReq({ authorization: `Bearer ${token}` }), token), true);
  // <img> 直链场景：查询参数
  assert.equal(authorized(new URL(`http://b/media?ch=1&m=2&token=${token}`), mkReq(), token), true);
  // 拒绝
  assert.equal(authorized(new URL("http://b/feed"), mkReq({ "x-token": "nope" }), token), false);
  assert.equal(authorized(new URL("http://b/feed"), mkReq(), token), false);
  assert.equal(authorized(new URL("http://b/feed?token=wrong"), mkReq(), token), false);
  assert.equal(equalString("abc", "abc"), true);
  assert.equal(equalString("abc", "abd"), false);
});

test("桥接鉴权：真实 Node http headers（普通对象，无 .get）不抛错", () => {
  const token = "bridge-token-real";
  // 真实 http.createServer 的 req.headers：普通对象、键小写、值为字符串（或字符串数组）
  const realReq = (headers) => ({ headers, method: "GET" });
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
