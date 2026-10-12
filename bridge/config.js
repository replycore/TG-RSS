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
    // 容忍 `export KEY=value`（shell 习惯误写进 .env）：剥掉前缀再取键名，
    // 否则键会变成 "export TG_API_ID"，排错时只看到「缺少环境变量」
    const cleaned = trimmed.replace(/^export\s+/, "");
    const eq2 = cleaned.indexOf("=");
    if (eq2 < 0) continue;
    const key = cleaned.slice(0, eq2).trim();
    let value = cleaned.slice(eq2 + 1).trim();
    const quoted = (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"));
    if (quoted) {
      value = value.slice(1, -1);
    } else {
      // 行内注释仅在未加引号时剥离：KEY=abc # 备注 → abc；"abc # x" 保持原样
      const hash = value.indexOf(" #");
      if (hash >= 0) value = value.slice(0, hash).trim();
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
  // 可选 Origin 白名单：逗号分隔的完整 origin（如 https://rss.example.com），
  // 配置后仅约束「头认证」请求；签名请求不受影响
  allowedOrigins: String(env.BRIDGE_ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter(Boolean),
  // 签名时间窗（秒）：机器时钟与 Cloudflare 偏差大时可放宽（默认 300，范围 60~3600）
  signWindowSec: Math.min(3600, Math.max(60, Number(env.BRIDGE_SIGN_WINDOW_SEC) || 300)),
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
