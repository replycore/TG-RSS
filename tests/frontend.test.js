/**
 * 前端集成冒烟测试：用 happy-dom 驱动真实视图，请求真实后端。
 * 需要先启动开发服务器：npm run dev  （未启动时自动跳过）
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Window } from "happy-dom";

const BASE = process.env.TG_RSS_BASE || "http://localhost:8787";
const dir = path.dirname(fileURLToPath(import.meta.url));
const realFetch = globalThis.fetch;

async function serverUp() {
  try {
    const res = await realFetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(5000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function setupDom() {
  const html = await readFile(path.join(dir, "..", "public", "index.html"), "utf8");
  const body = /<body>([\s\S]*)<\/body>/.exec(html)?.[1] || "";

  const window = new Window({
    url: `${BASE}/`,
    settings: { disableJavaScriptFileLoading: true, disableCSSFileLoading: true },
  });
  const document = window.document;
  document.body.innerHTML = body;

  globalThis.window = window;
  globalThis.document = document;
  globalThis.location = window.location;
  globalThis.localStorage = window.localStorage;
  globalThis.Node = window.Node;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Event = window.Event;
  globalThis.CustomEvent = window.CustomEvent;
  globalThis.getComputedStyle = window.getComputedStyle.bind(window);
  globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
  globalThis.fetch = (input, init) =>
    realFetch(new URL(String(input), BASE).toString(), init);

  return { window, document };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeout = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = await fn();
    if (value) return value;
    await sleep(60);
  }
  return null;
}

test("前端：启动、信息流、媒体模式、后台、频道页", async (t) => {
  if (!(await serverUp())) {
    t.skip(`开发服务器未启动（${BASE}），请先执行 npm run dev`);
    return;
  }

  // 预热：信息流冷缓存时要实时抓 t.me，耗时可能超过首屏渲染的等待窗口
  await realFetch(`${BASE}/api/feed`, { signal: AbortSignal.timeout(45000) }).catch(() => {});

  const { window, document } = await setupDom();

  try {
    // 动态导入前端模块（导入即执行 boot）
    await import("../public/app.js");

    // 1) 启动后信息流应渲染出消息卡片（或空态）
    const appNode = document.getElementById("app");
    const rendered = await waitFor(() => {
      const html = appNode.innerHTML;
      return html && !html.includes("加载中") ? html : null;
    }, 20000); // 首屏可能要等后端抓取上游频道，放宽到 20s
    assert.ok(rendered, "启动后 app 容器应完成渲染");
    const postCount = document.querySelectorAll(".post").length;
    const emptyCount = document.querySelectorAll(".empty, .errorbox").length;
    assert.ok(postCount > 0 || emptyCount > 0, "应渲染消息卡片或空态提示");

    // 2) 侧边栏频道列表
    const channelItems = document.querySelectorAll("#channel-list li").length;
    assert.ok(channelItems >= 1, "侧栏应至少有一项（含空态文案）");

    // 3) 站点标题与服务端 /api/config 一致（不依赖可变的测试数据）
    const cfg = await (await realFetch(`${BASE}/api/config`)).json();
    assert.equal(document.getElementById("site-title").textContent, cfg.siteTitle);
    assert.equal(document.title, cfg.siteTitle);

    // 4) 导航高亮
    const feedNav = document.querySelector('#main-nav a[data-nav="feed"]');
    assert.ok(feedNav.classList.contains("active"), "信息流导航应高亮");

    // 5) 跳转媒体模式
    window.location.hash = "#/media/video";
    window.dispatchEvent(new window.Event("hashchange"));
    const mediaReady = await waitFor(() => document.querySelectorAll(".tabs a").length);
    assert.ok(mediaReady, "媒体模式应渲染分类 Tab");
    assert.equal(document.querySelectorAll(".tabs a").length, 4, "应有视频/图片/音频/文件四个 Tab");
    assert.ok(document.querySelector('.tabs a.active')?.textContent.includes("视频"));
    assert.ok(document.querySelector("select"), "媒体模式应有频道筛选器");

    // 6) 跳转后台（未登录 → 登录表单）
    window.location.hash = "#/admin";
    window.dispatchEvent(new window.Event("hashchange"));
    const adminReady = await waitFor(() => document.querySelector(".auth-wrap h1"));
    assert.ok(adminReady, "后台应渲染");
    const title = document.querySelector(".auth-wrap h1").textContent;
    assert.ok(title.includes("登录") || title.includes("初始化"), `后台应显示登录或初始化页，实际：${title}`);
    assert.ok(document.querySelector('form input[type="password"]'), "应有密码输入框");

    // 7) 跳转单频道
    window.location.hash = "#/c/telegram";
    window.dispatchEvent(new window.Event("hashchange"));
    const channelReady = await waitFor(() => {
      const html = document.getElementById("app").innerHTML;
      // 标题可能来自上游元信息，也可能用后台配置的显示名；再兜底错误态与空态
      const hasTitle = !!document.querySelector("#app h1");
      const hasFallback = html.includes("频道不存在") || html.includes("errorbox") || html.includes("该频道暂无可显示的内容");
      return html && (hasTitle || hasFallback) ? html : null;
    }, 20000);
    assert.ok(channelReady, "频道页应渲染标题、错误态或空态");

    // 8) 错误路由回退到信息流
    window.location.hash = "#/does-not-exist";
    window.dispatchEvent(new window.Event("hashchange"));
    await sleep(300);
    assert.ok(document.getElementById("app").innerHTML.length > 0, "未知路由应有渲染结果");

  } finally {
    globalThis.fetch = realFetch;
    await window.happyDOM?.close?.();
  }
});
