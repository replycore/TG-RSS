/** TG-RSS 应用入口：启动、路由、侧边栏、主题 */

import { api, ApiError } from "./api.js";
import { el, clear, toast, avatarNode, closeLightbox } from "./ui.js";
import { renderFeed, renderChannel } from "./views.js";
import { renderMedia } from "./media.js";
import { renderAdmin } from "./admin.js";

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
  toast(next === "auto" ? "主题：跟随系统" : next === "dark" ? "主题：深色" : "主题：浅色");
};

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
      el("div", { text: "还没有频道" }),
      state.authenticated
        ? el("a", { href: "#/admin/channels", text: "去添加 →" })
        : el("a", { href: "#/admin", text: "管理员登录 →" }),
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
    if (ch.hidden) link.append(el("span", { class: "lock", title: "仅登录可见", text: "锁" }));
    list.append(el("li", {}, [link]));
  });
}

function activeChannelKey() {
  const raw = location.hash.replace(/^#/, "");
  const m = /^\/c\/([^/?]+)/.exec(raw);
  return m ? decodeURIComponent(m[1]) : null;
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
  btn.textContent = "刷新中…";
  await refreshAuth();
  await ctx.refreshChannels();
  btn.textContent = "刷新";
  toast("已刷新频道列表", "ok");
};

/* ---------------------------------------------------------------- 路由 */

export function parseRoute() {
  const raw = (location.hash || "#/").replace(/^#/, "");
  // 先把路径和 query 拆开：否则 `#/?tag=xxx` 的路径部分是 "/"，
  // 会在下面 parts 为空时提前返回，把 ?tag= 整个丢掉（点了标签却不筛选）
  const qIndex = raw.indexOf("?");
  const pathPart = qIndex >= 0 ? raw.slice(0, qIndex) : raw;
  const queryPart = qIndex >= 0 ? raw.slice(qIndex + 1) : "";
  const parts = pathPart.split("/").filter(Boolean);
  const query = new URLSearchParams(queryPart);
  const tag = query.get("tag");
  const feedRoute = () => (tag ? { name: "feed", tag } : { name: "feed" });
  if (!parts.length) return feedRoute();
  if (parts[0] === "c" && parts[1]) {
    const key = decodeURIComponent(parts[1]);
    return tag ? { name: "channel", key, tag } : { name: "channel", key };
  }
  if (parts[0] === "media") return { name: "media", type: parts[1] || "video", key: parts[2] ? decodeURIComponent(parts[2]) : "" };
  if (parts[0] === "admin") return { name: "admin", tab: parts[1] || "general" };
  return feedRoute();
}

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
  btn.textContent = open ? "标签折叠 ▴" : "标签展开 ▾";
}

async function route() {
  const r = parseRoute();
  const seq = ++renderSeq;
  closeLightbox();
  setActiveNav(r.name === "channel" ? "feed" : r.name);
  renderSidebar();

  clear(app).append(el("div", { class: "loading", text: "加载中…" }));

  // 标签筛选状态：两个视图都可能带 ?tag=，其它视图先清掉回调
  ctx.feedTag = r.tag || null;
  ctx.onTagClick = null;
  ctx.refreshTags = null;
  if (r.name !== "feed" && r.name !== "channel") updateTagToggle(false, false);

  try {
    if (r.name === "feed") {
      await renderFeed(app, ctx);
    } else if (r.name === "channel") {
      await renderChannel(app, ctx, r.key);
    } else if (r.name === "media") {
      await renderMedia(app, ctx, r.type, r.key);
    } else if (r.name === "admin") {
      await renderAdmin(app, ctx, r.tab);
    }
  } catch (err) {
    if (seq !== renderSeq) return;
    console.error(err);
    clear(app).append(
      el("div", { class: "errorbox" }, [
        el("div", { text: err instanceof ApiError ? err.message : "页面加载失败" }),
        el("button", { class: "btn", type: "button", text: "重试", onclick: () => route() }),
      ]),
    );
    if (err instanceof ApiError && err.status === 401) {
      state.authenticated = false;
      updateAuthBadge();
    }
  }
}

window.addEventListener("hashchange", route);

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
    if (versionNode) versionNode.textContent = `v${state.config.version || "1.1.0"}`;
  } catch (err) {
    console.error("配置加载失败", err);
  }
  initTheme();
  await refreshAuth();
  await loadChannels();
  await route();
}

boot();
