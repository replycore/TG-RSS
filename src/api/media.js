/**
 * 媒体模式 API：视频 / 图片 / 音频 / 文件 四类分类 + 媒体代理。
 */
import {
  HttpError,
  b64urlDecodeToString,
  b64urlEncode,
  clampInt,
  decodeState,
  getClientIp,
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

/* ------------------------------------------------- 代理安全（重定向/内容类型/速率） */

const MAX_REDIRECTS = 3;
const MAX_PROXY_BYTES = 256 * 1024 * 1024; // 256MB，视频流够用又挡住异常巨响应
const PROXY_RATE_MAX = 120; // 每 IP 每分钟
const PROXY_RATE_WINDOW = 60; // 秒
const proxyBuckets = new Map();

/**
 * 每跳校验重定向目标：旧实现 fetch 默认 follow，白名单只校验了初始 URL，
 * 白名单域名一个 302 就能绕过（SSRF/白名单绕过）。现在改 manual + 逐跳复检。
 */
export function assertRedirectAllowed(locationHeader, currentUrl, bridge) {
  let next;
  try {
    next = new URL(locationHeader, currentUrl);
  } catch {
    throw new HttpError(502, "上游返回了无法解析的重定向", "bad_redirect");
  }
  if (next.protocol !== "https:" && next.protocol !== "http:") {
    throw new HttpError(502, "重定向目标协议不支持", "bad_redirect");
  }
  const bridgeHost = bridge && bridge.url ? (() => { try { return new URL(bridge.url).hostname; } catch { return null; } })() : null;
  if (next.protocol === "http:" && next.hostname !== bridgeHost) {
    throw new HttpError(403, "重定向目标仅允许 https", "bad_redirect_scheme");
  }
  if (!hostAllowed(next.hostname, bridge)) {
    throw new HttpError(403, "重定向目标不在白名单内", "redirect_not_allowed");
  }
  return next;
}

/**
 * 上游内容类型安检：
 * - HTML / XHTML 一律拒绝（同源可执行 → XSS，可打管理员会话）
 * - SVG/XML 等文档类型返回 "sandbox"（响应要加 CSP: sandbox 头）
 */
export function checkProxyContentType(contentType) {
  const ctype = String(contentType || "").toLowerCase();
  if (ctype.includes("text/html") || ctype.includes("application/xhtml+xml")) {
    throw new HttpError(415, "上游返回了 HTML 页面，已拒绝代理", "html_not_allowed");
  }
  if (/(?:^|;)\s*(?:image\/svg\+xml|application\/xml|text\/xml)\b/.test(ctype) || ctype.startsWith("image/svg+xml") || ctype.includes("application/xml") || ctype.includes("text/xml")) {
    return "sandbox";
  }
  return "plain";
}

/** 进程内令牌桶：挡住拿媒体代理当免费 CDN 刷带宽的行为（同 isolate 内无竞态） */
export function proxyRateConsume(ip) {
  const now = Date.now();
  let rec = proxyBuckets.get(ip);
  if (!rec || now - rec.start >= PROXY_RATE_WINDOW * 1000) {
    rec = { start: now, count: 0 };
    proxyBuckets.set(ip, rec);
    if (proxyBuckets.size > 5000) {
      for (const [k, v] of proxyBuckets) if (now - v.start >= PROXY_RATE_WINDOW * 1000) proxyBuckets.delete(k);
    }
  }
  rec.count += 1;
  if (rec.count > PROXY_RATE_MAX) {
    const err = new HttpError(429, "媒体请求过于频繁，请稍后再试", "proxy_rate_limited");
    err.retryAfter = Math.max(1, Math.ceil((PROXY_RATE_WINDOW * 1000 - (now - rec.start)) / 1000));
    throw err;
  }
}

function applyDocSecurity(headers, mode) {
  if (mode === "sandbox") headers.set("content-security-policy", "sandbox");
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

  // 速率限制：每 IP 每分钟 120 次（媒体播放会连续发 Range 请求，阈值放宽松）
  proxyRateConsume(getClientIp(request));

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
      if (hit) {
        // 修复前可能缓存了 HTML，命中也要过安检；不通过就丢缓存改走上游（上游会拒绝）
        let hitMode = null;
        try {
          hitMode = checkProxyContentType(hit.headers.get("content-type"));
        } catch {
          hitMode = null;
        }
        if (hitMode) return dl ? withAttachment(hit, filename, hitMode) : withBrowserCache(hit, hitMode);
        if (typeof cache.delete === "function") await cache.delete(cacheKey).catch(() => {});
      }
    } catch {
      /* ignore */
    }
  }

  // 手动跟随重定向：每一跳都重新过白名单（默认 follow 会被白名单域名 302 绕过）
  let res = null;
  let currentUrl = target.toString();
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    try {
      res = await fetch(currentUrl, { headers, redirect: "manual" });
    } catch (err) {
      throw new HttpError(502, `媒体拉取失败：${err?.message || err}`, "media_upstream_error");
    }
    if (![301, 302, 303, 307, 308].includes(res.status)) break;
    const loc = res.headers.get("location");
    if (!loc) break;
    if (hop === MAX_REDIRECTS) throw new HttpError(502, "上游重定向次数过多", "too_many_redirects");
    const next = assertRedirectAllowed(loc, currentUrl, bridge);
    if (res.body && typeof res.body.cancel === "function") await res.body.cancel().catch(() => {});
    currentUrl = next.toString();
  }

  if (!res.ok && res.status !== 206) {
    // 不再原样透传上游错误页（HTML 错误页会成为同源可执行内容），统一 JSON 错误
    if (res.body && typeof res.body.cancel === "function") await res.body.cancel().catch(() => {});
    const status = res.status >= 400 && res.status <= 599 ? res.status : 502;
    throw new HttpError(status, `上游返回 ${res.status}`, "upstream_status");
  }

  // 内容类型安检：HTML 拒绝 / SVG·XML 沙箱化
  const docMode = checkProxyContentType(res.headers.get("content-type"));
  const declaredLength = Number(res.headers.get("content-length") || 0);
  if (declaredLength > MAX_PROXY_BYTES) {
    if (res.body && typeof res.body.cancel === "function") await res.body.cancel().catch(() => {});
    throw new HttpError(413, "媒体体积超过限制", "too_large");
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
  applyDocSecurity(outHeaders, docMode);
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
function withAttachment(response, filename, mode) {
  const headers = new Headers(response.headers);
  headers.set("content-disposition", contentDisposition(filename));
  applyDocSecurity(headers, mode || "plain");
  if (!headers.has("cache-control")) headers.set("cache-control", "public, max-age=86400");
  if (!headers.has("access-control-allow-origin")) headers.set("access-control-allow-origin", "*");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function withBrowserCache(response, mode) {
  const headers = new Headers(response.headers);
  if (!headers.has("cache-control")) headers.set("cache-control", "public, max-age=86400");
  if (!headers.has("access-control-allow-origin")) headers.set("access-control-allow-origin", "*");
  if (!headers.has("x-content-type-options")) headers.set("x-content-type-options", "nosniff");
  applyDocSecurity(headers, mode || "plain");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
