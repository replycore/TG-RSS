/** DOM 工具、格式化、消息卡片渲染、灯箱播放器 */

import { api } from "./api.js";

/* ------------------------------------------------------------ DOM 基础 */

export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "html") node.innerHTML = value; // 仅用于服务端已清洗的 HTML
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key === "style") Object.assign(node.style, value);
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value === true) node.setAttribute(key, "");
    else node.setAttribute(key, String(value));
  }
  const list = Array.isArray(children) ? children : [children];
  for (const child of list) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function fragment(children = []) {
  const f = document.createDocumentFragment();
  children.filter(Boolean).forEach((c) => f.append(c.nodeType ? c : String(c)));
  return f;
}

/* -------------------------------------------------------------- 提示条 */

let toastTimer = null;
export function toast(message, type = "") {
  const node = document.getElementById("toast");
  if (!node) return;
  node.textContent = message;
  node.className = `toast ${type}`.trim();
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, 3200);
}

/* -------------------------------------------------------------- 格式化 */

export function fmtDate(value) {
  if (!value) return "";
  const t = Date.parse(value);
  if (Number.isNaN(t)) return "";
  const diff = Date.now() - t;
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return "刚刚";
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 7 * day) return `${Math.floor(diff / day)} 天前`;
  const d = new Date(t);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function fmtDateTime(value) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function initials(name) {
  const s = String(name || "?").trim();
  return (s[0] || "?").toUpperCase();
}

export function avatarNode(url, name, cls = "avatar") {
  if (url) return el("img", { class: cls, src: url, alt: name || "", loading: "lazy" });
  return el("span", { class: `${cls} fallback`, text: initials(name) });
}

/* -------------------------------------------------------------- 灯箱 */

export function closeLightbox() {
  const box = document.getElementById("lightbox");
  if (!box) return;
  box.hidden = true;
  clear(box);
  document.body.style.overflow = "";
}

/**
 * 原生播放器灯箱：<video>/<audio> 使用浏览器默认播放器，<img> 直接查看。
 */
export function openLightbox(item) {
  const box = document.getElementById("lightbox");
  if (!box || !item) return;
  clear(box);
  document.body.style.overflow = "hidden";
  box.hidden = false;

  const inner = el("div", { class: "lb-inner" });
  const src = item.src || item.direct;
  const direct = item.direct || src;

  if (item.type === "video" && src) {
    inner.append(
      el("video", {
        controls: true,
        autoplay: true,
        playsinline: true,
        preload: "auto",
        src,
        poster: item.thumb || undefined,
      }),
    );
  } else if (item.type === "audio" && src) {
    inner.append(el("audio", { controls: true, autoplay: true, preload: "auto", src }));
  } else if (src) {
    inner.append(el("img", { src, alt: item.name || "" }));
  }

  const bar = el("div", { class: "lb-bar" });
  if (item.name) bar.append(el("span", { text: item.name }));
  if (item.size) bar.append(el("span", { text: item.size }));
  if (item.date) bar.append(el("span", { text: fmtDateTime(item.date) }));
  if (direct) {
    bar.append(
      el("button", {
        class: "btn sm",
        type: "button",
        text: "新窗口打开",
        onclick: () => window.open(direct, "_blank", "noopener"),
      }),
    );
  }
  const lbDl = downloadBtn({ ...item, src, direct });
  if (lbDl) bar.append(lbDl);
  if (item.messageUrl) {
    bar.append(
      el("a", { class: "btn sm", href: item.messageUrl, target: "_blank", rel: "noopener", text: "原文" }),
    );
  }
  inner.append(bar);
  box.append(inner);
  box.append(
    el("button", { class: "lb-close", type: "button", "aria-label": "关闭", text: "×", onclick: closeLightbox }),
  );
  box.onclick = (e) => { if (e.target === box) closeLightbox(); };
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeLightbox();
});

/* ------------------------------------------------------------ 标签链接化 */

/** 把正文文本节点里的 #话题 转成可点的筛选链接（已在 a/button 里的不再处理） */
function linkifyTags(container, onTag) {
  // 手动递归收集文本节点：不依赖 NodeFilter，兼容各种 DOM 实现
  const nodes = [];
  const walk = (node) => {
    for (const child of node.childNodes || []) {
      if (child.nodeType === 3) {
        if (child.nodeValue && child.nodeValue.includes("#")) nodes.push(child);
      } else if (child.nodeType === 1) {
        if (child.closest && child.closest("a, button")) continue;
        walk(child);
      }
    }
  };
  walk(container);
  const re = /(^|[\s(（【[{"'])#([\p{L}\p{N}_]{1,32})/gu;
  for (const node of nodes) {
    const raw = node.nodeValue;
    re.lastIndex = 0;
    if (!re.test(raw)) continue;
    re.lastIndex = 0;
    const frag = document.createDocumentFragment();
    let last = 0;
    let m;
    while ((m = re.exec(raw)) !== null) {
      frag.append(raw.slice(last, m.index + m[1].length));
      const tag = m[2];
      frag.append(
        el("a", {
          class: "taglink",
          href: `#/?tag=${encodeURIComponent(tag)}`,
          text: `#${tag}`,
          onclick: (e) => {
            e.preventDefault();
            onTag(tag);
          },
        }),
      );
      last = m.index + m[0].length;
    }
    frag.append(raw.slice(last));
    node.replaceWith(frag);
  }
}

/* --------------------------------------------------------------- 下载 */

function b64url(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * 下载链接：一律走 /api/media/proxy?...&dl=1（服务端回 Content-Disposition: attachment），
 * 这样跨域地址（CDN / 桥接）也能触发浏览器下载并带正确文件名。
 */
export function downloadHref(item) {
  if (!item) return null;
  const name = item.name || "";
  const suffix = name ? `&name=${encodeURIComponent(name)}` : "";
  const proxySrc = typeof item.src === "string" && item.src.startsWith("/api/media/proxy?") ? item.src : null;
  if (proxySrc) return `${proxySrc}&dl=1${suffix}`;
  const target = item.direct || (typeof item.src === "string" && /^https?:/.test(item.src) ? item.src : null);
  if (!target) return null;
  return `/api/media/proxy?u=${b64url(target)}&dl=1${suffix}`;
}

/** 下载按钮（没有可用地址时返回 null，由调用方决定是否跳过） */
export function downloadBtn(item, label = "下载") {
  const href = downloadHref(item);
  if (!href) return null;
  return el("a", { class: "btn sm", href, download: "", text: label, title: "下载文件" });
}

/* ------------------------------------------------------- 单条消息渲染 */

export function renderPost(post, ctx = {}) {
  const config = ctx.config || {};
  const article = el("article", { class: "post" });

  const head = el("div", { class: "post-head" });
  const channelName = post.channelName || post.channel;
  if (channelName) head.append(el("a", { class: "ch", href: `#/c/${encodeURIComponent(post.channelKey || post.channel)}`, text: channelName }));
  if (config.showDate !== false && post.date) head.append(el("span", { class: "sep", text: "·" }), el("time", { datetime: post.date, text: fmtDate(post.date) }));
  if (config.showViews && post.views) head.append(el("span", { class: "sep", text: "·" }), el("span", { text: `${post.views} 浏览` }));
  if (post.comments) head.append(el("span", { class: "sep", text: "·" }), el("span", { text: `${post.comments} 评论` }));
  article.append(head);

  if (post.author && post.author.name) {
    article.append(el("div", { class: "muted", style: { fontSize: "13px", marginBottom: "4px" }, text: `转发自 ${post.author.name}` }));
  }

  if (post.textHtml) {
    const textNode = el("div", { class: "post-text", html: post.textHtml });
    article.append(textNode);
    // 提供了标签筛选回调（信息流）时，把正文里的 #话题 变成可点的筛选入口
    if (ctx && typeof ctx.onTagClick === "function") linkifyTags(textNode, ctx.onTagClick);
  }

  const media = post.media || [];
  if (media.length) {
    const wrap = el("div", { class: `media ${media.length === 1 ? "media-1" : "media-n"}` });
    media.forEach((m, index) => wrap.append(renderMediaItem(m, post, index, ctx)));
    article.append(wrap);
  }

  const foot = el("div", { class: "post-foot" });
  if (post.url) {
    foot.append(el("a", { href: post.url, target: "_blank", rel: "noopener", text: "在 Telegram 查看" }));
  }
  article.append(foot);
  return article;
}

function renderMediaItem(item, post, index, ctx) {
  if (item.type === "video") return renderVideo(item, post, ctx);
  if (item.type === "image") return renderImage(item, post);
  if (item.type === "audio") return renderAudio(item, post);
  return renderFile(item, post, index);
}

function renderVideo(item, post, ctx) {
  const box = el("div", { class: "media-item" });
  const src = item.src || item.direct;
  if (!src) return box;
  const video = el("video", {
    controls: true,
    preload: "metadata",
    playsinline: true,
    src,
    poster: item.thumb || undefined,
  });
  box.append(video);
  const bar = el("div", { class: "media-inline" });
  bar.append(
    el("div", { class: "meta" }, [
      el("div", { class: "title", text: "视频" }),
      el("div", { class: "sub", text: [item.duration, item.size].filter(Boolean).join(" · ") || "浏览器原生播放器" }),
    ]),
  );
  const actions = el("div", { class: "actions" });
  actions.append(
    el("button", {
      class: "btn sm",
      type: "button",
      text: "全屏播放",
      onclick: () => openLightbox({ ...item, date: post.date, messageUrl: post.url }),
    }),
  );
  if (item.direct) {
    actions.append(
      el("button", {
        class: "btn sm",
        type: "button",
        text: "新窗口",
        title: "调用浏览器/系统默认播放器",
        onclick: () => window.open(item.direct, "_blank", "noopener"),
      }),
    );
  }
  const videoDl = downloadBtn(item);
  if (videoDl) actions.append(videoDl);
  bar.append(actions);
  box.append(bar);
  return box;
}

function renderImage(item, post) {
  const box = el("div", { class: "media-item" });
  const src = item.thumbSrc || item.thumb || item.src || item.direct;
  if (src) {
    const img = el("img", { class: "thumb", src, alt: "", loading: "lazy" });
    const open = () => openLightbox({ ...item, type: "image", src: item.src || item.direct, date: post.date, messageUrl: post.url });
    img.onclick = open;
    box.append(img);
    // 图片本身即可点击放大：操作行只放「查看大图 / 下载」，不再叠加播放键图标
    const actions = el("div", { class: "media-actions" }, [
      el("button", { class: "btn sm", type: "button", text: "查看大图", onclick: open }),
    ]);
    const imgDl = downloadBtn(item);
    if (imgDl) actions.append(imgDl);
    box.append(actions);
  }
  return box;
}

function renderAudio(item, post) {
  const src = item.src || item.direct;
  const box = el("div", { class: "media-item" });
  const wrap = el("div", { class: "media-inline", style: { display: "grid", gap: "8px" } });
  wrap.append(
    el("div", { class: "meta" }, [
      el("div", { class: "title", text: item.name || "音频" }),
      el("div", { class: "sub", text: [item.duration, item.size].filter(Boolean).join(" · ") || "音频" }),
    ]),
  );
  if (src) wrap.append(el("audio", { controls: true, preload: "none", src }));
  const audioDl = downloadBtn(item);
  if (audioDl) wrap.append(el("div", { class: "media-actions" }, [audioDl]));
  box.append(wrap);
  return box;
}

function renderFile(item, post, index) {
  const box = el("div", { class: "media-item" });
  const wrap = el("div", { class: "filecard" });
  const ext = (item.name || "file").split(".").pop().slice(0, 4);
  wrap.append(el("div", { class: "ico", text: ext }));
  wrap.append(
    el("div", { class: "info" }, [
      el("div", { class: "nm", text: item.name || "文件" }),
      el("div", { class: "sz", text: item.size || "" }),
    ]),
  );

  const actions = el("div", { class: "row-actions" });
  // 私密频道（桥接）或已解析出直链时直接打开；公开频道预览页无直链，需要按需解析
  if (item.direct || item.src) {
    actions.append(
      el("a", {
        class: "btn sm",
        href: item.direct || item.src,
        target: "_blank",
        rel: "noopener",
        text: "打开",
      }),
    );
    const fileDl = downloadBtn(item);
    if (fileDl) actions.append(fileDl);
  } else if (post.channelKey && post.key) {
    actions.append(
      el("button", {
        class: "btn sm",
        type: "button",
        text: "获取文件",
        onclick: async (e) => {
          const btn = e.currentTarget;
          btn.disabled = true;
          btn.textContent = "解析中…";
          try {
            const info = await api.doc({ key: post.channelKey, post: post.postId, i: index });
            if (info.url) {
              window.open(info.url, "_blank", "noopener");
            } else if (info.link) {
              window.open(info.link, "_blank", "noopener");
            }
          } catch (err) {
            toast(err.message || "解析失败", "error");
          } finally {
            btn.disabled = false;
            btn.textContent = "获取文件";
          }
        },
      }),
    );
  }
  if (item.link || post.url) {
    actions.append(
      el("a", { class: "btn sm", href: item.link || post.url, target: "_blank", rel: "noopener", text: "原文" }),
    );
  }
  wrap.append(actions);
  box.append(wrap);
  return box;
}

/**
 * 「加载更多」控件：直接持有 button 引用，避免反复 querySelector 产生空引用。
 */
export function createMoreControls(onClick) {
  const button = el("button", { class: "btn", type: "button", text: "加载更多", onclick: onClick });
  const node = el("div", { class: "loadmore" }, [button]);
  return {
    node,
    button,
    setState({ disabled = false, label } = {}) {
      button.disabled = !!disabled;
      if (label) button.textContent = label;
    },
    mount(container) {
      clear(container).append(node);
      return node;
    },
  };
}
