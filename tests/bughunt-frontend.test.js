/**
 * 前端 bughunt 回归（5 项）：
 * 1) api.posts 不传 limit，服务端缺省才跟随"每页消息数"设置
 * 2) 同 hash 下登录成功主动 route()（hash 不变时浏览器不触发 hashchange）
 * 3) 频道保存回写 settings（Object.assign），切 tab 重绘用新值
 * 4) 私密频道添加：正数 ID 前端直接拒绝（与服务端 validateChannel 一致）
 * 5) 桥接保存成功后状态行同步刷新
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Window } from "happy-dom";

const dir = path.dirname(fileURLToPath(import.meta.url));

const SETTINGS = {
  general: { siteTitle: "T", pageSize: 20, cacheTtl: 120, feedChannels: 6, showViews: true, showDate: true, theme: "auto", adTagsExtra: [] },
  media: { video: true, image: true, audio: true, file: false, pageSize: 24, proxyAll: true },
  channels: [],
  bridge: { url: "", enabled: false, hasToken: false, fromEnv: false },
  credential: { source: "kv", username: "admin" },
};

const jsonRes = (data) => ({
  ok: true,
  status: 200,
  headers: { get: (k) => (/content-type/i.test(String(k)) ? "application/json" : null) },
  json: async () => data,
});

// 每次返回深拷贝：前端 save 成功后会 Object.assign(settings, res)，
// 若返回同一对象会污染后续测试的 mock 数据
const freshSettings = () => JSON.parse(JSON.stringify(SETTINGS));

async function waitFor(fn, timeout = 4000) {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error("waitFor 超时");
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** 搭一个带 index.html body 的 happy-dom 环境，返回 window/root */
async function setupDom(hash) {
  const html = await readFile(path.join(dir, "..", "public", "index.html"), "utf8");
  const body = /<body>([\s\S]*)<\/body>/.exec(html)?.[1] || "";
  const window = new Window({
    url: `http://localhost:8787/${hash}`,
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
  const root = document.getElementById("app");
  return { window, root };
}

test("api.posts 不传 limit（服务端缺省跟随 pageSize）", async () => {
  let url = "";
  globalThis.fetch = async (input) => {
    url = String(input);
    return jsonRes({ posts: [], next: null });
  };
  const { api } = await import(`../public/api.js?v=bughunt-posts-${Date.now()}`);
  await api.posts("telegram");
  assert.ok(!/[?&]limit=/.test(url), `URL 不应带 limit，实际：${url}`);
  await api.posts("telegram", "12345", "tag1");
  assert.ok(url.includes("before=12345"), `应带 before：${url}`);
  assert.ok(url.includes("tag=tag1"), `应带 tag：${url}`);
  assert.ok(!/[?&]limit=/.test(url), `带游标时也不应带 limit：${url}`);
});

test("同 hash 下登录成功跳转后台（go 主动 route）", async () => {
  const { window } = await setupDom("#/admin/general");
  let authed = false;
  globalThis.fetch = async (input, init = {}) => {
    const u = String(input);
    const method = init.method || "GET";
    if (u.includes("/api/config")) return jsonRes({ siteTitle: "T", version: "1.3.2" });
    if (u.includes("/api/admin/state")) {
      return jsonRes({ initialized: true, authenticated: authed, username: "admin", credentialSource: "kv", envManaged: false, hasBridge: false });
    }
    if (u.includes("/api/channels") && !u.includes("/posts")) return jsonRes({ channels: [], authenticated: authed });
    if (u.includes("/api/admin/login") && method === "POST") { authed = true; return jsonRes({ ok: true }); }
    if (u.includes("/api/admin/settings")) return jsonRes(freshSettings());
    throw new Error(`未预期的请求：${u} ${method}`);
  };
  await import(`../public/app.js?v=bughunt-login-${Date.now()}`);
  // boot → #/admin/general 未登录 → 登录表单
  const form = await waitFor(() => document.querySelector("form"), 5000);
  assert.ok(form, "应渲染登录表单");
  form.querySelector('input[type="password"]').value = "secret";
  form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  // 登录成功后 ctx.go("#/admin/general")：hash 不变，靠主动 route() 渲染后台
  const tabs = await waitFor(() => document.querySelector(".tabs"), 5000);
  assert.ok(tabs, "登录成功后应渲染后台 tabs（而非停留在登录表单）");
  assert.ok(!document.querySelector("form"), "登录表单应已消失");
});

test("频道保存后切 tab 再回来仍显示新频道", async () => {
  const { window, root } = await setupDom("#/admin/channels");
  let postBody = null;
  globalThis.fetch = async (input, init = {}) => {
    const u = String(input);
    const method = init.method || "GET";
    if (u.includes("/api/admin/state")) {
      return jsonRes({ initialized: true, authenticated: true, username: "admin", credentialSource: "kv", envManaged: false, hasBridge: false });
    }
    if (u.includes("/api/admin/settings") && method === "GET") return jsonRes(freshSettings());
    if (u.includes("/api/admin/settings") && method === "POST") {
      postBody = JSON.parse(init.body);
      // 服务端返回完整新 settings（saveSettings → {ok, ...getSettings()}）
      return jsonRes({ ok: true, ...freshSettings(), channels: postBody.channels });
    }
    throw new Error(`未预期的请求：${u} ${method}`);
  };
  const { renderAdmin } = await import(`../public/admin.js?v=bughunt-ch-${Date.now()}`);
  const ctx = { state: { config: {}, authenticated: true, initialized: true }, go: () => {}, refreshAuth: () => {}, refreshChannels: async () => {}, applyTheme: () => {} };
  await renderAdmin(root, ctx, "channels");

  // UI 添加私密频道
  const sel = root.querySelector("select");
  sel.value = "private";
  sel.dispatchEvent(new window.Event("change", { bubbles: true }));
  const inputs = [...root.querySelectorAll(".card input")];
  const idInput = inputs[0], nameInput = inputs[1];
  idInput.value = "-1001234567890";
  nameInput.value = "测试频道";
  const addBtn = [...root.querySelectorAll("button")].find((b) => b.textContent.trim() === "添加");
  assert.ok(addBtn, "应有添加按钮");
  addBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  assert.ok(root.querySelector("table"), "添加后应渲染表格");

  // 保存
  const saveBtn = [...root.querySelectorAll("button")].find((b) => b.textContent.includes("保存全部修改"));
  assert.ok(saveBtn, "应有保存按钮");
  saveBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  // 等保存 handler 真正结束（finally 里恢复 disabled），不只等 fetch 发出，
  // 否则 Object.assign(settings, res) 的 microtask 还没跑就切了 tab
  await waitFor(() => postBody !== null && saveBtn.disabled === false, 3000);

  // 切 tab 往返
  const tabLink = (label) => [...root.querySelectorAll(".tabs a")].find((a) => a.textContent.trim() === label);
  tabLink("常规").dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  tabLink("频道").dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  // 显示名渲染在表格行的 input value 里（textContent 拿不到），查 value
  const nameValues = [...root.querySelectorAll("table input")].map((i) => i.value);
  assert.ok(nameValues.includes("测试频道"), `切 tab 回来后表格应仍显示新频道（settings 已回写），实际：${nameValues}`);
});

test("私密频道添加：正数 ID 前端直接拒绝", async () => {
  const { window, root } = await setupDom("#/admin/channels");
  globalThis.fetch = async (input, init = {}) => {
    const u = String(input);
    if (u.includes("/api/admin/state")) {
      return jsonRes({ initialized: true, authenticated: true, username: "admin", credentialSource: "kv", envManaged: false, hasBridge: false });
    }
    if (u.includes("/api/admin/settings")) return jsonRes(freshSettings());
    throw new Error(`未预期的请求：${u}`);
  };
  const { renderAdmin } = await import(`../public/admin.js?v=bughunt-posid-${Date.now()}`);
  const ctx = { state: { config: {}, authenticated: true, initialized: true }, go: () => {}, refreshAuth: () => {}, refreshChannels: async () => {}, applyTheme: () => {} };
  await renderAdmin(root, ctx, "channels");

  const sel = root.querySelector("select");
  sel.value = "private";
  sel.dispatchEvent(new window.Event("change", { bubbles: true }));
  const inputs = [...root.querySelectorAll(".card input")];
  inputs[0].value = "1001234567890"; // 正数 ID
  inputs[1].value = "正数频道";
  const addBtn = [...root.querySelectorAll("button")].find((b) => b.textContent.trim() === "添加");
  addBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  assert.ok(!root.querySelector("table"), "正数 ID 不应进入表格");
  assert.ok(root.querySelector(".empty"), "应仍显示空态");
  assert.ok(document.getElementById("toast").textContent.includes("频道 ID 不合法"), "应 toast 报错");
});

test("桥接保存成功后状态行同步刷新", async () => {
  const { window, root } = await setupDom("#/admin/bridge");
  let postBody = null;
  globalThis.fetch = async (input, init = {}) => {
    const u = String(input);
    const method = init.method || "GET";
    if (u.includes("/api/admin/state")) {
      return jsonRes({ initialized: true, authenticated: true, username: "admin", credentialSource: "kv", envManaged: false, hasBridge: false });
    }
    if (u.includes("/api/admin/settings") && method === "GET") return jsonRes(freshSettings());
    if (u.includes("/api/admin/settings") && method === "POST") {
      postBody = JSON.parse(init.body);
      return jsonRes({ ok: true, ...freshSettings(), bridge: { url: postBody.bridge.url, enabled: postBody.bridge.enabled, hasToken: true, fromEnv: false } });
    }
    throw new Error(`未预期的请求：${u} ${method}`);
  };
  const { renderAdmin } = await import(`../public/admin.js?v=bughunt-bridge-${Date.now()}`);
  const ctx = { state: { config: {}, authenticated: true, initialized: true }, go: () => {}, refreshAuth: () => {}, refreshChannels: async () => {}, applyTheme: () => {} };
  await renderAdmin(root, ctx, "bridge");
  assert.ok(root.textContent.includes("尚未设置令牌。"), "保存前状态行应为未设置");

  const urlInput = [...root.querySelectorAll(".card input")].find((i) => (i.placeholder || "").includes("bridge.example.com"));
  assert.ok(urlInput, "应有桥接 URL 输入框");
  urlInput.value = "https://bridge.example.com";
  const tokenInput = [...root.querySelectorAll(".card input")].find((i) => i !== urlInput);
  tokenInput.value = "tok123";
  const saveBtn = [...root.querySelectorAll("button")].find((b) => b.textContent.includes("保存"));
  saveBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await waitFor(() => postBody !== null && saveBtn.disabled === false, 3000);
  assert.ok(root.textContent.includes("已保存令牌。"), "保存成功后状态行应同步刷新");
  assert.ok(!root.textContent.includes("尚未设置令牌。"), "旧文案不应残留");
});
