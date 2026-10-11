/**
 * 视图竞态残留回归（Bug D）：feed 请求 in-flight 时切走视图，
 * 晚到的 renderTagBar 不得再操作顶栏共享的 #tag-toggle 按钮。
 * （bar 随容器 detached → createTagBar 的 isConnected 守卫生效）
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Window } from "happy-dom";

const dir = path.dirname(fileURLToPath(import.meta.url));
const realFetch = globalThis.fetch;

async function setupDom() {
  const html = await readFile(path.join(dir, "..", "public", "index.html"), "utf8");
  const body = /<body>([\s\S]*)<\/body>/.exec(html)?.[1] || "";
  const window = new Window({
    url: "http://localhost:8787/",
    settings: { disableJavaScriptFileLoading: true, disableCSSFileLoading: true },
  });
  window.document.body.innerHTML = body;
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.location = window.location;
  globalThis.history = window.history;
  globalThis.localStorage = window.localStorage;
  globalThis.Node = window.Node;
  return window;
}

function makeCtx(calls) {
  return {
    state: { config: { siteTitle: "T" }, channels: [], tagsOpen: false },
    feedTag: null,
    onTagClick: null,
    refreshTags: null,
    updateTagToggle: () => { calls.count += 1; },
    go: () => {},
    refreshChannels: async () => {},
    applyTheme: () => {},
  };
}

test("切走视图后晚到的 renderTagBar 不再碰 #tag-toggle", async () => {
  await setupDom();
  // feed 响应延迟 80ms，制造 in-flight 窗口
  globalThis.fetch = async (url) => {
    if (String(url).includes("/api/feed")) {
      await new Promise((r) => setTimeout(r, 80));
      return {
        ok: true, status: 200,
        headers: { get: (k) => (/content-type/i.test(String(k)) ? "application/json" : null) },
        json: async () => ({ posts: [], cursors: {}, channels: [], errors: [], done: true }),
      };
    }
    throw new Error(`未预期请求：${url}`);
  };

  const { renderFeed } = await import(`../public/views.js?v=${Date.now()}`);
  const toggle = document.getElementById("tag-toggle");
  assert.ok(toggle.hidden, "初始 hidden");

  // A：in-flight 时把容器移出文档（模拟 route() 切走视图）
  const callsA = { count: 0 };
  const rootA = document.createElement("div");
  document.body.append(rootA);
  const p = renderFeed(rootA, makeCtx(callsA));
  await new Promise((r) => setTimeout(r, 10)); // fetch 已发出
  const callsBeforeDetach = callsA.count; // 同步段的首调（bar 仍在文档里，合法）
  rootA.remove(); // 容器 detached
  await p;
  assert.equal(callsA.count, callsBeforeDetach, "晚到的 renderTagBar 不得再调用共享 updateTagToggle");
  assert.ok(toggle.hidden, "#tag-toggle 保持隐藏（修复前会被晚到回调错误打开）");

  // 对照组：容器在文档内 → 正常调用（防守卫过度拦截造成假阳性）
  const callsB = { count: 0 };
  const rootB = document.createElement("div");
  document.body.append(rootB);
  await renderFeed(rootB, makeCtx(callsB));
  assert.ok(callsB.count > 0, "正常视图的 renderTagBar 应更新顶栏按钮");
});

test.after(() => {
  globalThis.fetch = realFetch;
});
