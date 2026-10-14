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
  globalThis.CustomEvent = window.CustomEvent; // setLang 广播用（Node 自带 CustomEvent 与 happy-dom 不兼容）
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
  return { window, root, captured, ctx, replaced, renderAdmin };
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

test("频道 tab：粘贴分享链接可直接添加（不被前端拦）", async () => {
  const { window, root } = await renderAdminGeneral();
  tabLink(root, "频道").dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));

  const inputs = [...root.querySelectorAll(".card input.input")];
  const idInput = inputs.find((i) => (i.placeholder || "").includes("t.me/"));
  const nameInput = inputs.find((i) => (i.placeholder || "").includes("显示名"));
  assert.ok(idInput, "应有频道 ID 输入框");
  idInput.value = "https://t.me/telegram";
  if (nameInput) nameInput.value = "";

  const addBtn = [...root.querySelectorAll("button")].find((b) => b.textContent.trim() === "添加");
  addBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));

  // 未被拦：频道进入本地表格且 key 规范化为 telegram（此前正则拦掉分享链接，只能 toast「用户名不合法」）
  const table = root.querySelector("table.table");
  assert.ok(table, "添加后应渲染频道表格（被拦时 channels 仍为空，不渲染表格）");
  assert.ok(table.textContent.includes("telegram"), "分享链接应被规范化为 username=telegram");
});

test("语言切换后重建：tab 文案跟随新语言（防顶层 t() 一次性求值钉死旧语言）", async () => {
  const { root, ctx, renderAdmin } = await renderAdminGeneral();
  tabLink(root, "常规"); // 初始中文

  // 与 admin.js 引用同一 i18n 单例（均不带 query 的 ../i18n.js）
  const { setLang } = await import("../public/i18n.js");
  setLang("en");
  try {
    await renderAdmin(root, ctx, "general"); // 模拟 langchange 后的 route() 重建
    tabLink(root, "General");
    tabLink(root, "Channels");
    tabLink(root, "Media");
  } finally {
    setLang("zh-CN"); // 复位，不污染后续用例
  }
});

test.after(() => {
  globalThis.fetch = realFetch;
});

test("formDirty：输入后脏、切 tab 清零（旧 tab 输入已随重建丢失）", async () => {
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
  globalThis.CustomEvent = window.CustomEvent;
  const replaced = [];
  const origReplace = window.history.replaceState.bind(window.history);
  window.history.replaceState = (st, t, url) => { replaced.push(String(url)); try { origReplace(st, t, url); } catch {} };
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const jsonRes = (data) => ({
      ok: true, status: 200,
      headers: { get: (k) => (/content-type/i.test(String(k)) ? "application/json" : null) },
      json: async () => data,
    });
    if (url.includes("/api/admin/state")) return jsonRes({ initialized: true, authenticated: true, username: "admin", credentialSource: "kv", envManaged: false, hasBridge: false });
    if (url.includes("/api/admin/settings")) return jsonRes(SETTINGS);
    throw new Error(`未预期的请求：${url}`);
  };
  const v = `dirty-tab-${Date.now()}`;
  const { renderAdmin, isAdminFormDirty } = await import(`../public/admin.js?v=${v}`);
  const ctx = { state: { config: {}, authenticated: true, initialized: true }, go: () => {}, refreshAuth: () => {}, refreshChannels: async () => {}, applyTheme: () => {} };
  const root = document.getElementById("app") || document.createElement("div");
  root.id = "app";
  if (!root.parentElement) document.body.append(root);
  await renderAdmin(root, ctx, "general");
  assert.equal(isAdminFormDirty(), false, "初始渲染应不脏");
  const input = root.querySelector(".card .field input");
  assert.ok(input, "常规页应有输入框");
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
  assert.equal(isAdminFormDirty(), true, "输入后应为脏");
  tabLink(root, "媒体").dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  assert.ok(root.querySelector(".card h2")?.textContent.includes("媒体"), "应已切到媒体 tab");
  assert.equal(isAdminFormDirty(), false, "切 tab 后 dirty 应清零（旧 tab 输入已丢失）");
});

test("formDirty：频道保存成功后清零", async () => {
  const html = await readFile(path.join(dir, "..", "public", "index.html"), "utf8");
  const body = /<body>([\s\S]*)<\/body>/.exec(html)?.[1] || "";
  const window = new Window({
    url: "http://localhost:8787/#/admin/channels",
    settings: { disableJavaScriptFileLoading: true, disableCSSFileLoading: true },
  });
  window.document.body.innerHTML = body;
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.location = window.location;
  globalThis.history = window.history;
  globalThis.localStorage = window.localStorage;
  globalThis.Node = window.Node;
  globalThis.CustomEvent = window.CustomEvent;
  let saved = 0;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const jsonRes = (data) => ({
      ok: true, status: 200,
      headers: { get: (k) => (/content-type/i.test(String(k)) ? "application/json" : null) },
      json: async () => data,
    });
    if (url.includes("/api/admin/state")) return jsonRes({ initialized: true, authenticated: true, username: "admin", credentialSource: "kv", envManaged: false, hasBridge: false });
    if (url.includes("/api/admin/settings") && (init.method || "GET") === "GET") return jsonRes(SETTINGS);
    if (url.includes("/api/admin/settings") && (init.method || "GET") === "POST") { saved++; return jsonRes({ ok: true }); }
    throw new Error(`未预期的请求：${url} ${init.method || "GET"}`);
  };
  const v = `dirty-save-${Date.now()}`;
  const { renderAdmin, isAdminFormDirty } = await import(`../public/admin.js?v=${v}`);
  const ctx = { state: { config: {}, authenticated: true, initialized: true }, go: () => {}, refreshAuth: () => {}, refreshChannels: async () => {}, applyTheme: () => {} };
  const root = document.getElementById("app") || document.createElement("div");
  root.id = "app";
  if (!root.parentElement) document.body.append(root);
  await renderAdmin(root, ctx, "channels");
  // 频道列表为空时仍有"添加频道"输入框：输入置脏
  const input = root.querySelector(".card .field input, .card input");
  assert.ok(input, "频道页应有输入框");
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
  assert.equal(isAdminFormDirty(), true, "输入后应为脏");
  const saveBtn = [...root.querySelectorAll("button")].find((b) => b.textContent.includes("保存全部修改"));
  assert.ok(saveBtn, "应有保存全部修改按钮");
  saveBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(saved, 1, "应保存一次");
  assert.equal(isAdminFormDirty(), false, "频道保存成功后 dirty 应清零");
});
