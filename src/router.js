/**
 * 路由：/api/* 交给处理器，其余交给静态资源（SPA）。
 * Workers：wrangler.jsonc 里 run_worker_first = ["/api/*"]
 * Pages：functions/[[path]].js 先判断 /api/* 再回退资源服务器
 */
import { HttpError, json, jsonError } from "./util.js";
import { getGeneral, getMediaSettings, getChannels, getBridgeSettings, readJSON, KEYS } from "./store.js";
import { getAuthState, requireAdmin } from "./auth.js";
import * as content from "./api/content.js";
import * as media from "./api/media.js";
import * as admin from "./api/admin.js";
import * as rss from "./api/rss.js";
import { turnstileSiteKey } from "./turnstile.js";

const VERSION = "1.1.0";

async function readBody(request) {
  if (request.method === "GET" || request.method === "HEAD") return {};
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.includes("json")) {
    const raw = await request.text().catch(() => "");
    if (!raw) return {};
    try {
      return JSON.parse(raw);
    } catch {
      throw new HttpError(400, "请求体必须是 JSON", "bad_json");
    }
  }
  try {
    const data = await request.json();
    return data && typeof data === "object" ? data : {};
  } catch {
    throw new HttpError(400, "JSON 解析失败", "bad_json");
  }
}

/* --------------------------------------------------------------- 静态资源 */

async function serveStatic(request, env, ctx) {
  if (env && env.ASSETS && typeof env.ASSETS.fetch === "function") {
    let res = await env.ASSETS.fetch(request);
    if (res.status === 404 && request.method === "GET") {
      res = await env.ASSETS.fetch(new URL("/index.html", request.url).toString());
    }
    return res;
  }
  if (ctx && typeof ctx.next === "function") return ctx.next();
  return new Response("Not Found", { status: 404 });
}

/* --------------------------------------------------------------- API 分发 */

async function handleApi(request, env, ctx, url) {
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method.toUpperCase();

  if (method === "OPTIONS") return new Response(null, { status: 204 });

  // ---- 公开
  if (path === "/api/health") {
    return json({
      ok: true,
      version: VERSION,
      time: new Date().toISOString(),
      kv: !!env.TG_RSS_KV,
    });
  }

  if (path === "/api/config") {
    const [general, mediaSettings] = await Promise.all([getGeneral(env), getMediaSettings(env)]);
    return json({
      version: VERSION,
      siteTitle: general.siteTitle,
      theme: general.theme,
      showViews: general.showViews,
      showDate: general.showDate,
      pageSize: general.pageSize,
      media: {
        video: mediaSettings.video,
        image: mediaSettings.image,
        audio: mediaSettings.audio,
        file: mediaSettings.file,
        pageSize: mediaSettings.pageSize,
      },
      // 配置了 TURNSTILE_SECRET 才会下发，前端据此渲染人机验证组件
      turnstileSiteKey: turnstileSiteKey(env),
    });
  }

  const authState = await getAuthState(request, env);
  const authenticated = authState.authenticated;

  // ---- 内容
  if (path === "/api/channels" && method === "GET") {
    return json(await content.listChannels(request, env, ctx, url, authenticated));
  }
  if (path === "/api/feed" && method === "GET") {
    return json(await content.getFeed(request, env, ctx, url, authenticated));
  }
  const postsMatch = /^\/api\/channels\/([^/]+)\/posts$/.exec(path);
  if (postsMatch && method === "GET") {
    const key = decodeURIComponent(postsMatch[1]);
    return json(await content.getChannelPosts(request, env, ctx, url, key, authenticated));
  }
  if (path === "/api/media" && method === "GET") {
    return json(await media.getMediaList(request, env, ctx, url, authenticated));
  }
  if (path === "/api/media/proxy" && method === "GET") {
    return await media.proxyMedia(request, env, ctx, url);
  }
  if (path === "/api/media/doc" && method === "GET") {
    return json(await media.resolveDocument(request, env, ctx, url, authenticated));
  }
  // ---- RSS 订阅（公开）
  if ((path === "/api/rss" || path === "/rss.xml") && method === "GET") {
    return await rss.rssFeed(request, env, ctx, url);
  }

  // ---- 管理后台
  if (path === "/api/admin/state" && method === "GET") {
    return json(await admin.adminState(request, env));
  }
  if (path === "/api/admin/setup" && method === "POST") {
    const body = await readBody(request);
    return await admin.setup(request, env, body);
  }
  if (path === "/api/admin/login" && method === "POST") {
    const body = await readBody(request);
    return await admin.login(request, env, body);
  }
  if (path === "/api/admin/logout" && method === "POST") {
    return await admin.logout(request, env);
  }
  if (path === "/api/admin/password" && method === "POST") {
    const body = await readBody(request);
    return await admin.changePassword(request, env, body);
  }
  if (path === "/api/admin/settings" && method === "GET") {
    return json(await admin.getSettings(request, env));
  }
  if (path === "/api/admin/settings" && method === "POST") {
    const body = await readBody(request);
    return json(await admin.saveSettings(request, env, body));
  }
  if (path === "/api/admin/channels/test" && method === "POST") {
    const body = await readBody(request);
    return json(await admin.testChannel(request, env, ctx, body));
  }
  if (path === "/api/admin/channels/refresh" && method === "POST") {
    const body = await readBody(request);
    return json(await admin.refreshChannel(request, env, ctx, body));
  }

  // ---- 简易统计（后台可读）
  if (path === "/api/admin/stats" && method === "GET") {
    await requireAdmin(request, env);
    const channels = await getChannels(env);
    const bridge = await getBridgeSettings(env);
    return json({
      channels: channels.length,
      hidden: channels.filter((c) => c.hidden).length,
      private: channels.filter((c) => c.type === "private").length,
      bridgeEnabled: !!bridge.enabled || !!env.BRIDGE_URL,
      kvReady: await readJSON(env, KEYS.channels, null) !== null,
    });
  }

  throw new HttpError(404, "接口不存在", "not_found");
}

/* ----------------------------------------------------------------- 入口 */

export async function handleRequest(request, env, ctx = {}) {
  const url = new URL(request.url);
  try {
    if (url.pathname === "/api" || url.pathname.startsWith("/api/") || url.pathname === "/rss.xml") {
      return await handleApi(request, env, ctx, url);
    }
    if (request.method === "OPTIONS") return new Response(null, { status: 204 });
    return await serveStatic(request, env, ctx);
  } catch (err) {
    if (err instanceof HttpError) {
      const headers = {};
      if (err.retryAfter) headers["retry-after"] = String(err.retryAfter);
      return jsonError(err.status, err.message, err.code, headers);
    }
    console.error("[tg-rss] unhandled error:", err && err.stack ? err.stack : err);
    // 设 DEBUG=1 时回显错误信息，便于自托管排错；默认只给通用提示
    const detail = env && env.DEBUG ? `：${err && err.message ? err.message : String(err)}` : "";
    return jsonError(500, `服务器内部错误${detail}`, "internal_error");
  }
}
