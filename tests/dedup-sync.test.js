/**
 * Nit 2：normalizeChannelInput 前后端双维护漂移检测。
 * public/admin.js 是前端副本（静态资源无法 import src/），与 src/util.js 各维护一份。
 * 这里提取两处 normalizeChannelInput + cleanUsername 的函数体，去注释/空白后逐字比对，
 * 一旦有人只改了一端，本测试即失败——避免「前端预览正常、点保存才被后端 400 打回」。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function extractFunc(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`找不到 ${name}`);
  // 从函数起始的 { 配对到结束 }
  let i = src.indexOf("{", start);
  let depth = 0;
  for (let j = i; j < src.length; j += 1) {
    if (src[j] === "{") depth += 1;
    else if (src[j] === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(start, j + 1);
    }
  }
  throw new Error(`${name} 括号不配对`);
}

function strip(s) {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, "") // 块注释
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1") // 行注释（避开 URL 的 //）
    .replace(/\s+/g, "")
    .replace(/;+/g, ";");
}

function read(rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

test("前后端 normalizeChannelInput / cleanUsername 保持同步（Nit 2 漂移检测）", () => {
  for (const fn of ["normalizeChannelInput", "cleanUsername"]) {
    const be = extractFunc(read("src/util.js"), fn);
    const fe = extractFunc(read("public/admin.js"), fn);
    assert.equal(
      strip(be),
      strip(fe),
      `${fn} 前后端实现已漂移：src/util.js 与 public/admin.js 必须同步修改`,
    );
  }
});
