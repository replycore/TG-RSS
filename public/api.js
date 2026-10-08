/** 前端 API 封装：统一错误处理与 JSON 序列化 */

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
    throw new ApiError(`网络错误：${err?.message || err}`, 0, "network_error");
  }

  const isJson = (res.headers.get("content-type") || "").includes("json");
  const data = isJson ? await res.json().catch(() => null) : null;

  if (!res.ok) {
    const message = data?.error || `请求失败（HTTP ${res.status}）`;
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
  posts: (key, before, tag) =>
    request(
      `/api/channels/${encodeURIComponent(key)}/posts?limit=20${before ? `&before=${encodeURIComponent(before)}` : ""}${
        tag ? `&tag=${encodeURIComponent(tag)}` : ""
      }`,
    ),
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
