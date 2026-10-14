/** TG-RSS 多语言（i18n）
 *
 * 设计约定（评审/协作请遵守）：
 * - 默认 zh-CN；语言由 localStorage（key: tg_rss_lang）决定——用户手动切换后以其为准；
 *   未手动选过时按浏览器语言初始化（navigator.language 匹配 /^en(\b|-)/ → en，其余 → zh-CN）。
 *   自动探测限定非 Node 进程（Node 21+ 自带 navigator.language=en-US，且无头测试环境
 *   （happy-dom 默认 en-US）会被误判导致断言中文失败）。
 * - 各业务模块用 reg(section, entries) 注册自己的词条；key = `${section}.${name}`。
 *   词条值 { zh, en }；zh 必须与原中文字面量一字不差（默认中文渲染有测试断言）。
 * - t(key, vars) 取词条：en 缺失回退 zh，词条缺失回退 key 本身（安全，不抛错）。
 *   vars 支持 {name} 占位插值。
 * - setLang() 后：刷新 data-i18n 静态节点 → 广播 window 事件 "tg:langchange"
 *   （app 壳监听它重渲染当前视图）。
 */

const STORAGE_KEY = "tg_rss_lang";
const DICT = Object.create(null);
let lang = "zh-CN";

try {
  const saved = typeof localStorage !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null;
  if (saved === "en" || saved === "zh-CN") {
    lang = saved;
  } else if (typeof process === "undefined" && typeof navigator !== "undefined" && navigator.language) {
    // 未手动选过时按浏览器语言初始化：en-* 用英文，其余（含 zh）用中文。
    // 限定非 Node：Node 21+ 自带 navigator.language（en-US），在测试进程里会把默认语言带偏
    lang = /^en(\b|-)/i.test(navigator.language) ? "en" : "zh-CN";
  }
} catch { /* 无 localStorage 环境保持默认 */ }

// 初始化即同步 <html lang>（index.html 硬编码 zh-CN，保存 en/按浏览器判为 en 的用户
// 在点切换前 lang 也是错的，会让屏幕阅读器/翻译工具误判）；setLang() 里是切换时的同步
try {
  if (typeof document !== "undefined" && document.documentElement) document.documentElement.lang = lang;
} catch { /* 无 document 环境保持默认 */ }

export function getLang() {
  return lang;
}

export function setLang(next) {
  if (next !== "en" && next !== "zh-CN") return;
  lang = next;
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(STORAGE_KEY, next);
  } catch { /* ignore */ }
  if (typeof document !== "undefined") {
    document.documentElement.lang = next === "en" ? "en" : "zh-Hans";
  }
  applyStatic(typeof document !== "undefined" ? document : null);
  if (typeof window !== "undefined" && typeof CustomEvent === "function") {
    window.dispatchEvent(new CustomEvent("tg:langchange"));
  }
}

/** 注册一个模块的词条段：reg("views", { title: { zh: "信息流", en: "Feed" } }) → t("views.title") */
export function reg(section, entries) {
  for (const [name, value] of Object.entries(entries)) {
    DICT[`${section}.${name}`] = value;
  }
}

/** 取词条；vars 形如 { n: 5 }，替换文案里的 {n} 占位 */
export function t(key, vars) {
  const entry = DICT[key];
  let out = entry ? (entry[lang] != null ? entry[lang] : entry.zh) : key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      out = out.split(`{${k}}`).join(String(v));
    }
  }
  return out;
}

/** 刷新静态节点：[data-i18n] 改 textContent；[data-i18n-title] 改 title 与 aria-label */
export function applyStatic(root) {
  if (!root || typeof root.querySelectorAll !== "function") return;
  for (const node of root.querySelectorAll("[data-i18n]")) {
    const entry = DICT[node.getAttribute("data-i18n")];
    if (entry) node.textContent = entry[lang] != null ? entry[lang] : entry.zh;
  }
  for (const node of root.querySelectorAll("[data-i18n-title]")) {
    const entry = DICT[node.getAttribute("data-i18n-title")];
    if (!entry) continue;
    const value = entry[lang] != null ? entry[lang] : entry.zh;
    if (node.hasAttribute("title")) node.setAttribute("title", value);
    if (node.hasAttribute("aria-label")) node.setAttribute("aria-label", value);
  }
}
