/**
 * TG-RSS 私密频道桥接服务
 *
 * 启动：npm install && npm run login && npm start
 * 接口：
 *   GET /health            健康检查（无需令牌）
 *   GET /feed?channel=&before=&limit=&token=   频道消息（与 Worker 约定的结构）
 *   GET /media?ch=&m=      媒体文件（支持 Range，命中磁盘缓存）
 *   GET /avatar?ch=        频道头像
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { config, requireConfig } from "./config.js";
import { resolvePeer, fetchMessages, getMessageById, downloadMediaToCache, downloadAvatarToCache, getMe, disconnect } from "./client.js";
import { messageToPost, peerInfo } from "./post.js";

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

function equalString(a, b) {
  const x = String(a || "");
  const y = String(b || "");
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i += 1) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

function authorized(req, url) {
  if (!config.token) return true;
  const got = req.headers["x-token"] || url.searchParams.get("token") || "";
  return equalString(got, config.token);
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
}

function serveFile(req, res, file) {
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
    if (m) {
      let start = m[1] === "" ? 0 : Number(m[1]);
      let end = m[2] === "" ? stat.size - 1 : Number(m[2]);
      if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= stat.size) {
        res.writeHead(416, { "content-range": `bytes */${stat.size}` });
        res.end();
        return;
      }
      end = Math.min(end, stat.size - 1);
      res.writeHead(206, {
        ...baseHeaders,
        "content-range": `bytes ${start}-${end}/${stat.size}`,
        "content-length": end - start + 1,
      });
      fs.createReadStream(file, { start, end }).pipe(res);
      return;
    }
  }

  res.writeHead(200, { ...baseHeaders, "content-length": stat.size });
  fs.createReadStream(file).pipe(res);
}

async function handleFeed(url) {
  requireConfig();
  const channel = url.searchParams.get("channel");
  const before = url.searchParams.get("before");
  const limit = Math.max(1, Math.min(50, Number(url.searchParams.get("limit") || 20)));

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
  try {
    if (req.method === "OPTIONS") {
      res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-headers": "x-token", "access-control-allow-methods": "GET,OPTIONS" });
      res.end();
      return;
    }

    if (url.pathname === "/health") {
      sendJson(res, 200, { ok: true, service: "tg-rss-bridge", publicUrl: config.publicUrl || null });
      return;
    }

    if (!authorized(req, url)) {
      sendJson(res, 401, { error: "invalid_token" });
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
  const me = await getMe();
  fs.mkdirSync(config.cacheDir, { recursive: true });

  server.listen(config.port, async () => {
    console.log(`TG-RSS bridge listening on http://127.0.0.1:${config.port}`);
    console.log(`  登录账号 : ${me.first_name || ""} ${me.last_name || ""} (id=${me.id})`);
    console.log(`  对外地址 : ${config.publicUrl || `(未设置 PUBLIC_URL) http://127.0.0.1:${config.port}`}`);
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

main().catch((err) => {
  console.error("启动失败：", err.message || err);
  process.exit(1);
});
