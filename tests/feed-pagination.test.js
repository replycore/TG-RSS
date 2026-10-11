/**
 * 分页游标回退回归（Bug A：getFeed / getMediaList 截断静默丢数据）：
 *  - getFeed：频道数×页大小 > limit 时，被 slice 截掉的帖游标不得越过；
 *    第二页必须从截断点续上（无丢失无重复）
 *  - getMediaList：同根，按帖粒度回退
 * 注意 clampInt 下限：feed limit 最小 10、media limit 最小 6
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { getFeed } from "../src/api/content.js";
import { getMediaList } from "../src/api/media.js";
import { encodeState } from "../src/util.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const fixture = await readFile(path.join(dir, "fixtures", "channel-page.html"), "utf8");

function mockEnv(channels, general = null) {
  const store = new Map();
  store.set("settings:channels", JSON.stringify(channels));
  if (general) store.set("settings:general", JSON.stringify(general));
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

function page(username, posts, moreBefore) {
  const blocks = posts
    .map((p) => `<div class="tgme_widget_message js-widget_message" data-post="${username}/${p.id}" data-view="eyJjIjoxfQ">
  <time datetime="${p.date}+00:00"></time>
  <div class="tgme_widget_message_text js-message_text">帖 ${p.id}</div>
</div>`)
    .join("\n");
  const more = moreBefore
    ? `<a class="tme_messages_more" data-before="${moreBefore}" href="https://t.me/s/${username}?before=${moreBefore}">Load more</a>`
    : "";
  return `<html><body>${blocks}${more}</body></html>`;
}

const d = (day, hour = 10) => `2024-${day}T${String(hour).padStart(2, "0")}:00:00`;
const chana1 = page("chana", [205, 204, 203, 202, 201, 200].map((id, i) => ({ id, date: `2024-06-0${6 - i}T10:00:00` })), 200);
const chana2 = page("chana", [199, 198, 197, 196, 195, 194].map((id, i) => ({ id, date: `2024-05-${31 - i}T10:00:00` })), 194);
const chanb1 = page("chanb", [105, 104, 103, 102, 101, 100].map((id, i) => ({ id, date: `2024-05-${25 - i}T10:00:00` })), 100);
const chanb2 = page("chanb", [101, 100, 99, 98, 97, 96].map((id, i) => ({ id, date: `2024-05-${19 - i}T10:00:00` })), 96);
const chanc1 = page("chanc", [505, 504, 503, 502, 501, 500].map((id, i) => ({ id, date: `2024-04-${String(10 - i).padStart(2, "0")}T10:00:00` })), 500);

function mockFetchRoutes() {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    let html;
    if (u.includes("/s/chana")) html = u.includes("before=") ? chana2 : chana1;
    else if (u.includes("/s/chanb")) html = u.includes("before=102") ? chanb2 : chanb1;
    else html = u.includes("before=") ? chanc1 : chanc1;
    return { ok: true, status: 200, text: async () => html, headers: new Map() };
  };
  return () => { globalThis.fetch = realFetch; };
}

const CHANNELS = [
  { key: "chana", type: "public", username: "chana", name: "A", order: 0 },
  { key: "chanb", type: "public", username: "chanb", name: "B", order: 1 },
  { key: "chanc", type: "public", username: "chanc", name: "C", order: 2 },
];
// 每频道页大小 = mock 页面帖数（6），防止 loadFilledChannelPage 补页循环打乱时序
const GENERAL = { pageSize: 6 };

test("getFeed：limit 截断时游标回退，第二页从截断点续上（无丢失）", async () => {
  const restore = mockFetchRoutes();
  try {
    const env = mockEnv(CHANNELS, GENERAL);
    // 第一页：3 频道×6 帖=18，limit=10 → 保留 chana/205..200（6）+ chanb/105..102（4）；chanc 全截
    const res1 = await getFeed({}, env, {}, new URL("https://x/api/feed?limit=10"), false);
    assert.equal(res1.posts.length, 10);
    assert.deepEqual(res1.posts.map((p) => p.postId), [205, 204, 203, 202, 201, 200, 105, 104, 103, 102]);
    assert.equal(res1.cursors.chana, "200", "chana 全保留 → 游标推进页尾");
    assert.equal(res1.cursors.chanb, "102", "chanb 被截断 → 游标回退到最后保留帖（修复前是 '100'，101..100 永久丢失）");
    assert.ok(!("chanc" in res1.cursors), "chanc 展示帖全被截 → 游标不推进（恢复「未开始」，下次重抓）");

    // 第二页：chanb 必须从 101 续上（无断层、无重复）——游标用 b64url encodeState（与前端一致）
    const c = encodeState(res1.cursors);
    const res2 = await getFeed({}, env, {}, new URL(`https://x/api/feed?limit=10&c=${c}`), false);
    const chanBIds = res2.posts.filter((p) => p.channel === "chanb").map((p) => p.postId);
    assert.ok(chanBIds.includes(101) && chanBIds.includes(100), `被截断的 101/100 应在第二页取回，实际: ${chanBIds}`);
    const allIds = [...res1.posts, ...res2.posts].map((p) => `${p.channel}/${p.postId}`);
    assert.equal(new Set(allIds).size, allIds.length, "两页之间无重复");
    assert.ok(!("chanc" in res2.cursors) || res2.cursors.chanc !== null, "chanc 仍无保留 → 游标继续保持「未开始」（重抓不丢）");
  } finally {
    restore();
  }
});

function mediaPost(username, id, date) {
  return `<div class="tgme_widget_message js-widget_message" data-post="${username}/${id}" data-view="eyJjIjoxfQ">
  <time datetime="${date}+00:00"></time>
  <a class="tgme_widget_message_video_player" href="https://t.me/${username}/${id}"><i class="tgme_widget_message_video_thumb" style="background-image:url('https://cdn1.telesco.pe/file/t.jpg')"></i></a>
  <video src="https://cdn1.telesco.pe/file/${id}.mp4" class="tgme_widget_message_video js-message_video" width="100%" height="100%" preload muted autoplay loop playsinline></video>
  <div class="tgme_widget_message_text js-message_text">视频 ${id}</div>
</div>`;
}
const chan2Page = `<html><body>${[303, 302, 301].map((id, i) => mediaPost("chan2", id, `2024-03-0${3 - i}`)).join("")}
<a class="tme_messages_more" data-before="301" href="https://t.me/s/chan2?before=301">Load more</a></body></html>`;

test("getMediaList：limit 截断时按帖粒度回退游标", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    const html = u.includes("/s/chan2") ? chan2Page : fixture;
    return { ok: true, status: 200, text: async () => html, headers: new Map() };
  };
  try {
    const env = mockEnv([
      { key: "telegram", type: "public", username: "telegram", name: "TG", order: 0 },
      { key: "chan2", type: "public", username: "chan2", name: "C2", order: 1 },
    ]);
    // fixture：4 条 video（date 2024-05）；chan2：3 条 video（date 2024-03，全旧）→ 共 7 条
    // 对照组：limit=60 全保留 → 游标全部推进 page.next
    const full = await getMediaList({}, env, {}, new URL("https://x/api/media?type=video&limit=60"), false);
    assert.equal(full.items.length, 7, "fixture 4 video + chan2 3 video");
    assert.equal(full.cursors.telegram, "80", "全保留 → 推进 page.next");
    assert.equal(full.cursors.chan2, "301", "全保留 → 推进 page.next");

    // 截断组：limit=6 → 保留 fixture 4 + chan2 最新 2 条（303,302）；chan2/301 被截 → 游标回退
    const clipped = await getMediaList({}, env, {}, new URL("https://x/api/media?type=video&limit=6"), false);
    assert.equal(clipped.items.length, 6);
    assert.equal(clipped.cursors.telegram, "80", "telegram 全保留 → 推进");
    assert.equal(clipped.cursors.chan2, "302", "chan2 被截断 → 回退到最后保留媒体帖（修复前是 '301'，301 永久丢失）");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("getMediaList：截断点落在帖子内部（一帖双视频）→ 游标 postId+1，下页整帖拿回", async () => {
  const chanAVids = [504, 503, 502, 501, 500]; // 5 条视频，date 全新
  const chanAPage1 = `<html><body>${chanAVids.map((id, i) => `<div class="tgme_widget_message js-widget_message" data-post="chana/${id}" data-view="x">
  <time datetime="2024-05-0${5 - i}T10:00:00+00:00"></time>
  <video src="https://cdn1.telesco.pe/file/${id}.mp4" class="tgme_widget_message_video js-message_video" width="100%" height="100%" preload muted autoplay loop playsinline></video>
  <div class="tgme_widget_message_text js-message_text">a ${id}</div>
</div>`).join("")}<a class="tme_messages_more" data-before="500" href="https://t.me/s/chana?before=500">Load more</a></body></html>`;
  // multib：402 帖带 2 个视频 + 401 帖 1 个视频；before=403 → exclusive 语义下仍返回 402/401
  const multibPage = `<html><body><div class="tgme_widget_message js-widget_message" data-post="multib/402" data-view="x">
  <time datetime="2024-03-05T10:00:00+00:00"></time>
  <video src="https://cdn1.telesco.pe/file/402a.mp4" class="tgme_widget_message_video js-message_video" width="100%" height="100%" preload muted autoplay loop playsinline></video>
  <video src="https://cdn1.telesco.pe/file/402b.mp4" class="tgme_widget_message_video js-message_video" width="100%" height="100%" preload muted autoplay loop playsinline></video>
  <div class="tgme_widget_message_text js-message_text">双视频帖</div>
</div><div class="tgme_widget_message js-widget_message" data-post="multib/401" data-view="x">
  <time datetime="2024-03-04T10:00:00+00:00"></time>
  <video src="https://cdn1.telesco.pe/file/401.mp4" class="tgme_widget_message_video js-message_video" width="100%" height="100%" preload muted autoplay loop playsinline></video>
  <div class="tgme_widget_message_text js-message_text">单视频帖</div>
</div><a class="tme_messages_more" data-before="401" href="https://t.me/s/multib?before=401">Load more</a></body></html>`;

  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    let html;
    if (u.includes("/s/chana")) html = u.includes("before=") ? EMPTY_PAGE : chanAPage1;
    else if (u.includes("/s/multib")) html = u.includes("before=401") ? EMPTY_PAGE : multibPage;
    else html = EMPTY_PAGE;
    return { ok: true, status: 200, text: async () => html, headers: new Map() };
  };
  try {
    const env = mockEnv([
      { key: "chana", type: "public", username: "chana", name: "A", order: 0 },
      { key: "multib", type: "public", username: "multib", name: "M", order: 1 },
    ], GENERAL);
    // 第一页 limit=6：保留 chanA 5 条 + multib/402 的第 1 个视频（第 6 位）→
    // 截断切在 402 帖内部（402#1 和 401 被截）→ multib 游标必须 402+1=403 而非 402
    const p1 = await getMediaList({}, env, {}, new URL("https://x/api/media?type=video&limit=6"), false);
    assert.equal(p1.items.length, 6);
    assert.ok(p1.items.some((it) => it.id === "multib/402#0"), "边界帖第 1 个视频在第一页");
    assert.ok(!p1.items.some((it) => it.id === "multib/402#1"), "第 2 个视频被截断");
    assert.equal(p1.cursors.multib, "403", "截断点在帖内 → postId+1（before exclusive，+1 才能整帖重取）");
    assert.equal(p1.cursors.chana, "500", "chana 全保留 → 推进 page.next");

    // 第二页：before=403（exclusive）→ 402 整帖重新出现 → 第 2 个视频拿回（修复前 before=402 会永久丢失）
    const c = encodeState(p1.cursors);
    const p2 = await getMediaList({}, env, {}, new URL(`https://x/api/media?type=video&limit=6&c=${c}`), false);
    assert.ok(p2.items.some((it) => it.id === "multib/402#1"), "第二页必须拿回边界帖第 2 个视频");
    assert.ok(p2.items.some((it) => it.id === "multib/401#0"), "401 也拿回");
    assert.equal(p2.cursors.multib, "401", "第二页全保留 → 推进");
  } finally {
    globalThis.fetch = realFetch;
  }
});
