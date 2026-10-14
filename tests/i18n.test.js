/** i18n 多语言回归：默认中文保功能、切换英文不断言失败、词条全注册 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

// 最小浏览器垫片（i18n.js 只用 localStorage + document.querySelectorAll + dispatchEvent）
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
globalThis.document = { querySelectorAll: () => [], documentElement: {} };
globalThis.window = { dispatchEvent: () => true };

const { t, reg, getLang, setLang } = await import("../public/i18n.js?v=" + Date.now());

test("i18n：默认 zh-CN，t() 取中文", () => {
  assert.equal(getLang(), "zh-CN");
  // 初始化即同步 <html lang>（保存 en 的用户首载前 lang 也不能错）
  assert.equal(document.documentElement.lang, "zh-CN", "初始化应同步 documentElement.lang");
  reg("probe", { hello: { zh: "你好", en: "Hello" } });
  assert.equal(t("probe.hello"), "你好");
  // 占位插值
  reg("probe2", { n: { zh: "共 {n} 条", en: "{n} items" } });
  assert.equal(t("probe2.n", { n: 5 }), "共 5 条");
});

test("i18n：切 en 后取英文 + 回退语义", () => {
  setLang("en");
  assert.equal(getLang(), "en");
  assert.equal(t("probe.hello"), "Hello");
  assert.equal(t("probe2.n", { n: 5 }), "5 items");
  // 缺 key 回退 key 本身；en 缺失回退 zh
  assert.equal(t("probe.noSuch"), "probe.noSuch");
  reg("probe3", { onlyZh: { zh: "仅中文" } });
  assert.equal(t("probe3.onlyZh"), "仅中文");
  setLang("zh-CN"); // 复位，不污染其他测试
});

test("i18n：各业务文件词条 used ⊆ reg（防漏注册显示 key 名）", () => {
  const files = { app: "app", api: "api", views: "views", media: "media", ui: "ui", adm: "admin" };
  for (const [sec, f] of Object.entries(files)) {
    const src = fs.readFileSync(new URL(`../public/${f}.js`, import.meta.url), "utf8");
    const used = new Set([...src.matchAll(new RegExp(`t\\("${sec}\\.([\\w]+)"`, "g"))].map((m) => m[1]));
    const regM = src.match(new RegExp(`reg\\("${sec}",\\s*\\{([\\s\\S]*?)\\n\\}\\);`));
    assert.ok(regM, `${f}.js 缺 reg("${sec}") 注册段`);
    const reged = new Set([...regM[1].matchAll(/^\s*(\w+):/gm)].map((m) => m[1]));
    const missing = [...used].filter((k) => !reged.has(k));
    assert.deepEqual(missing, [], `${f}.js 漏注册: ${missing}`);
    assert.ok(used.size > 0, `${f}.js 词条数为 0？`);
  }
  // media 的 tab 词条走动态拼接 key，单独确认存在
  const msrc = fs.readFileSync(new URL("../public/media.js", import.meta.url), "utf8");
  for (const k of ["tabVideo", "tabImage", "tabAudio", "tabFile"]) {
    assert.ok(new RegExp(`^\\s*${k}:`, "m").test(msrc.match(/reg\("media",\s*\{([\s\S]*?)\n\}\);/)[1]), `media 缺 ${k}`);
  }
});

test("i18n：index.html 静态节点全标记 + 语言按钮存在", () => {
  const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const marks = (html.match(/data-i18n(-title)?="html\.\w+"/g) || []).length;
  assert.ok(marks >= 14, `data-i18n 标记过少: ${marks}`);
  assert.ok(html.includes('id="lang-toggle"'), "缺 #lang-toggle 按钮");
  // 中文原文保留（首屏/测试断言用）
  assert.ok(html.includes("信息流") && html.includes("媒体"), "中文原文被删？");
});

test("i18n：fmtDate 直接可调（线上事故回归：局部 const t 遮蔽 i18n 的 t）", async (tctx) => {
  // 事故：ui.js fmtDate 内 `const t = Date.parse(value)` 遮蔽 i18n 的 t()
  // → 渲染帖子时间抛 "t is not a function"，整个信息流打不开
  const { Window } = await import("happy-dom");
  const window = new Window({ url: "http://localhost/" });
  globalThis.window = window; globalThis.document = window.document;
  globalThis.localStorage = window.localStorage;
  tctx.after(() => { delete globalThis.window; delete globalThis.document; delete globalThis.localStorage; });
  const { fmtDate } = await import(`../public/ui.js?regress=${Date.now()}`);
  assert.equal(typeof fmtDate(new Date().toISOString()), "string", "fmtDate 应返回字符串");
  assert.ok(fmtDate(new Date(Date.now() - 5 * 60000).toISOString()).includes("分钟前"), "中文时间文案");
  assert.ok(fmtDate("2026-01-05T10:00:00Z").length > 0, "远日期格式化");
  assert.equal(fmtDate(""), "", "空值容错");
});

test("i18n：前端文件禁止用 t 作局部变量/形参名（遮蔽静态审计）", () => {
  const files = ["app.js", "api.js", "route.js", "views.js", "media.js", "ui.js", "admin.js"];
  const re = /(?:\b(?:const|let|var)\s+t\b|\(\s*t\s*[,)]|\bfor\s*\(\s*const\s+t\b|\bcatch\s*\(\s*t\b)/;
  for (const f of files) {
    const src = fs.readFileSync(new URL(`../public/${f}`, import.meta.url), "utf8");
    const bad = src.split("\n")
      .map((line, i) => [i + 1, line])
      .filter(([, line]) => re.test(line) && !/^\s*(?:\/\/|\*|\/\*)/.test(line));
    assert.deepEqual(bad, [], `${f} 存在 t 遮蔽风险行: ${bad.map(([i]) => i).join(",")}`);
  }
});
