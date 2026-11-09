/**
 * 桥接帖子 HTML 二次清洗回归（纵深防御）：
 * 官方 bridge 已 escapeHtml，但 Worker 侧不能依赖外部实现——
 * 旧版/第三方/被攻破的 bridge 返回任意 HTML 时，前端 innerHTML 会直接执行。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { normalizeBridgePost } from "../src/tg/fetcher.js";

const channel = { key: "priv:-1001234567890", username: "demo", name: "Demo" };

test("normalizeBridgePost：丢弃事件属性与危险标签", () => {
  const post = normalizeBridgePost(
    { postId: 1, textHtml: '<img src=x onerror="alert(1)"><script>alert(2)</script>hello' },
    channel,
  );
  assert.ok(!/onerror/i.test(post.textHtml), "事件属性必须被移除");
  assert.ok(!/<img/i.test(post.textHtml), "img 不在白名单");
  assert.ok(!/<script/i.test(post.textHtml), "script 必须被丢弃");
  assert.ok(post.textHtml.includes("hello"), "正常文本保留");
});

test("normalizeBridgePost：保留白名单标签", () => {
  const post = normalizeBridgePost(
    { postId: 2, textHtml: 'a<br><b>粗体</b> <a href="https://example.com/x">链接</a>' },
    channel,
  );
  assert.ok(post.textHtml.includes("<br>"));
  assert.ok(post.textHtml.includes("<b>粗体</b>"));
  assert.ok(post.textHtml.includes('href="https://example.com/x"'));
  assert.ok(post.textHtml.includes('rel="noopener noreferrer nofollow"'));
});

test("normalizeBridgePost：已转义的文本不会被二次转义", () => {
  // 官方 bridge 输出 a &lt; b，再次清洗后仍应是 a &lt; b（前端渲染为 a < b）
  const post = normalizeBridgePost({ postId: 3, textHtml: "a &lt; b &amp; c" }, channel);
  assert.equal(post.textHtml, "a &lt; b &amp; c");
});

test("normalizeBridgePost：javascript: 链接被拒绝", () => {
  const post = normalizeBridgePost(
    { postId: 4, textHtml: '<a href="javascript:alert(1)">x</a>' },
    channel,
  );
  assert.ok(!/javascript:/i.test(post.textHtml));
  assert.ok(post.textHtml.includes("<a>") || !post.textHtml.includes("href"));
});
