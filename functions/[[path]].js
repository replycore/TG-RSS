// Cloudflare Pages 桥接层：把同一个 fetch 处理器挂到 Pages Functions 上。
// Pages 的静态资源优先级低于 Functions，所以这里显式把非 API 请求交回资源服务器。
import worker from "../src/index.js";

function isApi(pathname) {
  // /rss.xml 也交给 Worker 生成（RSS 订阅）
  return pathname === "/api" || pathname.startsWith("/api/") || pathname === "/rss.xml";
}

export async function onRequest(context) {
  const { request, env, waitUntil } = context;
  const url = new URL(request.url);

  if (isApi(url.pathname)) {
    return worker.fetch(request, env, { waitUntil });
  }

  // Pages 也暴露 ASSETS 绑定时，优先用它（可做 SPA 回退）
  if (env && env.ASSETS && typeof env.ASSETS.fetch === "function") {
    let res = await env.ASSETS.fetch(request);
    if (res.status === 404 && request.method === "GET") {
      res = await env.ASSETS.fetch(new URL("/index.html", request.url).toString());
    }
    return res;
  }

  // 否则交给 Pages 的资源服务器（等价于静态资源优先）
  return context.next();
}
