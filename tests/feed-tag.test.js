import test from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.TG_RSS_BASE || "http://localhost:8787";

async function serverUp() {
  try {
    const res = await fetch(`${BASE}/api/config`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

test("GET /api/feed?tag= 只返回带该标签的帖子（有数据时）", async (t) => {
  if (!(await serverUp())) {
    t.skip(`开发服务器未启动（${BASE}）`);
    return;
  }
  const allRes = await fetch(`${BASE}/api/feed?limit=30`, { signal: AbortSignal.timeout(30000) }).catch(() => null);
  if (!allRes || !allRes.ok) {
    t.skip("信息流不可用（上游不可达）");
    return;
  }
  const all = await allRes.json();
  assert.ok(Array.isArray(all.posts), "feed.posts 应为数组");
  // 每条帖子都应带 tags 字段
  for (const p of all.posts) assert.ok(Array.isArray(p.tags), "帖子应带 tags 数组");

  const tagged = all.posts.filter((p) => p.tags.length);
  if (!tagged.length) {
    t.skip("当前数据里没有带 #标签 的帖子");
    return;
  }
  const tag = tagged[0].tags[0];
  const res = await fetch(`${BASE}/api/feed?limit=30&tag=${encodeURIComponent(tag)}`, { signal: AbortSignal.timeout(30000) });
  assert.equal(res.status, 200);
  const filtered = await res.json();
  assert.ok(filtered.posts.length > 0, `按 #${tag} 过滤后应仍有结果`);
  for (const p of filtered.posts) {
    assert.ok(
      (p.tags || []).some((x) => x.toLowerCase() === tag.toLowerCase()),
      `结果里混进了不带 #${tag} 的帖子：${p.textPlain?.slice(0, 30)}`,
    );
  }
});

test("GET /api/posts?channel=&tag= 只返回带该标签的帖子（有数据时）", async (t) => {
  if (!(await serverUp())) {
    t.skip(`开发服务器未启动（${BASE}）`);
    return;
  }
  const allRes = await fetch(`${BASE}/api/posts?channel=telegram&limit=30`, { signal: AbortSignal.timeout(30000) }).catch(() => null);
  if (!allRes || !allRes.ok) {
    t.skip("频道页接口不可用（上游不可达）");
    return;
  }
  const all = await allRes.json();
  const tagged = (all.posts || []).filter((p) => (p.tags || []).length);
  if (!tagged.length) {
    t.skip("当前频道数据里没有带标签的帖子");
    return;
  }
  const tag = tagged[0].tags[0];
  const res = await fetch(
    `${BASE}/api/posts?channel=telegram&limit=30&tag=${encodeURIComponent(tag)}`,
    { signal: AbortSignal.timeout(30000) },
  );
  assert.equal(res.status, 200);
  const filtered = await res.json();
  assert.ok(filtered.posts.length > 0, `按 #${tag} 过滤后应仍有结果`);
  for (const p of filtered.posts) {
    assert.ok((p.tags || []).some((x) => x.toLowerCase() === tag.toLowerCase()), "结果里不应混入不带该标签的帖子");
  }
});
