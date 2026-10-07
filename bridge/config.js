/** 极简 .env 加载器（避免额外依赖） */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export function loadEnv(file = path.join(here, ".env")) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  const text = fs.readFileSync(file, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

const fileEnv = loadEnv();
export const env = { ...fileEnv, ...process.env };

export const config = {
  apiId: Number(env.TG_API_ID || 0),
  apiHash: String(env.TG_API_HASH || ""),
  phone: String(env.TG_PHONE || ""),
  session: String(env.TG_SESSION || ""),
  token: String(env.BRIDGE_TOKEN || ""),
  port: Number(env.PORT || 8788),
  // 默认只监听本机：私密频道内容不应直接暴露在局域网，需要对外时设 BRIDGE_HOST=0.0.0.0
  host: String(env.BRIDGE_HOST || "127.0.0.1"),
  publicUrl: String(env.PUBLIC_URL || "").replace(/\/+$/, ""),
  cacheDir: env.CACHE_DIR
    ? path.resolve(env.CACHE_DIR)
    : path.join(here, "cache"),
};

export function requireConfig({ needSession = true } = {}) {
  const missing = [];
  if (!config.apiId) missing.push("TG_API_ID");
  if (!config.apiHash) missing.push("TG_API_HASH");
  if (needSession && !config.session) missing.push("TG_SESSION");
  if (!config.token) missing.push("BRIDGE_TOKEN");
  if (missing.length) {
    throw new Error(`缺少环境变量：${missing.join("、")}（参考 bridge/.env.example）`);
  }
}

export function baseUrl() {
  if (config.publicUrl) return config.publicUrl;
  return `http://127.0.0.1:${config.port}`;
}
