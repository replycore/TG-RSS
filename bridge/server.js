/**
 * TG-RSS 私密频道桥接服务
 *
 * 启动：npm install && npm run login && npm start
 * 接口：
 *   GET /health            健康检查（无需令牌）
 *   GET /feed?channel=&before=&limit=        频道消息（与 Worker 约定的结构）
 *   GET /media?ch=&m=      媒体文件（支持 Range，命中磁盘缓存）
 *   GET /thumb?ch=&m=      视频缩略图（<video poster>）
 *   GET /avatar?ch=        频道头像
 *
 * 鉴权：HMAC 签名（x-timestamp + x-signature）优先，兼容 x-token / Bearer；
 *      ?token= 查询参数已于 v1.2.4 移除。
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { config, requireConfig, baseUrl } from "./config.js";
import { resolvePeer, fetchMessages, getMessageById, downloadMediaToCache, downloadAvatarToCache, downloadThumbToCache, getMe, disconnect } from "./client.js";
import { messageToPost, peerInfo, pickVideoThumb } from "./post.js";
import { authorized, responseSignatureHeaders } from "./auth.js";

const MIME = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", bmp: "image/bmp",
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", mkv: "video/x-matroska", m4v: "video/x-m4v",
  mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac", ogg: "audio/ogg", oga: "audio/ogg",
  opus: "audio/opus", wav: "audio/wav", flac: "audio/flac",
  pdf: "application/pdf", zip: "application/zip", txt: "text/plain; charset=utf-8",
  bin: "application/octet-stream",
};

function mimeOf(file) {
  const ext = path.extname(file).slice(1).toLowerCase();
  return MIME[ext] || "application/octet-stream";
}

/* 鉴权统一在 ./auth.js：HMAC 签名（x-timestamp + x-signature）为主，
   也兼容 x-token 头 / Authorization: Bearer；?token= 查询参数已移除（token 不进 URL/HTML） */

/**
 * 统一出口：所有响应都带 bridge 响应签名（x-bridge-timestamp/-signature），
 * 供 TG-RSS 校验 bridge 身份（双向校验的反向方向）。桥接地址通常在公网，
 * 缺这一步的话伪造的 bridge 能返回任意帖子/媒体。
 */
function signedHeaders(req, url, status) {
  return responseSignatureHeaders({
    token: config.token,
    status,
    method: req.method,
    pathWithQuery: url.pathname + url.search,
    windowSec: config.signWindowSec,
  });
}

/**
 * 取该响应的 bridge 签名头（res.__signedHeaders 由请求入口在鉴权前挂载）。
 * 必须定义在这里：serveFile 的 200/206/416 三个分支都依赖它。
 */
function sig(res, status) {
  return res.__signedHeaders ? res.__signedHeaders(status) : {};
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...sig(res, status) });
  res.end(body);
}

export function serveFile(req, res, file) {
  if (!file || !fs.existsSync(file)) {
    sendJson(res, 404, { error: "file_not_found" });
    return;
  }
  const stat = fs.statSync(file);
  const mime = mimeOf(file);
  const range = req.headers.range;

  const baseHeaders = {
    "content-type": mime,
    "accept-ranges": "bytes",
    "cache-control": "public, max-age=86400",
  };

  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (m && (m[1] !== "" || m[2] !== "")) {
      // bytes=start-end / bytes=start- / bytes=-suffix（最后 N 字节）
      let start = m[1] === "" ? Math.max(0, stat.size - Number(m[2])) : Number(m[1]);
      let end = m[2] === "" ? stat.size - 1 : Number(m[2]);
      if (m[1] === "") end = stat.size - 1;
      if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= stat.size) {
        res.writeHead(416, { "content-range": `bytes */${stat.size}`, ...sig(res, 416) });
        res.end();
        return;
      }
      end = Math.min(end, stat.size - 1);
      res.writeHead(206, {
        ...baseHeaders,
        "content-range": `bytes ${start}-${end}/${stat.size}`,
        "content-length": end - start + 1,
        // 206 也要签名：Worker 侧 proxyMedia 透传 Range，res.ok 覆盖 206 → 会走验签分支。
        // 状态码参与签名 payload，206 与 200 的签名互不通用（防状态码篡改）
        ...sig(res, 206),
      });
      const stream = fs.createReadStream(file, { start, end });
      stream.on("error", () => res.destroy());
      res.on("close", () => stream.destroy());
      stream.pipe(res);
      return;
    }
  }

  res.writeHead(200, { ...baseHeaders, "content-length": stat.size, ...sig(res, 200) });
  const stream = fs.createReadStream(file);
  stream.on("error", () => res.destroy());
  res.on("close", () => stream.destroy());
  stream.pipe(res);
}

async function handleFeed(url) {
  requireConfig();
  const channel = url.searchParams.get("channel");
  const before = url.searchParams.get("before");
  const rawLimit = Number(url.searchParams.get("limit") || 20);
  const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(50, rawLimit)) : 20;

  const peer = await resolvePeer(channel);
  const info = await peerInfo(peer);
  const messages = await fetchMessages(peer, { before, limit });
  const posts = messages.map((m) => messageToPost(m, peer, { username: info.username }));

  return {
    channel: info,
    posts,
    next: messages.length >= limit && messages.length ? String(messages[messages.length - 1].id) : null,
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  // 双向校验：所有响应（200/401/404 全覆盖）都带 bridge 签名头，
  // TG-RSS 侧据此确认对端确实持有 token。必须在鉴权前挂，否则 401 类响应漏签。
  res.__signedHeaders = (status) => signedHeaders(req, url, status);
  try {
    if (req.method === "OPTIONS") {
      res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-headers": "x-timestamp, x-signature", "access-control-allow-methods": "GET,OPTIONS" });
      res.end();
      return;
    }

    if (url.pathname === "/health") {
      sendJson(res, 200, { ok: true, service: "tg-rss-bridge", publicUrl: config.publicUrl || null });
      return;
    }

    if (!authorized(url, req, config.token, { allowedOrigins: config.allowedOrigins, windowSec: config.signWindowSec })) {
      // 时钟差诊断：签名被拒时最常见的原因是 bridge 机器时钟与 Cloudflare 偏差超窗，
      // 日志和响应都带上服务端时间，便于远程排查（响应体 serverTime 供 Worker 提示用）
      const tsRaw = Array.isArray(req.headers?.["x-timestamp"]) ? null : req.headers?.["x-timestamp"];
      const serverTime = Math.floor(Date.now() / 1000);
      const drift = tsRaw && Number.isFinite(Number(tsRaw)) ? serverTime - Number(tsRaw) : null;
      if (tsRaw) {
        console.warn(`拒绝 ${req.method} ${url.pathname}：签名无效（服务端时间 ${serverTime}，签名时间 ${tsRaw}，差 ${drift}s，窗 ${config.signWindowSec}s）`);
      }
      sendJson(res, 401, { error: "invalid_token", serverTime, windowSec: config.signWindowSec });
      return;
    }

    if (url.pathname === "/feed" && req.method === "GET") {
      const data = await handleFeed(url);
      sendJson(res, 200, data);
      return;
    }

    if (url.pathname === "/media" && req.method === "GET") {
      requireConfig();
      const peer = await resolvePeer(url.searchParams.get("ch"));
      const msg = await getMessageById(peer, url.searchParams.get("m"));
      if (!msg || !msg.media) {
        sendJson(res, 404, { error: "media_not_found" });
        return;
      }
      const file = await downloadMediaToCache(peer, msg);
      serveFile(req, res, file);
      return;
    }

    if (url.pathname === "/thumb" && req.method === "GET") {
      requireConfig();
      const peer = await resolvePeer(url.searchParams.get("ch"));
      const msg = await getMessageById(peer, url.searchParams.get("m"));
      const size = pickVideoThumb(msg);
      if (!msg || !size) {
        sendJson(res, 404, { error: "thumb_not_found" });
        return;
      }
      const file = await downloadThumbToCache(peer, msg, size);
      serveFile(req, res, file);
      return;
    }

    if (url.pathname === "/avatar" && req.method === "GET") {
      requireConfig();
      const peer = await resolvePeer(url.searchParams.get("ch"));
      const file = await downloadAvatarToCache(peer);
      serveFile(req, res, file);
      return;
    }

    sendJson(res, 404, { error: "not_found" });
  } catch (err) {
    const message = err?.message || "bridge_error";
    const status = /找不到|not found|could not/i.test(message) ? 404 : 500;
    console.error("[bridge]", req.method, url.pathname, "->", message);
    sendJson(res, status, { error: message });
  }
});

async function main() {
  requireConfig();
  // 对外监听但没配 PUBLIC_URL：帖子媒体/头像 URL 会写成 127.0.0.1，浏览器侧不可达——直接拒绝启动
  const listeningPublic = config.host !== "127.0.0.1" && config.host !== "localhost";
  if (listeningPublic && !config.publicUrl) {
    throw new Error("BRIDGE_HOST 对外监听时必须设置 PUBLIC_URL（浏览器要通过它访问媒体/头像）");
  }
  const me = await getMe();
  fs.mkdirSync(config.cacheDir, { recursive: true });
  // 启动清扫：中断下载残留的 .part（不再被同名媒体请求的会永远占着磁盘）
  for (const f of fs.readdirSync(config.cacheDir)) {
    if (f.endsWith(".part")) fs.rmSync(path.join(config.cacheDir, f), { force: true });
  }

  server.listen(config.port, config.host, async () => {
    console.log(`TG-RSS bridge listening on ${baseUrl()} （监听 ${config.host}:${config.port}）`);
    console.log(`  登录账号 : ${me.first_name || ""} ${me.last_name || ""} (id=${me.id})`);
    if (config.host !== "127.0.0.1" && config.host !== "localhost") {
      console.log("  ⚠ 已对非本机开放：请确认 BRIDGE_TOKEN 足够长，并用防火墙/Tunnel 保护");
    }
    console.log(`  对外地址 : ${config.publicUrl || "(未设置 PUBLIC_URL，Worker 将回源 127.0.0.1——跨机部署必须设置)"}`);
    if (!config.publicUrl) {
      console.log("  ⚠ 未设置 PUBLIC_URL：帖子里的媒体/头像 URL 会写成 http://127.0.0.1:…，浏览器侧无法直连");
    }
    console.log(`  媒体缓存 : ${config.cacheDir}`);
    console.log("  接口     : /health /feed /media /avatar");
  });

  const shutdown = async () => {
    console.log("\n正在退出…");
    server.close();
    await disconnect();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// 仅直接运行时启动（node server.js）；被 import 时（如测试 serveFile 的签名头）不启动
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("启动失败：", err.message || err);
    process.exit(1);
  });
}
