/**
 * 前端 Turnstile 接线测试（happy-dom）：
 * 1) 配置了 sitekey → 登录表单渲染验证组件，提交时带上令牌；
 * 2) 未配置 sitekey → 不渲染、不发令牌（后端同步跳过）。
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
  globalThis.localStorage = window.localStorage;
  globalThis.Node = window.Node;
  return window;
}

function makeFetch(captured) {
  return async (input, init = {}) => {
    const url = String(input);
    const method = (init.method || "GET").toUpperCase();
    if (url.includes("/api/admin/state")) {
      return {
        ok: true,
        status: 200,
        headers: { get: (k) => (/content-type/i.test(String(k)) ? "application/json" : null) },
        json: async () => ({ initialized: true, authenticated: false, username: null, credentialSource: "kv", envManaged: false, hasBridge: false }),
      };
    }
    if (url.includes("/api/admin/login")) {
      captured.loginBody = JSON.parse(init.body || "{}");
      return {
        ok: true,
        status: 200,
        headers: { get: (k) => (/content-type/i.test(String(k)) ? "application/json" : null) },
        json: async () => ({ ok: true, username: "admin" }),
      };
    }
    throw new Error(`未预期的请求：${method} ${url}`);
  };
}

async function renderLoginView({ sitekey, token }) {
  const window = await setupDom();
  if (sitekey !== undefined) {
    // 预置 turnstile 桩：证明组件被渲染且 callback 令牌会进提交体
    window.turnstile = {
      render(box, opts) {
        box.textContent = "turnstile-widget";
        if (token) opts.callback(token);
        return 1;
      },
      reset() {},
    };
  }
  const captured = {};
  globalThis.fetch = makeFetch(captured);
  const { renderAdmin } = await import(`../public/admin.js?v=${Date.now()}`);
  const ctx = {
    state: { config: { turnstileSiteKey: sitekey ?? null }, authenticated: false, initialized: true },
    go: () => {},
    refreshAuth: () => {},
  };
  const root = document.getElementById("app") || document.createElement("div");
  root.id = "app";
  if (!root.parentElement) document.body.append(root);
  await renderAdmin(root, ctx);
  return { window, root, captured, ctx };
}

function submitLogin(window, root) {
  const form = root.querySelector("form");
  assert.ok(form, "应渲染登录表单");
  const inputs = root.querySelectorAll("input");
  inputs[0].value = "admin";
  inputs[1].value = "password123";
  form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
}

async function waitFor(fn, timeout = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return fn();
}

test("配置 sitekey：表单渲染验证组件并携带令牌提交", async () => {
  const { root, captured } = await renderLoginView({ sitekey: "0xTESTSITEKEY", token: "tok-abc" });
  const box = root.querySelector(".turnstile-box");
  assert.ok(box, "应有 .turnstile-box 容器");
  assert.equal(box.textContent, "turnstile-widget", "组件应被渲染进容器");

  submitLogin(window, root);
  const ok = await waitFor(() => captured.loginBody);
  assert.ok(ok, "应发出登录请求");
  assert.equal(captured.loginBody.turnstileToken, "tok-abc", "提交体必须带 turnstile 令牌");
  assert.equal(captured.loginBody.username, "admin");
});

test("未配置 sitekey：不渲染组件，令牌为空（后端同步跳过）", async () => {
  const { root, captured } = await renderLoginView({ sitekey: null, token: "" });
  const box = root.querySelector(".turnstile-box");
  assert.ok(box, "容器仍在（占位），但不渲染外部组件");
  assert.equal(box.textContent, "", "无 sitekey 时组件不渲染");

  submitLogin(window, root);
  const ok = await waitFor(() => captured.loginBody);
  assert.ok(ok, "应发出登录请求");
  assert.equal(captured.loginBody.turnstileToken, "", "无配置时令牌为空字符串");
});

test.after(() => {
  globalThis.fetch = realFetch;
});
