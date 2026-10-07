/**
 * 媒体模式 API：视频 / 图片 / 音频 / 文件 四类分类 + 媒体代理。
 */
import {
  HttpError,
  b64urlDecodeToString,
  b64urlEncode,
  clampInt,
  decodeState,
} from "../util.js";
import { getGeneral, getMediaSettings, getChannels } from "../store.js";
import { loadChannelPage, visibleChannels, findChannel, assertVisible } from "./content.js";
import { resolveBridge, fetchPublicChannelPage } from "../tg/fetcher.js";
import { parseSingleMessage } from "../tg/parser.js";

export const MEDIA_TYPES = ["video", "image", "audio", "file"];
const MAX_MEDIA_CHANNELS = 6;
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const EDGE_CACHE_TTL = 6 * 3600;
const MAX_EDGE_CACHE_BYTES = 8 * 1024 * 1024;

function getCache() {
  try {
    if (typeof caches !== "undefined" && caches.default) return caches.default;
  } catch {
    /* ignore */
  }
  return null;
}

/* ------------------------------------------------------------ GET /api/media */

export async function getMediaList(request, env, ctx, url, authenticated) {
  const type = (url.searchParams.get("type") || "video").toLowerCase();
  if (!MEDIA_TYPES.includes(type)) throw new HttpError(400, "type 必须是 video/image/audio/file", "bad_type");

  const mediaSettings = await getMediaSettings(env);
  if (mediaSettings[type] === false) {
    return { type, items: [], cursors: {}, done: true, disabled: true };
  }

  const channels = await getChannels(env);
  const general = await getGeneral(env);
  const onlyKey = url.searchParams.get("key");
  let visible = visibleChannels(channels, authenticated);
  if (onlyKey) visible = visible.filter((ch) => ch.key === onlyKey);

  const pageSize = clampInt(url.searchParams.get("limit"), 6, 60, mediaSettings.pageSize || 24);
  const cursors = decodeState(url.searchParams.get("c"), {}) || {};
  const pending = visible.filter((ch) => cursors[ch.key] === undefined || typeof cursors[ch.key] === "string");
  const batch = pending.slice(0, MAX_MEDIA_CHANNELS);

  const nextCursors = { ...cursors };
  const items = [];
  const errors = [];

  await Promise.all(
    batch.map(async (ch) => {
      try {
        const before = typeof cursors[ch.key] === "string" ? cursors[ch.key] : null;
        const page = await loadChannelPage(env, ctx, ch, before, general.pageSize || 20);
        nextCursors[ch.key] = page.next ? String(page.next) : null;
        for (const post of page.posts) {
          (post.media || []).forEach((m, index) => {
            if (m.type !== type) return;
            items.push({
              id: `${post.id}#${index}`,
              type,
              src: m.src || null,
              direct: m.direct || null,
              thumb: m.thumbSrc || null,
              name: m.name || null,
              size: m.size || null,
              duration: m.duration || null,
              date: post.date,
              channel: { key: page.info.key, name: page.info.name, avatar: page.info.avatar },
              post: {
                id: post.id,
                url: post.url,
                key: post.key,
                text: (post.textPlain || "").slice(0, 400),
              },
            });
          });
        }
      } catch (err) {
        nextCursors[ch.key] = null;
        errors.push({ key: ch.key, message: err?.message || "fetch_failed" });
      }
    }),
  );

  items.sort((a, b) => (Date.parse(b.date || 0) || 0) - (Date.parse(a.date || 0) || 0));
  return {
    type,
    items: items.slice(0, pageSize),
    cursors: nextCursors,
    done: batch.length === 0,
    errors,
    disabled: false,
  };
}

/* ------------------------------------------- 文档（文件类）直链按需解析 */

export async function resolveDocument(request, env, ctx, url, authenticated) {
  const channels = await getChannels(env);
  const key = url.searchParams.get("key") || "";
  const postId = url.searchParams.get("post") || "";
  const index = clampInt(url.searchParams.get("i"), 0, 50, 0);

  const channel = findChannel(channels, key);
  assertVisible(channel, authenticated);
  if (!/^\d+$/.test(postId)) throw new HttpError(400, "post 参数非法", "bad_post");

  if (channel.type !== "public") {
    throw new HttpError(400, "私密频道文件请直接通过媒体地址访问", "use_bridge");
  }

  const general = await getGeneral(env);
  const page = await fetchPublicChannelPage(env, ctx, channel.username, null, Math.max(0, general.cacheTtl ?? 120));
  const post = page.posts.find((p) => String(p.postId) === postId);
  if (!post) throw new HttpError(404, "该消息不在最新一页，请先刷新", "post_not_found");

  const target = (post.media || [])[index];
  if (!target) throw new HttpError(404, "消息没有对应媒体", "media_not_found");

  // 预览页不给文档直链：尝试单条 embed 页
  let direct = target.url || null;
  if (!direct) {
    try {
      const res = await fetch(`https://t.me/${encodeURIComponent(channel.username)}/${postId}?embed=1`, {
        headers: { "user-agent": UA, accept: "text/html" },
      });
      if (res.ok) {
        const html = await res.text();
        const single = parseSingleMessage(html);
        const candidate = (single?.media || []).find((m) => (m.name && target.name && m.name === target.name)) ||
          (single?.media || [])[index];
        if (candidate && candidate.url) direct = candidate.url;
      }
    } catch {
      /* 忽略，回退到消息链接 */
    }
  }

  const mediaSettings = await getMediaSettings(env);
  return {
    name: target.name || null,
    size: target.size || null,
    url: direct ? (mediaSettings.proxyAll === false ? direct : `/api/media/proxy?u=${b64urlEncode(direct)}`) : null,
    direct,
    link: target.permalink || post.url,
  };
}

/* ------------------------------------------------------- GET /api/media/proxy */

function hostAllowed(hostname, bridge) {
  const host = String(hostname || "").toLowerCase();
  if (!host) return false;
  const allowlist = ["telesco.pe", "t.me", "telegram.org", "telegram-cdn.org", "telegram-cdn.net", "t.me"];
  if (allowlist.some((d) => host === d || host.endsWith(`.${d}`))) return true;
  if (bridge && bridge.url) {
    try {
      const b = new URL(bridge.url);
      if (b.hostname === host) return true;
    } catch {
      /* ignore */
    }
  }
  return false;
}

export async function proxyMedia(request, env, ctx, url) {
  const raw = url.searchParams.get("u");
  if (!raw) throw new HttpError(400, "缺少 u 参数", "bad_url");

  // 下载模式：&dl=1 时带 Content-Disposition: attachment，跨域地址也能触发浏览器下载
  const dl = url.searchParams.get("dl") === "1";
  const nameHint = (url.searchParams.get("name") || "").trim();

  let target;
  try {
    target = new URL(b64urlDecodeToString(raw));
  } catch {
    throw new HttpError(400, "u 参数无法解析", "bad_url");
  }
  if (target.protocol !== "https:" && target.protocol !== "http:") {
    throw new HttpError(400, "仅支持 http/https 媒体地址", "bad_scheme");
  }

  const bridge = await resolveBridge(env);
  const isBridge = !!(bridge && bridge.url && new URL(bridge.url).hostname === target.hostname);
  if (target.protocol === "http:" && !isBridge) {
    throw new HttpError(403, "只允许 https 媒体地址", "bad_scheme");
  }
  if (!hostAllowed(target.hostname, bridge)) {
    throw new HttpError(403, "该媒体地址不在白名单内", "host_not_allowed");
  }

  const filename = sanitizeFilename(nameHint || basenameOf(target));

  const headers = new Headers({ "user-agent": UA, accept: "*/*" });
  const range = request.headers.get("range");
  if (range) headers.set("range", range);
  if (isBridge && bridge.token) headers.set("x-token", bridge.token);

  const cache = getCache();
  const cacheKey = new Request(`https://tg-rss-media.invalid/${b64urlEncode(target.toString())}`, {
    method: "GET",
    headers: range ? { range } : {},
  });
  if (cache && !range) {
    try {
      const hit = await cache.match(cacheKey);
      if (hit) return dl ? withAttachment(hit, filename) : withBrowserCache(hit);
    } catch {
      /* ignore */
    }
  }

  let res;
  try {
    res = await fetch(target.toString(), { headers });
  } catch (err) {
    throw new HttpError(502, `媒体拉取失败：${err?.message || err}`, "media_upstream_error");
  }

  if (!res.ok && res.status !== 206) {
    return new Response(res.body, { status: res.status, statusText: res.statusText });
  }

  // 先 clone 再消费 body（顺序反了会抛 “Body has already been consumed”）
  let stored = null;
  if (cache && !range && res.status === 200) {
    const length = Number(res.headers.get("content-length") || 0);
    if (length && length <= MAX_EDGE_CACHE_BYTES) {
      try {
        stored = res.clone();
      } catch {
        stored = null;
      }
    }
  }

  const outHeaders = new Headers();
  res.headers.forEach((value, key) => {
    const k = key.toLowerCase();
    if (["set-cookie", "content-encoding", "content-security-policy", "x-frame-options", "strict-transport-security"].includes(k)) return;
    outHeaders.set(key, value);
  });
  outHeaders.set("access-control-allow-origin", "*");
  if (res.status === 200) outHeaders.set("cache-control", "public, max-age=86400");
  outHeaders.set("x-content-type-options", "nosniff");
  if (dl) outHeaders.set("content-disposition", contentDisposition(filename));

  const out = new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers: outHeaders,
  });

  if (stored) {
    const storedHeaders = new Headers(stored.headers);
    storedHeaders.delete("set-cookie");
    storedHeaders.delete("content-encoding");
    const cached = new Response(stored.body, { status: 200, headers: storedHeaders });
    const done = cache.put(cacheKey, cached).catch((err) => console.error("[media cache]", err));
    if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(done);
    else await done.catch(() => {});
  }

  return out;
}

/** URL 路径里的文件名（先解码，失败则用原始片段） */
function basenameOf(target) {
  const raw = String(target.pathname.split("/").pop() || "");
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** 文件名清洗：去掉引号、换行与控制字符，避免破坏响应头 */
function sanitizeFilename(name) {
  const cleaned = String(name || "")
    .replace(/[\r\n"\\]+/g, " ")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 120);
  return cleaned || "media";
}

/** attachment 响应头：ASCII 兜底 + RFC 5987 的 UTF-8 文件名（中文名也能正确落地） */
function contentDisposition(filename) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_") || "media";
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/** 缓存命中时补下载头：缓存响应不可直接改头，重建一个响应即可 */
function withAttachment(response, filename) {
  const headers = new Headers(response.headers);
  headers.set("content-disposition", contentDisposition(filename));
  if (!headers.has("cache-control")) headers.set("cache-control", "public, max-age=86400");
  if (!headers.has("access-control-allow-origin")) headers.set("access-control-allow-origin", "*");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function withBrowserCache(response) {
  const headers = new Headers(response.headers);
  if (!headers.has("cache-control")) headers.set("cache-control", "public, max-age=86400");
  if (!headers.has("access-control-allow-origin")) headers.set("access-control-allow-origin", "*");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
