/**
 * 调色板对比度审计（无需浏览器）。
 *
 * contrast.mjs 需要真实 Chrome 才能逐元素取色；本脚本反过来：直接从 styles.css
 * 里解析出亮/暗两套 CSS 变量，对「前景角色 × 背景角色」的组合计算 WCAG 对比度，
 * 在没有浏览器的环境（CI / iSH）也能做回归检查。
 *
 * 用法：
 *   node tools/palette-check.mjs            # 打印全表，任一项 < 4.5 退出码 1
 *   node tools/palette-check.mjs --json     # 只输出 JSON
 *
 * 阈值：正文级 4.5:1（WCAG AA normal text）。UI 图形/边框按 3.0 单列，不计入退出码。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dir = path.dirname(fileURLToPath(import.meta.url));
const cssPath = path.join(dir, "..", "public", "styles.css");
const css = readFileSync(cssPath, "utf8");

/* ------------------------------------------------------------ 颜色工具 */

const hex = (s) => {
  const m = /#([0-9a-f]{6}|[0-9a-f]{3})\b/i.exec(s || "");
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
};

const rgba = (s) => {
  const m = /rgba?\(([^)]+)\)/i.exec(s || "");
  if (!m) return null;
  const n = m[1].split(",").map((v) => parseFloat(v));
  return { r: n[0], g: n[1], b: n[2], a: n[3] === undefined ? 1 : n[3] };
};

const color = (s) => hex(s) || (() => { const c = rgba(s); return c ? [c.r, c.g, c.b] : null; })();
const alphaOf = (s) => { const c = rgba(s); return c ? c.a : 1; };

/** 把半透明色叠到不透明底色上 */
function over(top, bottom, a) {
  return [
    Math.round(top[0] * a + bottom[0] * (1 - a)),
    Math.round(top[1] * a + bottom[1] * (1 - a)),
    Math.round(top[2] * a + bottom[2] * (1 - a)),
  ];
}

function luminance([r, g, b]) {
  const f = (v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

export function contrast(a, b) {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

/* ------------------------------------------------- 解析 styles.css 变量 */

function varsIn(block) {
  const out = {};
  for (const m of block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}

function block(pattern) {
  const re = new RegExp(pattern + "\\s*\\{([^}]*)\\}", "m");
  const m = re.exec(css);
  if (!m) throw new Error("styles.css 中找不到块：" + pattern);
  return m[1];
}

const lightVars = varsIn(block(":root\\s*(?!\\[)"));
const darkVars = {
  ...lightVars,
  ...varsIn(block(":root\\[data-theme=\\\"dark\\\"]")),
};
const autoDarkVars = {
  ...lightVars,
  ...varsIn(block("@media\\s*\\(prefers-color-scheme:\\s*dark\\)")),
};

/* -------------------------------------------------------------- 审计 */

const GRAY_SOFT = "rgba(127,127,127,.16)";
const GRAY_CODE = "rgba(127,127,127,0.12)";

function audit(name, vars) {
  const V = vars;
  const WHITE = [255, 255, 255];
  const bg = color(V["--bg"]);
  const elev = color(V["--bg-elev"]);
  const fg = color(V["--fg"]);
  const muted = color(V["--fg-muted"]);
  const accent = color(V["--accent"]);
  const accentText = color(V["--accent-text"] || V["--accent"]);
  const accentFg = color(V["--accent-fg"] || "#ffffff");
  const danger = color(V["--danger"]);
  const dangerText = color(V["--danger-text"] || V["--danger"]);
  const ok = color(V["--ok"]);
  const warnText = color(V["--warn-text"] || "#b7811f");
  const accentSoft = alphaOf(V["--accent-soft"]);
  const softOnBg = over(accent, bg, accentSoft);
  const softOnElev = over(accent, elev, accentSoft);
  const grayOnElev = over([127, 127, 127], elev, 0.16);
  const grayOnBg = over([127, 127, 127], bg, 0.12);
  const warnOnElev = over([217, 160, 60], elev, 0.16);
  const coverOnElev = over([127, 127, 127], elev, 0.12);

  const rows = [
    ["正文 fg / bg", fg, bg, 4.5],
    ["正文 fg / bg-elev", fg, elev, 4.5],
    ["次要 fg-muted / bg", muted, bg, 4.5],
    ["次要 fg-muted / bg-elev", muted, elev, 4.5],
    ["次要 fg-muted / accent-soft(bg)", muted, softOnBg, 4.5],
    ["链接 accent-text / bg", accentText, bg, 4.5],
    ["链接 accent-text / bg-elev", accentText, elev, 4.5],
    ["链接 accent-text / accent-soft(elev)", accentText, softOnElev, 4.5],
    ["链接 accent-text / 灰底(elev)", accentText, grayOnElev, 4.5],
    ["主按钮/Tab accent-fg / accent", accentFg, accent, 4.5],
    ["危险文字 danger-text / bg", dangerText, bg, 4.5],
    ["危险文字 danger-text / bg-elev", dangerText, elev, 4.5],
    ["危险文字 danger-text / accent-soft(elev)", dangerText, softOnElev, 4.5],
    ["toast.error 白字 / danger 底", WHITE, danger, 4.5],
    ["toast.ok 白字 / ok 底", WHITE, ok, 4.5],
    ["toast 反白 bg 底 / fg 字", bg, fg, 4.5],
    ["pill.off fg-muted / 灰底", muted, grayOnElev, 4.5],
    ["pill.warn warn-text / 琥珀底", warnText, warnOnElev, 4.5],
    ["代码块文字 fg / 灰底", fg, grayOnBg, 4.5],
    ["封面占位 fg-muted / 灰底", muted, coverOnElev, 4.5],
    // ---- 以下为非文字（WCAG 1.4.11，参考项，不计入退出码）----
    ["[图形] accent 组件边框 / bg-elev", accent, elev, 3.0, true],
    ["[图形] accent 组件边框 / bg", accent, bg, 3.0, true],
    ["[图形] accent / accent-soft(elev)", accent, softOnElev, 3.0, true],
  ];

  const results = rows.map(([label, fg2, bg2, need, info]) => {
    const ratio = Math.round(contrast(fg2, bg2) * 100) / 100;
    return { label, ratio, need, info: !!info, pass: ratio >= need };
  });
  return { name, results };
}

const reports = [
  audit("light", lightVars),
  audit("dark (data-theme=dark)", darkVars),
  audit("dark (auto + OS dark)", autoDarkVars),
];

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(reports, null, 2));
} else {
  let failed = 0;
  let infoFailed = 0;
  for (const r of reports) {
    console.log(`\n== ${r.name}`);
    for (const x of r.results) {
      if (!x.pass) {
        if (x.info) infoFailed += 1;
        else failed += 1;
      }
      const tag = x.pass ? "  " : x.info ? "~ " : "✗ ";
      const kind = x.info ? "参考" : "    ";
      console.log(
        `${tag}${kind} ${x.ratio.toFixed(2).padStart(5)}:1 (需 ${x.need})  ${x.label}`,
      );
    }
  }
  console.log(`\n合计不达标（文字 4.5:1）：${failed}；非文字参考项未达标：${infoFailed}`);
  process.exit(failed > 0 ? 1 : 0);
}
