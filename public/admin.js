/** 管理后台：初始化 / 登录 / 频道 / 常规 / 媒体 / 桥接 / 安全 */

import { api } from "./api.js";
import { el, clear, toast } from "./ui.js";

const TABS = [
  { key: "general", label: "常规" },
  { key: "channels", label: "频道" },
  { key: "media", label: "媒体" },
  { key: "bridge", label: "私密频道桥接" },
  { key: "security", label: "安全" },
];

export async function renderAdmin(root, ctx, tab = "general") {
  clear(root);
  root.classList.remove("wide");

  let state;
  try {
    state = await api.adminState();
    ctx.state.authenticated = state.authenticated;
    ctx.state.initialized = state.initialized;
  } catch (err) {
    root.append(el("div", { class: "errorbox", text: err.message }));
    return;
  }

  if (!state.initialized) return renderSetup(root, ctx);
  if (!state.authenticated) return renderLogin(root, ctx, state);

  const head = el("div", { class: "view-head" }, [
    el("div", {}, [
      el("h1", { text: "管理后台" }),
      el("div", { class: "sub" }, [
        `当前账号 ${state.username || "admin"}`,
        state.envManaged ? el("span", { class: "pill warn", style: { marginLeft: "8px" }, text: "环境变量管理" }) : null,
      ].filter(Boolean)),
    ]),
  ]);
  root.append(head);

  const tabs = el("div", { class: "tabs" });
  TABS.forEach((t) => tabs.append(el("a", { href: `#/admin/${t.key}`, class: t.key === tab ? "active" : "", text: t.label })));
  root.append(tabs);

  const body = el("div");
  root.append(body);

  try {
    const settings = await api.settings();
    ctx.state.settings = settings;
    if (tab === "channels") return renderChannels(body, ctx, settings);
    if (tab === "media") return renderMediaSettings(body, ctx, settings);
    if (tab === "bridge") return renderBridge(body, ctx, settings);
    if (tab === "security") return renderSecurity(body, ctx, settings);
    return renderGeneral(body, ctx, settings);
  } catch (err) {
    if (err.status === 401) {
      ctx.state.authenticated = false;
      return renderLogin(root, ctx, { initialized: true });
    }
    body.append(el("div", { class: "errorbox", text: err.message }));
  }
}

/* --------------------------------------------------------------- 初始化 */

/* --------------------------------------------------------- 人机验证（Turnstile） */

let turnstileScriptPromise = null;

function loadTurnstileScript() {
  if (typeof window !== "undefined" && window.turnstile) return Promise.resolve(window.turnstile);
  if (turnstileScriptPromise) return turnstileScriptPromise;
  turnstileScriptPromise = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    s.async = true;
    s.onload = () => resolve(window.turnstile);
    s.onerror = () => {
      turnstileScriptPromise = null;
      reject(new Error("验证脚本加载失败"));
    };
    document.head.appendChild(s);
  });
  return turnstileScriptPromise;
}

/**
 * 渲染人机验证组件。sitekey 来自 /api/config（服务端配置 TURNSTILE_SECRET 后才下发）；
 * 未配置时返回空实现，表单照常提交，后端同样跳过校验（前后端状态一致）。
 */
function turnstileField(ctx) {
  const sitekey = ctx?.state?.config?.turnstileSiteKey;
  const box = el("div", { class: "turnstile-box" });
  if (!sitekey) return { box, enabled: false, getToken: async () => "", reset: () => {} };

  let handle = null;
  let token = "";
  const ready = (async () => {
    try {
      const ts = await loadTurnstileScript();
      const id = ts.render(box, {
        sitekey,
        theme: document.documentElement.dataset.theme === "dark" ? "dark" : "auto",
        callback: (t) => { token = t; },
        "expired-callback": () => { token = ""; },
      });
      handle = { ts, id };
      return true;
    } catch (err) {
      box.append(el("div", { class: "hint", text: `人机验证组件加载失败：${err?.message || err}` }));
      return false;
    }
  })();

  return {
    box,
    enabled: true,
    getToken: async () => {
      await ready;
      return token;
    },
    reset: () => {
      token = "";
      if (handle) {
        try { handle.ts.reset(handle.id); } catch { /* ignore */ }
      }
    },
  };
}

function renderSetup(root, ctx) {
  const wrap = el("div", { class: "auth-wrap card" });
  wrap.append(el("h1", { text: "初始化管理员" }), el("div", { class: "hint", text: "首次访问请设置管理员账号；也可通过环境变量 ADMIN_USERNAME / ADMIN_PASSWORD 管理。" }));

  const username = field("用户名", { name: "username", value: "admin", autocomplete: "username" });
  const password = field("密码（至少 8 位）", { name: "password", type: "password", autocomplete: "new-password" });
  const confirm = field("确认密码", { name: "confirm", type: "password", autocomplete: "new-password" });
  const submit = el("button", { class: "btn primary", type: "submit", text: "创建并登录" });

  const tsSetup = turnstileField(ctx);
  const form = el("form", {}, [username.node, password.node, confirm.node, tsSetup.box, submit]);
  form.onsubmit = async (e) => {
    e.preventDefault();
    if (password.input.value !== confirm.input.value) return toast("两次密码不一致", "error");
    if (password.input.value.length < 8) return toast("密码至少 8 位", "error");
    submit.disabled = true;
    try {
      await api.setup({
        username: username.input.value || "admin",
        password: password.input.value,
        turnstileToken: await tsSetup.getToken(),
      });
      toast("初始化成功", "ok");
      ctx.state.authenticated = true;
      ctx.go("#/admin/general");
    } catch (err) {
      toast(err.message, "error");
      tsSetup.reset();
      submit.disabled = false;
    }
  };
  wrap.append(form);
  root.append(wrap);
}

function renderLogin(root, ctx, state) {
  const wrap = el("div", { class: "auth-wrap card" });
  wrap.append(el("h1", { text: "管理员登录" }), el("div", { class: "hint", text: "登录后可配置频道、隐藏策略与媒体模式。" }));

  const username = field("用户名", { name: "username", value: "admin", autocomplete: "username" });
  const password = field("密码", { name: "password", type: "password", autocomplete: "current-password" });
  const submit = el("button", { class: "btn primary", type: "submit", text: "登录" });

  const tsLogin = turnstileField(ctx);
  const form = el("form", {}, [username.node, password.node, tsLogin.box, submit]);
  form.onsubmit = async (e) => {
    e.preventDefault();
    submit.disabled = true;
    try {
      await api.login({
        username: username.input.value,
        password: password.input.value,
        turnstileToken: await tsLogin.getToken(),
      });
      toast("登录成功", "ok");
      ctx.state.authenticated = true;
      ctx.refreshAuth();
      ctx.go("#/admin/general");
    } catch (err) {
      toast(err.message, "error");
      tsLogin.reset();
      submit.disabled = false;
    }
  };
  wrap.append(form);

  if (state?.envManaged) {
    wrap.append(el("div", { class: "hint", text: "当前由环境变量 ADMIN_PASSWORD 管理账号密码。" }));
  }
  root.append(wrap);
}

/* ---------------------------------------------------------------- 常规 */

function renderGeneral(body, ctx, settings) {
  const g = settings.general;
  const card = el("div", { class: "card" });
  card.append(el("h2", { text: "站点设置" }));

  const title = field("站点标题", { value: g.siteTitle });
  const pageSize = field("每页消息数", { type: "number", value: g.pageSize, min: 5, max: 50 });
  const cacheTtl = field("抓取缓存（秒）", { type: "number", value: g.cacheTtl, min: 0, max: 3600 });
  const feedChannels = field("信息流并行频道数", { type: "number", value: g.feedChannels, min: 1, max: 8 });

  const grid = el("div", { class: "formgrid" }, [
    title.node, pageSize.node, cacheTtl.node, feedChannelNode(feedChannels),
  ]);

  const showViews = checkbox("显示浏览数", g.showViews);
  const showDate = checkbox("显示发布时间", g.showDate);
  const theme = field("主题", {
    type: "select",
    options: [
      { value: "auto", label: "跟随系统" },
      { value: "light", label: "浅色" },
      { value: "dark", label: "深色" },
    ],
    value: g.theme,
  });

  const opts = el("div", { style: { display: "grid", gap: "10px", margin: "6px 0 14px" } }, [
    showViews.node, showDate.node, theme.node,
  ]);

  const save = el("button", { class: "btn primary", type: "button", text: "保存设置" });
  save.onclick = async () => {
    save.disabled = true;
    try {
      await api.saveSettings({
        general: {
          siteTitle: title.input.value,
          pageSize: Number(pageSize.input.value),
          cacheTtl: Number(cacheTtl.input.value),
          feedChannels: Number(feedChannels.input.value),
          showViews: showViews.input.checked,
          showDate: showDate.input.checked,
          theme: theme.select.value,
        },
      });
      ctx.state.config = { ...ctx.state.config, siteTitle: title.input.value, theme: theme.select.value, showViews: showViews.input.checked, showDate: showDate.input.checked };
      document.getElementById("site-title").textContent = title.input.value;
      ctx.applyTheme(theme.select.value);
      toast("已保存", "ok");
    } catch (err) {
      toast(err.message, "error");
    } finally {
      save.disabled = false;
    }
  };

  card.append(grid, opts, save);
  body.append(card);
}

function feedChannelNode(f) { return f.node; }

/* ---------------------------------------------------------------- 频道 */

function renderChannels(body, ctx, settings) {
  const channels = (settings.channels || []).map((c) => ({ ...c }));
  const card = el("div", { class: "card" });
  const titleRow = el("div", { class: "card-title" }, [
    el("h2", { text: "频道列表" }),
    el("div", { class: "hint", text: "支持粘贴分享链接（t.me/xxx、t.me/s/xxx、tg://resolve?domain=xxx）；显示名优先于 Telegram 原名；「隐藏」的频道仅登录后可见" }),
  ]);
  card.append(titleRow);

  /* --- 新增表单 --- */
  const typeSel = el("select", { class: "select", style: { maxWidth: "140px" } }, [
    el("option", { value: "public", text: "公开频道" }),
    el("option", { value: "private", text: "私密频道" }),
  ]);
  const idInput = el("input", { class: "input", placeholder: "t.me/频道名 或 @telegram", autocomplete: "off" });
  const nameInput = el("input", { class: "input", placeholder: "显示名称（可选）", autocomplete: "off" });
  const testBtn = el("button", { class: "btn", type: "button", text: "测试" });
  const addBtn = el("button", { class: "btn primary", type: "button", text: "添加" });
  const testResult = el("div", { class: "hint", text: "" });

  function currentChannel() {
    return {
      type: typeSel.value,
      username: typeSel.value === "public" ? idInput.value.trim() : "",
      tgId: typeSel.value === "private" ? idInput.value.trim() : "",
      name: nameInput.value.trim(),
      hidden: false,
      mediaOnly: false,
      enabled: true,
    };
  }

  typeSel.onchange = () => {
    idInput.placeholder = typeSel.value === "public" ? "t.me/频道名 或 @telegram（可直接粘贴分享链接）" : "频道 ID，如 -1001234567890";
    testResult.textContent = "";
  };

  testBtn.onclick = async () => {
    testBtn.disabled = true;
    testBtn.textContent = "测试中…";
    testResult.textContent = "";
    try {
      const res = await api.testChannel(currentChannel());
      if (!res.ok) {
        testResult.textContent = `失败：${res.error}`;
        testResult.style.color = "var(--danger)";
      } else {
        const meta = res.meta || {};
        testResult.style.color = "var(--ok)";
        testResult.textContent = `成功：${meta.title || "未命名"}，最近 ${res.count} 条${meta.counters?.subscribers ? `，${meta.counters.subscribers} 订阅` : ""}`;
        if (!nameInput.value && meta.title) nameInput.value = meta.title;
      }
    } catch (err) {
      testResult.style.color = "var(--danger)";
      testResult.textContent = err.message;
    } finally {
      testBtn.disabled = false;
      testBtn.textContent = "测试";
    }
  };

  addBtn.onclick = () => {
    const ch = currentChannel();
    if (ch.type === "public" && !/^[A-Za-z0-9_]{4,64}$/.test(ch.username)) return toast("用户名不合法", "error");
    if (ch.type === "private" && !/^-?\d{5,25}$/.test(ch.tgId)) return toast("频道 ID 不合法", "error");
    if (!ch.name) ch.name = ch.type === "public" ? ch.username : ch.tgId;
    if (channels.some((c) => c.key === keyOf(ch))) return toast("频道已存在", "error");
    channels.push({ ...ch, key: keyOf(ch), order: channels.length });
    idInput.value = "";
    nameInput.value = "";
    testResult.textContent = "";
    drawTable();
  };

  const addBar = el("div", { style: { display: "flex", gap: "8px", flexWrap: "wrap", marginBottom: "8px" } }, [
    typeSel, idInput, nameInput, testBtn, addBtn,
  ]);
  addBar.style.flex = "1 1 auto";
  idInput.style.flex = "1 1 220px";
  nameInput.style.flex = "1 1 180px";
  card.append(addBar, testResult);

  const tableWrap = el("div", { style: { overflowX: "auto" } });
  card.append(tableWrap);

  function drawTable() {
    clear(tableWrap);
    if (!channels.length) {
      tableWrap.append(el("div", { class: "empty", text: "还没有频道，先在上方添加一个" }));
      return;
    }
    const table = el("table", { class: "table" });
    table.append(
      el("thead", {}, [
        el("tr", {}, [
          el("th", { text: "#" }), el("th", { text: "类型" }), el("th", { text: "标识" }),
          el("th", { text: "显示名" }), el("th", { text: "可见性" }), el("th", { text: "仅媒体" }),
          el("th", { text: "状态" }), el("th", { text: "操作" }),
        ]),
      ]),
    );
    const tbody = el("tbody");
    channels.forEach((ch, index) => {
      const nameCell = el("input", { class: "input", value: ch.name, style: { minWidth: "130px" } });
      nameCell.onchange = () => { ch.name = nameCell.value.trim() || ch.name; };

      const hiddenBtn = el("button", {
        class: `btn sm ${ch.hidden ? "danger" : ""}`,
        type: "button",
        text: ch.hidden ? "隐藏中" : "公开",
        title: "切换是否对未登录用户隐藏",
        onclick: () => { ch.hidden = !ch.hidden; drawTable(); },
      });
      const mediaBtn = el("button", {
        class: `btn sm ${ch.mediaOnly ? "" : ""}`,
        type: "button",
        text: ch.mediaOnly ? "是" : "否",
        onclick: () => { ch.mediaOnly = !ch.mediaOnly; drawTable(); },
      });
      const enabledBtn = el("button", {
        class: `btn sm ${ch.enabled === false ? "danger" : ""}`,
        type: "button",
        text: ch.enabled === false ? "停用" : "启用",
        onclick: () => { ch.enabled = ch.enabled === false; drawTable(); },
      });

      const row = el("tr", {}, [
        el("td", { text: String(index + 1) }),
        el("td", {}, [el("span", { class: `pill ${ch.type === "private" ? "warn" : ""}`, text: ch.type === "private" ? "私密" : "公开" })]),
        el("td", {}, [
          el("div", { text: ch.type === "public" ? `@${ch.username}` : ch.tgId, style: { fontFamily: "var(--mono)", fontSize: "13px" } }),
        ]),
        el("td", {}, [nameCell]),
        el("td", {}, [hiddenBtn]),
        el("td", {}, [mediaBtn]),
        el("td", {}, [enabledBtn]),
        el("td", {}, [
          el("div", { class: "row-actions" }, [
            el("button", { class: "btn sm", type: "button", text: "↑", title: "上移", onclick: () => move(index, -1) }),
            el("button", { class: "btn sm", type: "button", text: "↓", title: "下移", onclick: () => move(index, 1) }),
            el("button", {
              class: "btn sm", type: "button", text: "测试",
              onclick: async (e) => {
                const btn = e.currentTarget;
                btn.disabled = true;
                try {
                  const res = await api.testChannel(ch);
                  toast(res.ok ? `成功：${res.meta?.title || ch.name}` : `失败：${res.error}`, res.ok ? "ok" : "error");
                  if (res.ok && res.meta?.title && (!ch.name || ch.name === ch.username || ch.name === ch.tgId)) {
                    ch.name = res.meta.title;
                    drawTable();
                  }
                } catch (err) {
                  toast(err.message, "error");
                } finally {
                  btn.disabled = false;
                }
              },
            }),
            el("button", {
              class: "btn sm", type: "button", text: "刷新",
              onclick: async (e) => {
                const btn = e.currentTarget;
                btn.disabled = true;
                try {
                  await api.refreshChannel(ch.key);
                  await ctx.refreshChannels();
                  toast("已刷新频道元信息", "ok");
                } catch (err) {
                  toast(err.message, "error");
                } finally {
                  btn.disabled = false;
                }
              },
            }),
            el("button", {
              class: "btn sm danger", type: "button", text: "删除",
              onclick: () => { channels.splice(index, 1); drawTable(); },
            }),
          ]),
        ]),
      ]);
      tbody.append(row);
    });
    table.append(tbody);
    tableWrap.append(table);
  }

  function move(index, delta) {
    const target = index + delta;
    if (target < 0 || target >= channels.length) return;
    const [item] = channels.splice(index, 1);
    channels.splice(target, 0, item);
    drawTable();
  }

  drawTable();

  const saveBar = el("div", { style: { display: "flex", gap: "10px", marginTop: "14px" } });
  const saveBtn = el("button", { class: "btn primary", type: "button", text: "保存全部修改" });
  saveBtn.onclick = async () => {
    saveBtn.disabled = true;
    try {
      await api.saveSettings({ channels: channels.map((c, i) => ({ ...c, order: i })) });
      await ctx.refreshChannels();
      toast("频道设置已保存", "ok");
    } catch (err) {
      toast(err.message, "error");
    } finally {
      saveBtn.disabled = false;
    }
  };
  saveBar.append(saveBtn);
  card.append(saveBar);

  body.append(card);
}

function keyOf(ch) {
  if (ch.type === "public") return String(ch.username || "").replace(/^@/, "").toLowerCase();
  return `p${String(ch.tgId || "").replace(/^-/, "")}`;
}

/* ---------------------------------------------------------------- 媒体 */

function renderMediaSettings(body, ctx, settings) {
  const m = settings.media;
  const card = el("div", { class: "card" });
  card.append(el("h2", { text: "媒体模式" }), el("div", { class: "hint", text: "控制媒体页展示的分类；视频使用浏览器原生播放器。" }));

  const video = checkbox("视频", m.video);
  const image = checkbox("图片", m.image);
  const audio = checkbox("音频", m.audio);
  const file = checkbox("文件", m.file);
  const proxyAll = checkbox("媒体走站内代理（私密频道与防盗链需要）", m.proxyAll);
  const pageSize = field("每页媒体数", { type: "number", value: m.pageSize, min: 6, max: 60 });

  card.append(
    el("div", { style: { display: "grid", gap: "10px", margin: "6px 0 14px" } }, [
      video.node, image.node, audio.node, file.node, proxyAll.node,
    ]),
    pageSize.node,
  );

  const save = el("button", { class: "btn primary", type: "button", text: "保存媒体设置" });
  save.onclick = async () => {
    save.disabled = true;
    try {
      await api.saveSettings({
        media: {
          video: video.input.checked,
          image: image.input.checked,
          audio: audio.input.checked,
          file: file.input.checked,
          proxyAll: proxyAll.input.checked,
          pageSize: Number(pageSize.input.value),
        },
      });
      ctx.state.config = {
        ...ctx.state.config,
        media: { video: video.input.checked, image: image.input.checked, audio: audio.input.checked, file: file.input.checked, pageSize: Number(pageSize.input.value) },
      };
      toast("已保存", "ok");
    } catch (err) {
      toast(err.message, "error");
    } finally {
      save.disabled = false;
    }
  };
  card.append(save);
  body.append(card);
}

/* --------------------------------------------------------------- 桥接 */

function renderBridge(body, ctx, settings) {
  const b = settings.bridge;
  const card = el("div", { class: "card" });
  card.append(
    el("h2", { text: "私密频道桥接" }),
    el("div", {
      class: "hint",
      html: "用你自己的 Telegram 账号运行仓库内 <code>bridge/</code> 程序，TG-RSS 通过它读取私密频道。<br>桥接需公网可达（HTTPS 或内网穿透），Worker 通过 URL + Token 调用。",
    }),
  );

  const url = field("桥接地址（https://）", { value: b.url || "", placeholder: "https://bridge.example.com" });
  const token = field("访问令牌", { value: "", placeholder: b.hasToken ? "已设置（留空保持不变）" : "bridge/.env 中的 BRIDGE_TOKEN" });
  const enabled = checkbox("启用桥接", b.enabled);

  card.append(url.node, token.node, enabled.node);

  const status = el("div", { class: "hint" });
  status.textContent = b.fromEnv
    ? "当前使用环境变量 BRIDGE_URL / BRIDGE_TOKEN（优先级高于此处配置）。"
    : b.hasToken ? "已保存令牌。" : "尚未设置令牌。";
  card.append(status);

  const row = el("div", { style: { display: "flex", gap: "10px", marginTop: "12px", flexWrap: "wrap" } });
  const save = el("button", { class: "btn primary", type: "button", text: "保存桥接设置" });
  const ping = el("button", { class: "btn", type: "button", text: "连通性测试" });
  row.append(save, ping);
  card.append(row);

  save.onclick = async () => {
    save.disabled = true;
    try {
      const body2 = { bridge: { url: url.input.value.trim(), enabled: enabled.input.checked } };
      if (token.input.value) body2.bridge.token = token.input.value;
      await api.saveSettings(body2);
      toast("已保存", "ok");
    } catch (err) {
      toast(err.message, "error");
    } finally {
      save.disabled = false;
    }
  };

  ping.onclick = async () => {
    ping.disabled = true;
    ping.textContent = "测试中…";
    try {
      const res = await api.testChannel({ type: "private", tgId: "-1000000000000", name: "ping" });
      if (res.ok) toast("桥接可达", "ok");
      else toast(`桥接不可用：${res.error}`, "error");
    } catch (err) {
      toast(err.message, "error");
    } finally {
      ping.disabled = false;
      ping.textContent = "连通性测试";
    }
  };

  body.append(card);
}

/* --------------------------------------------------------------- 安全 */

function renderSecurity(body, ctx, settings) {
  const card = el("div", { class: "card" });
  card.append(el("h2", { text: "修改密码" }));

  if (settings.credential?.source === "env") {
    card.append(el("div", { class: "hint", text: "账号密码由环境变量 ADMIN_PASSWORD 管理，请修改环境变量后重新部署。" }));
    body.append(card);
  } else {
    const cur = field("当前密码", { type: "password", autocomplete: "current-password" });
    const next = field("新密码（至少 8 位）", { type: "password", autocomplete: "new-password" });
    const save = el("button", { class: "btn primary", type: "button", text: "修改密码" });
    const tsPw = turnstileField(ctx);
    save.onclick = async () => {
      save.disabled = true;
      try {
        await api.changePassword({
          currentPassword: cur.input.value,
          newPassword: next.input.value,
          turnstileToken: await tsPw.getToken(),
        });
        toast("密码已修改，请重新登录", "ok");
        ctx.state.authenticated = false;
        setTimeout(() => ctx.go("#/admin"), 700);
      } catch (err) {
        toast(err.message, "error");
        tsPw.reset();
      } finally {
        save.disabled = false;
      }
    };
    card.append(cur.node, next.node, tsPw.box, save);
    body.append(card);
  }

  const info = el("div", { class: "card" });
  info.append(el("h2", { text: "会话" }));
  const logout = el("button", { class: "btn danger", type: "button", text: "退出登录" });
  logout.onclick = async () => {
    try {
      await api.logout();
    } catch { /* ignore */ }
    ctx.state.authenticated = false;
    ctx.refreshAuth();
    toast("已退出登录", "ok");
    ctx.go("#/admin");
  };
  info.append(el("div", { class: "hint", text: "会话保存在 KV 中，有效期 7 天。" }), logout);
  body.append(info);
}

/* ---------------------------------------------------------------- 工具 */

function field(label, opts = {}) {
  const id = `f_${Math.random().toString(36).slice(2, 9)}`;
  let control;
  if (opts.type === "select") {
    control = el("select", { class: "select", id });
    (opts.options || []).forEach((o) => {
      const opt = el("option", { value: o.value, text: o.label });
      if (String(o.value) === String(opts.value)) opt.selected = true;
      control.append(opt);
    });
  } else {
    control = el("input", {
      class: "input",
      id,
      type: opts.type || "text",
      value: opts.value ?? "",
      placeholder: opts.placeholder || "",
      autocomplete: opts.autocomplete || "off",
      min: opts.min,
      max: opts.max,
    });
  }
  const node = el("div", { class: "field" }, [el("label", { for: id, text: label }), control]);
  return { node, input: control, select: control };
}

function checkbox(label, checked) {
  const input = el("input", { type: "checkbox", checked: !!checked });
  const node = el("label", { class: "checkbox" }, [input, label]);
  return { node, input };
}
