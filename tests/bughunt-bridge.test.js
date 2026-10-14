/**
 * Bug-hunt 回归（bridge 批）：
 * 1) downloadMediaToCache 并发单飞：同媒体并发下载只下一次、文件完整
 * 2) bridge/server.js 正确引入了 evictCacheSync（曾是被 catch{} 吞掉的死代码）
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(dir, "..");

// 必须在 import client.js 之前设置：config.cacheDir 在 import 时求值
const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-cache-"));
process.env.CACHE_DIR = cacheDir;

const client = await import("../bridge/client.js?v=" + Date.now());

test("downloadMediaToCache：并发同媒体只下载一次、文件完整", async () => {
  let calls = 0;
  const payload = Buffer.alloc(4096, 0xab);
  client.__setClientForTest({
    async downloadMedia(media, { outputFile }) {
      calls += 1;
      await new Promise((r) => setTimeout(r, 80)); // 制造重叠窗口
      fs.writeFileSync(outputFile, payload);
      return undefined; // 非 Buffer：走 tmp→rename 路径
    },
  });
  try {
    const peer = { id: -100999 };
    const msg = { id: 42, document: { mimeType: "video/mp4" } };
    const [a, b] = await Promise.all([
      client.downloadMediaToCache(peer, msg),
      client.downloadMediaToCache(peer, msg),
    ]);
    assert.equal(calls, 1, `并发两次应只下载一次，实际 ${calls} 次`);
    assert.equal(a, b, "两次返回同一目标路径");
    const data = fs.readFileSync(a);
    assert.equal(data.length, 4096, "缓存文件完整（非截断）");
    assert.ok(data.every((x) => x === 0xab), "内容无混写");
    // 串行复调：命中缓存不再下载
    await client.downloadMediaToCache(peer, msg);
    assert.equal(calls, 1, "缓存命中不应再次下载");
  } finally {
    client.__setClientForTest(null);
  }
});

test("downloadMediaToCache：tmp 残留不污染后续（随机后缀）", async () => {
  let n = 0;
  client.__setClientForTest({
    async downloadMedia(media, { outputFile }) {
      n += 1;
      // 前两次调用（首次 + 内部 retry）"崩溃"：只写一半就抛错，留下 .part 残留
      if (n <= 2) {
        fs.writeFileSync(outputFile, Buffer.alloc(100, 0x11));
        throw new Error("boom");
      }
      await new Promise((r) => setTimeout(r, 30));
      fs.writeFileSync(outputFile, Buffer.alloc(200, 0x22));
      return undefined;
    },
  });
  try {
    const peer = { id: -100998 };
    const msg = { id: 7, document: { mimeType: "video/mp4" } };
    // 第一路失败后，第二路应能成功且文件完整（残留 .part 不被当成缓存）
    await assert.rejects(client.downloadMediaToCache(peer, msg), /boom/);
    const target = await client.downloadMediaToCache(peer, msg);
    assert.equal(fs.readFileSync(target).length, 200);
  } finally {
    client.__setClientForTest(null);
  }
});

test("bridge/server.js：evictCacheSync 已正确引入（非死代码）", async () => {
  const src = fs.readFileSync(path.join(repoRoot, "bridge", "server.js"), "utf8");
  const m = /import\s*\{([^}]*)\}\s*from\s*["']\.\/client\.js["']/.exec(src);
  assert.ok(m, "应有从 ./client.js 的 import");
  assert.ok(m[1].split(",").map((s) => s.trim()).includes("evictCacheSync"), "import 列表必须包含 evictCacheSync");
  assert.ok(src.includes("evictCacheSync(config.cacheDir)"), "调用点仍在");
  // client.js 确实导出它
  assert.equal(typeof client.evictCacheSync, "function");
  // server.js 可被 import 而不启动监听（main 有直接运行守卫）
  await import("../bridge/server.js?v=" + Date.now());
});
