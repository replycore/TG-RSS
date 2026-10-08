/**
 * 仅媒体（mediaOnly）频道回归：
 *  - loadMediaOnlyChannelPage：只返回带媒体的帖子，整页纯文字时自动续翻
 *  - getFeed：mediaOnly 频道保留在信息流，但只投放媒体帖；纯文字帖不出现
 *  - getChannelPosts：mediaOnly 频道页只显示媒体帖
 *  - 非 mediaOnly 频道不受影响（纯文字帖照常出现）
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { loadMediaOnlyChannelPage, postHasMedia } from "../src/api/content.js";
import { getFeed, getChannelPosts } from "../src/api/content.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const fixture = await readFile(path.join(dir, "fixtures", "channel-page.html"), "utf8");
// 空页：模拟翻到没有更多消息的尽头
const EMPTY_PAGE = "<html><body><p>no more messages</p></body></html>";

function mockEnv(channels) {
  const store = new Map();
  store.set("settings:channels", JSON.stringify(channels));
  return {
    TG_RSS_KV: {
      async get(key, type) {
        const raw = store.has(key) ? store.get(key) : null;
        if (raw == null) return null;
        if (type === "json" && typeof raw === "string") {
          try { return JSON.parse(raw); } catch { return null; }
        }
        return raw;
      },
      async put(key, value) { store.set(key, value); },
      async delete(key) { store.delete(key); },
    },
  };
}

/** mock fetch：telegram 返回 fixture（含媒体帖），其他频道返回纯文字页；带 before 的请求返回空页 */
function mockFetch(fixtureHtml) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    let html;
    if (u.includes("before=")) {
      html = EMPTY_PAGE;
    } else if (u.includes("/s/telegram")) {
      html = fixtureHtml;
    } else {
      html = TEXT_ONLY_PAGE;
    }
    return {
      ok: true,
      status: 200,
      text: async () => html,
      headers: new Map(),
    };
  };
  return () => {
    globalThis.fetch = realFetch;
  };
}

// 纯文字频道页：3 条消息全部无媒体
const TEXT_ONLY_PAGE = `<html><body>
<div class="tgme_widget_message js-widget_message" data-post="durov/101" data-view="eyJjIjoxfQ">
  <time datetime="2024-05-01T10:00:00+00:00"></time>
  <div class="tgme_widget_message_text js-message_text">第一条纯文字</div>
</div>
<div class="tgme_widget_message js-widget_message" data-post="durov/100" data-view="eyJjIjoxfQ">
  <time datetime="2024-05-01T09:00:00+00:00"></time>
  <div class="tgme_widget_message_text js-message_text">第二条纯文字</div>
</div>
<div class="tgme_widget_message js-widget_message" data-post="durov/99" data-view="eyJjIjoxfQ">
  <time datetime="2024-05-01T08:00:00+00:00"></time>
  <div class="tgme_widget_message_text js-message_text">第三条纯文字</div>
</div>
</body></html>`;

const MEDIA_CHANNEL = { type: "public", username: "telegram", name: "TG", mediaOnly: true, order: 0 };
const NORMAL_CHANNEL = { type: "public", username: "durov", name: "Durov", mediaOnly: false, order: 1 };

test("postHasMedia：媒体数组非空即为 true", () => {
  assert.equal(postHasMedia({ media: [{ type: "image" }] }), true);
  assert.equal(postHasMedia({ media: [] }), false);
  assert.equal(postHasMedia({}), false);
});

test("loadMediaOnlyChannelPage：只返回带媒体的帖子", async () => {
  const restore = mockFetch(fixture);
  try {
    const env = mockEnv([MEDIA_CHANNEL]);
    const { info, posts, next } = await loadMediaOnlyChannelPage(env, {}, MEDIA_CHANNEL, null, 20);
    assert.ok(info, "应返回频道信息");
    assert.ok(posts.length > 0, "fixture 有媒体帖，应至少返回一条");
    for (const p of posts) {
      assert.ok(p.media && p.media.length > 0, `帖子 ${p.id} 不应无媒体`);
    }
    // fixture 共 20 条消息、5 条带媒体；全部应被收集（可能翻到空页）
    assert.equal(posts.length, 5, "应恰好返回 5 条媒体帖");
    assert.equal(next, null, "翻到空页后 next 应为 null");
  } finally {
    restore();
  }
});

test("getFeed：mediaOnly 频道保留但只投放媒体帖；普通频道纯文字照常", async () => {
  const restore = mockFetch(fixture);
  try {
    const env = mockEnv([MEDIA_CHANNEL, NORMAL_CHANNEL]);
    const url = new URL("https://example.com/api/feed");
    const res = await getFeed({}, env, {}, url, false);

    assert.ok(res.channels.some((c) => c.key === "telegram"), "mediaOnly 频道应保留在信息流");
    assert.ok(res.channels.some((c) => c.key === "durov"), "普通频道应在信息流");

    const tgPosts = res.posts.filter((p) => p.channel === "telegram");
    const durovPosts = res.posts.filter((p) => p.channel === "durov");

    assert.ok(tgPosts.length > 0, "mediaOnly 频道应有帖子出现在信息流");
    assert.equal(tgPosts.length, 5, "mediaOnly 频道只应投放 5 条媒体帖");
    for (const p of tgPosts) {
      assert.ok(p.media && p.media.length > 0, `信息流中 ${p.id} 不应无媒体`);
    }

    assert.ok(durovPosts.length > 0, "普通频道应有帖子");
    const hasTextOnly = durovPosts.some((p) => !p.media || p.media.length === 0);
    assert.ok(hasTextOnly, "普通频道的纯文字帖应照常出现在信息流");
  } finally {
    restore();
  }
});

test("getChannelPosts：mediaOnly 频道页只显示媒体帖", async () => {
  const restore = mockFetch(fixture);
  try {
    const env = mockEnv([MEDIA_CHANNEL]);
    const url = new URL("https://example.com/api/channels/telegram/posts?limit=20");
    const res = await getChannelPosts({}, env, {}, url, "telegram", false);
    assert.ok(res.posts.length > 0, "频道页应有媒体帖");
    for (const p of res.posts) {
      assert.ok(p.media && p.media.length > 0, `频道页帖子 ${p.id} 不应无媒体`);
    }
    assert.equal(res.posts.length, 5, "频道页应恰好显示 5 条媒体帖");
  } finally {
    restore();
  }
});

test("getChannelPosts：普通频道页纯文字帖不受影响", async () => {
  const restore = mockFetch(fixture);
  try {
    const env = mockEnv([NORMAL_CHANNEL]);
    const url = new URL("https://example.com/api/channels/durov/posts?limit=20");
    const res = await getChannelPosts({}, env, {}, url, "durov", false);
    const hasTextOnly = res.posts.some((p) => !p.media || p.media.length === 0);
    assert.ok(hasTextOnly, "普通频道页纯文字帖应照常显示");
  } finally {
    restore();
  }
});
