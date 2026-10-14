/**
 * 广告标签识别回归（isAdPost）：
 *  - 帖子 tags 命中广告标签（广告/ad/推广/赞助/aff 等）→ 全局隐藏
 *  - getFeed / getChannelPosts：广告帖不出现在信息流和频道页
 *  - 整页全是广告帖时自动续翻补页，不误判「到底了」
 *  - 正常帖（无广告标签）不受影响
 */
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { isAdPost, normalizeTag } from "../src/util.js";
import { getFeed, getChannelPosts } from "../src/api/content.js";

const dir = path.dirname(fileURLToPath(import.meta.url));

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
      async list({ prefix = "" } = {}) {
        const names = [...store.keys()].filter((k) => k.startsWith(prefix));
        return { keys: names.map((name) => ({ name })), list_complete: true, cursor: undefined };
      },
    },
  };
}

// 混合页：2 条正常帖 + 1 条广告帖（正文带 #广告，走 extractTags 链路）
const MIXED_PAGE = `<html><body>
<div class="tgme_widget_message js-widget_message" data-post="mixed/203" data-view="eyJjIjoxfQ">
  <time datetime="2024-05-01T10:00:00+00:00"></time>
  <div class="tgme_widget_message_text js-message_text">限时优惠最后一天 #广告</div>
</div>
<div class="tgme_widget_message js-widget_message" data-post="mixed/202" data-view="eyJjIjoxfQ">
  <time datetime="2024-05-01T09:00:00+00:00"></time>
  <div class="tgme_widget_message_text js-message_text">正常内容第一条</div>
</div>
<div class="tgme_widget_message js-widget_message" data-post="mixed/201" data-view="eyJjIjoxfQ">
  <time datetime="2024-05-01T08:00:00+00:00"></time>
  <div class="tgme_widget_message_text js-message_text">正常内容第二条 #日常</div>
</div>
</body></html>`;

// 全广告页：3 条全带广告标签（多种写法），带「加载更多」游标 → 触发续翻
const AD_ONLY_PAGE = `<html><body>
<div class="tgme_widget_message js-widget_message" data-post="promo/303" data-view="eyJjIjoxfQ">
  <time datetime="2024-05-02T10:00:00+00:00"></time>
  <div class="tgme_widget_message_text js-message_text">福利推广 #推广</div>
</div>
<div class="tgme_widget_message js-widget_message" data-post="promo/302" data-view="eyJjIjoxfQ">
  <time datetime="2024-05-02T09:00:00+00:00"></time>
  <div class="tgme_widget_message_text js-message_text">商业合作 #Ad</div>
</div>
<div class="tgme_widget_message js-widget_message" data-post="promo/301" data-view="eyJjIjoxfQ">
  <time datetime="2024-05-02T08:00:00+00:00"></time>
  <div class="tgme_widget_message_text js-message_text">返利活动 #aff</div>
</div>
<a class="tme_messages_more" data-before="90" href="https://t.me/s/promo?before=90">Load more</a>
</body></html>`;

// 续翻后的正常页：3 条无广告标签，无更多链接（翻完）
function normalPage(username, prefix) {
  return `<html><body>
<div class="tgme_widget_message js-widget_message" data-post="${username}/${prefix}2" data-view="eyJjIjoxfQ">
  <time datetime="2024-05-01T07:00:00+00:00"></time>
  <div class="tgme_widget_message_text js-message_text">补翻到的正常帖一</div>
</div>
<div class="tgme_widget_message js-widget_message" data-post="${username}/${prefix}1" data-view="eyJjIjoxfQ">
  <time datetime="2024-05-01T06:00:00+00:00"></time>
  <div class="tgme_widget_message_text js-message_text">补翻到的正常帖二</div>
</div>
</body></html>`;
}

const EMPTY_PAGE = "<html><body><p>no more messages</p></body></html>";

/** mock fetch：/s/promo 首页全广告、带 before 返回正常页；/s/mixed 返回混合页 */
function mockFetch() {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    let html;
    if (u.includes("/s/promo")) {
      html = u.includes("before=") ? normalPage("promo", "9") : AD_ONLY_PAGE;
    } else if (u.includes("/s/mixed")) {
      html = MIXED_PAGE;
    } else {
      html = EMPTY_PAGE;
    }
    return { ok: true, status: 200, text: async () => html, headers: new Map() };
  };
  return () => { globalThis.fetch = realFetch; };
}

const MIXED_CHANNEL = { key: "mixed", type: "public", username: "mixed", name: "Mixed", order: 0 };
const PROMO_CHANNEL = { key: "promo", type: "public", username: "promo", name: "Promo", order: 1 };

/* ---------------- isAdPost 单元 ---------------- */

test("normalizeTag：剥 # 前缀、去尾部标点、转小写", () => {
  assert.equal(normalizeTag("#Ad"), "ad");
  assert.equal(normalizeTag("＃广告，"), "广告");
  assert.equal(normalizeTag(" 广告 "), "广告");
});

test("isAdPost：命中广告标签集合", () => {
  assert.equal(isAdPost({ tags: ["广告"] }), true, "中文广告标签");
  assert.equal(isAdPost({ tags: ["#Ad"] }), true, "# 前缀 + 大小写容错");
  assert.equal(isAdPost({ tags: ["推广"] }), true);
  assert.equal(isAdPost({ tags: ["Sponsored"] }), true);
  assert.equal(isAdPost({ tags: ["aff"] }), true);
  assert.equal(isAdPost({ tags: ["日常"] }), false, "普通标签不误伤");
  assert.equal(isAdPost({ tags: ["add"] }), false, "相似词 add 不误伤");
  assert.equal(isAdPost({ tags: [] }), false);
  assert.equal(isAdPost({}), false, "无 tags 字段");
});

/* ---------------- 端到端过滤 ---------------- */

test("getChannelPosts：混合页广告帖被隐藏，正常帖保留", async () => {
  const restore = mockFetch();
  try {
    const env = mockEnv([MIXED_CHANNEL]);
    const url = new URL("https://example.com/api/channels/mixed/posts?limit=10");
    const res = await getChannelPosts({}, env, {}, url, "mixed", false);
    assert.equal(res.posts.length, 2, "3 条中 1 条广告，应剩 2 条");
    for (const p of res.posts) {
      assert.ok(isAdPost(p) === false, `帖子 ${p.id} 不应是广告`);
      assert.ok(!((p.tags || []).some((t) => String(t).toLowerCase().includes("广告"))), "不应含广告标签");
    }
  } finally {
    restore();
  }
});

test("getChannelPosts：整页全广告时自动续翻补页，不误判到底", async () => {
  const restore = mockFetch();
  try {
    const env = mockEnv([PROMO_CHANNEL]);
    const url = new URL("https://example.com/api/channels/promo/posts?limit=2");
    const res = await getChannelPosts({}, env, {}, url, "promo", false);
    assert.equal(res.posts.length, 2, "首页全广告被滤光，应从第二页补齐 2 条正常帖");
    for (const p of res.posts) {
      assert.ok(isAdPost(p) === false, `帖子 ${p.id} 不应是广告`);
    }
    assert.equal(res.next, null, "第二页无更多链接，游标应为 null");
  } finally {
    restore();
  }
});

test("getFeed：广告帖不出现在信息流，正常帖照常", async () => {
  const restore = mockFetch();
  try {
    const env = mockEnv([MIXED_CHANNEL]);
    const url = new URL("https://example.com/api/feed");
    const res = await getFeed({}, env, {}, url, false);
    const mixedPosts = res.posts.filter((p) => p.channel === "mixed");
    assert.equal(mixedPosts.length, 2, "信息流应只含 2 条正常帖");
    for (const p of mixedPosts) {
      assert.ok(isAdPost(p) === false, `信息流帖子 ${p.id} 不应是广告`);
    }
  } finally {
    restore();
  }
});

test("广告帖的 #日常 等普通标签不触发隐藏（精确匹配）", async () => {
  const restore = mockFetch();
  try {
    const env = mockEnv([MIXED_CHANNEL]);
    const url = new URL("https://example.com/api/channels/mixed/posts?limit=10");
    const res = await getChannelPosts({}, env, {}, url, "mixed", false);
    const tagged = res.posts.find((p) => (p.tags || []).some((t) => String(t).toLowerCase() === "日常"));
    assert.ok(tagged, "带 #日常 的正常帖应保留");
  } finally {
    restore();
  }
});
