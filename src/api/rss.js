/**
 * RSS 2.0 订阅输出。
 *   GET /api/rss            聚合信息流（与首页一致，只含可见频道，按发布时间倒序）
 *   GET /rss.xml            同上，便于客户端识别的别名
 *   GET /api/rss?channel=k  单个频道
 *   可选 limit=5..200（默认 50）
 */
import { clampInt } from "../util.js";
import { getGeneral } from "../store.js";
import { getFeed, getChannelPosts } from "./content.js";

const MIME_BY_EXT = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp",
  gif: "image/gif", avif: "image/avif",
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime",
  mp3: "audio/mpeg", m4a: "audio/mp4", ogg: "audio/ogg", opus: "audio/ogg",
};

/**
 * 让字符串变成「良构 UTF-16」：把孤立代理项替换成 U+FFFD。
 * 不做这一步，slice() 截断 emoji 会留下半个代理对，序列化成 UTF-8 就是
 * 0xED 0xA0 0x80 之类的非法字节，XML 客户端会直接报「解析失败」。
 */
function wellFormed(value) {
  const str = String(value ?? "");
  if (typeof str.toWellFormed === "function") return str.toWellFormed();
  let out = "";
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = str.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += str[i] + str[i + 1];
        i++;
      } else {
        out += "\uFFFD";
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      out += "\uFFFD";
    } else {
      out += str[i];
    }
  }
  return out;
}

export function escapeXml(value) {
  return wellFormed(value)
    // XML 1.0 允许字符范围之外的控制符也要去掉，否则同样解析失败
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function rfc822(iso) {
  const t = Date.parse(iso || "");
  return Number.isNaN(t) ? "" : new Date(t).toUTCString();
}

/** 按码点截断（Array.from 按码点迭代），不会把 emoji 的代理对劈开 */
function clipByCodePoints(text, max) {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : chars.join("");
}

function firstLine(text, max = 90) {
  const line = String(text || "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)[0] || "";
  if (!line) return "";
  return clipByCodePoints(line, max);
}

export function itemTitle(post) {
  return (
    firstLine(post.textPlain || post.text || "") ||
    (post.media || []).map((m) => m.name).filter(Boolean)[0] ||
    "新消息"
  );
}

function enclosureOf(post) {
  const media = (post.media || []).find(
    (m) => ["image", "video", "audio"].includes(m.type) && (m.direct || m.src),
  );
  if (!media) return "";
  const target = media.direct || media.src;
  const path = (() => {
    try { return new URL(target, "https://placeholder.invalid").pathname; } catch { return ""; }
  })();
  const ext = (path.split(".").pop() || "").toLowerCase();
  const type = MIME_BY_EXT[ext] || `${media.type}/mpeg`;
  return `  <enclosure url="${escapeXml(target)}" length="0" type="${escapeXml(type)}"/>\n`;
}

function buildItem(post, opts = {}) {
  const origin = opts.origin || "";
  const channelName = post.channelName || post.channel || "";
  const link = post.url || `${origin}/#/c/${encodeURIComponent(post.channelKey || post.channel || "")}`;
  const pubDate = rfc822(post.date);
  const body = post.textHtml
    ? escapeXml(post.textHtml)
    : escapeXml(post.textPlain || post.text || "");
  const lines = ["<item>"];
  lines.push(`  <title>${escapeXml(itemTitle(post))}</title>`);
  lines.push(`  <link>${escapeXml(link)}</link>`);
  lines.push(`  <guid isPermaLink="true">${escapeXml(link)}</guid>`);
  if (pubDate) lines.push(`  <pubDate>${pubDate}</pubDate>`);
  if (body) lines.push(`  <description>${body}</description>`);
  if (channelName) lines.push(`  <category>${escapeXml(channelName)}</category>`);
  const enc = enclosureOf(post);
  if (enc) lines.push(enc.trimEnd());
  lines.push("</item>");
  return lines.map((l) => (l.startsWith("  ") ? `    ${l.trimStart()}` : l)).join("\n");
}

export function renderRss({ title, link, description, selfHref, posts = [], origin = "", lastBuildDate }) {
  const newest = posts
    .map((p) => Date.parse(p.date || ""))
    .filter((t) => !Number.isNaN(t))
    .sort((a, b) => b - a)[0];
  const build = lastBuildDate || (newest ? new Date(newest).toUTCString() : new Date().toUTCString());

  const items = posts.map((p) => buildItem(p, { origin })).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(title)}</title>
    <link>${escapeXml(link)}</link>
    <description>${escapeXml(description)}</description>
    <language>zh-cn</language>
    <generator>TG-RSS</generator>
    <lastBuildDate>${build}</lastBuildDate>
${selfHref ? `    <atom:link href="${escapeXml(selfHref)}" rel="self" type="application/rss+xml"/>\n` : ""}${items ? `${items}\n` : ""}  </channel>
</rss>
`;
}

function xmlResponse(body, maxAge) {
  return new Response(body, {
    headers: {
      "content-type": "application/rss+xml; charset=utf-8",
      "cache-control": `public, max-age=${Math.max(0, maxAge)}`,
      "x-content-type-options": "nosniff",
    },
  });
}

/* ------------------------------------------------------------ GET /api/rss */

export async function rssFeed(request, env, ctx, url) {
  const general = await getGeneral(env);
  const origin = new URL(request.url).origin;
  const maxAge = Number.isFinite(general.cacheTtl) ? general.cacheTtl : 120;
  const channelKey = (url.searchParams.get("channel") || "").trim();
  const limit = clampInt(url.searchParams.get("limit"), 5, 200, 50);

  if (channelKey) {
    const res = await getChannelPosts(request, env, ctx, url, channelKey, false);
    const posts = (res.posts || []).map((p) => ({
      ...p,
      channelKey: res.channel.key,
      channelName: res.channel.name,
    }));
    const xml = renderRss({
      title: `${res.channel.name} - ${general.siteTitle}`,
      link: `${origin}/#/c/${encodeURIComponent(channelKey)}`,
      description: res.channel.description || `${general.siteTitle} · ${res.channel.name}`,
      selfHref: `${origin}/api/rss?channel=${encodeURIComponent(channelKey)}`,
      posts,
      origin,
    });
    return xmlResponse(xml, maxAge);
  }

  const feedUrl = new URL(url);
  feedUrl.searchParams.set("limit", String(limit));
  const res = await getFeed(request, env, ctx, feedUrl, false);
  const nameOf = new Map((res.channels || []).filter((c) => c && c.key).map((c) => [c.key, c.name]));
  const posts = (res.posts || []).map((p) => ({
    ...p,
    channelName: nameOf.get(p.channelKey || p.channel) || p.channel,
  }));
  const xml = renderRss({
    title: general.siteTitle,
    link: `${origin}/`,
    description: `${general.siteTitle} · 聚合信息流（按发布时间倒序）`,
    selfHref: `${origin}/rss.xml`,
    posts,
    origin,
  });
  return xmlResponse(xml, maxAge);
}
