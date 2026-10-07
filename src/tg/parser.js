/**
 * Telegram 公开频道页面解析器（纯字符串实现，Node 与 Workers 均可运行，便于单测）。
 *
 * 数据来源（已实测验证）：
 *  - 列表页   https://t.me/s/<username>[?before=<cursor>]
 *  - 单条页   https://t.me/<username>/<id>?embed=1
 *  - 消息根   data-post="slug/id"  +  data-view(base64 json {c,p,t,h})
 *  - 分页     a.js-messages_more[data-before]
 *  - 频道信息 .tgme_channel_info_*
 */
import { sanitizeHtml, htmlToText, decodeDataView, styleUrl, absoluteUrl } from "../util.js";

const VIDEO_EXT = ["mp4", "webm", "mov", "m4v", "mkv"];
const AUDIO_EXT = ["mp3", "m4a", "aac", "ogg", "oga", "opus", "wav", "flac"];

/* ---------------------------------------------------------------- 基础扫描 */

function scanTags(html, tagName) {
  const out = [];
  // 说明：Telegram 返回的 HTML 标签名恒为小写，直接用小写 needle 精确匹配，
  // 避免对整串 toLowerCase() 后索引错位（非 ASCII 字符长度会变）。
  const needle = `<${tagName}`;
  let i = 0;
  while (i < html.length) {
    const idx = html.indexOf(needle, i);
    if (idx === -1) break;
    const after = idx + needle.length;
    const ch = html[after];
    if (ch !== undefined && !/[\s/>]/.test(ch)) {
      i = after;
      continue;
    }
    let j = after;
    let quote = null;
    for (; j < html.length; j += 1) {
      const c = html[j];
      if (quote) {
        if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'") {
        quote = c;
        continue;
      }
      if (c === ">") break;
    }
    out.push({ index: idx, tagEnd: j + 1, attrs: html.slice(after, j) });
    i = j + 1;
  }
  return out;
}

function attrValue(attrs, name) {
  const re = new RegExp(`(?:^|\\s)${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
  const m = re.exec(attrs || "");
  if (!m) return null;
  const value = m[2] ?? m[3] ?? m[4] ?? "";
  return decodeEntities(value);
}

function decodeEntities(value) {
  return String(value)
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function hasClass(attrs, className) {
  const cls = attrValue(attrs, "class") || "";
  return cls.split(/\s+/).includes(className);
}

function hasClassPart(attrs, part) {
  const cls = attrValue(attrs, "class") || "";
  return cls.includes(part);
}

/** 找到与开标签配对的内容区间（支持 div 嵌套，a 不嵌套） */
function elementInner(html, tagEnd, tagName) {
  if (tagName === "a") {
    const end = lowerIndexOf(html, "</a>", tagEnd);
    return end === -1 ? { inner: "", end: html.length } : { inner: html.slice(tagEnd, end), end };
  }
  const start = tagEnd;
  let depth = 1;
  let i = tagEnd;
  const open = `<${tagName}`;
  const close = `</${tagName}>`;
  while (i < html.length) {
    const nextOpen = lowerIndexOf(html, open, i);
    const nextClose = lowerIndexOf(html, close, i);
    if (nextClose === -1) return { inner: html.slice(start), end: html.length };
    if (nextOpen !== -1 && nextOpen < nextClose) {
      const ch = html[nextOpen + open.length];
      if (ch !== undefined && /[\s/>]/.test(ch)) depth += 1;
      i = nextOpen + open.length;
    } else {
      depth -= 1;
      if (depth === 0) return { inner: html.slice(start, nextClose), end: nextClose };
      i = nextClose + close.length;
    }
  }
  return { inner: html.slice(start), end: html.length };
}

function lowerIndexOf(haystack, needle, from) {
  return haystack.indexOf(needle, from);
}

function stripTags(html) {
  return htmlToText(html);
}

function textOf(html, className) {
  const tags = ["div", "span", "a", "time"];
  for (const tag of tags) {
    for (const t of scanTags(html, tag)) {
      if (!hasClass(t.attrs, className)) continue;
      const { inner } = elementInner(html, t.tagEnd, tag);
      const text = stripTags(inner).trim();
      if (text) return text;
    }
  }
  return null;
}

function firstAttrInClass(html, className, attrName) {
  for (const tag of scanTags(html, "a")) {
    if (!hasClass(tag.attrs, className)) continue;
    return attrValue(tag.attrs, attrName);
  }
  for (const tag of scanTags(html, "div")) {
    if (!hasClass(tag.attrs, className)) continue;
    return attrValue(tag.attrs, attrName);
  }
  return null;
}

/* ------------------------------------------------------------------ 媒体解析 */

function extOf(url) {
  if (!url) return "";
  const clean = url.split("?")[0].split("#")[0];
  const dot = clean.lastIndexOf(".");
  if (dot < 0) return "";
  return clean.slice(dot + 1).toLowerCase();
}

function classifyDocument(name, extra) {
  const ext = extOf(name);
  if (VIDEO_EXT.includes(ext)) return "video";
  if (AUDIO_EXT.includes(ext)) return "audio";
  // 无扩展名时看 "extra"（如 "mp3 · 3.2 MB"）
  const hint = `${extra || ""} ${name || ""}`.toLowerCase();
  if (/\b(mp3|m4a|audio|ogg|opus|wav|flac)\b/.test(hint)) return "audio";
  if (/\b(mp4|video|webm)\b/.test(hint)) return "video";
  return "file";
}

function parseMedia(blockHtml) {
  const media = [];

  // 图片：a.tgme_widget_message_photo_wrap 的 background-image
  for (const tag of scanTags(blockHtml, "a")) {
    if (!hasClass(tag.attrs, "tgme_widget_message_photo_wrap")) continue;
    const src = styleUrl(attrValue(tag.attrs, "style"));
    if (src) {
      media.push({ type: "image", url: absoluteUrl(src), thumb: absoluteUrl(src), name: null, size: null, duration: null });
    }
  }

  // 视频：a.tgme_widget_message_video_player 内嵌 video[src]；缩略图来自 video_thumb
  for (const tag of scanTags(blockHtml, "a")) {
    if (!hasClass(tag.attrs, "tgme_widget_message_video_player")) continue;
    const { inner } = elementInner(blockHtml, tag.tagEnd, "a");
    const videoTag = scanTags(inner, "video")[0];
    const src = videoTag ? attrValue(videoTag.attrs, "src") : null;
    const thumbStyle = firstAttrInClass(inner, "tgme_widget_message_video_thumb", "style");
    const poster = videoTag ? attrValue(videoTag.attrs, "poster") : null;
    const durationMatch = /([0-9]{1,2}:[0-9]{2}(?::[0-9]{2})?)/.exec(
      stripTags(inner.replace(/<video[\s\S]*?<\/video>/gi, "")),
    );
    media.push({
      type: "video",
      url: absoluteUrl(src),
      thumb: absoluteUrl(styleUrl(thumbStyle) || poster),
      name: null,
      size: null,
      duration: durationMatch ? durationMatch[1] : null,
    });
  }

  // 兜底：孤立 video / audio 标签
  for (const tag of scanTags(blockHtml, "video")) {
    const src = attrValue(tag.attrs, "src");
    if (!src) continue;
    const url = absoluteUrl(src);
    if (media.some((m) => m.url === url)) continue;
    media.push({ type: "video", url, thumb: absoluteUrl(attrValue(tag.attrs, "poster")), name: null, size: null, duration: null });
  }
  for (const tag of scanTags(blockHtml, "audio")) {
    const src = attrValue(tag.attrs, "src");
    if (!src) continue;
    const { inner } = elementInner(blockHtml, tag.tagEnd, "audio");
    const duration = textOf(inner, "tgme_widget_message_voice_duration") || textOf(inner, "tgme_widget_message_duration");
    media.push({
      type: "audio",
      url: absoluteUrl(src),
      thumb: null,
      name: attrValue(tag.attrs, "data-name") || null,
      size: null,
      duration,
    });
  }

  // 文档/文件：a.tgme_widget_message_document（t.me 预览不提供直链）
  for (const tag of scanTags(blockHtml, "a")) {
    if (!hasClassPart(tag.attrs, "tgme_widget_message_document")) continue;
    const { inner } = elementInner(blockHtml, tag.tagEnd, "a");
    const name = textOf(inner, "tgme_widget_message_document_title");
    const size = textOf(inner, "tgme_widget_message_document_extra");
    const iconStyle = firstAttrInClass(inner, "tgme_widget_message_document_icon", "style");
    const href = attrValue(tag.attrs, "href");
    if (!name && !size) continue;
    media.push({
      type: classifyDocument(name, size),
      url: null,
      thumb: styleUrl(iconStyle),
      name,
      size,
      duration: null,
      permalink: href || null,
    });
  }

  // 贴纸/表情图
  for (const tag of scanTags(blockHtml, "img")) {
    if (!hasClass(tag.attrs, "tgme_widget_message_sticker")) continue;
    const src = attrValue(tag.attrs, "src");
    if (!src) continue;
    const url = absoluteUrl(src);
    if (media.some((m) => m.url === url)) continue;
    media.push({ type: "image", url, thumb: url, name: null, size: null, duration: null });
  }

  return media
    .filter((m) => m.url || m.name || m.permalink)
    .filter((m, idx, arr) => arr.findIndex((x) => x.type === m.type && x.url === m.url && x.name === m.name) === idx);
}

/* --------------------------------------------------------------- 消息块切分 */

function splitMessageBlocks(html) {
  const starts = [];
  let from = 0;
  while (true) {
    const idx = html.indexOf('data-post="', from);
    if (idx === -1) break;
    const open = html.lastIndexOf("<div", idx);
    starts.push(open === -1 ? idx : open);
    from = idx + 1;
  }
  const blocks = [];
  for (let i = 0; i < starts.length; i += 1) {
    const end = i + 1 < starts.length ? starts[i + 1] : html.length;
    blocks.push(html.slice(starts[i], end));
  }
  return blocks;
}

function parsePost(blockHtml) {
  const dataPost = attrValue(/data-post/.test(blockHtml) ? blockHtml.slice(0, 400) : "", "data-post");
  // data-post 位于根 div 上，直接在整块里找第一个
  const postMatch = /data-post="([^"]+)"/.exec(blockHtml);
  const postRef = postMatch ? decodeEntities(postMatch[1]) : dataPost;
  if (!postRef || !/^[^/]+\/\d+$/.test(postRef)) return null;
  const [slug, idStr] = postRef.split("/");
  const postId = Number.parseInt(idStr, 10);

  const viewMatch = /data-view="([^"]+)"/.exec(blockHtml);
  const view = decodeDataView(viewMatch ? viewMatch[1] : null);
  const postKey = view.p != null ? String(view.p) : String(postId);

  const timeMatch = /<time[^>]*datetime="([^"]+)"/i.exec(blockHtml);
  const date = timeMatch ? safeDate(timeMatch[1]) : null;

  let textHtml = "";
  for (const tag of scanTags(blockHtml, "div")) {
    if (!hasClass(tag.attrs, "tgme_widget_message_text")) continue;
    const { inner } = elementInner(blockHtml, tag.tagEnd, "div");
    textHtml = sanitizeHtml(inner);
    break;
  }

  const views = textOf(blockHtml, "tgme_widget_message_views");
  const comments = textOf(blockHtml, "tgme_widget_message_comments");
  const authorName = textOf(blockHtml, "tgme_widget_message_author_name");
  const authorHref = firstAttrInClass(blockHtml, "tgme_widget_message_author_name", "href");

  const media = parseMedia(blockHtml);

  return {
    id: `${slug}/${postId}`,
    key: postKey,
    channel: slug,
    postId,
    url: absoluteUrl(attrValue((scanTags(blockHtml, "a").find((t) => hasClass(t.attrs, "tgme_widget_message_date")) || { attrs: "" }).attrs, "href")) ||
      `https://t.me/${slug}/${postId}`,
    date,
    textHtml,
    textPlain: htmlToText(textHtml),
    views,
    comments,
    author: authorName ? { name: authorName, url: absoluteUrl(authorHref) } : null,
    media,
    channelId: view.c != null ? String(view.c) : null,
  };
}

function safeDate(value) {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/* ------------------------------------------------------------------ 频道信息 */

export function parseChannelInfo(html) {
  let title = null;
  for (const cls of ["tgme_channel_info_header_title", "tgme_header_title"]) {
    for (const tag of scanTags(html, "div")) {
      if (!hasClass(tag.attrs, cls)) continue;
      const { inner } = elementInner(html, tag.tagEnd, "div");
      const span = scanTags(inner, "span")[0];
      if (span) {
        const { inner: spanInner } = elementInner(inner, span.tagEnd, "span");
        const t = stripTags(spanInner).trim();
        if (t) {
          title = t;
          break;
        }
      }
      const t = stripTags(inner).trim();
      if (t) title = t;
    }
    if (title) break;
  }

  let avatar = null;
  for (const cls of ["tgme_channel_info_header", "tgme_header_info"]) {
    for (const tag of scanTags(html, "div")) {
      if (!hasClass(tag.attrs, cls)) continue;
      const { inner } = elementInner(html, tag.tagEnd, "div");
      const img = scanTags(inner, "img")[0];
      if (img) {
        avatar = absoluteUrl(attrValue(img.attrs, "src"));
        break;
      }
    }
    if (avatar) break;
  }

  let description = null;
  for (const tag of scanTags(html, "div")) {
    if (!hasClass(tag.attrs, "tgme_channel_info_description")) continue;
    const { inner } = elementInner(html, tag.tagEnd, "div");
    const t = stripTags(inner).trim();
    if (t) {
      description = t;
      break;
    }
  }

  const counters = {};
  for (const tag of scanTags(html, "div")) {
    if (!hasClass(tag.attrs, "tgme_channel_info_counter")) continue;
    const { inner } = elementInner(html, tag.tagEnd, "div");
    const label = textOf(inner, "counter_type");
    const value = textOf(inner, "counter_value");
    if (label) counters[label] = value;
  }

  const username = textOf(html, "tgme_channel_info_header_username") ||
    (/tgme_header_link[^>]*>\s*@?([A-Za-z0-9_]+)/.exec(html) || [])[1] || null;

  return {
    title,
    username: username ? username.replace(/^@/, "") : null,
    avatar,
    description,
    counters,
  };
}

export function parseNextBefore(html) {
  for (const tag of scanTags(html, "a")) {
    const cls = attrValue(tag.attrs, "class") || "";
    if (cls.includes("js-messages_more") || cls.includes("tme_messages_more")) {
      const value = attrValue(tag.attrs, "data-before") || (/before=(\d+)/.exec(attrValue(tag.attrs, "href") || "") || [])[1];
      if (value && /^\d+$/.test(value)) return Number.parseInt(value, 10);
    }
  }
  return null;
}

/**
 * 解析频道预览页 / 单条 embed 页。
 * @returns {{posts:Array, nextBefore:number|null, channel:object}}
 */
export function parseChannelPage(html) {
  if (!html || typeof html !== "string") return { posts: [], nextBefore: null, channel: {} };
  const seen = new Set();
  const posts = [];
  for (const block of splitMessageBlocks(html)) {
    const post = parsePost(block);
    if (!post) continue;
    if (seen.has(post.key)) continue;
    seen.add(post.key);
    posts.push(post);
  }
  posts.sort((a, b) => (b.postId ?? 0) - (a.postId ?? 0));
  return {
    posts,
    nextBefore: parseNextBefore(html),
    channel: parseChannelInfo(html),
  };
}

/** 从单条消息页提取（复用同一套逻辑） */
export function parseSingleMessage(html) {
  const { posts } = parseChannelPage(html);
  return posts[0] || null;
}

/** 供媒体模式快速筛选 */
export function classifyMediaItem(item) {
  return item.type;
}

// 供单测使用
export const __internals = { scanTags, elementInner, attrValue, hasClass, textOf, stripTags };
