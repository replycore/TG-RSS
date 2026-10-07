/**
 * 无 workerd 的本地开发/测试服务器。
 *
 * 背景：`wrangler dev` 依赖 workerd（glibc 二进制），在 musl 环境（Alpine / iSH）跑不起来；
 * 而 `npm test` 里的前端集成用例需要一个真实后端在 http://localhost:8787。
 * 本脚本直接加载项目自己的 `src/index.js`（原生 fetch handler），用：
 *   - 内存 KV（模拟 TG_RSS_KV：get/put/delete + expirationTtl）
 *   - 内存 Cache API（模拟 caches.default：match/put）
 *   - public/ 静态资源（模拟 env.ASSETS.fetch，含 SPA 回退）
 * 在纯 Node 里跑同一套后端代码，行为与 Workers 一致，供测试与本地调试使用。
 *
 * 用法：
 *   node tools/dev-server.mjs            # http://localhost:8787
 *   PORT=9000 node tools/dev-server.mjs
 *
 * 与 wrangler dev 的差异（仅影响本地，不影响线上）：
 *   - 无 Edge 限制：`Request.cf` 为空
 *   - 本地数据存在进程内存里，重启即清空
 */
import http from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(dir, "..", "public");
const PORT = Number(process.env.PORT || 8787);

/* ------------------------------------------------------------ 内存 KV */

function createKV() {
  const map = new Map(); // key -> { value, expiresAt }
  const alive = (rec) => rec && (!rec.expiresAt || rec.expiresAt > Date.now());
  return {
    async get(key, type) {
      const rec = map.get(key);
      if (!alive(rec)) return null;
      if (type === "json") {
        try { return JSON.parse(rec.value); } catch { return null; }
      }
      return rec.value;
    },
    async put(key, value, opts = {}) {
      const ttl = opts.expirationTtl || opts.expiration_ttl;
      map.set(key, {
        value: String(value),
        expiresAt: ttl ? Date.now() + ttl * 1000 : 0,
      });
    },
    async delete(key) { map.delete(key); },
    async list() { return [...map.keys()].map((name) => ({ name })); },
    _map: map,
  };
}

/* ---------------------------------------------------------- 内存 Cache */

function createCache() {
  // 只存状态 + 头 + 已缓冲的字节：直接存 Response/流会在多次 clone 后拿到已消费的
  // 空 body（表现为「频道不存在」——其实是上游 HTML 没读到）。
  const map = new Map();
  const keyOf = (req) => (typeof req === "string" ? req : req.url);
  return {
    async match(req) {
      const hit = map.get(keyOf(req));
      if (!hit) return undefined;
      const headers = new Headers(hit.headers);
      headers.set("x-cache-hit", "1");
      return new Response(hit.body.slice(0), { status: hit.status, statusText: hit.statusText, headers });
    },
    async put(req, res) {
      const headers = {};
      res.headers.forEach((v, k) => { headers[k] = v; });
      const body = Buffer.from(await res.arrayBuffer());
      map.set(keyOf(req), { status: res.status, statusText: res.statusText, headers, body });
    },
    async delete(req) { return map.delete(keyOf(req)); },
  };
}

/* --------------------------------------------------------- 静态资源 */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

async function assetsFetch(request) {
  const url = new URL(typeof request === "string" ? request : request.url);
  let rel = decodeURIComponent(url.pathname);
  if (rel.endsWith("/")) rel += "index.html";
  const target = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!target.startsWith(PUBLIC_DIR)) return new Response("Forbidden", { status: 403 });
  if (!existsSync(target) || !statSync(target).isFile()) return new Response("Not Found", { status: 404 });
  const body = await readFile(target);
  const headers = {
    "content-type": MIME[path.extname(target).toLowerCase()] || "application/octet-stream",
    "cache-control": "no-cache",
  };
  return new Response(body, { status: 200, headers });
}

/* ------------------------------------------------------------- 启动 */

/*
 * 某些沙箱环境（如 iSH）会注入一个极简的全局 fetch polyfill：返回的对象只有
 * status/headers/text/arrayBuffer/clone，没有标准的 `.body` 流。项目的抓取层
 * `stripHopHeaders(clone, clone.body)` 依赖标准 Response，否则会把「空 body」
 * 写进缓存，之后每次缓存命中都读到 0 字节 HTML → 解析出 0 条消息 →
 * 报「频道不存在」。这里把非标准响应规范化成真正的 Response，让本地行为对齐 Workers。
 */
const rawFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (input, init) => {
  const res = await rawFetch(input, init);
  if (!res || res instanceof Response) return res;
  const headers = new Headers();
  const src = res.headers;
  if (src) {
    if (typeof src.forEach === "function") src.forEach((v, k) => { try { headers.set(k, v); } catch { /* skip */ } });
    else for (const [k, v] of Object.entries(src)) if (typeof v !== "function") headers.set(k, v);
  }
  const body = typeof res.arrayBuffer === "function" ? await res.arrayBuffer() : null;
  return new Response(body, {
    status: res.status || 200,
    statusText: res.statusText || "",
    headers,
  });
};

globalThis.caches = { default: createCache() };

const { default: worker } = await import(path.join(dir, "..", "src", "index.js"));
const env = {
  TG_RSS_KV: createKV(),
  ASSETS: { fetch: assetsFetch },
  DEBUG: process.env.DEBUG || "",
};
const ctx = { waitUntil: (p) => Promise.resolve(p).catch(() => {}) };

const server = http.createServer(async (req, res) => {
  try {
    const host = req.headers.host || `localhost:${PORT}`;
    const request = new Request(`http://${host}${req.url}`, {
      method: req.method,
      headers: req.headers,
      body: ["GET", "HEAD"].includes(req.method) ? undefined : req,
      duplex: "half",
    });
    const response = await worker.fetch(request, env, ctx);
    const out = {};
    response.headers.forEach((v, k) => { out[k] = v; });
    res.writeHead(response.status, out);
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (err) {
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end(`dev-server error: ${err && err.stack ? err.stack : err}`);
  }
});

server.listen(PORT, () => {
  console.log(`[dev-server] http://localhost:${PORT}  (无 workerd，直接跑 src/index.js)`);
});
