/** 信息流与单频道视图 */

import { api } from "./api.js";
import { el, clear, renderPost, createMoreControls, toast, avatarNode } from "./ui.js";

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
  const meta = map[post.channelKey || post.channel] || map[post.channel] || null;
  return {
    ...post,
    channelKey: post.channelKey || post.channel,
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
    clear(bar);
    const list = [...tagSet.values()].sort((a, b) => a.localeCompare(b));
    if (activeTag && !list.some((t) => t.toLowerCase() === activeTag.toLowerCase())) list.unshift(activeTag);
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
    bar.append(chip("全部", !activeTag, () => setTag(null)));
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
      el("div", { class: "sub", text: "聚合信息流 · 按发布时间倒序" }),
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
    more.setState({ disabled: true, label: "加载中…" });
    try {
      const data = await api.feed(cursors, activeTag);
      cursors = data.cursors || {};
      (data.channels || []).forEach((c) => { if (c?.key) channelMap[c.key] = c; });
      let added = 0;
      (data.posts || []).forEach((p) => {
        const post = withChannelMeta(p, channelMap);
        if (!accept(post)) return;
        (post.tags || []).forEach((t) => tagSet.set(String(t).toLowerCase(), t));
        const node = renderPost(post, ctx);
        posts.append(node);
        entries.push({ t: Date.parse(post.date) || 0, node });
        added += 1;
      });
      resort();
      renderTagBar();
      (data.errors || []).forEach((e) => toast(`${e.key}：${e.message}`, "error"));

      const hasPending = Object.values(cursors).some((v) => typeof v === "string");
      if (!hasPending || (added === 0 && data.done)) finished = true;
      if (finished) {
        clear(footer);
        footer.append(el("div", { class: "muted", style: { textAlign: "center", padding: "14px" }, text: "没有更多了" }));
      } else {
        more.mount(footer);
        more.setState({ disabled: false, label: "加载更多" });
      }
      if (!posts.children.length && finished) {
        if (activeTag) {
          clear(root).append(
            el("div", { class: "empty" }, [
              el("div", { text: `没有带 #${activeTag} 的已加载内容` }),
              el("div", { class: "hint", text: "试试点「全部」取消筛选，或加载更多" }),
              el("p", {}, [el("button", { class: "btn", type: "button", text: "清除筛选", onclick: () => setTag(null) })]),
            ]),
          );
        } else {
          clear(root).append(
            el("div", { class: "empty" }, [
              el("div", { text: "还没有内容" }),
              el("div", { class: "hint", text: "前往「管理 → 频道」添加 Telegram 频道" }),
              el("p", {}, [el("a", { class: "btn primary", href: "#/admin", text: "去配置" })]),
            ]),
          );
        }
      }
    } catch (err) {
      toast(err.message || "加载失败", "error");
      more.mount(footer);
      more.setState({ disabled: false, label: "重试" });
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

  const channel = (ctx.state.channels || []).find((c) => c.key === key);
  if (!channel) {
    root.append(
      el("div", { class: "errorbox" }, [
        el("div", { text: "频道不存在" }),
        el("div", { class: "hint", text: "可能被设为「隐藏」且当前未登录" }),
        el("p", {}, [el("a", { class: "btn", href: "#/", text: "返回首页" })]),
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
        channel.type === "private" ? el("span", { text: `${channel.username ? " · " : ""}私密频道 ${channel.tgId || ""}` }) : null,
        channel.hidden ? el("span", { class: "pill warn", style: { marginLeft: "8px" }, text: "仅登录可见" }) : null,
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
    more.setState({ disabled: true, label: "加载中…" });
    try {
      const data = await api.posts(key, before, activeTag);
      before = data.next;
      let added = 0;
      (data.posts || []).forEach((p) => {
        const post = withChannelMeta({ ...p, channelKey: key, channelName: channel.name }, { [key]: channel });
        if (!accept(post)) return;
        (post.tags || []).forEach((t) => tagSet.set(String(t).toLowerCase(), t));
        posts.append(renderPost(post, ctx));
        added += 1;
      });
      renderTagBar();
      if (!before || added === 0) finished = true;

      if (finished) {
        clear(footer).append(el("div", { class: "muted", style: { textAlign: "center", padding: "14px" }, text: "到底了" }));
      } else {
        more.mount(footer);
        more.setState({ disabled: false, label: "加载更多" });
      }
      if (!posts.children.length && finished) {
        if (activeTag) {
          clear(root).append(
            el("div", { class: "empty" }, [
              el("div", { text: `该频道没有带 #${activeTag} 的内容` }),
              el("p", {}, [el("button", { class: "btn", type: "button", text: "清除筛选", onclick: () => setTag(null) })]),
            ]),
          );
        } else {
          clear(root).append(el("div", { class: "empty", text: "该频道暂无可显示的内容" }));
        }
      }
    } catch (err) {
      if (err.status === 403) {
        clear(root).append(
          el("div", { class: "errorbox" }, [
            el("div", { text: err.message }),
            el("p", {}, [el("a", { class: "btn primary", href: "#/admin", text: "去登录" })]),
          ]),
        );
        return;
      }
      toast(err.message || "加载失败", "error");
      more.mount(footer);
      more.setState({ disabled: false, label: "重试" });
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
