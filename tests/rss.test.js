/**
 * RSS 订阅输出测试：XML 结构、转义、条目顺序、媒体 enclosure。
 * 最后一项在本地开发服务器（npm run dev:node）运行时才会执行，否则自动跳过。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { renderRss, itemTitle } from "../src/api/rss.js";
import { isolatedBase } from "./helpers/dev-server.js";

// N-6：默认拉起本文件专属 dev-server（随机端口、独立内存 KV），避免与其他测试共享状态
const BASE = (await isolatedBase()) || "http://localhost:8787";

function samplePosts() {
  return [
    {
      id: "demo/3",
      channel: "demo",
      channelName: "演示频道",
      channelKey: "demo",
      postId: 3,
      url: "https://t.me/demo/3",
      date: "2026-10-07T12:00:00.000Z",
      textHtml: "<p>最新一条 A &amp; B</p>",
      textPlain: "最新一条 A & B",
      media: [{ type: "image", direct: "https://cdn.example.com/a.jpg" }],
    },
    {
      id: "demo/2",
      channel: "demo",
      channelName: "演示频道",
      channelKey: "demo",
      postId: 2,
      url: "https://t.me/demo/2",
      date: "2026-10-07T11:00:00.000Z",
      textHtml: '<p>含 <script>alert(1)</script> 的正文</p>',
      textPlain: "含 的正文",
      media: [],
    },
    {
      id: "demo/1",
      channel: "demo",
      channelName: "演示频道",
      channelKey: "demo",
      postId: 1,
      url: "https://t.me/demo/1",
      date: "2026-10-07T10:00:00.000Z",
      textHtml: "<p>纯文本</p>",
      textPlain: "纯文本",
      media: [
        { type: "video", direct: "https://cdn.example.com/v.mp4", size: "1 MB" },
        { type: "audio", direct: "https://cdn.example.com/a.mp3" },
      ],
    },
  ];
}

test("renderRss：XML 头与 channel 必备字段", () => {
  const xml = renderRss({
    title: "站点标题",
    link: "https://example.com/",
    description: "站点描述",
    selfHref: "https://example.com/rss.xml",
    posts: samplePosts(),
    origin: "https://example.com",
  });
  assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
  assert.match(xml, /<rss version="2\.0"/);
  assert.match(xml, /xmlns:atom="http:\/\/www\.w3\.org\/2005\/Atom"/);
  assert.match(xml, /<channel>/);
  assert.match(xml, /<title>站点标题<\/title>/);
  assert.match(xml, /<link>https:\/\/example\.com\/<\/link>/);
  assert.match(xml, /<description>站点描述<\/description>/);
  assert.match(xml, /<atom:link href="https:\/\/example\.com\/rss\.xml" rel="self"/);
  assert.match(xml, /<lastBuildDate>/);
});

test("renderRss：条目顺序与 RSS 字段齐全", () => {
  const posts = samplePosts();
  const xml = renderRss({ title: "t", link: "https://example.com/", description: "d", posts, origin: "https://example.com" });
  const items = xml.match(/<item>/g) || [];
  assert.equal(items.length, posts.length);
  // 保持传入顺序（调用方已按时间倒序）
  const ids = [...xml.matchAll(/<guid[^>]*>([^<]+)<\/guid>/g)].map((m) => m[1]);
  assert.deepEqual(ids, posts.map((p) => p.url));
  assert.ok(
    xml.includes(`<pubDate>${new Date(posts[0].date).toUTCString()}</pubDate>`),
    "pubDate 应为 RFC822/UTC 格式",
  );
  assert.match(xml, /<category>演示频道<\/category>/);
});

test("renderRss：HTML 被转义，脚本不会破坏 XML", () => {
  const xml = renderRss({ title: "t", link: "https://example.com/", description: "d", posts: samplePosts(), origin: "https://example.com" });
  assert.ok(!/<script>/i.test(xml), "不应出现原始 <script>");
  // description 走纯文本（textPlain/htmlToText），正文里的标签被剥掉而不是转义输出；
  // 其余字段（title/link 等）的 HTML 仍必须转义
  assert.ok(!/<p>含 /.test(xml), "正文 HTML 不应原样进入 description");
  assert.ok(xml.includes("A &amp; B"), "& 应被转义");
  assert.ok(xml.includes("&lt;script&gt;") || !/<script>/i.test(xml), "脚本不得破坏 XML");
  // XML 里不应残留未转义的 <、& （头与标签之外）
  const body = xml.replace(/<[^>]+>/g, "");
  assert.ok(!/[<&]/.test(body.replace(/&[a-z]+;|&#\d+;/g, "")), "文本节点里不应有裸 < 或 &");
});

test("renderRss：媒体生成 enclosure，首个媒体优先", () => {
  const xml = renderRss({ title: "t", link: "https://example.com/", description: "d", posts: samplePosts(), origin: "https://example.com" });
  assert.match(xml, /<enclosure url="https:\/\/cdn\.example\.com\/a\.jpg"[^>]*type="image\/jpeg"/);
  assert.match(xml, /<enclosure url="https:\/\/cdn\.example\.com\/v\.mp4"[^>]*type="video\/mp4"/);
  assert.ok(!xml.includes("a.mp3"), "每条只取首个媒体做 enclosure");
});

test("本地服务 /rss.xml 与 /api/rss 可订阅", async (t) => {
  let up = false;
  try {
    const res = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(4000) });
    up = res.ok;
  } catch {
    up = false;
  }
  if (!up) {
    t.skip(`开发服务器未启动（${BASE}），请先执行 npm run dev:node`);
    return;
  }

  for (const path of ["/rss.xml", "/api/rss"]) {
    const res = await fetch(`${BASE}${path}`);
    assert.equal(res.status, 200, `${path} 应为 200`);
    const type = res.headers.get("content-type") || "";
    assert.match(type, /application\/rss\+xml/, `${path} 应为 RSS content-type`);
    assert.match(res.headers.get("cache-control") || "", /max-age=/, `${path} 应可缓存`);
    const xml = await res.text();
    assert.ok(xml.startsWith("<?xml"), `${path} 应为 XML`);
    assert.match(xml, /<\/rss>/, `${path} 应为完整 XML 文档`);

    // 配了频道且信息流能取到条目时，RSS 必须真的吐出 <item>
    const feedRes = await fetch(`${BASE}/api/feed?limit=100`, { signal: AbortSignal.timeout(30000) }).catch(() => null);
    const feed = feedRes && feedRes.ok ? await feedRes.json() : null;
    if (feed && (feed.posts || []).length > 0) {
      assert.match(xml, /<item>/, `${path} 应包含 ${feed.posts.length} 条中的 item`);
      const count = (xml.match(/<item>/g) || []).length;
      assert.ok(count <= feed.posts.length, "RSS 条目数不应超过信息流返回数");
    }
  }
});

test("RSS：截断不劈开 emoji，输出不含孤立代理项与非法控制符", () => {
  // 复刻线上问题：标题在第 90 个字符处截断，正好落在 emoji 代理对中间
  const LINK = "https://example.com/rss.xml";
  const post1 = samplePosts()[0];
  const long = "甲".repeat(88) + "🗓测试标题结尾";
  const title = itemTitle({ textPlain: long });
  const xml = renderRss({ title, link: LINK, description: "d", selfHref: LINK, posts: [post1, { ...post1, textPlain: long }], origin: LINK });

  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  assert.ok(!lone.test(title), "标题不得含孤立代理项");
  assert.ok(!lone.test(xml), "整个 XML 不得含孤立代理项（否则是非法 UTF-8，客户端报解析失败）");
  assert.ok(!/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/.test(xml), "不得含 XML 1.0 禁止的控制字符");
  assert.ok(title.includes("🗓") || title.endsWith("…"), "截断点应落在码点边界");
  assert.doesNotThrow(
    () => new TextDecoder("utf-8", { fatal: true }).decode(new TextEncoder().encode(xml)),
    "输出必须是合法 UTF-8",
  );
});

test("RSS enclosure MIME：代理路径无扩展名时按 media.type 给合法 MIME", async () => {
  const { renderRss } = await import("../src/api/rss.js");
  const xml = renderRss({
    title: "t",
    link: "https://e.com",
    description: "d",
    selfHref: "https://e.com/rss.xml",
    origin: "https://e.com",
    posts: [
      { id: "c/1", url: "https://t.me/c/1", date: "2024-05-01T10:00:00Z", textPlain: "v",
        media: [{ type: "video", src: "/api/media/proxy?u=https%3A%2F%2Fbridge%2Fmedia%3Fch%3D-1%26m%3D2" }] },
      { id: "c/2", url: "https://t.me/c/2", date: "2024-05-01T11:00:00Z", textPlain: "i",
        media: [{ type: "image", src: "/api/media/proxy?u=https%3A%2F%2Fbridge%2Fmedia%3Fch%3D-1%26m%3D3" }] },
      { id: "c/3", url: "https://t.me/c/3", date: "2024-05-01T12:00:00Z", textPlain: "a",
        media: [{ type: "audio", src: "/api/media/proxy?u=https%3A%2F%2Fbridge%2Fmedia%3Fch%3D-1%26m%3D4" }] },
    ],
  });
  const types = [...xml.matchAll(/type="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(types.includes("video/mp4"), `video 应为 video/mp4，实际 ${types.join(",")}`);
  assert.ok(types.includes("image/jpeg"), `image 应为 image/jpeg，实际 ${types.join(",")}`);
  assert.ok(types.includes("audio/mpeg"), `audio 应为 audio/mpeg，实际 ${types.join(",")}`);
  assert.ok(!types.some((t) => /\/mpeg$/.test(t) && !t.startsWith("audio")), `不应有 image/mpeg 这类非法 MIME：${types.join(",")}`);
});

test("RSS description 用纯文本，不输出 HTML 标签字面量", async () => {
  const { renderRss } = await import("../src/api/rss.js");
  // 真实数据里 textPlain 与 textHtml 并存（parser/bridge 都产出两者）；
// textPlain 缺失时应由 textHtml 兜底转纯文本
  const xml = renderRss({
    title: "t", link: "https://e.com", description: "d", selfHref: "https://e.com/rss.xml", origin: "https://e.com",
    posts: [{ id: "c/1", url: "https://t.me/c/1", date: "2024-05-01T10:00:00Z",
      textPlain: "看这个链接 正文 第二行",
      textHtml: '<a href="https://t.me/x">链接</a>正文<br>第二行' }],
  });
  // 取 item 内的 description（XML 里第一个 <description> 是频道级的）
  const item = /<item>[\s\S]*?<\/item>/.exec(xml)[0];
  const desc = /<description>([\s\S]*?)<\/description>/.exec(item)[1];
  assert.ok(!desc.includes("&lt;a"), `description 不应含转义后的标签源码：${desc}`);
  assert.ok(!desc.includes("<a "), `description 不应含原始标签：${desc}`);
  assert.ok(desc.includes("链接") && desc.includes("正文"), `应保留正文文本：${desc}`);
});
