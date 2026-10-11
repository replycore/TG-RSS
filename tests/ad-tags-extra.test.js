/**
 * 自定义广告标签回归（adTagsExtra）：
 *  - 存取：saveSettings 写入自定义词（去重/截断/上限），getSettings 读回
 *  - 兼容：老数据无 adTagsExtra 字段 → mergeDefaults 补 []，不影响内置过滤
 *  - 过滤：自定义词参与 isAdPost 判定；loadChannelPage 实际过滤自定义命中帖
 */
import test from "node:test";
import assert from "node:assert/strict";

import { AD_TAGS, isAdPost } from "../src/util.js";
import { DEFAULTS, mergeDefaults, createSession } from "../src/store.js";
import { saveSettings, getSettings } from "../src/api/admin.js";
import { loadChannelPage } from "../src/api/content.js";

/** 极简内存 KV */
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

const env = () => ({ TG_RSS_KV: new MockKV() });

/** 已登录请求：setup 占位凭据 + session cookie */
async function authedReq(e, sessionToken) {
  return {
    headers: { get: (k) => (String(k).toLowerCase() === "cookie" ? `tgrss_session=${sessionToken}` : null) },
  };
}

async function setupAdmin(e) {
  // 直接写凭据 + 建会话（跳过 setup 的 turnstile/限流）
  e.TG_RSS_KV.map.set("admin:cred", JSON.stringify({ source: "kv", username: "root", salt: "00", hash: "00", iterations: 1 }));
  // getAdminCredential 走 KV 读取；session 用真实 createSession
  const token = await createSession(e, { username: "root" });
  return authedReq(e, token);
}

/* ---------------- 默认关键词 ---------------- */

test("内置默认关键词存在且不可删（代码常量）", () => {
  for (const must of ["广告", "推廣", "ad", "sponsor", "promo", "aff"]) {
    assert.ok(AD_TAGS.has(must), `内置集合应含 ${must}`);
  }
  assert.ok(isAdPost({ tags: ["广告"] }), "内置词直接命中");
});

/* ---------------- isAdPost + 自定义词 ---------------- */

test("isAdPost(extra)：自定义词参与判定，大小写/# 不敏感", () => {
  assert.ok(isAdPost({ tags: ["福利"] }, ["福利"]), "自定义词命中");
  assert.ok(isAdPost({ tags: ["#Coupon"] }, ["coupon"]), "# 前缀 + 大小写容错");
  assert.equal(isAdPost({ tags: ["日常"] }, ["福利"]), false, "未命中自定义词不隐藏");
  assert.equal(isAdPost({ tags: ["福利"] }, []), false, "无自定义词时不误伤");
  assert.equal(isAdPost({ tags: ["福利"] }), false, "缺省参数不误伤");
});

/* ---------------- 后端存取 ---------------- */

test("saveSettings：自定义词清洗后落盘（去重/截断/去空）", async () => {
  const e = env();
  const req = await setupAdmin(e);
  const res = await saveSettings(req, e, {
    general: { adTagsExtra: ["福利", "福利", "  ", "#返利", "x".repeat(50)] },
  });
  assert.equal(res.ok, true);
  const saved = res.general.adTagsExtra;
  assert.deepEqual(saved, ["福利", "#返利", "x".repeat(32)], "去重、去空、剥空格、单项截断 32 字符（# 保留由判定层剥）");
});

test("saveSettings：非数组输入容错", async () => {
  const e = env();
  const req = await setupAdmin(e);
  const res = await saveSettings(req, e, { general: { adTagsExtra: "福利" } });
  assert.deepEqual(res.general.adTagsExtra, ["福利"]);
});

test("老数据兼容：无 adTagsExtra 字段 → 读回默认 []，内置过滤不受影响", async () => {
  const e = env();
  const req = await setupAdmin(e);
  await saveSettings(req, e, { general: { siteTitle: "T" } });
  const settings = await getSettings(req, e);
  assert.deepEqual(settings.general.adTagsExtra, [], "mergeDefaults 补空数组");
  assert.ok(isAdPost({ tags: ["ad"] }, settings.general.adTagsExtra), "内置词仍命中");
});

/* ---------------- 端到端过滤 ---------------- */

const AD_PAGE = (username, text) => `<html><body>
<div class="tgme_widget_message js-widget_message" data-post="${username}/201" data-view="eyJjIjoxfQ">
  <time datetime="2024-05-01T10:00:00+00:00"></time>
  <div class="tgme_widget_message_text js-message_text">${text}</div>
</div>
<div class="tgme_widget_message js-widget_message" data-post="${username}/200" data-view="eyJjIjoxfQ">
  <time datetime="2024-05-01T09:00:00+00:00"></time>
  <div class="tgme_widget_message_text js-message_text">普通帖</div>
</div>
</body></html>`;

function mockFetch() {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => ({
    ok: true,
    status: 200,
    text: async () => AD_PAGE("custom", "限时福利速领 #福利"),
    headers: new Map(),
  });
  return () => { globalThis.fetch = realFetch; };
}

test("loadChannelPage：命中自定义词的帖被过滤", async () => {
  const restore = mockFetch();
  try {
    const e = env();
    e.TG_RSS_KV.map.set("settings:general", JSON.stringify({ ...DEFAULTS.general, adTagsExtra: ["福利"] }));
    const { posts } = await loadChannelPage(e, {}, { type: "public", username: "custom", name: "C" }, null, 10);
    assert.equal(posts.length, 1, "#福利 帖被过滤，应剩普通帖");
    assert.ok(!posts[0].textPlain.includes("福利"));
  } finally {
    restore();
  }
});

test("loadChannelPage：无自定义词时同帖保留", async () => {
  const restore = mockFetch();
  try {
    const e = env();
    e.TG_RSS_KV.map.set("settings:general", JSON.stringify({ ...DEFAULTS.general, adTagsExtra: [] }));
    const { posts } = await loadChannelPage(e, {}, { type: "public", username: "custom", name: "C" }, null, 10);
    assert.equal(posts.length, 2, "无自定义词，#福利 帖应保留");
  } finally {
    restore();
  }
});
