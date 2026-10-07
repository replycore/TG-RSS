/**
 * 可读性审计：用真实浏览器逐元素计算「文字色 vs 实际背景色」的 WCAG 对比度。
 *
 * 用法：
 *   node tools/contrast.mjs                       # 审计本地（先 npm run dev:node）
 *   BASE=http://localhost:8787 node tools/contrast.mjs
 *   node tools/contrast.mjs --strict               # 有不达标项时退出码 1（可用于 CI）
 *
 * 需要先 `npm install`（依赖 devDependencies 里的 puppeteer）。
 * Chrome 首次运行需系统库：libatk1.0-0/libatk-bridge2.0-0/libgbm1/libnss3/libasound2t64 等。
 */
import puppeteer from "puppeteer";

const args = process.argv.slice(2);
const STRICT = args.includes("--strict");
const BASE = process.env.BASE || "http://localhost:8787";
const ROUTES = ["", "#/media/video", "#/admin"];
const SCHEMES = ["dark", "light"];

const browser = await puppeteer.launch({
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
});

const parseRGBA = (s) => {
  const n = (s.match(/-?\d+(\.\d+)?/g) || []).map(Number);
  return { r: n[0] || 0, g: n[1] || 0, b: n[2] || 0, a: n[3] === undefined ? 1 : n[3] };
};

/** 把半透明背景与祖先背景合成，得到最终不透明颜色 */
function flatten(getBg, el) {
  const layers = [];
  let node = el;
  while (node) {
    const bg = parseRGBA(getBg(node));
    if (bg.a > 0) {
      layers.push(bg);
      if (bg.a >= 1) break;
    }
    node = node.parentElement;
  }
  const base = layers.length && layers[layers.length - 1].a >= 1 ? layers.pop() : { r: 255, g: 255, b: 255, a: 1 };
  let out = base;
  for (let i = layers.length - 1; i >= 0; i -= 1) {
    const l = layers[i];
    out = {
      r: l.r * l.a + out.r * (1 - l.a),
      g: l.g * l.a + out.g * (1 - l.a),
      b: l.b * l.a + out.b * (1 - l.a),
      a: 1,
    };
  }
  return [out.r, out.g, out.b];
}

function luminance([r, g, b]) {
  const f = (v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contrast(a, b) {
  const l1 = luminance(a);
  const l2 = luminance(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

async function auditInPage(page, scheme, route) {
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: scheme }]);
  await page.goto(`${BASE}/${route}`, { waitUntil: "networkidle2", timeout: 60000 });
  await new Promise((r) => setTimeout(r, 2500));

  return page.evaluate(() => {
    const parse = (s) => {
      const n = (s.match(/-?\d+(\.\d+)?/g) || []).map(Number);
      return { r: n[0] || 0, g: n[1] || 0, b: n[2] || 0, a: n[3] === undefined ? 1 : n[3] };
    };
    const flattenBg = (el) => {
      const layers = [];
      let node = el;
      while (node) {
        const bg = parse(getComputedStyle(node).backgroundColor);
        if (bg.a > 0) {
          layers.push(bg);
          if (bg.a >= 1) break;
        }
        node = node.parentElement;
      }
      const base = layers.length && layers[layers.length - 1].a >= 1 ? layers.pop() : { r: 255, g: 255, b: 255, a: 1 };
      let out = base;
      for (let i = layers.length - 1; i >= 0; i -= 1) {
        const l = layers[i];
        out = {
          r: l.r * l.a + out.r * (1 - l.a),
          g: l.g * l.a + out.g * (1 - l.a),
          b: l.b * l.a + out.b * (1 - l.a),
          a: 1,
        };
      }
      return [out.r, out.g, out.b];
    };
    const lum = ([r, g, b]) => {
      const f = (v) => {
        const c = v / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const ratio = (a, b) => {
      const l1 = lum(a);
      const l2 = lum(b);
      return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    };

    const rows = [];
    for (const el of document.querySelectorAll("body *")) {
      const hasOwnText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
      if (!hasOwnText) continue;
      const s = getComputedStyle(el);
      if (s.visibility === "hidden" || s.display === "none" || Number(s.opacity) < 0.1) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 4 || rect.height < 4) continue;
      const fg = parse(s.color);
      const bg = flattenBg(el); // 从元素自身开始合成，不能跳过自身背景
      const fgFlat = fg.a >= 1 ? [fg.r, fg.g, fg.b] : [
        fg.r * fg.a + bg[0] * (1 - fg.a),
        fg.g * fg.a + bg[1] * (1 - fg.a),
        fg.b * fg.a + bg[2] * (1 - fg.a),
      ];
      rows.push({
        sel:
          el.tagName.toLowerCase() +
          (typeof el.className === "string" && el.className.trim()
            ? "." + el.className.trim().split(/\s+/).slice(0, 3).join(".")
            : ""),
        ratio: ratio(fgFlat, bg),
        size: parseFloat(s.fontSize),
        weight: Number(s.fontWeight) || 400,
        fg: `rgb(${fgFlat.map((x) => Math.round(x)).join(",")})`,
        bg: `rgb(${bg.map((x) => Math.round(x)).join(",")})`,
        text: el.textContent.trim().slice(0, 40),
      });
    }
    return rows;
  });
}

let totalIssues = 0;
for (const scheme of SCHEMES) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 1000 });
  for (const route of ROUTES) {
    const rows = await auditInPage(page, scheme, route);
    const bad = new Map();
    for (const r of rows) {
      const large = r.size >= 24 || (r.size >= 18.66 && r.weight >= 700);
      const need = large ? 3 : 4.5;
      if (r.ratio < need) {
        const key = `${r.sel}|${r.fg}|${r.bg}`;
        if (!bad.has(key)) bad.set(key, { ...r, need });
      }
    }
    totalIssues += bad.size;
    console.log(`\n== ${scheme || "auto"} /${route || ""}   采样文本 ${rows.length}，不达标 ${bad.size}`);
    for (const b of bad.values()) {
      console.log(`   ${b.ratio.toFixed(2)}:1 (需 ${b.need})  ${b.sel}  ${b.fg} on ${b.bg}  "${b.text}"`);
    }
  }
  await page.close();
}

await browser.close();
console.log(`\n合计不达标项：${totalIssues}`);
if (STRICT && totalIssues > 0) process.exit(1);
