/**
 * 主题/可见性回归：这两个问题都只在真实浏览器里才暴露（WCAG 数值审计发现不了），
 * 所以把结论固化成可重复执行的断言。
 *
 * 1. [hidden] 必须压过组件自身的 display —— 否则 WebKit/Safari 下 `.lightbox`
 *    （display:grid，90% 黑）与移动端 `.sidebar-mask`（display:block，45% 黑）
 *    常驻，整页被压暗到「字都看不到」。
 * 2. 主题必须显式设置 color-scheme，否则原生下拉/滚动条/自动填充按系统方案绘制，
 *    出现「浅色底 + 浅色字」。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dir = path.dirname(fileURLToPath(import.meta.url));
const css = await readFile(path.join(dir, "..", "public", "styles.css"), "utf8");
const html = await readFile(path.join(dir, "..", "public", "index.html"), "utf8");

test("[hidden] 全局生效，不会被组件 display 覆盖", () => {
  assert.match(
    css,
    /\[hidden\]\s*\{\s*display\s*:\s*none\s*!important\s*;?\s*\}/,
    "styles.css 必须包含 `[hidden] { display: none !important; }`",
  );
  // index.html 里所有用 hidden 属性控制显隐的节点
  const hiddenIds = [...html.matchAll(/id="([\w-]+)"[^>]*\shidden(?=[\s>])/g)].map((m) => m[1]);
  assert.ok(hiddenIds.includes("lightbox") && hiddenIds.includes("sidebar-mask"),
    "lightbox / sidebar-mask 仍应由 hidden 属性控制");
});

test("每套主题都显式声明 color-scheme", () => {
  const rootBlock = /:root\s*\{([\s\S]*?)\}/.exec(css)?.[1] || "";
  assert.match(rootBlock, /color-scheme\s*:\s*light/, ":root 需要 color-scheme: light");

  const autoDark = /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root\[data-theme="auto"\]\s*\{([\s\S]*?)\}/.exec(css)?.[1] || "";
  assert.match(autoDark, /color-scheme\s*:\s*dark/, "auto + 系统深色需要 color-scheme: dark");

  const darkBlock = /:root\[data-theme="dark"\]\s*\{([\s\S]*?)\}/.exec(css)?.[1] || "";
  assert.match(darkBlock, /color-scheme\s*:\s*dark/, "data-theme=dark 需要 color-scheme: dark");
});

test("文字色与品牌色分离：accent-text / danger-text / warn-text 均已定义", () => {
  const rootBlock = /:root\s*\{([\s\S]*?)\}/.exec(css)?.[1] || "";
  for (const token of ["--accent-text", "--danger-text", "--warn-text", "--accent-fg"]) {
    assert.match(rootBlock, new RegExp(`${token}\\s*:`), `:root 缺少 ${token}`);
  }
  // 品牌蓝只用于背景/描边，文字一律走 --accent-text（注意别把 border-color 算进来）
  const textUsages = [...css.matchAll(/(?<![-\w])color:\s*var\(--accent\)/g)];
  assert.equal(textUsages.length, 0, "不应存在 color: var(--accent)，文字需用 var(--accent-text)");
});
