/** 信息流与单频道视图 */

import { api } from "./api.js";
import { el, clear, renderPost, createMoreControls, toast, avatarNode } from "./ui.js";
import { t, reg } from "./i18n.js";

reg("views", {
  all: { zh: "全部", en: "All" },
  feedSub: { zh: "聚合信息流 · 按发布时间倒序", en: "Aggregated feed · newest first" },
  loading: { zh: "加载中…", en: "Loading…" },
  noMore: { zh: "没有更多了", en: "No more items" },
  loadMore: { zh: "加载更多", en: "Load more" },
  noTagContentFeed: { zh: "没有带 #{tag} 的已加载内容", en: "No loaded items tagged #{tag}" },
  tryClearFilter: { zh: "试试点「全部」取消筛选，或加载更多", en: "Try clearing the filter with “All”, or load more" },
  clearFilter: { zh: "清除筛选", en: "Clear filter" },
  empty: { zh: "还没有内容", en: "No content yet" },
  goAdminHint: { zh: "前往「管理 → 频道」添加 Telegram 频道", en: "Go to “Admin → Channels” to add Telegram channels" },
  goConfig: { zh: "去配置", en: "Configure" },
  loadFailed: { zh: "加载失败", en: "Load failed" },
  retry: { zh: "重试", en: "Retry" },
  channelMissing: { zh: "频道不存在", en: "Channel not found" },
  channelHiddenHint: { zh: "可能被设为「隐藏」且当前未登录", en: "It may be hidden and you are not logged in" },
  backHome: { zh: "返回首页", en: "Back to home" },
  privateChannel: { zh: "{sep}私密频道 {tgId}", en: "{sep}Private channel {tgId}" },
  loginOnly: { zh: "仅登录可见", en: "Visible after login" },
  reachedEnd: { zh: "到底了", en: "You've reached the end" },
  noTagContentChannel: { zh: "该频道没有带 #{tag} 的内容", en: "This channel has no content tagged #{tag}" },
  channelEmpty: { zh: "该频道暂无可显示的内容", en: "No content to show in this channel" },
  goLogin: { zh: "去登录", en: "Log in" },
});

function dedupe() {
  const seen = new Set();
  return (post) => {
    const id = post.id || `${post.channel}/${post.postId}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  };
}

function withChannelMeta(post, map) {
  // 大小写不敏感查找：频道 key 是 username.toLowerCase()（store.js），
  // 但 post.channel 取自 t.me HTML 的 data-post，保留原始大小写（如 "Xiaomi"）
  // ——精确匹配 miss 会导致频道链接变成 #/c/原始slug → "频道不存在"，自定义名也丢失
  const slugKey = post.channelKey || post.channel;
  const lowerKey = typeof slugKey === "string" ? slugKey.toLowerCase() : slugKey;
  const meta = map[slugKey] || map[lowerKey] || map[post.channel] || null;
  return {
    ...post,
    channelKey: meta?.key || slugKey,
    channelName: meta?.name || post.channelName || post.channel,
  };
}

/* ------------------------------------------------------------- 信息流 */

/**
 * 标签筛选条（信息流 / 单频道共用）。
 * 折叠展开状态存放在 ctx.state.tagsOpen，由顶栏「标签展开 ▾ / 标签折叠 ▴」按钮驱动，
 * 按钮固定在顶栏「媒体」之后，切换视图也不丢状态。
 */
function createTagBar({ bar, ctx, tagSet, activeTag, setTag }) {
  return function renderTagBar() {
    // 容器隔离守卫：feed 请求 in-flight 时切走视图，bar 已随容器 detached——
    // 此时不得再动顶栏共享的 #tag-toggle 按钮（否则晚到回调把「标签展开」错误带回非筛选视图）
    if (!bar.isConnected) return;
    clear(bar);
    const list = [...tagSet.values()].sort((a, b) => a.localeCompare(b));
    if (activeTag && !list.some((tagName) => tagName.toLowerCase() === activeTag.toLowerCase())) list.unshift(activeTag);
    const hasAny = list.length > 0 || !!activeTag;
    const open = !!ctx.state.tagsOpen;
    ctx.updateTagToggle(hasAny, open);
    if (!hasAny) {
      bar.hidden = true;
      return;
    }
    const chip = (label, active, onclick) =>
      el("button", { class: `tag-chip${active ? " active" : ""}`, type: "button", text: label, onclick });
    if (!open) {
      // 折叠态：只保留当前筛选，可直接点掉
      bar.hidden = !activeTag;
      if (activeTag) bar.append(chip(`#${activeTag} ✕`, true, () => setTag(null)));
      return;
    }
    bar.hidden = false;
    bar.append(chip(t("views.all"), !activeTag, () => setTag(null)));
    for (const tag of list) {
      const active = activeTag && activeTag.toLowerCase() === tag.toLowerCase();
      bar.append(chip(`#${tag}`, active, () => setTag(active ? null : tag)));
    }
  };
}

export async function renderFeed(root, ctx) {
  clear(root);
  root.classList.remove("wide");

  const head = el("div", { class: "view-head" }, [
    el("div", {}, [
      el("h1", { text: ctx.state.config?.siteTitle || "TG-RSS" }),
      el("div", { class: "sub", text: t("views.feedSub") }),
    ]),
  ]);
  root.append(head);

  const activeTag = ctx.feedTag || null;
  // 正文里的 #话题 点击后回到本视图并按该标签筛选
  ctx.onTagClick = (tag) => setTag(tag);
  function setTag(tag) {
    ctx.go(tag ? `#/?tag=${encodeURIComponent(tag)}` : "#/");
  }

  const tagBar = el("div", { class: "tag-bar" });
  root.append(tagBar);

  const posts = el("div", { class: "posts" });
  const footer = el("div");
  root.append(posts, footer);

  let cursors = {};
  let finished = false;
  let loading = false;
  const accept = dedupe();
  const channelMap = {};
  const tagSet = new Map(); // key(小写) -> 展示用原文

  // 信息流：标签条 + 顶栏按钮联动
  const renderTagBar = createTagBar({ bar: tagBar, ctx, tagSet, activeTag, setTag });
  ctx.refreshTags = renderTagBar;
  renderTagBar();

  const more = createMoreControls(() => load());
  // 逐页追加时仍按发布时间整体排序：按时间倒序重排并重新挂载（appendChild 会移动已有节点）
  const entries = [];
  const resort = () => {
    entries.sort((a, b) => b.t - a.t);
    entries.forEach((e) => posts.append(e.node));
  };

  async function load() {
    if (loading || finished) return;
    loading = true;
    more.setState({ disabled: true, label: t("views.loading") });
    try {
      const data = await api.feed(cursors, activeTag);
      cursors = data.cursors || {};
      (data.channels || []).forEach((c) => { if (c?.key) channelMap[c.key] = c; });
      let added = 0;
      (data.posts || []).forEach((p) => {
        const post = withChannelMeta(p, channelMap);
        if (!accept(post)) return;
        (post.tags || []).forEach((tagName) => tagSet.set(String(tagName).toLowerCase(), tagName));
        const node = renderPost(post, ctx);
        posts.append(node);
        entries.push({ t: Date.parse(post.date) || 0, node });
        added += 1;
      });
      resort();
      renderTagBar();
      (data.errors || []).forEach((e) => toast(`${e.key}：${e.message}`, "error"));

      const hasPending = Object.entries(cursors).some(([k, v]) => k !== "__lastBatchTail" && typeof v === "string");
      if (!hasPending || (added === 0 && data.done)) finished = true;
      if (finished) {
        clear(footer);
        footer.append(el("div", { class: "muted", style: { textAlign: "center", padding: "14px" }, text: t("views.noMore") }));
      } else {
        more.mount(footer);
        more.setState({ disabled: false, label: t("views.loadMore") });
      }
      if (!posts.children.length && finished) {
        if (activeTag) {
          clear(root).append(
            el("div", { class: "empty" }, [
              el("div", { text: t("views.noTagContentFeed", { tag: activeTag }) }),
              el("div", { class: "hint", text: t("views.tryClearFilter") }),
              el("p", {}, [el("button", { class: "btn", type: "button", text: t("views.clearFilter"), onclick: () => setTag(null) })]),
            ]),
          );
        } else {
          clear(root).append(
            el("div", { class: "empty" }, [
              el("div", { text: t("views.empty") }),
              el("div", { class: "hint", text: t("views.goAdminHint") }),
              el("p", {}, [el("a", { class: "btn primary", href: "#/admin", text: t("views.goConfig") })]),
            ]),
          );
        }
      }
    } catch (err) {
      toast(err.message || t("views.loadFailed"), "error");
      more.mount(footer);
      more.setState({ disabled: false, label: t("views.retry") });
    } finally {
      loading = false;
    }
  }

  more.mount(footer);
  await load();
}

/* --------------------------------------------------------------- 单频道 */

export async function renderChannel(root, ctx, key) {
  clear(root);
  root.classList.remove("wide");
  ctx.onTagClick = null; // 频道不存在早退时先复位，避免留下上一个视图的回调

  const lowerKey = typeof key === "string" ? key.toLowerCase() : key;
  const channel =
    (ctx.state.channels || []).find((c) => c.key === key) ||
    (ctx.state.channels || []).find((c) => typeof c.key === "string" && c.key.toLowerCase() === lowerKey);
  if (!channel) {
    root.append(
      el("div", { class: "errorbox" }, [
        el("div", { text: t("views.channelMissing") }),
        el("div", { class: "hint", text: t("views.channelHiddenHint") }),
        el("p", {}, [el("a", { class: "btn", href: "#/", text: t("views.backHome") })]),
      ]),
    );
    return;
  }

  const head = el("div", { class: "view-head" }, [
    avatarNode(channel.avatar, channel.name),
    el("div", {}, [
      el("h1", { text: channel.name }),
      el("div", { class: "sub" }, [
        channel.username ? el("a", { href: `https://t.me/${channel.username}`, target: "_blank", rel: "noopener", text: `@${channel.username}` }) : null,
        channel.type === "private" ? el("span", { text: t("views.privateChannel", { sep: channel.username ? " · " : "", tgId: channel.tgId || "" }) }) : null,
        channel.hidden ? el("span", { class: "pill warn", style: { marginLeft: "8px" }, text: t("views.loginOnly") }) : null,
      ].filter(Boolean)),
      channel.description ? el("div", { class: "desc", text: channel.description }) : null,
      countersRow(channel.counters),
    ].filter(Boolean)),
  ]);
  root.append(head);

  // 单频道同样支持 #标签 过滤
  const activeTag = ctx.feedTag || null;
  ctx.onTagClick = (tag) => setTag(tag);
  function setTag(tag) {
    const base = `#/c/${encodeURIComponent(key)}`;
    ctx.go(tag ? `${base}?tag=${encodeURIComponent(tag)}` : base);
  }
  const tagBar = el("div", { class: "tag-bar" });
  root.append(tagBar);
  const tagSet = new Map();
  const renderTagBar = createTagBar({ bar: tagBar, ctx, tagSet, activeTag, setTag });
  ctx.refreshTags = renderTagBar;
  renderTagBar();

  const posts = el("div", { class: "posts" });
  const footer = el("div");
  root.append(posts, footer);

  let before = null;
  let finished = false;
  let loading = false;
  const accept = dedupe();

  const more = createMoreControls(() => load());

  async function load() {
    if (loading || finished) return;
    loading = true;
    more.setState({ disabled: true, label: t("views.loading") });
    try {
      const data = await api.posts(key, before, activeTag);
      before = data.next;
      let added = 0;
      (data.posts || []).forEach((p) => {
        const post = withChannelMeta({ ...p, channelKey: key, channelName: channel.name }, { [key]: channel });
        if (!accept(post)) return;
        (post.tags || []).forEach((tagName) => tagSet.set(String(tagName).toLowerCase(), tagName));
        posts.append(renderPost(post, ctx));
        added += 1;
      });
      renderTagBar();
      // tag 模式下当页零匹配 ≠ 到底：后端按 tag 过滤后 next 游标照常返回，
      // 更早的匹配帖可能在下一页。只有 !before（后端说没下一页）才算 finished
      // （对齐 views.js:138 信息流逻辑：(!hasPending || (added === 0 && data.done))）
      if (!before) finished = true;

      if (finished) {
        clear(footer).append(el("div", { class: "muted", style: { textAlign: "center", padding: "14px" }, text: t("views.reachedEnd") }));
      } else {
        more.mount(footer);
        more.setState({ disabled: false, label: t("views.loadMore") });
      }
      if (!posts.children.length && finished) {
        if (activeTag) {
          clear(root).append(
            el("div", { class: "empty" }, [
              el("div", { text: t("views.noTagContentChannel", { tag: activeTag }) }),
              el("p", {}, [el("button", { class: "btn", type: "button", text: t("views.clearFilter"), onclick: () => setTag(null) })]),
            ]),
          );
        } else {
          clear(root).append(el("div", { class: "empty", text: t("views.channelEmpty") }));
        }
      }
    } catch (err) {
      if (err.status === 403) {
        clear(root).append(
          el("div", { class: "errorbox" }, [
            el("div", { text: err.message }),
            el("p", {}, [el("a", { class: "btn primary", href: "#/admin", text: t("views.goLogin") })]),
          ]),
        );
        return;
      }
      toast(err.message || t("views.loadFailed"), "error");
      more.mount(footer);
      more.setState({ disabled: false, label: t("views.retry") });
    } finally {
      loading = false;
    }
  }

  more.mount(footer);
  await load();
}

function countersRow(counters) {
  if (!counters || !Object.keys(counters).length) return null;
  const row = el("div", { class: "sub", style: { marginTop: "6px", display: "flex", gap: "12px", flexWrap: "wrap" } });
  for (const [label, value] of Object.entries(counters)) {
    row.append(el("span", { text: `${value} ${label}` }));
  }
  return row;
}
