/**
 * 频道帖子接口的 limit 契约回归：
 *  - 返回条数不得超过 limit（loadFilledChannelPage 会整页取回）
 *  - 截断时 next 游标必须回退到「最后一条展示帖」，否则被截掉的帖子永久丢失
 *  - tag 过滤后不足 limit 时，next 保持页尾游标（继续翻页）
 */
import test from "node:test";
import assert from "node:assert/strict";

import { getChannelPosts } from "../src/api/content.js";

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

/** 8 条消息（id 108→101，新→旧），其中 105 带 #topic 标签 */
function buildPage(withMore) {
  const rows = [];
  for (let id = 108; id >= 101; id -= 1) {
    const tag = id === 105 ? " #topic" : "";
    rows.push(`
<div class="tgme_widget_message js-widget_message" data-post="big/${id}" data-view="eyJjIjoxfQ">
  <time datetime="2024-05-01T${String(id - 100).padStart(2, "0")}:00:00+00:00"></time>
  <div class="tgme_widget_message_text js-message_text">第 ${id} 条正常内容${tag}</div>
</div>`);
  }
  const more = withMore
    ? '<a class="tme_messages_more" data-before="90" href="https://t.me/s/big?before=90">More</a>'
    : "";
  return `<html><body>${rows.join("")}${more}</body></html>`;
}

function mockFetch(withMore) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => buildPage(withMore),
    headers: new Map(),
  });
  return () => { globalThis.fetch = realFetch; };
}

const CHANNEL = { key: "big", type: "public", username: "big", name: "Big", order: 0 };

test("getChannelPosts：返回条数不超过 limit，且 next 回退到最后一条展示帖", async () => {
  const restore = mockFetch(true);
  try {
    const env = mockEnv([CHANNEL]);
    const url = new URL("https://example.com/api/channels/big/posts?limit=5");
    const res = await getChannelPosts({}, env, {}, url, "big", false);
    assert.equal(res.posts.length, 5, "请求 5 条只能返回 5 条（此前会返回整页 8 条）");
    assert.equal(res.count, 5);
    assert.deepEqual(res.posts.map((p) => p.postId), [108, 107, 106, 105, 104]);
    // 最后一条展示的是 104 → 下一页 before=104 取 103 及更旧，不重复也不丢
    assert.equal(res.next, "104");
  } finally {
    restore();
  }
});

test("getChannelPosts：tag 过滤后不足 limit，next 保持页尾游标", async () => {
  const restore = mockFetch(true);
  try {
    const env = mockEnv([CHANNEL]);
    const url = new URL("https://example.com/api/channels/big/posts?limit=5&tag=topic");
    const res = await getChannelPosts({}, env, {}, url, "big", false);
    assert.equal(res.posts.length, 1, "只有 105 带 #topic");
    assert.equal(res.next, 90, "未被截断时应保留页尾游标（继续翻页）");
  } finally {
    restore();
  }
});

test("getChannelPosts：条数不足 limit 时保持原 next", async () => {
  const restore = mockFetch(true);
  try {
    const env = mockEnv([CHANNEL]);
    const url = new URL("https://example.com/api/channels/big/posts?limit=50");
    const res = await getChannelPosts({}, env, {}, url, "big", false);
    assert.equal(res.posts.length, 8);
    assert.equal(res.next, 90);
  } finally {
    restore();
  }
});
