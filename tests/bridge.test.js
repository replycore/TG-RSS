import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { classifyMedia, formatSize, formatDuration, messageToPost, mediaOf, peerKeyArg } from "../bridge/post.js";

const peer = { id: -1001234567890 };
const date = new Date("2024-05-01T10:00:00.000Z");

function makeMessage(overrides = {}) {
  return {
    id: 42,
    date,
    message: "hello <world>",
    views: 123,
    replies: { replies: 5 },
    media: null,
    photo: null,
    document: null,
    ...overrides,
  };
}

test("formatSize / formatDuration", () => {
  assert.equal(formatSize(0), null);
  assert.equal(formatSize(1024), "1.0 KB");
  assert.equal(formatSize(1536000), "1.5 MB");
  assert.equal(formatSize(512), "512 B");
  assert.equal(formatDuration(59), "0:59");
  assert.equal(formatDuration(61), "1:01");
  assert.equal(formatDuration(3725), "1:02:05");
});

test("classifyMedia：图片 / 视频 / 音频 / 文件", () => {
  assert.equal(classifyMedia(makeMessage({ media: { className: "MessageMediaPhoto" }, photo: {} })), "image");
  assert.equal(
    classifyMedia(
      makeMessage({
        media: { className: "MessageMediaDocument" },
        document: {
          mimeType: "video/mp4",
          size: 10,
          attributes: [{ className: "DocumentAttributeFilename", fileName: "clip.mp4" }],
        },
      }),
    ),
    "video",
  );
  assert.equal(
    classifyMedia(
      makeMessage({
        media: { className: "MessageMediaDocument" },
        document: {
          mimeType: "audio/mpeg",
          size: 10,
          attributes: [{ className: "DocumentAttributeFilename", fileName: "song.mp3" }],
        },
      }),
    ),
    "audio",
  );
  assert.equal(
    classifyMedia(
      makeMessage({
        media: { className: "MessageMediaDocument" },
        document: {
          mimeType: "application/pdf",
          size: 10,
          attributes: [{ className: "DocumentAttributeFilename", fileName: "report.pdf" }],
        },
      }),
    ),
    "file",
  );
  assert.equal(classifyMedia(makeMessage()), null);
});

test("链接预览 / 投票等不产生媒体", () => {
  const page = makeMessage({ media: { className: "MessageMediaWebPage" }, photo: {} });
  assert.deepEqual(mediaOf(page, peer), []);
  assert.deepEqual(mediaOf(makeMessage({ media: { className: "MessageMediaPoll" } }), peer), []);
  assert.deepEqual(mediaOf(makeMessage({ media: null }), peer), []);
});

test("messageToPost：结构与转义", () => {
  const msg = makeMessage({
    media: { className: "MessageMediaDocument" },
    document: {
      mimeType: "application/pdf",
      size: 2 * 1024 * 1024,
      attributes: [
        { className: "DocumentAttributeFilename", fileName: "季度报告.pdf" },
        { className: "DocumentAttributeAudio", duration: 65 },
      ],
    },
    message: "line1\n<script>alert(1)</script>",
  });
  const post = messageToPost(msg, peer, { username: "mychannel" });

  assert.equal(post.id, "mychannel/42");
  assert.equal(post.postId, 42);
  assert.equal(post.url, "https://t.me/mychannel/42");
  assert.equal(post.date, "2024-05-01T10:00:00.000Z");
  assert.equal(post.views, "123");
  assert.equal(post.comments, "5");
  assert.ok(post.textHtml.includes("<br>"), "换行应转成 <br>");
  assert.ok(!post.textHtml.includes("<script>"), "HTML 必须转义");
  assert.equal(post.textPlain.includes("<script>"), true, "纯文本保留原样");

  assert.equal(post.media.length, 1);
  const media = post.media[0];
  assert.equal(media.type, "file");
  assert.equal(media.name, "季度报告.pdf");
  assert.equal(media.size, "2.0 MB");
  assert.equal(media.duration, "1:05");
  assert.match(media.url, /^http:\/\/127\.0\.0\.1:8788\/media\?ch=-1001234567890&m=42$/);
});

test("私密频道（无 username）不生成外链", () => {
  const post = messageToPost(makeMessage(), peer, { username: null });
  assert.equal(post.url, null);
  assert.match(post.id, /^-1001234567890\/42$/);
});

test("peerKeyArg：数字频道 id 带 -100 前缀（防冷启动被判成 PeerUser）", () => {
  assert.equal(peerKeyArg(1234567890), "-1001234567890");
  assert.equal(peerKeyArg({ id: 1234567890 }), "-1001234567890", "peer 对象取 id");
  assert.equal(peerKeyArg("-1001234567890"), "-1001234567890", "已带前缀原样返回");
  assert.equal(peerKeyArg("telegram"), "telegram", "用户名不受影响");
  assert.equal(peerKeyArg({ id: "telegram" }), "telegram");
});

test("pickVideoThumb：选最大可用缩略图，跳过 Stripped/Path/Empty", async () => {
  const { pickVideoThumb } = await import("../bridge/post.js");
  const mk = (className, extra) => ({ className, ...extra });
  const msg = {
    media: {
      document: {
        thumbs: [
          mk("PhotoStrippedSize", { bytes: Buffer.alloc(9999) }), // 大但格式不可用 → 跳过
          mk("PhotoSize", { type: "m", size: 1200 }),
          mk("PhotoCachedSize", { type: "i", bytes: Buffer.alloc(3000) }),
          mk("PhotoPathSize", {}),
        ],
      },
    },
  };
  const picked = pickVideoThumb(msg);
  assert.equal(picked.type, "i", "应选 bytes 更大的 PhotoCachedSize");
  assert.equal(pickVideoThumb({ media: {} }), null, "无 thumbs → null");
  assert.equal(pickVideoThumb({ media: { document: { thumbs: [mk("PhotoStrippedSize", { bytes: Buffer.alloc(10) })] } } }), null, "只剩 Stripped → null（宁可黑屏不发坏图）");
});

test("downloadThumbToCache：必须用 { thumb } 对象形式，且 .part 原子写入", async () => {
  const os = await import("node:os");
  const fsp = await import("node:fs/promises");
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "tgthumb-"));
  process.env.CACHE_DIR = dir;
  const mod = await import("../bridge/client.js");
  const { config } = await import("../bridge/config.js");
  config.cacheDir = dir;

  const calls = [];
  const fakeClient = {
    downloadMedia: async (...args) => {
      calls.push(args);
      return Buffer.from("jpeg-bytes");
    },
  };
  mod.__setClientForTest(fakeClient);

  const size = { className: "PhotoSize", type: "i", size: 200 };
  const msg = { id: 77, media: { document: { thumbs: [size] } } };
  const peer = { id: -100123 };

  const file = await mod.downloadThumbToCache(peer, msg, size);
  assert.equal(calls.length, 1, "应调用一次 downloadMedia");
  assert.equal(calls[0].length, 2, "必须只传两参（第三位置参会静默丢弃 → 下完整视频）");
  assert.deepEqual(calls[0][1], { thumb: size }, "thumb 必须走对象形式 downloadParams");
  assert.equal(file, path.join(dir, "thumb_-100123_77.jpg"));
  assert.equal(fs.readFileSync(file, "utf8"), "jpeg-bytes");
  const left = fs.readdirSync(dir);
  assert.ok(!left.some((f) => f.endsWith(".part")), `不应残留 .part：${left.join(",")}`);

  // 缓存复用：不再下载
  const again = await mod.downloadThumbToCache(peer, msg, size);
  assert.equal(calls.length, 1, "命中缓存不应重复下载");
  assert.equal(again, file);

  // 截断文件（size>0 的残留 .jpg）不能被永久命中：删除后重下
  fs.unlinkSync(file);
  const third = await mod.downloadThumbToCache(peer, msg, size);
  assert.equal(calls.length, 2, "文件缺失应重新下载");
  assert.ok(fs.existsSync(third));

  // .part 残留不得被当作有效缓存
  fs.unlinkSync(third);
  fs.writeFileSync(path.join(dir, "thumb_-100123_77.jpg.part"), "partial");
  const fourth = await mod.downloadThumbToCache(peer, msg, size);
  assert.equal(calls.length, 3, ".part 残留应被忽略并重下");
  assert.equal(fs.readFileSync(fourth, "utf8"), "jpeg-bytes");

  mod.__setClientForTest(null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("downloadThumbToCache：下载空结果应抛错且不落文件", async () => {
  const os = await import("node:os");
  const fsp = await import("node:fs/promises");
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "tgthumb2-"));
  const mod = await import("../bridge/client.js");
  const { config } = await import("../bridge/config.js");
  config.cacheDir = dir;
  mod.__setClientForTest({ downloadMedia: async () => Buffer.alloc(0) });
  await assert.rejects(() => mod.downloadThumbToCache({ id: -1 }, { id: 9 }, { className: "PhotoSize" }), /thumb_empty/);
  assert.equal(fs.readdirSync(dir).filter((f) => !f.endsWith(".part")).length, 0, "空结果不应留下正式文件");
  mod.__setClientForTest(null);
  fs.rmSync(dir, { recursive: true, force: true });
});
