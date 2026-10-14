/** 前端 API 封装：统一错误处理与 JSON 序列化 */

import { t, reg } from "./i18n.js";

reg("api", {
  networkError: { zh: "网络错误：{msg}", en: "Network error: {msg}" },
  errWithCode: { zh: "请求失败（HTTP {code}）", en: "Request failed (HTTP {code})" },
  // 服务端错误文案只有中文；en 模式按 err code 查这里，查不到回退服务端原文
  err_channel_not_found: { zh: "频道不存在", en: "Channel not found" },
  err_post_not_found: { zh: "帖子不存在", en: "Post not found" },
  err_rate_limited: { zh: "上游限流，请稍后再试", en: "Upstream rate limited, please retry later" },
  err_upstream_error: { zh: "抓取失败，请稍后再试", en: "Fetch failed, please retry later" },
  err_upstream_busy: { zh: "上游暂时不可用，请稍后重试", en: "Upstream temporarily unavailable, please retry" },
  err_hidden_channel: { zh: "该频道需要登录或有效令牌后查看", en: "This channel requires sign-in or a valid token" },
  err_unauthorized: { zh: "未登录或登录已过期", en: "Not signed in or session expired" },
  err_not_initialized: { zh: "尚未完成初始化", en: "Not initialized yet" },
  err_not_found: { zh: "资源不存在", en: "Resource not found" },
  err_turnstile_required: { zh: "请先完成人机验证", en: "Please complete the human verification" },
  err_turnstile_failed: { zh: "人机验证未通过", en: "Human verification failed" },
  err_turnstile_error: { zh: "人机验证出错", en: "Human verification error" },
  err_bad_credentials: { zh: "用户名或密码错误", en: "Incorrect username or password" },
  err_weak_password: { zh: "密码强度不足", en: "Password too weak" },
  err_bridge_unverified: { zh: "桥接服务响应验签失败", en: "Bridge response signature verification failed" },
  err_use_bridge: { zh: "该频道需配置私密频道桥接服务", en: "This channel requires the private-channel bridge" },
  err_invalid_settings: { zh: "设置无效", en: "Invalid settings" },
  err_body_too_large: { zh: "请求体过大", en: "Request body too large" },
  err_proxy_rate_limited: { zh: "代理请求过于频繁", en: "Proxy requests too frequent" },
  err_media_not_found: { zh: "媒体不存在", en: "Media not found" },
  err_media_upstream_error: { zh: "媒体获取失败", en: "Media fetch failed" },
  // 以下为服务端静态文案码。故意未收录的 5 个动态文案码（bad_channel / bridge_denied /
  // bridge_error / bridge_unreachable / upstream_status）带诊断细节（校验原因、NTP 时钟差、
  // 上游状态码），进静态表会丢信息，故保留回退服务端原文。
  err_already_initialized: { zh: "管理员已初始化，无法重复初始化", en: "Already initialized" },
  err_bad_action: { zh: "action 必须是 rotate 或 revoke", en: "action must be rotate or revoke" },
  err_bad_json: { zh: "请求体 JSON 无效", en: "Invalid JSON request body" },
  err_bad_post: { zh: "post 参数非法", en: "Invalid post parameter" },
  err_bad_proxy_sig: { zh: "媒体代理链接未签名或签名无效", en: "Media proxy link is unsigned or has an invalid signature" },
  err_bad_redirect: { zh: "上游返回了无法解析的重定向", en: "Upstream returned an unparsable redirect" },
  err_bad_redirect_scheme: { zh: "重定向目标仅允许 https", en: "Redirect target must use https" },
  err_bad_scheme: { zh: "仅支持 http/https 媒体地址", en: "Only http/https media URLs are supported" },
  err_bad_setup_code: { zh: "初始化码不正确", en: "Incorrect setup code" },
  err_bad_type: { zh: "type 必须是 video/image/audio/file", en: "type must be video/image/audio/file" },
  err_bad_url: { zh: "缺少 u 参数", en: "Missing u parameter" },
  err_bad_username: { zh: "用户名仅允许字母数字 . _ -", en: "Username may only contain letters, digits, . _ -" },
  err_bridge_not_configured: { zh: "尚未配置私密频道桥接服务", en: "Private-channel bridge is not configured" },
  err_channel_disabled: { zh: "频道已停用", en: "Channel is disabled" },
  err_env_managed: { zh: "当前使用环境变量 ADMIN_PASSWORD，请修改环境变量而非数据库凭据", en: "ADMIN_PASSWORD is set via environment variable; change it there instead" },
  err_host_not_allowed: { zh: "该媒体地址不在白名单内", en: "This media URL is not in the allowlist" },
  err_html_not_allowed: { zh: "上游返回了 HTML 页面，已拒绝代理", en: "Upstream returned an HTML page; proxying refused" },
  err_redirect_not_allowed: { zh: "重定向目标不在白名单内", en: "Redirect target is not in the allowlist" },
  err_too_large: { zh: "媒体体积超过限制", en: "Media exceeds the size limit" },
  err_too_many_redirects: { zh: "上游重定向次数过多", en: "Too many upstream redirects" },
});

export class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code || "error";
  }
}

async function request(path, options = {}) {
  const init = {
    method: options.method || "GET",
    headers: { accept: "application/json" },
    credentials: "same-origin",
    // 30s 超时，避免卡死；不支持 AbortSignal.timeout 的环境降级为不超时
    signal: typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(30000) : undefined,
  };
  if (options.body !== undefined) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(options.body);
  }

  let res;
  try {
    res = await fetch(path, init);
  } catch (err) {
    throw new ApiError(t("api.networkError", { msg: err?.message || err }), 0, "network_error");
  }

  const isJson = (res.headers.get("content-type") || "").includes("json");
  const data = isJson ? await res.json().catch(() => null) : null;

  if (!res.ok) {
    // 服务端错误文案全中文：en 模式优先按 err code 查前端词条，查不到回退服务端原文
    let message = data?.error || t("api.errWithCode", { code: res.status });
    if (data?.code) {
      const codeKey = `api.err_${data.code}`;
      const localized = t(codeKey);
      if (localized !== codeKey) message = localized; // 有词条才替换，无词条保留服务端原文
    }
    const error = new ApiError(message, res.status, data?.code);
    error.retryAfter = res.headers.get("retry-after");
    throw error;
  }
  return data;
}

export const api = {
  config: () => request("/api/config"),
  channels: () => request("/api/channels"),
  feed: (cursors, tag) =>
    request(
      `/api/feed${cursorQuery(cursors)}${tag ? `${cursorQuery(cursors) ? "&" : "?"}tag=${encodeURIComponent(tag)}` : ""}`,
    ),
  posts: (key, before, tag) => {
    // limit 不传：服务端 content.js 用 clampInt(limit, 5, 50, pageSize)，缺省才跟随"每页消息数"设置
    const q = new URLSearchParams();
    if (before) q.set("before", before);
    if (tag) q.set("tag", tag);
    const qs = q.toString();
    return request(`/api/channels/${encodeURIComponent(key)}/posts${qs ? `?${qs}` : ""}`);
  },
  media: ({ type, cursors, key, limit } = {}) => {
    const q = new URLSearchParams({ type: type || "video" });
    if (key) q.set("key", key);
    if (limit) q.set("limit", String(limit));
    if (cursors) q.set("c", encodeState(cursors));
    return request(`/api/media?${q.toString()}`);
  },
  doc: ({ key, post, i }) =>
    request(`/api/media/doc?key=${encodeURIComponent(key)}&post=${encodeURIComponent(post)}&i=${i ?? 0}`),

  adminState: () => request("/api/admin/state"),
  setup: (body) => request("/api/admin/setup", { method: "POST", body }),
  login: (body) => request("/api/admin/login", { method: "POST", body }),
  logout: () => request("/api/admin/logout", { method: "POST" }),
  settings: () => request("/api/admin/settings"),
  saveSettings: (body) => request("/api/admin/settings", { method: "POST", body }),
  testChannel: (channel) => request("/api/admin/channels/test", { method: "POST", body: { channel } }),
  refreshChannel: (key) => request("/api/admin/channels/refresh", { method: "POST", body: { key } }),
  changePassword: (body) => request("/api/admin/password", { method: "POST", body }),
  rssToken: () => request("/api/admin/rss-token"),
  rssTokenAction: (action) => request("/api/admin/rss-token", { method: "POST", body: { action } }),
  stats: () => request("/api/admin/stats"),
};

function encodeState(value) {
  const json = JSON.stringify(value);
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  bytes.forEach((b) => { binary += String.fromCharCode(b); });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function cursorQuery(cursors) {
  if (!cursors || !Object.keys(cursors).length) return "";
  return `?c=${encodeState(cursors)}`;
}

export { encodeState };
