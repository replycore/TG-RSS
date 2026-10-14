/** 极简 .env 加载器（避免额外依赖） */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export function loadEnv(file = path.join(here, ".env")) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const rawLine = lines[i];
    i += 1;
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    // 容忍 `export KEY=value`（shell 习惯误写进 .env）：剥掉前缀再取键名，
    // 否则键会变成 "export TG_API_ID"，排错时只看到「缺少环境变量」
    const cleaned = trimmed.replace(/^export\s+/, "");
    const eq = cleaned.indexOf("=");
    if (eq < 0) continue;
    const key = cleaned.slice(0, eq).trim();
    if (!key) continue;
    let rest = cleaned.slice(eq + 1);
    // 双引号多行值：累积到闭合引号（含转义 \"），引号内的 # / 换行都保留；
    // 到文件尾仍未闭合则直接抛错，不静默截断
    if (rest.trimStart().startsWith('"') && rest.trim() !== '"' && indexOfUnescapedQuote(rest, rest.indexOf('"') + 1) < 0) {
      const buf = [rest];
      let closed = false;
      while (i < lines.length) {
        buf.push(lines[i]);
        i += 1;
        if (indexOfUnescapedQuote(buf.join("\n"), 1) >= 0) {
          closed = true;
          break;
        }
      }
      if (!closed) throw new Error(`.env 解析失败：${key} 的双引号未闭合`);
      rest = buf.join("\n");
    }
    out[key] = parseEnvValue(rest);
  }
  return out;
}

/** 在 s 中找第一个未被反斜杠转义的双引号下标（从 from 开始），找不到返回 -1 */
function indexOfUnescapedQuote(s, from = 0) {
  for (let j = from; j < s.length; j += 1) {
    if (s[j] === "\\") {
      j += 1;
      continue;
    }
    if (s[j] === '"') return j;
  }
  return -1;
}

/**
 * 引号感知剥行内注释：双引号（支持 \" 转义）/单引号内的 # 保留；
 * 引号外的 ` #`（空格/Tab + #）剥离。无引号值沿用旧行为（`a#b` 保留）。
 */
function stripInlineComment(s) {
  let inSingle = false;
  let inDouble = false;
  for (let j = 0; j < s.length; j += 1) {
    const c = s[j];
    if (inDouble) {
      if (c === "\\") {
        j += 1;
        continue;
      }
      if (c === '"') inDouble = false;
      continue;
    }
    if (inSingle) {
      if (c === "'") inSingle = false;
      continue;
    }
    if (c === '"') {
      inDouble = true;
      continue;
    }
    if (c === "'") {
      inSingle = true;
      continue;
    }
    if (c === "#" && (j === 0 || s[j - 1] === " " || s[j - 1] === "\t")) {
      return s.slice(0, j).trimEnd();
    }
  }
  return s;
}

/** 双引号内转义：\" → "、\\ → \、\n → 换行；其它反斜杠序列原样保留 */
function unescapeDoubleQuoted(s) {
  return s.replace(/\\(\\|"|n)/g, (m, c) => (c === "n" ? "\n" : c));
}

function parseEnvValue(rest) {
  const noComment = stripInlineComment(rest).trim();
  if (noComment === '"') return '"'; // 单个引号字符按普通字符处理
  const dq = noComment.length >= 2 && noComment.startsWith('"') && noComment.endsWith('"');
  const sq = noComment.length >= 2 && noComment.startsWith("'") && noComment.endsWith("'");
  if (dq) return unescapeDoubleQuoted(noComment.slice(1, -1));
  if (sq) return noComment.slice(1, -1);
  return noComment;
}

const fileEnv = loadEnv();
export const env = { ...fileEnv, ...process.env };

export const config = {
  apiId: Number(env.TG_API_ID || 0),
  apiHash: String(env.TG_API_HASH || ""),
  phone: String(env.TG_PHONE || ""),
  session: String(env.TG_SESSION || ""),
  token: String(env.BRIDGE_TOKEN || ""),
  port: (() => {
    // 非法 PORT 直接启动抛错（不静默 clamp）：NaN/越界会让 server.listen 崩溃，
    // 0 会绑随机端口但 baseUrl() 仍报 :0，fail-fast 比运行时排错便宜
    const p = Number(env.PORT || 8788);
    if (!Number.isInteger(p) || p < 1 || p > 65535) {
      throw new Error(`PORT 非法：${env.PORT}（应为 1–65535 的整数）`);
    }
    return p;
  })(),
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
