/**
 * 客户端 IP 识别回归：
 *  - Cloudflare 的 cf-connecting-ip 优先（边缘注入，不可伪造）
 *  - 默认不信任 X-Forwarded-For（客户端可任意伪造，会绕过登录限流）
 *  - 仅显式 TRUST_PROXY=1 时读取 XFF
 */
import test from "node:test";
import assert from "node:assert/strict";

import { getClientIp } from "../src/util.js";

function req(headers) {
  const map = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { headers: { get: (k) => map.get(String(k).toLowerCase()) ?? null } };
}

test("getClientIp：优先使用 cf-connecting-ip", () => {
  const r = req({ "cf-connecting-ip": "203.0.113.7", "x-forwarded-for": "1.2.3.4" });
  assert.equal(getClientIp(r, {}), "203.0.113.7");
});

test("getClientIp：默认忽略 X-Forwarded-For（防伪造绕过限流）", () => {
  const r = req({ "x-forwarded-for": "1.2.3.4" });
  assert.equal(getClientIp(r, {}), "unknown");
  assert.equal(getClientIp(r), "unknown", "env 省略时同样不信任 XFF");
});

test("getClientIp：TRUST_PROXY=1 时取 XFF 第一段", () => {
  const r = req({ "x-forwarded-for": "1.2.3.4, 10.0.0.1" });
  assert.equal(getClientIp(r, { TRUST_PROXY: "1" }), "1.2.3.4");
  assert.equal(getClientIp(r, { TRUST_PROXY: true }), "1.2.3.4");
});

test("getClientIp：没有任何来源头时返回 unknown", () => {
  assert.equal(getClientIp(req({}), {}), "unknown");
});
