/**
 * 后台 tab 无刷新切换回归：
 * 1) 点击「常规/频道/媒体」等 tab → 不触发页面级重绘（#app 根节点保留，头部不重建）
 * 2) 切换时不再重拉 /api/admin/settings（已有缓存复用）
 * 3) URL hash 同步更新（replaceState），刷新后能回到该 tab
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Window } from "happy-dom";

const dir = path.dirname(fileURLToPath(import.meta.url));
const realFetch = globalThis.fetch;

const SETTINGS = {
  general: { siteTitle: "T", pageSize: 20, cacheTtl: 120, feedChannels: 6, showViews: true, showDate: true, theme: "auto", adTagsExtra: [] },
  media: { video: true, image: true, audio: true, file: false, pageSize: 24, proxyAll: true },
  channels: [],
  bridge: { url: "", enabled: false, hasToken: false, fromEnv: false },
  credential: { source: "kv", username: "admin" },
};

function makeFetch(captured) {
  const jsonRes = (data) => ({
    ok: true,
    status: 200,
    headers: { get: (k) => (/content-type/i.test(String(k)) ? "application/json" : null) },
    json: async () => data,
  });
  return async (input, init = {}) => {
    const url = String(input);
    if (url.includes("/api/admin/state")) {
      captured.state++;
      return jsonRes({ initialized: true, authenticated: true, username: "admin", credentialSource: "kv", envManaged: false, hasBridge: false });
    }
    if (url.includes("/api/admin/settings")) {
      captured.settings++;
      return jsonRes(SETTINGS);
    }
    throw new Error(`未预期的请求：${url}`);
  };
}

async function renderAdminGeneral() {
  const html = await readFile(path.join(dir, "..", "public", "index.html"), "utf8");
  const body = /<body>([\s\S]*)<\/body>/.exec(html)?.[1] || "";
  const window = new Window({
    url: "http://localhost:8787/#/admin/general",
    settings: { disableJavaScriptFileLoading: true, disableCSSFileLoading: true },
  });
  window.document.body.innerHTML = body;
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.location = window.location;
  globalThis.history = window.history;
  globalThis.localStorage = window.localStorage;
  globalThis.Node = window.Node;
  // happy-dom 可能缺 history.replaceState 行为——补最小桩记录调用
  const replaced = [];
  const origReplace = window.history.replaceState.bind(window.history);
  window.history.replaceState = (s, t, url) => { replaced.push(String(url)); try { origReplace(s, t, url); } catch {} };

  const captured = { state: 0, settings: 0 };
  globalThis.fetch = makeFetch(captured);
  const { renderAdmin } = await import(`../public/admin.js?v=${Date.now()}`);
  const ctx = { state: { config: {}, authenticated: true, initialized: true }, go: () => {}, refreshAuth: () => {}, refreshChannels: async () => {}, applyTheme: () => {} };
  const root = document.getElementById("app") || document.createElement("div");
  root.id = "app";
  if (!root.parentElement) document.body.append(root);
  await renderAdmin(root, ctx, "general");
  return { window, root, captured, ctx, replaced };
}

function tabLink(root, label) {
  const links = [...root.querySelectorAll(".tabs a")];
  const link = links.find((a) => a.textContent.trim() === label);
  assert.ok(link, `应有「${label}」tab`);
  return link;
}

test("切 tab 不重建页面根与头部（无整页刷新感）", async () => {
  const { window, root, captured } = await renderAdminGeneral();
  const headBefore = root.querySelector(".view-head");
  assert.ok(headBefore, "常规页应有头部");
  assert.equal(captured.settings, 1, "初始渲染拉一次 settings");

  tabLink(root, "媒体").dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  assert.equal(root.querySelector(".view-head"), headBefore, "头部 DOM 应是同一节点（未重建）");
  assert.ok(root.querySelector(".card h2")?.textContent.includes("媒体"), "下方 body 应切到媒体页");
  assert.equal(captured.settings, 1, "切换时不应重拉 settings");

  tabLink(root, "频道").dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  assert.equal(root.querySelector(".view-head"), headBefore, "头部仍是同一节点");
  assert.ok(root.querySelector(".card h2")?.textContent.includes("频道"), "下方 body 应切到频道页");
  assert.equal(captured.settings, 1, "再次切换仍不重拉");
  assert.equal(captured.state, 1, "全程只做一次 adminState 鉴权");
});

test("切 tab 同步 URL 且激活态唯一", async () => {
  const { window, root, replaced } = await renderAdminGeneral();
  tabLink(root, "频道").dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  assert.ok(replaced.some((u) => u.includes("#/admin/channels")), "URL 应同步为 #/admin/channels");
  const actives = [...root.querySelectorAll(".tabs a.active")].map((a) => a.textContent.trim());
  assert.deepEqual(actives, ["频道"], "激活态应唯一");

  // 重复点同一 tab：无操作
  const before = root.querySelector(".card h2")?.textContent;
  tabLink(root, "频道").dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  assert.equal(root.querySelector(".card h2")?.textContent, before, "重复点击不应重绘");
});

test("常规页渲染广告过滤卡片（内置只读 + 自定义输入框）", async () => {
  const { root } = await renderAdminGeneral();
  const cards = [...root.querySelectorAll(".card h2")].map((h) => h.textContent);
  assert.ok(cards.includes("广告过滤"), "应有广告过滤卡片");
  assert.ok(root.textContent.includes("#广告"), "内置标签只读展示");
  const input = [...root.querySelectorAll(".card .field input")].find((i) => (i.placeholder || "").includes("福利"));
  assert.ok(input, "应有自定义标签输入框");
});

test.after(() => {
  globalThis.fetch = realFetch;
});
