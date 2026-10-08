/**
 * RSS 2.0 订阅输出。
 *   GET /api/rss            聚合信息流（与首页一致，只含可见频道，按发布时间倒序）
 *   GET /rss.xml            同上，便于客户端识别的别名
 *   GET /api/rss?channel=k  单个频道
 *   可选 limit=5..200（默认 50）
 */
import { clampInt, HttpError } from "../util.js";
import { getGeneral } from "../store.js";
import { getFeed, getChannelPosts } from "./content.js";
import { checkRssToken } from "../rss-auth.js";

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

function xmlResponse(body, maxAge, isPrivate) {
  return new Response(body, {
    headers: {
      "content-type": "application/rss+xml; charset=utf-8",
      // 带令牌的源含私密内容：private 让共享缓存（CF 边缘）不落盘，每次回源
      "cache-control": `${isPrivate ? "private" : "public"}, max-age=${Math.max(0, maxAge)}`,
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}

/** 401：令牌无效/缺失（阅读器据此提示需要凭据），带标准 WWW-Authenticate */
function unauthorized(message, code) {
  const err = new HttpError(401, message, code);
  err.headers = { "www-authenticate": 'Bearer realm="rss"' };
  return err;
}

/** 上游抖动/桥接故障 → 503 + Retry-After，让阅读器重试而不是把空源缓存下来 */
function upstreamBusy(message) {
  const err = new HttpError(503, message || "上游暂时不可用，请稍后重试", "upstream_busy");
  err.retryAfter = 60;
  return err;
}

/** 把内容抓取异常映射成阅读器友好的 HTTP 语义（可单测） */
export function mapRssError(err) {
  if (!(err instanceof HttpError)) return err;
  switch (err.code) {
    case "hidden_channel":
      // 私密/隐藏频道：没有有效令牌就是需要凭据
      return unauthorized("私密频道需要有效令牌：链接加 ?token=… 或使用 Authorization: Bearer", "rss_token_required");
    case "upstream_error":
    case "rate_limited":
    case "upstream_status":
    case "bridge_unreachable":
    case "bridge_denied":
    case "bridge_error":
    case "not_reachable":
      return upstreamBusy(`上游暂时不可用：${err.message}`);
    default:
      return err;
  }
}

/* ------------------------------------------------------------ GET /api/rss */

export async function rssFeed(request, env, ctx, url) {
  // 1) 令牌校验：无效直接401（错误次数超限429）；有效则私密/隐藏频道可见
  const token = await checkRssToken(request, env, url);
  if (token.state === "invalid") {
    throw unauthorized("RSS 令牌无效或已吊销，请在管理后台重新生成", "rss_token_invalid");
  }
  const authed = token.state === "valid";

  const general = await getGeneral(env);
  const origin = new URL(request.url).origin;
  const maxAge = Number.isFinite(general.cacheTtl) ? general.cacheTtl : 120;
  const channelKey = (url.searchParams.get("channel") || "").trim();
  const limit = clampInt(url.searchParams.get("limit"), 5, 200, 50);

  try {
    if (channelKey) {
      const res = await getChannelPosts(request, env, ctx, url, channelKey, authed);
      const posts = (res.posts || []).map((p) => ({
        ...p,
        channelKey: res.channel.key,
        channelName: res.channel.name,
      }));
      const xml = renderRss({
        title: `${res.channel.name} - ${general.siteTitle}`,
        link: `${origin}/#/c/${encodeURIComponent(channelKey)}`,
        description: res.channel.description || `${general.siteTitle} · ${res.channel.name}`,
        // self 永远不带令牌：避免令牌被喂给第三方、或随源文本扩散
        selfHref: `${origin}/api/rss?channel=${encodeURIComponent(channelKey)}`,
        posts,
        origin,
      });
      return xmlResponse(xml, maxAge, authed);
    }

    const feedUrl = new URL(url);
    feedUrl.searchParams.delete("token");
    feedUrl.searchParams.set("limit", String(limit));
    const res = await getFeed(request, env, ctx, feedUrl, authed);
    const nameOf = new Map((res.channels || []).filter((c) => c && c.key).map((c) => [c.key, c.name]));
    const posts = (res.posts || []).map((p) => ({
      ...p,
      channelName: nameOf.get(p.channelKey || p.channel) || p.channel,
    }));

    // 上游故障导致的「合法空源」：503 + Retry-After，阅读器会重试；
    // 否则它们会把空结果当成功解析并缓存下来（表现为订阅内容为空）
    if (!posts.length && (res.errors || []).length) {
      throw upstreamBusy("上游频道抓取失败，稍后自动重试");
    }

    const xml = renderRss({
      title: general.siteTitle,
      link: `${origin}/`,
      description: `${general.siteTitle} · 聚合信息流（按发布时间倒序）`,
      selfHref: `${origin}/rss.xml`,
      posts,
      origin,
    });
    return xmlResponse(xml, maxAge, authed);
  } catch (err) {
    throw mapRssError(err);
  }
}
