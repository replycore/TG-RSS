/**
 * 抓取层：
 *  - 公开频道：t.me/s/ 预览页（Cache API 缓存 + KV 元信息）
 *  - 私密频道：调用管理员配置的账号桥接服务（bridge/）
 */
import { HttpError, absoluteUrl, b64urlEncode } from "../util.js";
import { parseChannelPage } from "./parser.js";
import { getBridgeSettings, getChannelMeta, putChannelMeta } from "../store.js";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function getCache() {
  try {
    if (typeof caches !== "undefined" && caches.default) return caches.default;
  } catch {
    /* ignore */
  }
  return null;
}

function stripHopHeaders(response, body) {
  const headers = new Headers();
  response.headers.forEach((value, key) => {
    const k = key.toLowerCase();
    if (k === "set-cookie" || k === "content-encoding" || k === "content-length" || k === "content-md5") return;
    headers.set(key, value);
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}

async function cachedFetch(upstream, ttl, ctx) {
  const cache = getCache();
  const cacheKey = new Request(`https://tg-rss-cache.invalid/${encodeURIComponent(upstream)}`, {
    method: "GET",
  });
  if (cache && ttl > 0) {
    try {
      const hit = await cache.match(cacheKey);
      if (hit) return hit;
    } catch {
      /* ignore */
    }
  }

  let res;
  try {
    res = await fetch(upstream, {
      headers: {
        "user-agent": UA,
        "accept-language": "en-US,en;q=0.9",
        accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
      },
      redirect: "follow",
    });
  } catch (err) {
    throw new HttpError(502, `上游请求失败：${err?.message || err}`, "upstream_error");
  }

  if (cache && ttl > 0 && res.ok && res.status === 200) {
    const clone = res.clone();
    const stored = stripHopHeaders(clone, clone.body);
    const done = cache.put(cacheKey, stored).catch(() => {});
    if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(done);
    else await done;
  }
  return res;
}

/* ------------------------------------------------------------- 公开频道抓取 */

export function publicChannelUrl(username, before) {
  const base = `https://t.me/s/${encodeURIComponent(username)}`;
  return before ? `${base}?before=${encodeURIComponent(before)}` : base;
}

export async function fetchPublicChannelPage(env, ctx, username, before = null, ttl = 120) {
  const url = publicChannelUrl(username, before);
  const res = await cachedFetch(url, ttl, ctx);
  if (res.status === 404) throw new HttpError(404, "频道不存在", "channel_not_found");
  if (res.status === 429) throw new HttpError(429, "上游限流，请稍后再试", "rate_limited");
  if (!res.ok) throw new HttpError(502, `抓取失败（HTTP ${res.status}）`, "upstream_error");

  const html = await res.text();
  const parsed = parseChannelPage(html);

  if (parsed.posts.length === 0) {
    // t.me 对不存在的频道会 302 首页，这里统一按 404 处理
    if (!before && !parsed.channel.title) {
      throw new HttpError(404, "频道不存在或不是公开频道", "channel_not_found");
    }
  }
  return parsed;
}

export async function resolvePublicChannelMeta(env, ctx, username, ttl = 600) {
  const cached = await getChannelMeta(env, username.toLowerCase());
  const fresh = cached && cached.fetchedAt && Date.now() - cached.fetchedAt < ttl * 1000;
  if (fresh) return cached;
  try {
    const parsed = await fetchPublicChannelPage(env, ctx, username, null, ttl);
    const meta = {
      title: parsed.channel.title || username,
      username: parsed.channel.username || username,
      avatar: parsed.channel.avatar || null,
      description: parsed.channel.description || "",
      counters: parsed.channel.counters || {},
      fetchedAt: Date.now(),
    };
    await putChannelMeta(env, username.toLowerCase(), meta);
    return meta;
  } catch (err) {
    if (cached) return cached;
    throw err;
  }
}

/* ------------------------------------------------------------- 私密频道桥接 */

export function getBridgeConfig(env) {
  const envUrl = env && env.BRIDGE_URL ? String(env.BRIDGE_URL).trim() : "";
  const envToken = env && env.BRIDGE_TOKEN ? String(env.BRIDGE_TOKEN).trim() : "";
  return {
    url: envUrl,
    token: envToken,
    fromEnv: !!envUrl,
  };
}

export async function resolveBridge(env) {
  const fromEnv = getBridgeConfig(env);
  if (fromEnv.url) return { url: fromEnv.url.replace(/\/+$/, ""), token: fromEnv.token, fromEnv: true };
  const stored = await getBridgeSettings(env);
  if (stored && stored.enabled && stored.url) {
    return { url: String(stored.url).replace(/\/+$/, ""), token: stored.token || "", fromEnv: false };
  }
  return null;
}

export async function fetchBridgeFeed(env, channel, before = null, limit = 20) {
  const bridge = await resolveBridge(env);
  if (!bridge) throw new HttpError(400, "尚未配置私密频道桥接服务", "bridge_not_configured");

  const url = new URL(`${bridge.url}/feed`);
  url.searchParams.set("channel", channel.tgId || channel.username);
  url.searchParams.set("limit", String(limit));
  if (before) url.searchParams.set("before", String(before));

  let res;
  try {
    res = await fetch(url.toString(), {
      headers: bridge.token ? { "x-token": bridge.token } : {},
    });
  } catch (err) {
    throw new HttpError(502, `桥接服务不可达：${err?.message || err}`, "bridge_unreachable");
  }

  if (res.status === 401 || res.status === 403) throw new HttpError(502, "桥接服务拒绝访问", "bridge_denied");
  if (res.status === 404) throw new HttpError(404, "桥接服务找不到该频道", "channel_not_found");
  if (!res.ok) throw new HttpError(502, `桥接服务返回 ${res.status}`, "bridge_error");

  const data = await res.json();
  const posts = (Array.isArray(data.posts) ? data.posts : []).map((p) => normalizeBridgePost(p, channel));
  return {
    posts,
    nextBefore: data.next ?? null,
    channel: {
      title: data.channel?.title || channel.name,
      username: data.channel?.username || channel.username || null,
      avatar: absoluteUrl(data.channel?.avatar) || null,
      description: data.channel?.description || "",
      counters: data.channel?.counters || {},
    },
  };
}

export function normalizeBridgePost(post, channel) {
  const slug = channel.username || channel.key;
  const media = (Array.isArray(post.media) ? post.media : []).map((m) => ({
    type: m.type || "file",
    url: m.url ? absoluteUrl(m.url) : null,
    thumb: m.thumb ? absoluteUrl(m.thumb) : null,
    name: m.name || null,
    size: m.size || null,
    duration: m.duration || null,
    permalink: m.permalink || null,
  }));
  return {
    id: post.id || `${slug}/${post.postId}`,
    key: String(post.key ?? post.postId ?? post.id ?? ""),
    channel: slug,
    postId: Number.parseInt(post.postId, 10) || 0,
    url: post.url ? absoluteUrl(post.url) : null,
    date: post.date || null,
    textHtml: post.textHtml || "",
    textPlain: post.textPlain || "",
    views: post.views || null,
    comments: post.comments || null,
    author: post.author || null,
    media,
    channelId: post.channelId || null,
  };
}

/* -------------------------------------------------------- 媒体地址 → 代理地址 */

export function proxyUrlFor(targetUrl, settings) {
  if (!targetUrl) return null;
  if (settings && settings.proxyAll === false) return targetUrl;
  return `/api/media/proxy?u=${b64urlEncode(targetUrl)}`;
}

export function decoratePostMedia(post, settings) {
  return {
    ...post,
    media: (post.media || []).map((m) => ({
      ...m,
      src: proxyUrlFor(m.url, settings),
      direct: m.url,
      thumbSrc: proxyUrlFor(m.thumb, settings),
      link: m.permalink || post.url,
    })),
  };
}
