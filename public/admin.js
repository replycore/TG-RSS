/** 管理后台：初始化 / 登录 / 频道 / 常规 / 媒体 / 桥接 / 安全 */

import { api } from "./api.js";
import { el, clear, toast } from "./ui.js";
import { t, reg } from "./i18n.js";

reg("adm", {
tabGeneral: { zh: "常规", en: "General" },
tabChannels: { zh: "频道", en: "Channels" },
tabMedia: { zh: "媒体", en: "Media" },
tabBridge: { zh: "私密频道桥接", en: "Private Channel Bridge" },
tabSecurity: { zh: "安全", en: "Security" },
adminTitle: { zh: "管理后台", en: "Admin" },
curAccount: { zh: "当前账号 {u}", en: "Current account: {u}" },
envManaged: { zh: "环境变量管理", en: "Env-managed" },
tsLoadFail: { zh: "验证脚本加载失败", en: "Failed to load verification script" },
tsCompFail: { zh: "人机验证组件加载失败：{e}", en: "Failed to load verification widget: {e}" },
setupTitle: { zh: "初始化管理员", en: "Initialize Admin" },
setupHint: { zh: "首次访问请设置管理员账号；也可通过环境变量 ADMIN_USERNAME / ADMIN_PASSWORD 管理。", en: "Set up the admin account on first visit; you can also manage it via ADMIN_USERNAME / ADMIN_PASSWORD env vars." },
fUsername: { zh: "用户名", en: "Username" },
fPassword8: { zh: "密码（至少 8 位）", en: "Password (min 8 chars)" },
fConfirm: { zh: "确认密码", en: "Confirm password" },
fSetupCode: { zh: "初始化口令（服务端设置了 SETUP_CODE 才需要填）", en: "Setup code (only needed if server set SETUP_CODE)" },
btnCreateLogin: { zh: "创建并登录", en: "Create & Log In" },
errPwMismatch: { zh: "两次密码不一致", en: "Passwords do not match" },
errPwShort: { zh: "密码至少 8 位", en: "Password must be at least 8 chars" },
okSetupDone: { zh: "初始化成功", en: "Initialized" },
loginTitle: { zh: "管理员登录", en: "Admin Login" },
loginHint: { zh: "登录后可配置频道、隐藏策略与媒体模式。", en: "After login you can configure channels, hiding rules and media mode." },
fPassword: { zh: "密码", en: "Password" },
btnLogin: { zh: "登录", en: "Log In" },
okLogin: { zh: "登录成功", en: "Logged in" },
hintEnvPw: { zh: "当前由环境变量 ADMIN_PASSWORD 管理账号密码。", en: "Credentials are currently managed by the ADMIN_PASSWORD env var." },
siteSettings: { zh: "站点设置", en: "Site Settings" },
fSiteTitle: { zh: "站点标题", en: "Site title" },
fPageSize: { zh: "每页消息数", en: "Messages per page" },
fCacheTtl: { zh: "抓取缓存（秒）", en: "Fetch cache (seconds)" },
fFeedCh: { zh: "信息流并行频道数", en: "Feed parallel channels" },
cbViews: { zh: "显示浏览数", en: "Show view counts" },
cbDate: { zh: "显示发布时间", en: "Show publish time" },
fTheme: { zh: "主题", en: "Theme" },
themeAuto: { zh: "跟随系统", en: "System" },
themeLight: { zh: "浅色", en: "Light" },
themeDark: { zh: "深色", en: "Dark" },
btnSaveSettings: { zh: "保存设置", en: "Save Settings" },
okSaved: { zh: "已保存", en: "Saved" },
fAdTags: { zh: "自定义广告标签（逗号 / 空格 / 换行分隔）", en: "Custom ad tags (comma / space / newline separated)" },
phAdTags: { zh: "如：福利, 返利, coupon", en: "e.g.: 福利, 返利, coupon" },
adFilter: { zh: "广告过滤", en: "Ad Filtering" },
adHint: { zh: "帖子正文带任一标签即全局隐藏（信息流 / 频道页 / RSS 均不投放）。内置标签不可删，自定义标签与内置取并集判定。", en: "Posts containing any tag are hidden globally (feed / channel pages / RSS). Built-in tags cannot be removed; custom tags are unioned with built-ins." },
adBuiltin: { zh: "内置标签：{tags}", en: "Built-in tags: {tags}" },
chList: { zh: "频道列表", en: "Channels" },
chHint: { zh: "支持粘贴分享链接（t.me/xxx、t.me/s/xxx、tg://resolve?domain=xxx）；显示名优先于 Telegram 原名；「隐藏」的频道仅登录后可见", en: "Paste share links (t.me/xxx, t.me/s/xxx, tg://resolve?domain=xxx); display name overrides the Telegram name; “hidden” channels are visible only after login" },
optPublic: { zh: "公开频道", en: "Public channel" },
optPrivate: { zh: "私密频道", en: "Private channel" },
phPublic: { zh: "t.me/频道名 或 @telegram", en: "t.me/name or @telegram" },
phName: { zh: "显示名称（可选）", en: "Display name (optional)" },
btnTest: { zh: "测试", en: "Test" },
btnAdd: { zh: "添加", en: "Add" },
phPublicLong: { zh: "t.me/频道名 或 @telegram（可直接粘贴分享链接）", en: "t.me/name or @telegram (share links OK)" },
phPrivate: { zh: "频道 ID，如 -1001234567890", en: "Channel ID, e.g. -1001234567890" },
testing: { zh: "测试中…", en: "Testing…" },
testFail: { zh: "失败：{e}", en: "Failed: {e}" },
untitled: { zh: "未命名", en: "Untitled" },
testOk: { zh: "成功：{title}，最近 {n} 条{sub}", en: "OK: {title}, latest {n} posts{sub}" },
testSubs: { zh: "，{n} 订阅", en: ", {n} subscribers" },
errBadUsername: { zh: "用户名或分享链接不合法", en: "Invalid username or share link" },
errBadId: { zh: "频道 ID 不合法", en: "Invalid channel ID" },
errDup: { zh: "频道已存在", en: "Channel already exists" },
emptyCh: { zh: "还没有频道，先在上方添加一个", en: "No channels yet — add one above" },
thType: { zh: "类型", en: "Type" },
thId: { zh: "标识", en: "ID" },
thName: { zh: "显示名", en: "Name" },
thVis: { zh: "可见性", en: "Visibility" },
thMedia: { zh: "仅媒体", en: "Media-only" },
thStatus: { zh: "状态", en: "Status" },
thOps: { zh: "操作", en: "Actions" },
visHidden: { zh: "隐藏中", en: "Hidden" },
visPublic: { zh: "公开", en: "Public" },
tipHidden: { zh: "切换是否对未登录用户隐藏", en: "Toggle hiding from logged-out users" },
mediaYes: { zh: "是", en: "Yes" },
mediaNo: { zh: "否", en: "No" },
tipMedia: { zh: "「是」= 该频道在信息流/频道页只显示带媒体的帖子（纯文字不显示）", en: "“Yes” = only posts with media are shown in feed/channel pages (text-only hidden)" },
stDisabled: { zh: "停用", en: "Disabled" },
stEnabled: { zh: "启用", en: "Enabled" },
pillPrivate: { zh: "私密", en: "Private" },
pillPublic: { zh: "公开", en: "Public" },
tipUp: { zh: "上移", en: "Move up" },
tipDown: { zh: "下移", en: "Move down" },
rowRefresh: { zh: "刷新", en: "Refresh" },
rowDelete: { zh: "删除", en: "Delete" },
testOkShort: { zh: "成功：{tt}", en: "OK: {tt}" },
okChRefreshed: { zh: "已刷新频道元信息", en: "Channel info refreshed" },
btnSaveAll: { zh: "保存全部修改", en: "Save All Changes" },
okChSaved: { zh: "频道设置已保存", en: "Channel settings saved" },
mediaMode: { zh: "媒体模式", en: "Media Mode" },
mediaHint: { zh: "控制媒体页展示的分类；视频使用浏览器原生播放器。", en: "Controls categories shown on the media page; videos use the native browser player." },
cbVideo: { zh: "视频", en: "Videos" },
cbImage: { zh: "图片", en: "Images" },
cbAudio: { zh: "音频", en: "Audio" },
cbFile: { zh: "文件", en: "Files" },
cbProxy: { zh: "媒体走站内代理（私密频道恒走代理；此开关只控制公开频道）", en: "Proxy media via this site (private channels always proxied; this only affects public ones)" },
fMediaPage: { zh: "每页媒体数", en: "Media items per page" },
btnSaveMedia: { zh: "保存媒体设置", en: "Save Media Settings" },
bridgeHintHtml: { zh: "用你自己的 Telegram 账号运行仓库内 <code>bridge/</code> 程序，TG-RSS 通过它读取私密频道。<br>桥接需公网可达（HTTPS 或内网穿透），Worker 通过 URL + Token 调用。", en: "Run the <code>bridge/</code> program in this repo with your own Telegram account so TG-RSS can read private channels.<br>The bridge must be publicly reachable (HTTPS or tunnel); the Worker calls it via URL + Token." },
fBridgeUrl: { zh: "桥接地址（https://）", en: "Bridge URL (https://)" },
fToken: { zh: "访问令牌", en: "Access token" },
phTokenSet: { zh: "已设置（留空保持不变）", en: "Set (leave blank to keep)" },
phTokenUnset: { zh: "bridge/.env 中的 BRIDGE_TOKEN", en: "BRIDGE_TOKEN in bridge/.env" },
cbBridge: { zh: "启用桥接", en: "Enable bridge" },
stFromEnv: { zh: "当前使用环境变量 BRIDGE_URL / BRIDGE_TOKEN（优先级高于此处配置）。", en: "Currently using BRIDGE_URL / BRIDGE_TOKEN env vars (they override settings here)." },
stHasToken: { zh: "已保存令牌。", en: "Token saved." },
stNoToken: { zh: "尚未设置令牌。", en: "No token set yet." },
btnSaveBridge: { zh: "保存桥接设置", en: "Save Bridge Settings" },
btnPing: { zh: "连通性测试", en: "Connectivity Test" },
okBridge: { zh: "桥接可达", en: "Bridge reachable" },
bridgeDown: { zh: "桥接不可用：{e}", en: "Bridge unavailable: {e}" },
pwTitle: { zh: "修改密码", en: "Change Password" },
hintEnvCred: { zh: "账号密码由环境变量 ADMIN_PASSWORD 管理，请修改环境变量后重新部署。", en: "Credentials are managed by the ADMIN_PASSWORD env var; edit it and redeploy." },
fCurPw: { zh: "当前密码", en: "Current password" },
fNewPw: { zh: "新密码（至少 8 位）", en: "New password (min 8 chars)" },
btnChangePw: { zh: "修改密码", en: "Change Password" },
okPwChanged: { zh: "密码已修改，请重新登录", en: "Password changed, please log in again" },
sessTitle: { zh: "会话", en: "Session" },
btnLogout: { zh: "退出登录", en: "Log Out" },
okLogout: { zh: "已退出登录", en: "Logged out" },
sessHint: { zh: "会话保存在 KV 中，有效期 7 天。", en: "Sessions are stored in KV, valid for 7 days." },
rssTitle: { zh: "RSS 订阅令牌", en: "RSS Subscription Token" },
rssHint: { zh: "启用后在订阅链接后加 ?token=…（或请求头 Authorization: Bearer …）即可读取私密/隐藏频道；不带令牌的源只含公开频道。令牌只存哈希，明文仅生成时显示一次，可随时轮换（旧链接立即失效）或吊销。", en: "After enabling, append ?token=… to feed URLs (or use header Authorization: Bearer …) to read private/hidden channels; feeds without a token only include public channels. Only the hash is stored; plaintext is shown once at generation. You can rotate (old links die immediately) or revoke anytime." },
fRssUrl: { zh: "订阅链接（含令牌）", en: "Subscription URL (with token)" },
phNoToken: { zh: "尚未生成令牌", en: "No token generated yet" },
btnGenToken: { zh: "生成 / 轮换令牌", en: "Generate / Rotate Token" },
btnCopy: { zh: "复制链接", en: "Copy Link" },
btnRevoke: { zh: "吊销", en: "Revoke" },
rssEnabled: { zh: "状态：已启用（{m}）", en: "Status: enabled ({m})" },
stDisabledRss: { zh: "状态：未启用 —— 公开源正常，需要读取私密频道时先生成令牌", en: "Status: disabled — public feeds work; generate a token to read private channels" },
stReadFail: { zh: "状态读取失败：{e}", en: "Failed to read status: {e}" },
okGenToken: { zh: "已生成，明文仅此一次，请立即复制保存", en: "Generated — plaintext shown only once, copy and save it now" },
errNeedToken: { zh: "请先生成令牌", en: "Generate a token first" },
okCopied: { zh: "已复制订阅链接", en: "Subscription link copied" },
errCopyManual: { zh: "已选中，请手动复制", en: "Selected — please copy manually" },
okRevoked: { zh: "令牌已吊销，旧链接立即失效", en: "Token revoked, old links are invalid immediately" },
rssSingleHint: { zh: "单频道源：把链接换成 /api/rss?channel=<频道key>&token=…；私密频道保存时会自动强制为「隐藏」。", en: "Per-channel feed: swap the link to /api/rss?channel=<channel key>&token=…; private channels are forced to “hidden” on save." },
});


const TABS = [
  { key: "general", label: t("adm.tabGeneral") },
  { key: "channels", label: t("adm.tabChannels") },
  { key: "media", label: t("adm.tabMedia") },
  { key: "bridge", label: t("adm.tabBridge") },
  { key: "security", label: t("adm.tabSecurity") },
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
      el("h1", { text: t("adm.adminTitle") }),
      el("div", { class: "sub" }, [
        t("adm.curAccount", { u: state.username || "admin" }),
        state.envManaged ? el("span", { class: "pill warn", style: { marginLeft: "8px" }, text: t("adm.envManaged") }) : null,
      ].filter(Boolean)),
    ]),
  ]);
  root.append(head);

  const tabs = el("div", { class: "tabs" });
  const links = {};
  TABS.forEach((tb) => {
    links[tb.key] = el("a", {
      href: `#/admin/${tb.key}`,
      class: tb.key === tab ? "active" : "",
      text: tb.label,
      // Tab 切换不经过 hash 路由：只重绘下方 body 区，已拉取的 settings 复用，
      // 不再整页清空 + 重拉 adminState/settings（解决每次切 tab 都"刷新一次"的问题）
      onclick: (e) => {
        e.preventDefault();
        if (currentTab === tb.key) return;
        // 直接切 URL（replaceState 不触发 hashchange），保证刷新/后退回到该 tab
        try { history.replaceState(null, "", `#/admin/${tb.key}`); } catch { /* 非浏览器环境忽略 */ }
        switchTab(tb.key);
      },
    });
    tabs.append(links[tb.key]);
  });
  root.append(tabs);

  const body = el("div");
  root.append(body);

  let currentTab = tab;
  let settings = null;

  function renderBody() {
    clear(body);
    if (currentTab === "channels") return renderChannels(body, ctx, settings);
    if (currentTab === "media") return renderMediaSettings(body, ctx, settings);
    if (currentTab === "bridge") return renderBridge(body, ctx, settings);
    if (currentTab === "security") return renderSecurity(body, ctx, settings);
    return renderGeneral(body, ctx, settings);
  }

  function switchTab(key) {
    currentTab = key;
    for (const [k, link] of Object.entries(links)) link.classList.toggle("active", k === key);
    try {
      renderBody();
    } catch (err) {
      body.append(el("div", { class: "errorbox", text: err.message }));
    }
  }

  try {
    settings = await api.settings();
    ctx.state.settings = settings;
    renderBody();
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
      reject(new Error(t("adm.tsLoadFail")));
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
        callback: (tok) => { token = tok; },
        "expired-callback": () => { token = ""; },
      });
      handle = { ts, id };
      return true;
    } catch (err) {
      box.append(el("div", { class: "hint", text: t("adm.tsCompFail", { e: err?.message || err }) }));
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
  wrap.append(el("h1", { text: t("adm.setupTitle") }), el("div", { class: "hint", text: t("adm.setupHint") }));

  const username = field(t("adm.fUsername"), { name: "username", value: "admin", autocomplete: "username" });
  const password = field(t("adm.fPassword8"), { name: "password", type: "password", autocomplete: "new-password" });
  const confirm = field(t("adm.fConfirm"), { name: "confirm", type: "password", autocomplete: "new-password" });
  // L-6：若服务端设置了环境变量 SETUP_CODE，初始化需带此口令；未设置则留空即可
  const setupCode = field(t("adm.fSetupCode"), { name: "code", type: "password", autocomplete: "off" });
  const submit = el("button", { class: "btn primary", type: "submit", text: t("adm.btnCreateLogin") });

  const tsSetup = turnstileField(ctx);
  const form = el("form", {}, [username.node, password.node, confirm.node, setupCode.node, tsSetup.box, submit]);
  form.onsubmit = async (e) => {
    e.preventDefault();
    if (password.input.value !== confirm.input.value) return toast(t("adm.errPwMismatch"), "error");
    if (password.input.value.length < 8) return toast(t("adm.errPwShort"), "error");
    submit.disabled = true;
    try {
      await api.setup({
        username: username.input.value || "admin",
        password: password.input.value,
        code: setupCode.input.value,
        turnstileToken: await tsSetup.getToken(),
      });
      toast(t("adm.okSetupDone"), "ok");
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
  wrap.append(el("h1", { text: t("adm.loginTitle") }), el("div", { class: "hint", text: t("adm.loginHint") }));

  const username = field(t("adm.fUsername"), { name: "username", value: "admin", autocomplete: "username" });
  const password = field(t("adm.fPassword"), { name: "password", type: "password", autocomplete: "current-password" });
  const submit = el("button", { class: "btn primary", type: "submit", text: t("adm.btnLogin") });

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
      toast(t("adm.okLogin"), "ok");
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
    wrap.append(el("div", { class: "hint", text: t("adm.hintEnvPw") }));
  }
  root.append(wrap);
}

/* ---------------------------------------------------------------- 常规 */

function renderGeneral(body, ctx, settings) {
  const g = settings.general;
  const card = el("div", { class: "card" });
  card.append(el("h2", { text: t("adm.siteSettings") }));

  const title = field(t("adm.fSiteTitle"), { value: g.siteTitle });
  const pageSize = field(t("adm.fPageSize"), { type: "number", value: g.pageSize, min: 5, max: 50 });
  const cacheTtl = field(t("adm.fCacheTtl"), { type: "number", value: g.cacheTtl, min: 0, max: 3600 });
  const feedChannels = field(t("adm.fFeedCh"), { type: "number", value: g.feedChannels, min: 1, max: 8 });

  const grid = el("div", { class: "formgrid" }, [
    title.node, pageSize.node, cacheTtl.node, feedChannelNode(feedChannels),
  ]);

  const showViews = checkbox(t("adm.cbViews"), g.showViews);
  const showDate = checkbox(t("adm.cbDate"), g.showDate);
  const theme = field(t("adm.fTheme"), {
    type: "select",
    options: [
      { value: "auto", label: t("adm.themeAuto") },
      { value: "light", label: t("adm.themeLight") },
      { value: "dark", label: t("adm.themeDark") },
    ],
    value: g.theme,
  });

  const opts = el("div", { style: { display: "grid", gap: "10px", margin: "6px 0 14px" } }, [
    showViews.node, showDate.node, theme.node,
  ]);

  const save = el("button", { class: "btn primary", type: "button", text: t("adm.btnSaveSettings") });
  save.onclick = async () => {
    save.disabled = true;
    try {
      const res = await api.saveSettings({
        general: {
          siteTitle: title.input.value,
          pageSize: Number(pageSize.input.value),
          cacheTtl: Number(cacheTtl.input.value),
          feedChannels: Number(feedChannels.input.value),
          showViews: showViews.input.checked,
          showDate: showDate.input.checked,
          theme: theme.select.value,
          adTagsExtra: parseAdTagsInput(adTags.input.value),
        },
      });
      // 回写内存 settings（后端返回完整新 settings）：切 tab 重绘不再显示旧值
      Object.assign(settings, res);
      ctx.state.config = { ...ctx.state.config, siteTitle: title.input.value, theme: theme.select.value, showViews: showViews.input.checked, showDate: showDate.input.checked };
      document.getElementById("site-title").textContent = title.input.value;
      ctx.applyTheme(theme.select.value);
      toast(t("adm.okSaved"), "ok");
    } catch (err) {
      toast(err.message, "error");
    } finally {
      save.disabled = false;
    }
  };

  card.append(grid, opts, save);
  body.append(card);

  // 广告过滤：内置标签只读展示（不可删），自定义标签可追加（逗号/空格/换行分隔，最多 64 个）
  const adTags = field(t("adm.fAdTags"), {
    value: (g.adTagsExtra || []).join(", "),
    placeholder: t("adm.phAdTags"),
  });
  const adCard = el("div", { class: "card" });
  const builtin = ["广告", "廣告", "推广", "推廣", "赞助", "贊助", "ad", "ads", "advert", "advertisement", "sponsor", "sponsored", "promo", "aff"];
  adCard.append(
    el("h2", { text: t("adm.adFilter") }),
    el("div", { class: "hint", text: t("adm.adHint") }),
    el("div", { class: "hint", text: t("adm.adBuiltin", { tags: builtin.map((b) => `#${b}`).join(" ") }) }),
    adTags.node,
  );
  body.append(adCard);
}

/** 解析自定义广告标签输入：逗号/空格/换行/顿号分隔，剥 # 前缀，去重（大小写不敏感） */
function parseAdTagsInput(raw) {
  const seen = new Set();
  const out = [];
  for (const part of String(raw || "").split(/[,\s，、;；\n]+/)) {
    const item = part.replace(/^[#＃]+/, "").trim().slice(0, 32);
    if (!item) continue;
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= 64) break;
  }
  return out;
}

/**
 * 把用户粘贴的内容规范成公开频道用户名（与 src/util.js 的同名函数同步维护——
 * public 静态资源无法 import src/，故复制一份）。
 * 返回："" → 空输入；null → 认得出来但不支持（私密邀请等）；字符串 → 合法用户名。
 * 支持：@name、name、https://t.me/name、t.me/name、t.me/s/name、t.me/name/12345、
 *       telegram.me/name、tg://resolve?domain=name
 */
function normalizeChannelInput(raw) {
  const input = String(raw ?? "").trim();
  if (!input) return "";
  const tg = /tg:\/\/(?:resolve)?\?[^#]*\bdomain=([^&#]+)/i.exec(input);
  if (tg) return cleanUsername(tg[1]);
  // 其余 tg:// 形式（tg://join?invite=… 等）不是公开频道——与 src/util.js 后端版一致，
  // 否则前端预览显示正常、点保存才被后端 400 打回
  if (/^tg:\/\//i.test(input)) return null;
  let s = input;
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  s = s.replace(/^(?:www\.)?(?:t\.me|telegram\.me|telegram\.dog)\.?/i, "");
  s = s.replace(/^\/+/, "");
  if (/^(?:\+|joinchat\/|addstickers\/|addlist\/|share\/)/i.test(s)) return null;
  if (/^c\/\d+/i.test(s)) return null;
  s = s.replace(/^s\//i, "");
  s = s.split(/[?#]/)[0];
  s = s.split("/").filter(Boolean)[0] || "";
  s = s.replace(/^@+/, "");
  // 剥完为空返回 ""（提示输入用户名），与 src/util.js 后端版一致
  if (!s) return "";
  return cleanUsername(s);
}

function cleanUsername(v) {
  const value = String(v || "").trim().replace(/^@+/, "");
  return /^[A-Za-z0-9_]{4,64}$/.test(value) ? value : null;
}

function feedChannelNode(f) { return f.node; }

/* ---------------------------------------------------------------- 频道 */

function renderChannels(body, ctx, settings) {
  const channels = (settings.channels || []).map((c) => ({ ...c }));
  const card = el("div", { class: "card" });
  const titleRow = el("div", { class: "card-title" }, [
    el("h2", { text: t("adm.chList") }),
    el("div", { class: "hint", text: t("adm.chHint") }),
  ]);
  card.append(titleRow);

  /* --- 新增表单 --- */
  const typeSel = el("select", { class: "select", style: { maxWidth: "140px" } }, [
    el("option", { value: "public", text: t("adm.optPublic") }),
    el("option", { value: "private", text: t("adm.optPrivate") }),
  ]);
  const idInput = el("input", { class: "input", placeholder: t("adm.phPublic"), autocomplete: "off" });
  const nameInput = el("input", { class: "input", placeholder: t("adm.phName"), autocomplete: "off" });
  const testBtn = el("button", { class: "btn", type: "button", text: t("adm.btnTest") });
  const addBtn = el("button", { class: "btn primary", type: "button", text: t("adm.btnAdd") });
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
    idInput.placeholder = typeSel.value === "public" ? t("adm.phPublicLong") : t("adm.phPrivate");
    testResult.textContent = "";
  };

  testBtn.onclick = async () => {
    testBtn.disabled = true;
    testBtn.textContent = t("adm.testing");
    testResult.textContent = "";
    try {
      const res = await api.testChannel(currentChannel());
      if (!res.ok) {
        testResult.textContent = t("adm.testFail", { e: res.error });
        testResult.style.color = "var(--danger)";
      } else {
        const meta = res.meta || {};
        testResult.style.color = "var(--ok)";
        testResult.textContent = t("adm.testOk", { title: meta.title || t("adm.untitled"), n: res.count, sub: meta.counters?.subscribers ? t("adm.testSubs", { n: meta.counters.subscribers }) : "" });
        if (!nameInput.value && meta.title) nameInput.value = meta.title;
      }
    } catch (err) {
      testResult.style.color = "var(--danger)";
      testResult.textContent = err.message;
    } finally {
      testBtn.disabled = false;
      testBtn.textContent = t("adm.btnTest");
    }
  };

  addBtn.onclick = () => {
    const ch = currentChannel();
    if (ch.type === "public") {
      // 与「测试」按钮/后端 validateChannel 同一套规范化：分享链接（t.me/xxx、tg://resolve?domain=xxx 等）
      // 也能直接添加，此前前端正则 /username/ 拦掉分享链接导致「测试能过、添加被拦」
      const username = normalizeChannelInput(ch.username);
      if (!username) return toast(t("adm.errBadUsername"), "error");
      ch.username = username;
    } else if (!/^-?\d{5,25}$/.test(ch.tgId)) return toast(t("adm.errBadId"), "error");
    if (!ch.name) ch.name = ch.type === "public" ? ch.username : ch.tgId;
    if (channels.some((c) => c.key === keyOf(ch))) return toast(t("adm.errDup"), "error");
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
      tableWrap.append(el("div", { class: "empty", text: t("adm.emptyCh") }));
      return;
    }
    const table = el("table", { class: "table" });
    table.append(
      el("thead", {}, [
        el("tr", {}, [
          el("th", { text: "#" }), el("th", { text: t("adm.thType") }), el("th", { text: t("adm.thId") }),
          el("th", { text: t("adm.thName") }), el("th", { text: t("adm.thVis") }), el("th", { text: t("adm.thMedia") }),
          el("th", { text: t("adm.thStatus") }), el("th", { text: t("adm.thOps") }),
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
        text: ch.hidden ? t("adm.visHidden") : t("adm.visPublic"),
        title: t("adm.tipHidden"),
        onclick: () => { ch.hidden = !ch.hidden; drawTable(); },
      });
      const mediaBtn = el("button", {
        class: `btn sm ${ch.mediaOnly ? "primary" : ""}`,
        type: "button",
        text: ch.mediaOnly ? t("adm.mediaYes") : t("adm.mediaNo"),
        title: t("adm.tipMedia"),
        onclick: () => { ch.mediaOnly = !ch.mediaOnly; drawTable(); },
      });
      const enabledBtn = el("button", {
        class: `btn sm ${ch.enabled === false ? "danger" : ""}`,
        type: "button",
        text: ch.enabled === false ? t("adm.stDisabled") : t("adm.stEnabled"),
        onclick: () => { ch.enabled = ch.enabled === false; drawTable(); },
      });

      const row = el("tr", {}, [
        el("td", { text: String(index + 1) }),
        el("td", {}, [el("span", { class: `pill ${ch.type === "private" ? "warn" : ""}`, text: ch.type === "private" ? t("adm.pillPrivate") : t("adm.pillPublic") })]),
        el("td", {}, [
          el("div", { text: ch.type === "public" ? `@${ch.username}` : ch.tgId, style: { fontFamily: "var(--mono)", fontSize: "13px" } }),
        ]),
        el("td", {}, [nameCell]),
        el("td", {}, [hiddenBtn]),
        el("td", {}, [mediaBtn]),
        el("td", {}, [enabledBtn]),
        el("td", {}, [
          el("div", { class: "row-actions" }, [
            el("button", { class: "btn sm", type: "button", text: "↑", title: t("adm.tipUp"), onclick: () => move(index, -1) }),
            el("button", { class: "btn sm", type: "button", text: "↓", title: t("adm.tipDown"), onclick: () => move(index, 1) }),
            el("button", {
              class: "btn sm", type: "button", text: t("adm.btnTest"),
              onclick: async (e) => {
                const btn = e.currentTarget;
                btn.disabled = true;
                try {
                  const res = await api.testChannel(ch);
                  toast(res.ok ? t("adm.testOkShort", { tt: res.meta?.title || ch.name }) : t("adm.testFail", { e: res.error }), res.ok ? "ok" : "error");
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
              class: "btn sm", type: "button", text: t("adm.rowRefresh"),
              onclick: async (e) => {
                const btn = e.currentTarget;
                btn.disabled = true;
                try {
                  await api.refreshChannel(ch.key);
                  await ctx.refreshChannels();
                  toast(t("adm.okChRefreshed"), "ok");
                } catch (err) {
                  toast(err.message, "error");
                } finally {
                  btn.disabled = false;
                }
              },
            }),
            el("button", {
              class: "btn sm danger", type: "button", text: t("adm.rowDelete"),
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
  const saveBtn = el("button", { class: "btn primary", type: "button", text: t("adm.btnSaveAll") });
  saveBtn.onclick = async () => {
    saveBtn.disabled = true;
    try {
      await api.saveSettings({ channels: channels.map((c, i) => ({ ...c, order: i })) });
      await ctx.refreshChannels();
      toast(t("adm.okChSaved"), "ok");
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
  card.append(el("h2", { text: t("adm.mediaMode") }), el("div", { class: "hint", text: t("adm.mediaHint") }));

  const video = checkbox(t("adm.cbVideo"), m.video);
  const image = checkbox(t("adm.cbImage"), m.image);
  const audio = checkbox(t("adm.cbAudio"), m.audio);
  const file = checkbox(t("adm.cbFile"), m.file);
  const proxyAll = checkbox(t("adm.cbProxy"), m.proxyAll);
  const pageSize = field(t("adm.fMediaPage"), { type: "number", value: m.pageSize, min: 6, max: 60 });

  card.append(
    el("div", { style: { display: "grid", gap: "10px", margin: "6px 0 14px" } }, [
      video.node, image.node, audio.node, file.node, proxyAll.node,
    ]),
    pageSize.node,
  );

  const save = el("button", { class: "btn primary", type: "button", text: t("adm.btnSaveMedia") });
  save.onclick = async () => {
    save.disabled = true;
    try {
      const res = await api.saveSettings({
        media: {
          video: video.input.checked,
          image: image.input.checked,
          audio: audio.input.checked,
          file: file.input.checked,
          proxyAll: proxyAll.input.checked,
          pageSize: Number(pageSize.input.value),
        },
      });
      // 回写内存 settings：切 tab 重绘显示新值
      Object.assign(settings, res);
      ctx.state.config = {
        ...ctx.state.config,
        media: { video: video.input.checked, image: image.input.checked, audio: audio.input.checked, file: file.input.checked, pageSize: Number(pageSize.input.value) },
      };
      toast(t("adm.okSaved"), "ok");
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
    el("h2", { text: t("adm.tabBridge") }),
    el("div", {
      class: "hint",
      html: t("adm.bridgeHintHtml"),
    }),
  );

  const url = field(t("adm.fBridgeUrl"), { value: b.url || "", placeholder: "https://bridge.example.com" });
  const token = field(t("adm.fToken"), { value: "", placeholder: b.hasToken ? t("adm.phTokenSet") : t("adm.phTokenUnset") });
  const enabled = checkbox(t("adm.cbBridge"), b.enabled);

  card.append(url.node, token.node, enabled.node);

  const status = el("div", { class: "hint" });
  status.textContent = b.fromEnv
    ? t("adm.stFromEnv")
    : b.hasToken ? t("adm.stHasToken") : t("adm.stNoToken");
  card.append(status);

  const row = el("div", { style: { display: "flex", gap: "10px", marginTop: "12px", flexWrap: "wrap" } });
  const save = el("button", { class: "btn primary", type: "button", text: t("adm.btnSaveBridge") });
  const ping = el("button", { class: "btn", type: "button", text: t("adm.btnPing") });
  row.append(save, ping);
  card.append(row);

  save.onclick = async () => {
    save.disabled = true;
    try {
      const body2 = { bridge: { url: url.input.value.trim(), enabled: enabled.input.checked } };
      if (token.input.value) body2.bridge.token = token.input.value;
      const res = await api.saveSettings(body2);
      // 回写内存 settings：切 tab 重绘时 b.hasToken / url / enabled 状态行才是新值
      Object.assign(settings, res);
      toast(t("adm.okSaved"), "ok");
    } catch (err) {
      toast(err.message, "error");
    } finally {
      save.disabled = false;
    }
  };

  ping.onclick = async () => {
    ping.disabled = true;
    ping.textContent = t("adm.testing");
    try {
      const res = await api.testChannel({ type: "private", tgId: "-1000000000000", name: "ping" });
      if (res.ok) toast(t("adm.okBridge"), "ok");
      else toast(t("adm.bridgeDown", { e: res.error }), "error");
    } catch (err) {
      toast(err.message, "error");
    } finally {
      ping.disabled = false;
      ping.textContent = t("adm.btnPing");
    }
  };

  body.append(card);
}

/* --------------------------------------------------------------- 安全 */

function renderSecurity(body, ctx, settings) {
  const card = el("div", { class: "card" });
  card.append(el("h2", { text: t("adm.pwTitle") }));

  if (settings.credential?.source === "env") {
    card.append(el("div", { class: "hint", text: t("adm.hintEnvCred") }));
    body.append(card);
  } else {
    const cur = field(t("adm.fCurPw"), { type: "password", autocomplete: "current-password" });
    const next = field(t("adm.fNewPw"), { type: "password", autocomplete: "new-password" });
    const save = el("button", { class: "btn primary", type: "button", text: t("adm.btnChangePw") });
    const tsPw = turnstileField(ctx);
    save.onclick = async () => {
      save.disabled = true;
      try {
        await api.changePassword({
          currentPassword: cur.input.value,
          newPassword: next.input.value,
          turnstileToken: await tsPw.getToken(),
        });
        toast(t("adm.okPwChanged"), "ok");
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
  info.append(el("h2", { text: t("adm.sessTitle") }));
  const logout = el("button", { class: "btn danger", type: "button", text: t("adm.btnLogout") });
  logout.onclick = async () => {
    try {
      await api.logout();
    } catch { /* ignore */ }
    ctx.state.authenticated = false;
    ctx.refreshAuth();
    toast(t("adm.okLogout"), "ok");
    ctx.go("#/admin");
  };
  info.append(el("div", { class: "hint", text: t("adm.sessHint") }), logout);
  body.append(info);

  // ---- RSS 订阅令牌：带 token 读取私密/隐藏频道
  const rssCard = el("div", { class: "card" });
  rssCard.append(el("h2", { text: t("adm.rssTitle") }));
  rssCard.append(
    el("div", {
      class: "hint",
      text: t("adm.rssHint"),
    }),
  );
  const rssStatus = el("div", { class: "hint" });
  const rssUrlField = field(t("adm.fRssUrl"), { placeholder: t("adm.phNoToken") });
  rssUrlField.input.readOnly = true;
  const rssRow = el("div", { style: { display: "flex", gap: "8px", flexWrap: "wrap", margin: "8px 0" } });
  const genBtn = el("button", { class: "btn primary", type: "button", text: t("adm.btnGenToken") });
  const copyBtn = el("button", { class: "btn", type: "button", text: t("adm.btnCopy") });
  const revokeBtn = el("button", { class: "btn danger", type: "button", text: t("adm.btnRevoke") });

  const loadRssToken = async () => {
    try {
      const st = await api.rssToken();
      rssStatus.textContent = st.enabled
        ? t("adm.rssEnabled", { m: st.masked })
        : t("adm.stDisabledRss");
      if (!st.enabled) rssUrlField.input.value = "";
    } catch (err) {
      rssStatus.textContent = t("adm.stReadFail", { e: err.message });
    }
  };

  genBtn.onclick = async () => {
    genBtn.disabled = true;
    try {
      const r = await api.rssTokenAction("rotate");
      rssUrlField.input.value = r.url;
      rssStatus.textContent = t("adm.rssEnabled", { m: r.masked });
      toast(t("adm.okGenToken"), "ok");
    } catch (err) {
      toast(err.message, "error");
    } finally {
      genBtn.disabled = false;
    }
  };

  copyBtn.onclick = async () => {
    const value = rssUrlField.input.value;
    if (!value) return toast(t("adm.errNeedToken"), "error");
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
        return toast(t("adm.okCopied"), "ok");
      }
      throw new Error("no clipboard");
    } catch {
      rssUrlField.input.select();
      return toast(t("adm.errCopyManual"), "error");
    }
  };

  revokeBtn.onclick = async () => {
    revokeBtn.disabled = true;
    try {
      await api.rssTokenAction("revoke");
      rssUrlField.input.value = "";
      toast(t("adm.okRevoked"), "ok");
      await loadRssToken();
    } catch (err) {
      toast(err.message, "error");
    } finally {
      revokeBtn.disabled = false;
    }
  };

  rssRow.append(genBtn, copyBtn, revokeBtn);
  rssCard.append(
    rssStatus,
    rssUrlField.node,
    rssRow,
    el("div", { class: "hint", text: t("adm.rssSingleHint") }),
  );
  body.append(rssCard);
  loadRssToken();
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
