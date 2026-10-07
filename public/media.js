/** 媒体模式：视频 / 图片 / 音频 / 文件 四类分类浏览 + 原生播放器 */

import { api } from "./api.js";
import { el, clear, toast, openLightbox, createMoreControls, fmtDate, downloadBtn } from "./ui.js";

const TABS = [
  { key: "video", label: "视频" },
  { key: "image", label: "图片" },
  { key: "audio", label: "音频" },
  { key: "file", label: "文件" },
];

export async function renderMedia(root, ctx, type = "video", channelKey = "") {
  const cfg = ctx.state.config?.media || {};
  clear(root);
  root.classList.add("wide");

  root.append(
    el("div", { class: "view-head" }, [
      el("div", {}, [
        el("h1", { text: "媒体模式" }),
        el("div", { class: "sub", text: "按视频 / 图片 / 音频 / 文件分类浏览所有可见频道" }),
      ]),
    ]),
  );

  const tabs = el("div", { class: "tabs" });
  TABS.forEach((tab) => {
    const disabled = cfg[tab.key] === false;
    const link = el("a", {
      href: `#/media/${tab.key}${channelKey ? `/${encodeURIComponent(channelKey)}` : ""}`,
      text: disabled ? `${tab.label}（已关闭）` : tab.label,
      class: tab.key === type ? "active" : "",
    });
    tabs.append(link);
  });
  root.append(tabs);

  // 频道筛选
  const channels = ctx.state.channels || [];
  const filterBar = el("div", { style: { display: "flex", gap: "10px", marginBottom: "14px", flexWrap: "wrap" } });
  const select = el("select", { class: "select", style: { maxWidth: "260px" } });
  select.append(el("option", { value: "", text: "全部频道" }));
  channels.forEach((c) => {
    const opt = el("option", { value: c.key, text: c.name });
    if (c.key === channelKey) opt.selected = true;
    select.append(opt);
  });
  select.onchange = () => {
    const v = select.value;
    location.hash = `#/media/${type}${v ? `/${encodeURIComponent(v)}` : ""}`;
  };
  filterBar.append(select);
  root.append(filterBar);

  if (cfg[type] === false) {
    root.append(
      el("div", { class: "empty" }, [
        el("div", { text: `${TABS.find((t) => t.key === type)?.label || type}分类已关闭` }),
        el("div", { class: "hint", text: "可在「管理 → 媒体」中开启" }),
      ]),
    );
    return;
  }

  const grid = el("div", { class: "media-grid" });
  const footer = el("div");
  root.append(grid, footer);

  let cursors = {};
  let finished = false;
  let loading = false;
  const seen = new Set();

  const more = createMoreControls(() => load());

  async function load() {
    if (loading || finished) return;
    loading = true;
    more.setState({ disabled: true, label: "加载中…" });
    try {
      const data = await api.media({ type, cursors, key: channelKey || undefined });
      cursors = data.cursors || {};
      let added = 0;
      (data.items || []).forEach((item) => {
        if (seen.has(item.id)) return;
        seen.add(item.id);
        grid.append(renderCard(item, ctx, type));
        added += 1;
      });
      (data.errors || []).forEach((e) => toast(`${e.key}：${e.message}`, "error"));

      const hasPending = Object.values(cursors).some((v) => typeof v === "string");
      if (!hasPending || (added === 0 && data.done)) finished = true;

      if (finished) {
        clear(footer).append(
          el("div", { class: "muted", style: { textAlign: "center", padding: "14px" },
            text: grid.children.length ? "没有更多了" : "暂无该类型的媒体" }),
        );
      } else {
        more.mount(footer);
        more.setState({ disabled: false, label: "加载更多" });
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

function renderCard(item, ctx, type) {
  const card = el("div", { class: "media-card", role: "button", tabindex: "0" });

  const cover = el("div", { class: "cover" });
  if (item.thumb) {
    cover.append(el("img", { src: item.thumb, alt: "", loading: "lazy" }));
  } else if (item.type === "image" && item.src) {
    cover.append(el("img", { src: item.src, alt: "", loading: "lazy" }));
  } else if (type === "audio") {
    cover.append(el("div", { class: "ph", text: "AUDIO" }));
  } else if (type === "file") {
    cover.append(el("div", { class: "ph", text: (item.name || "FILE").split(".").pop().slice(0, 5).toUpperCase() }));
  } else if (type === "video") {
    cover.append(el("div", { class: "ph", text: "VIDEO" }));
  }
  if (item.duration) cover.append(el("span", { class: "dur", text: item.duration }));
  card.append(cover);

  const body = el("div", { class: "body" }, [
    el("div", { class: "t", text: item.name || item.post?.text?.split("\n")[0] || "—" }),
    el("div", { class: "s", text: `${item.channel?.name || ""}${item.date ? " · " + fmtDate(item.date) : ""}` }),
  ]);
  card.append(body);
  // 卡片内的下载按钮：阻止冒泡，避免触发整卡点击（打开灯箱）
  const dl = downloadBtn({ ...item, name: item.name || (item.post?.text || "").split("\n")[0] || "" });
  if (dl) {
    dl.addEventListener("click", (e) => e.stopPropagation());
    body.append(el("div", { class: "card-actions" }, [dl]));
  }

  const open = () => activate(item, type);
  card.onclick = open;
  card.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } };
  return card;
}

function activate(item, type) {
  if (type === "file") {
    if (item.direct || item.src) {
      window.open(item.direct || item.src, "_blank", "noopener");
    } else if (item.link || item.post?.url) {
      window.open(item.link || item.post.url, "_blank", "noopener");
    } else {
      toast("该文件没有可用链接", "error");
    }
    return;
  }
  openLightbox({
    ...item,
    messageUrl: item.link || item.post?.url,
    date: item.date,
  });
}
