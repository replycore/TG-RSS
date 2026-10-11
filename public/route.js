/** 路由解析：location.hash → 视图描述。零副作用（不碰 DOM / 不发请求），便于单测。 */

/** 容错解码：坏的百分号序列（如 #/c/%E4）返回原值而不是抛 URIError 杀死路由 */
export function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function parseRoute() {
  const raw = (location.hash || "#/").replace(/^#/, "");
  // 先把路径和 query 拆开：否则 `#/?tag=xxx` 的路径部分是 "/"，
  // 会在下面 parts 为空时提前返回，把 ?tag= 整个丢掉（点了标签却不筛选）
  const qIndex = raw.indexOf("?");
  const pathPart = qIndex >= 0 ? raw.slice(0, qIndex) : raw;
  const queryPart = qIndex >= 0 ? raw.slice(qIndex + 1) : "";
  const parts = pathPart.split("/").filter(Boolean);
  const query = new URLSearchParams(queryPart);
  const tag = query.get("tag");
  const feedRoute = () => (tag ? { name: "feed", tag } : { name: "feed" });
  if (!parts.length) return feedRoute();
  if (parts[0] === "c" && parts[1]) {
    const key = safeDecode(parts[1]);
    return tag ? { name: "channel", key, tag } : { name: "channel", key };
  }
  if (parts[0] === "media") return { name: "media", type: parts[1] || "video", key: parts[2] ? safeDecode(parts[2]) : "" };
  if (parts[0] === "admin") return { name: "admin", tab: parts[1] || "general" };
  return feedRoute();
}
