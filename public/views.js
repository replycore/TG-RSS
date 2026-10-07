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

  const posts = el("div", { class: "posts" });
  const footer = el("div");
  root.append(posts, footer);

  let cursors = {};
  let finished = false;
  let loading = false;
  const accept = dedupe();
  const channelMap = {};

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
      const data = await api.feed(cursors);
      cursors = data.cursors || {};
      (data.channels || []).forEach((c) => { if (c?.key) channelMap[c.key] = c; });
      let added = 0;
      (data.posts || []).forEach((p) => {
        const post = withChannelMeta(p, channelMap);
        if (!accept(post)) return;
        const node = renderPost(post, ctx);
        posts.append(node);
        entries.push({ t: Date.parse(post.date) || 0, node });
        added += 1;
      });
      resort();
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
        clear(root).append(
          el("div", { class: "empty" }, [
            el("div", { text: "还没有内容" }),
            el("div", { class: "hint", text: "前往「管理 → 频道」添加 Telegram 频道" }),
            el("p", {}, [el("a", { class: "btn primary", href: "#/admin", text: "去配置" })]),
          ]),
        );
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
      const data = await api.posts(key, before);
      before = data.next;
      let added = 0;
      (data.posts || []).forEach((p) => {
        const post = withChannelMeta({ ...p, channelKey: key, channelName: channel.name }, { [key]: channel });
        if (!accept(post)) return;
        posts.append(renderPost(post, ctx));
        added += 1;
      });
      if (!before || added === 0) finished = true;

      if (finished) {
        clear(footer).append(el("div", { class: "muted", style: { textAlign: "center", padding: "14px" }, text: "到底了" }));
      } else {
        more.mount(footer);
        more.setState({ disabled: false, label: "加载更多" });
      }
      if (!posts.children.length && finished) {
        clear(root).append(el("div", { class: "empty", text: "该频道暂无可显示的内容" }));
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
