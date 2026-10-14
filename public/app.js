/** TG-RSS 应用入口：启动、路由、侧边栏、主题 */

import { t, reg, getLang, setLang, applyStatic } from "./i18n.js";
import { api, ApiError } from "./api.js";
import { el, clear, toast, avatarNode, closeLightbox } from "./ui.js";
import { renderFeed, renderChannel } from "./views.js";
import { renderMedia } from "./media.js";
import { renderAdmin } from "./admin.js";

reg("app", {
  themeAuto: { zh: "主题：跟随系统", en: "Theme: follow system" },
  themeDark: { zh: "主题：深色", en: "Theme: dark" },
  themeLight: { zh: "主题：浅色", en: "Theme: light" },
  noChannels: { zh: "还没有频道", en: "No channels yet" },
  addFirst: { zh: "去添加 →", en: "Add some →" },
  adminLogin: { zh: "管理员登录 →", en: "Admin login →" },
  lockTitle: { zh: "仅登录可见", en: "Visible after login" },
  lockText: { zh: "锁", en: "Lock" },
  refreshing: { zh: "刷新中…", en: "Refreshing…" },
  refreshBtn: { zh: "刷新", en: "Refresh" },
  refreshed: { zh: "已刷新频道列表", en: "Channel list refreshed" },
  tagCollapse: { zh: "标签折叠 ▴", en: "Hide tags ▴" },
  tagExpand: { zh: "标签展开 ▾", en: "Show tags ▾" },
  loading: { zh: "加载中…", en: "Loading…" },
  pageLoadFail: { zh: "页面加载失败", en: "Failed to load page" },
  retry: { zh: "重试", en: "Retry" },
});

// index.html 静态节点词条（data-i18n / data-i18n-title 引用；meta description 由 JS 刷新）
reg("html", {
  metaDesc: { zh: "TG-RSS — Telegram 频道阅读器", en: "TG-RSS — Telegram channel reader" },
  sidebarToggle: { zh: "频道列表", en: "Channel list" },
  navFeed: { zh: "信息流", en: "Feed" },
  navMedia: { zh: "媒体", en: "Media" },
  tagExpand: { zh: "标签展开 ▾", en: "Show tags ▾" },
  adminBadge: { zh: "管理员", en: "Admin" },
  themeToggle: { zh: "切换主题", en: "Toggle theme" },
  langToggleText: { zh: "EN", en: "中" },
  langToggleTitle: { zh: "English", en: "中文" },
  channels: { zh: "频道", en: "Channels" },
  refresh: { zh: "刷新", en: "Refresh" },
  refreshAll: { zh: "刷新频道列表", en: "Refresh channel list" },
  loading: { zh: "加载中…", en: "Loading…" },
  mediaMode: { zh: "媒体模式", en: "Media mode" },
  admin: { zh: "管理后台", en: "Admin panel" },
  rss: { zh: "RSS 订阅", en: "RSS feed" },
  about: { zh: "关于", en: "About" },
  aboutValue: { zh: "TG-RSS · 自托管 Telegram 阅读器", en: "TG-RSS · Self-hosted Telegram reader" },
  version: { zh: "版本", en: "Version" },
  repo: { zh: "仓库", en: "Repo" },
});

/** 刷新 <meta name="description">（静态 HTML 里保留原中文，语言切换后由 JS 覆盖） */
function updateMetaDesc() {
  const node = document.querySelector('meta[name="description"]');
  if (node) node.content = t("html.metaDesc");
}

// 启动早期：把 index.html 静态节点刷成当前语言（默认 zh 与原文字面量一致），并同步 meta description
applyStatic(document);
updateMetaDesc();

const state = {
  config: null,
  channels: [],
  authenticated: false,
  initialized: false,
  tagsOpen: false, // 标签条展开状态（顶栏按钮驱动，跨视图保持）
  settings: null,
};

const app = document.getElementById("app");

const ctx = {
  state,
  go: (hash) => { location.hash = hash; },
  refreshChannels: async () => {
    await loadChannels();
    renderSidebar();
  },
  refreshAuth: () => updateAuthBadge(),
  applyTheme: (theme) => setTheme(theme),
  // 顶栏「标签展开/折叠」按钮：由 views.js 的标签条更新显示与文案
  updateTagToggle,
};

/* --------------------------------------------------------------- 主题 */

const THEME_KEY = "tgrss.theme";

function setTheme(theme) {
  const value = ["light", "dark"].includes(theme) ? theme : "auto";
  document.documentElement.dataset.theme = value;
  try { localStorage.setItem(THEME_KEY, value); } catch { /* ignore */ }
}

function initTheme() {
  let stored = null;
  try { stored = localStorage.getItem(THEME_KEY); } catch { /* ignore */ }
  const fromConfig = state.config?.theme;
  setTheme(stored || fromConfig || "auto");
}

document.getElementById("theme-toggle").onclick = () => {
  const current = document.documentElement.dataset.theme;
  const order = { auto: "light", light: "dark", dark: "auto" };
  const next = order[current] || "auto";
  setTheme(next);
  toast(next === "auto" ? t("app.themeAuto") : next === "dark" ? t("app.themeDark") : t("app.themeLight"));
};

/* ------------------------------------------------------------- 语言切换 */

const langToggle = document.getElementById("lang-toggle");

/** 刷新语言切换按钮：zh 时显示 "EN"（title English），en 时显示 "中"（title 中文） */
function syncLangToggle() {
  if (!langToggle) return;
  langToggle.textContent = t("html.langToggleText");
  langToggle.title = t("html.langToggleTitle");
}

if (langToggle) {
  langToggle.onclick = () => setLang(getLang() === "en" ? "zh-CN" : "en");
}
syncLangToggle();

/* ------------------------------------------------------------- 数据加载 */

async function refreshAuth() {
  try {
    const res = await api.adminState();
    state.authenticated = res.authenticated;
    state.initialized = res.initialized;
  } catch {
    state.authenticated = false;
  }
  updateAuthBadge();
  return state;
}

function updateAuthBadge() {
  const badge = document.getElementById("auth-badge");
  badge.hidden = !state.authenticated;
}

async function loadChannels() {
  try {
    const res = await api.channels();
    state.channels = res.channels || [];
    state.authenticated = res.authenticated;
  } catch (err) {
    console.error(err);
    state.channels = [];
  }
  renderSidebar();
  return state.channels;
}

/* --------------------------------------------------------------- 侧边栏 */

function renderSidebar() {
  const list = document.getElementById("channel-list");
  clear(list);

  if (!state.channels.length) {
    list.append(el("li", { class: "muted", style: { padding: "8px 10px", fontSize: "13px" } }, [
      el("div", { text: t("app.noChannels") }),
      state.authenticated
        ? el("a", { href: "#/admin/channels", text: t("app.addFirst") })
        : el("a", { href: "#/admin", text: t("app.adminLogin") }),
    ]));
    return;
  }

  const activeKey = activeChannelKey();
  state.channels.forEach((ch) => {
    const link = el("a", {
      href: `#/c/${encodeURIComponent(ch.key)}`,
      class: ch.key === activeKey ? "active" : "",
      onclick: () => closeSidebar(),
    });
    link.append(avatarNode(ch.avatar, ch.name));
    link.append(el("span", { class: "name", text: ch.name }));
    if (ch.hidden) link.append(el("span", { class: "lock", title: t("app.lockTitle"), text: t("app.lockText") }));
    list.append(el("li", {}, [link]));
  });
}

function activeChannelKey() {
  const raw = location.hash.replace(/^#/, "");
  const m = /^\/c\/([^/?]+)/.exec(raw);
  // 必须容错：本函数在 route() 的 try 之外被调用，裸 decodeURIComponent 遇坏 hash（#/c/%E4）
  // 会抛 URIError 杀死整个启动链（首屏卡死）——与 parseRoute 同一套 safeDecode
  return m ? safeDecode(m[1]) : null;
}

/* ------------------------------------------------------------- 侧栏开关 */

const sidebar = document.getElementById("sidebar");
const mask = document.getElementById("sidebar-mask");

function toggleSidebar() {
  const open = sidebar.classList.toggle("open");
  mask.hidden = !open;
}
function closeSidebar() {
  sidebar.classList.remove("open");
  mask.hidden = true;
}
document.getElementById("sidebar-toggle").onclick = toggleSidebar;
mask.onclick = closeSidebar;
document.getElementById("refresh-all").onclick = async (e) => {
  const btn = e.currentTarget;
  btn.textContent = t("app.refreshing");
  await refreshAuth();
  await ctx.refreshChannels();
  btn.textContent = t("app.refreshBtn");
  toast(t("app.refreshed"), "ok");
};

/* ---------------------------------------------------------------- 路由 */

// 路由解析已抽到 public/route.js（safeDecode 容错 + 可单测）；保留转发导出兼容旧引用
export { parseRoute, safeDecode } from "./route.js";
import { parseRoute, safeDecode } from "./route.js";

function setActiveNav(name) {
  document.querySelectorAll("#main-nav a").forEach((a) => {
    a.classList.toggle("active", a.dataset.nav === name);
  });
}

let renderSeq = 0;

/** 顶栏「标签展开 ▾ / 标签折叠 ▴」按钮的显示与文案 */
function updateTagToggle(visible, open) {
  const btn = document.getElementById("tag-toggle");
  if (!btn) return;
  btn.hidden = !visible;
  btn.textContent = open ? t("app.tagCollapse") : t("app.tagExpand");
}

async function route() {
  const r = parseRoute();
  const seq = ++renderSeq;
  closeLightbox();
  setActiveNav(r.name === "channel" ? "feed" : r.name);
  renderSidebar();

  // 每次路由给视图一个专属容器：切换时 clear(app) 会让旧容器脱离文档，
  // 晚到的异步回调（空响应/403/登录框）只操作 detached 节点，
  // 不会覆盖当前视图（此前 root 就是 app 本身，晚到 clear(root) 会清掉新视图）
  const view = el("div", { class: "view" });
  view.append(el("div", { class: "loading", text: t("app.loading") }));
  clear(app).append(view);
  app.classList.toggle("wide", r.name === "media");

  // 标签筛选状态：两个视图都可能带 ?tag=，其它视图先清掉回调
  ctx.feedTag = r.tag || null;
  ctx.onTagClick = null;
  ctx.refreshTags = null;
  if (r.name !== "feed" && r.name !== "channel") updateTagToggle(false, false);

  try {
    if (r.name === "feed") {
      await renderFeed(view, ctx);
    } else if (r.name === "channel") {
      await renderChannel(view, ctx, r.key);
    } else if (r.name === "media") {
      await renderMedia(view, ctx, r.type, r.key);
    } else if (r.name === "admin") {
      await renderAdmin(view, ctx, r.tab);
    }
  } catch (err) {
    if (seq !== renderSeq) return;
    console.error(err);
    clear(view).append(
      el("div", { class: "errorbox" }, [
        el("div", { text: err instanceof ApiError ? err.message : t("app.pageLoadFail") }),
        el("button", { class: "btn", type: "button", text: t("app.retry"), onclick: () => route() }),
      ]),
    );
    if (err instanceof ApiError && err.status === 401) {
      state.authenticated = false;
      updateAuthBadge();
    }
  }
}

window.addEventListener("hashchange", route);

// 语言切换：setLang() 先刷静态节点（applyStatic）再广播本事件；
// 这里补上动态部分——切换按钮文案、meta description，并直接重渲染当前视图
window.addEventListener("tg:langchange", () => {
  syncLangToggle();
  updateMetaDesc();
  route();
});

/* ---------------------------------------------------------------- 启动 */

async function boot() {
  try {
    state.config = await api.config();
    document.getElementById("site-title").textContent = state.config.siteTitle || "TG-RSS";
    // 顶栏标签按钮：点击展开/收起当前视图的标签条；不在筛选视图时先回信息流
    const tagBtn = document.getElementById("tag-toggle");
    if (tagBtn) {
      tagBtn.addEventListener("click", () => {
        const routeNow = parseRoute();
        const filterView = routeNow.name === "feed" || routeNow.name === "channel";
        state.tagsOpen = !state.tagsOpen;
        if (filterView && typeof ctx.refreshTags === "function") {
          ctx.refreshTags();
        } else {
          location.hash = "#/";
        }
      });
    }
    document.title = state.config.siteTitle || "TG-RSS";
    const versionNode = document.getElementById("app-version");
    if (versionNode) versionNode.textContent = `v${state.config.version || "1.3.1"}`;
  } catch (err) {
    console.error("配置加载失败", err);
  }
  initTheme();
  await refreshAuth();
  await loadChannels();
  await route();
}

boot();
