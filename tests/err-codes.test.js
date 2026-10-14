/**
 * 服务端 HttpError code 覆盖回归：src/ 里的每个错误码，要么在 public/api.js 的
 * err_* 翻译表里（en 模式显示英文），要么在动态文案白名单里（带诊断细节，
 * 如校验原因/NTP 时钟差/上游状态码，进静态表会丢信息，故保留回退服务端原文）。
 * 新增服务端 code 未进表时此测试失败，提醒补齐。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(dir, "..");

// 动态文案码：服务端消息含诊断细节，不进静态翻译表（见 public/api.js 注释）
const DYNAMIC_CODES = new Set([
  "bad_channel", // validateChannel 的具体校验原因
  "bridge_denied", // 含 NTP 时钟差提示
  "bridge_error", // 含上游状态码
  "bridge_unreachable", // 含底层错误信息
  "upstream_status", // 含上游状态码
]);

async function walkJs(d, out = []) {
  for (const e of await readdir(d, { withFileTypes: true })) {
    if (e.name === "node_modules") continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) await walkJs(p, out);
    else if (e.name.endsWith(".js")) out.push(p);
  }
  return out;
}

test("err-code：服务端每个 HttpError code 都有翻译或在动态白名单", async () => {
  const apiSrc = await readFile(path.join(root, "public", "api.js"), "utf8");
  const tableCodes = new Set([...apiSrc.matchAll(/err_([a-z_0-9]+)\s*:/g)].map((m) => m[1]));

  const serverCodes = new Set();
  for (const f of await walkJs(path.join(root, "src"))) {
    const src = await readFile(f, "utf8");
    // HttpError(400, "msg", "code") 与 HttpError(status, `...`, "code") 两种形态
    for (const m of src.matchAll(/HttpError\(\s*[^,]+,\s*(?:"[^"]*"|`[^`]*`|[a-zA-Z_$][\w$.]*)\s*,\s*"([a-z_0-9]+)"\s*\)/g)) {
      serverCodes.add(m[1]);
    }
  }
  assert.ok(serverCodes.size >= 40, `应扫到 40+ 服务端 code，实际 ${serverCodes.size}`);

  const missing = [...serverCodes].filter((c) => !tableCodes.has(c) && !DYNAMIC_CODES.has(c));
  assert.deepEqual(missing, [], `以下服务端 code 既无翻译又不在动态白名单：${missing.join(", ")}`);

  // 翻译表每项必须有 zh+en（避免 en 模式回退中文）
  for (const c of tableCodes) {
    const m = apiSrc.match(new RegExp(`err_${c}:\\s*\\{\\s*zh:\\s*"[^"]+",\\s*en:\\s*"[^"]+"`));
    assert.ok(m, `err_${c} 必须有 zh+en 双语`);
  }
});
