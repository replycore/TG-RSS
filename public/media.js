/** 媒体模式：视频 / 图片 / 音频 / 文件 四类分类浏览 + 原生播放器 */

import { api } from "./api.js";
import { el, clear, toast, openLightbox, createMoreControls, fmtDate, downloadBtn } from "./ui.js";
import { t, reg } from "./i18n.js";

reg("media", {
  tabVideo: { zh: "视频", en: "Videos" },
  tabImage: { zh: "图片", en: "Images" },
  tabAudio: { zh: "音频", en: "Audio" },
  tabFile: { zh: "文件", en: "Files" },
  title: { zh: "媒体模式", en: "Media" },
  sub: { zh: "按视频 / 图片 / 音频 / 文件分类浏览所有可见频道", en: "Browse all visible channels by video / image / audio / file" },
  tabClosed: { zh: "{label}（已关闭）", en: "{label} (disabled)" },
  allChannels: { zh: "全部频道", en: "All channels" },
  typeClosed: { zh: "{label}分类已关闭", en: "{label} category is disabled" },
  openMediaHint: { zh: "可在「管理 → 媒体」中开启", en: "Enable it in “Admin → Media”" },
  loading: { zh: "加载中…", en: "Loading…" },
  noMore: { zh: "没有更多了", en: "No more items" },
  noMedia: { zh: "暂无该类型的媒体", en: "No media of this type" },
  loadMore: { zh: "加载更多", en: "Load more" },
  loadFailed: { zh: "加载失败", en: "Load failed" },
  retry: { zh: "重试", en: "Retry" },
  noFileLink: { zh: "该文件没有可用链接", en: "No available link for this file" },
});

const TAB_KEYS = ["video", "image", "audio", "file"];

function tabLabel(key) {
  return t(`media.tab${key[0].toUpperCase()}${key.slice(1)}`);
}

export async function renderMedia(root, ctx, type = "video", channelKey = "") {
  const cfg = ctx.state.config?.media || {};
  clear(root);
  root.classList.add("wide");

  root.append(
    el("div", { class: "view-head" }, [
      el("div", {}, [
        el("h1", { text: t("media.title") }),
        el("div", { class: "sub", text: t("media.sub") }),
      ]),
    ]),
  );

  const tabs = el("div", { class: "tabs" });
  TAB_KEYS.forEach((key) => {
    const disabled = cfg[key] === false;
    const label = tabLabel(key);
    const link = el("a", {
      href: `#/media/${key}${channelKey ? `/${encodeURIComponent(channelKey)}` : ""}`,
      text: disabled ? t("media.tabClosed", { label }) : label,
      class: key === type ? "active" : "",
    });
    tabs.append(link);
  });
  root.append(tabs);

  // 频道筛选
  const channels = ctx.state.channels || [];
  const filterBar = el("div", { style: { display: "flex", gap: "10px", marginBottom: "14px", flexWrap: "wrap" } });
  const select = el("select", { class: "select", style: { maxWidth: "260px" } });
  select.append(el("option", { value: "", text: t("media.allChannels") }));
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
        el("div", { text: t("media.typeClosed", { label: tabLabel(type) || type }) }),
        el("div", { class: "hint", text: t("media.openMediaHint") }),
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
    more.setState({ disabled: true, label: t("media.loading") });
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

      const hasPending = Object.entries(cursors).some(([k, v]) => k !== "__lastBatchTail" && typeof v === "string");
      if (!hasPending || (added === 0 && data.done)) finished = true;

      if (finished) {
        clear(footer).append(
          el("div", { class: "muted", style: { textAlign: "center", padding: "14px" },
            text: grid.children.length ? t("media.noMore") : t("media.noMedia") }),
        );
      } else {
        more.mount(footer);
        more.setState({ disabled: false, label: t("media.loadMore") });
      }
    } catch (err) {
      toast(err.message || t("media.loadFailed"), "error");
      more.mount(footer);
      more.setState({ disabled: false, label: t("media.retry") });
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
      // M-2：优先站内代理 src（bridge 媒体的 direct 无认证会 401）
      window.open(item.src || item.direct, "_blank", "noopener");
    } else if (item.link || item.post?.url) {
      window.open(item.link || item.post.url, "_blank", "noopener");
    } else {
      toast(t("media.noFileLink"), "error");
    }
    return;
  }
  openLightbox({
    ...item,
    messageUrl: item.link || item.post?.url,
    date: item.date,
  });
}
