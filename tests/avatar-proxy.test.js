/**
 * 频道头像代理回归：
 *  - 公开频道头像（telesco.pe）必须转成站内 /api/media/proxy，不能直连 CDN
 *  - proxyAll=false 时保持用户选择（直连）
 *  - 桥接头像已带签名时按当前 token 重签（旧 sig 会过期）
 *  - 脏数据（空 / 相对 / 非 http）不产生坏 URL
 */
import test from "node:test";
import assert from "node:assert/strict";

import { proxyAvatarUrl } from "../src/tg/fetcher.js";
import { b64urlDecodeToString } from "../src/util.js";

const PUBLIC_AVATAR = "https://cdn1.telesco.pe/file/abc123.jpg";
const BRIDGE_AVATAR = "https://bridge.example.com/avatar?ch=-1001";

test("proxyAvatarUrl：公开频道头像转为站内代理", async () => {
  const out = await proxyAvatarUrl(PUBLIC_AVATAR, { proxyAll: true });
  assert.match(out, /^\/api\/media\/proxy\?u=[A-Za-z0-9_-]+$/);
  const u = out.slice("/api/media/proxy?u=".length);
  assert.equal(b64urlDecodeToString(u), PUBLIC_AVATAR, "u 必须能还原出原始地址");
});

test("proxyAvatarUrl：proxyAll=false 时保持直连（尊重用户设置）", async () => {
  assert.equal(await proxyAvatarUrl(PUBLIC_AVATAR, { proxyAll: false }), PUBLIC_AVATAR);
});

test("proxyAvatarUrl：桥接头像带签名（含 exp）", async () => {
  const settings = { proxyAll: true, _bridgeToken: "tok-123", _bridgeHost: "bridge.example.com" };
  const out = await proxyAvatarUrl(BRIDGE_AVATAR, settings);
  assert.match(out, /^\/api\/media\/proxy\?u=/);
  assert.match(out, /&sig=[A-Za-z0-9_-]+/, "桥接主机必须签名");
  assert.match(out, /&exp=\d+/, "签名需带过期时间");
});

test("proxyAvatarUrl：已代理的桥接地址按当前 token 重签", async () => {
  const settings = { proxyAll: true, _bridgeToken: "tok-123", _bridgeHost: "bridge.example.com" };
  const stale = `${await proxyAvatarUrl(BRIDGE_AVATAR, settings)}`.replace(/&exp=\d+/, "&exp=1");
  const out = await proxyAvatarUrl(stale, settings);
  const exp = Number(/&exp=(\d+)/.exec(out)?.[1] || 0);
  assert.ok(exp > Date.now() / 1000, "过期时间应被刷新到未来");
});

test("proxyAvatarUrl：脏数据返回 null，不产出坏 URL", async () => {
  assert.equal(await proxyAvatarUrl(null, { proxyAll: true }), null);
  assert.equal(await proxyAvatarUrl("", { proxyAll: true }), null);
  assert.equal(await proxyAvatarUrl("/relative.png", { proxyAll: true }), null);
  assert.equal(await proxyAvatarUrl("javascript:alert(1)", { proxyAll: true }), null);
});

test("proxyAvatarUrl：已嵌套的代理地址不再套娃", async () => {
  const settings = { proxyAll: true, _bridgeToken: "tok", _bridgeHost: "bridge.example.com" };
  const once = await proxyAvatarUrl(BRIDGE_AVATAR, settings);
  // 构造历史脏数据：把代理地址本身又编码了一层
  const nested = `/api/media/proxy?u=${Buffer.from(once, "utf8").toString("base64url").replace(/=+$/, "")}`;
  const out = await proxyAvatarUrl(nested, settings);
  assert.equal(out, nested, "解出站内相对地址时原样返回，不再包一层");
});
