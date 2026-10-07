/**
 * 媒体代理「下载模式」测试：&dl=1 必须回 Content-Disposition: attachment，
 * 普通播放/显示请求不能带该头。上游用 mock（不依赖外网）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { proxyMedia } from "../src/api/media.js";
import { b64urlEncode } from "../src/util.js";

const fakeKv = {
  async get() { return null; },
  async put() {},
  async delete() {},
};

function makeUrl(target, extra = "") {
  const u = new URL("http://localhost/api/media/proxy");
  u.searchParams.set("u", b64urlEncode(target));
  const params = new URLSearchParams(extra);
  for (const [k, v] of params) u.searchParams.set(k, v);
  return u;
}

async function withMockUpstream(fn) {
  const realFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (input, init) => {
    seen.push(String(input));
    return new Response(Buffer.from("FAKE-IMAGE-BYTES"), {
      status: 200,
      headers: { "content-type": "image/png", "content-length": "17" },
    });
  };
  try {
    return await fn(seen);
  } finally {
    globalThis.fetch = realFetch;
  }
}

test("dl=1 返回 attachment 头，含 ASCII 兜底与 UTF-8 文件名", async () => {
  await withMockUpstream(async () => {
    const target = "https://t.me/emoji/file/stickers/测试图.png";
    const url = makeUrl(target, `dl=1&name=${encodeURIComponent("中文 名称.png")}`);
    const res = await proxyMedia(new Request(url), { TG_RSS_KV: fakeKv }, {}, url);
    assert.equal(res.status, 200);
    const cd = res.headers.get("content-disposition") || "";
    assert.match(cd, /^attachment;/);
    assert.match(cd, /filename="[^"]+"/);
    assert.ok(cd.includes(`filename*=UTF-8''${encodeURIComponent("中文 名称.png")}`), `实际：${cd}`);
    await res.arrayBuffer();
  });
});

test("不带 dl=1 时不返回 attachment（内联预览不受影响）", async () => {
  await withMockUpstream(async () => {
    const url = makeUrl("https://t.me/emoji/file/x.png");
    const res = await proxyMedia(new Request(url), { TG_RSS_KV: fakeKv }, {}, url);
    assert.equal(res.status, 200);
    assert.ok(!(res.headers.get("content-disposition") || "").startsWith("attachment"));
    await res.arrayBuffer();
  });
});

test("未传 name 时用 URL 路径里的文件名兜底", async () => {
  await withMockUpstream(async () => {
    const url = makeUrl("https://telegram-cdn.org/a/b/movie.mp4", "dl=1");
    const res = await proxyMedia(new Request(url), { TG_RSS_KV: fakeKv }, {}, url);
    const cd = res.headers.get("content-disposition") || "";
    assert.match(cd, /filename="movie\.mp4"/);
    await res.arrayBuffer();
  });
});

test("白名单外的地址直接拒绝", async () => {
  const url = makeUrl("https://evil.example.com/a.png", "dl=1");
  await assert.rejects(
    () => proxyMedia(new Request(url), { TG_RSS_KV: fakeKv }, {}, url),
    /白名单/,
  );
});
