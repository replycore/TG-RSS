/**
 * 截图工具：给能够查看图片的 agent / 人工验收用。
 *
 * 用法：
 *   node tools/screenshot.mjs                      # 线上
 *   BASE=http://localhost:8787 node tools/screenshot.mjs --out ./shots
 *   node tools/screenshot.mjs --scheme light
 *
 * 输出：shots/dark-home.png、dark-media.png、dark-admin.png、light-*.png
 */
import fs from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer";

const args = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};

const BASE = process.env.BASE || "http://localhost:8787";
const OUT = path.resolve(argOf("--out", "./shots"));
const ONLY = argOf("--scheme", "");

const ROUTES = [
  ["home", ""],
  ["media", "#/media/video"],
  ["admin", "#/admin"],
  ["channel", "#/c/telegram"],
];

fs.mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
});

const schemes = ONLY ? [ONLY] : ["dark", "light"];
for (const scheme of schemes) {
  for (const [name, route] of ROUTES) {
    const page = await browser.newPage();
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: scheme }]);
    await page.setViewport({ width: 1280, height: 960 });
    try {
      await page.goto(`${BASE}/${route}`, { waitUntil: "networkidle2", timeout: 60000 });
      await new Promise((r) => setTimeout(r, 2500));
      const file = path.join(OUT, `${scheme}-${name}.png`);
      await page.screenshot({ path: file });
      const theme = await page.evaluate(() => ({
        dataTheme: document.documentElement.dataset.theme,
        colorScheme: getComputedStyle(document.documentElement).colorScheme,
        bodyBg: getComputedStyle(document.body).backgroundColor,
        bodyColor: getComputedStyle(document.body).color,
      }));
      console.log("ok", file, JSON.stringify(theme));
    } catch (err) {
      console.log("fail", scheme, name, err.message);
    } finally {
      await page.close();
    }
  }
}

await browser.close();
