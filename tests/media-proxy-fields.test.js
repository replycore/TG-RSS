/**
 * 媒体字段代理一致性回归：
 *  - 响应里所有「可加载地址」字段（src / url / thumbSrc / thumb）都必须指向站内代理，
 *    只有 direct 保留原始上游地址 —— 否则第三方客户端按 url 取图会直连 CDN 碎图
 *  - proxyAll=false 时公开频道保持直连（尊重用户设置），但桥接媒体仍强制代理
 */
import test from "node:test";
import assert from "node:assert/strict";

import { decoratePostMedia, normalizeBridgePost } from "../src/tg/fetcher.js";

const PUBLIC_MEDIA = {
  type: "image",
  url: "https://cdn1.telesco.pe/file/a.jpg",
  thumb: "https://cdn1.telesco.pe/file/a_thumb.jpg",
  permalink: null,
};

test("decoratePostMedia：url/thumb 与 src/thumbSrc 一致（都走代理）", async () => {
  const out = await decoratePostMedia({ media: [PUBLIC_MEDIA] }, { proxyAll: true });
  const m = out.media[0];
  assert.match(m.src, /^\/api\/media\/proxy\?u=/, "src 走代理");
  assert.equal(m.url, m.src, "url 必须与 src 相同，避免第三方客户端直连 CDN");
  assert.equal(m.thumb, m.thumbSrc, "thumb 必须与 thumbSrc 相同");
  assert.equal(m.direct, PUBLIC_MEDIA.url, "direct 保留原始地址作为唯一出口");
});

test("decoratePostMedia：proxyAll=false 时公开频道 url/src 均为直链", async () => {
  const out = await decoratePostMedia({ media: [PUBLIC_MEDIA] }, { proxyAll: false });
  const m = out.media[0];
  assert.equal(m.src, PUBLIC_MEDIA.url);
  assert.equal(m.url, PUBLIC_MEDIA.url);
  assert.equal(m.direct, PUBLIC_MEDIA.url);
});

test("decoratePostMedia：桥接媒体无视 proxyAll=false 恒走代理且带签名", async () => {
  const post = normalizeBridgePost(
    { postId: 7, textPlain: "x", media: [{ type: "image", url: "https://bridge.example.com/media?ch=-100&m=7" }] },
    { key: "p1", username: null },
  );
  const out = await decoratePostMedia(post, {
    proxyAll: false,
    _bridgeToken: "tok",
    _bridgeHost: "bridge.example.com",
  });
  const m = out.media[0];
  assert.match(m.src, /^\/api\/media\/proxy\?u=/);
  assert.match(m.src, /&sig=[A-Za-z0-9_-]+/);
  assert.equal(m.url, m.src);
  assert.equal("forceProxy" in m, false, "内部标记不外泄");
});
