/**
 * 服务端 HttpError code 覆盖回归：src/ 里的每个错误码，要么在 public/api.js 的
 * err_* 翻译表里（en 模式显示英文），要么在动态文案白名单里（暂空，机制保留）。
 * 动态文案码（消息含校验原因/NTP 时钟差/上游状态码等诊断细节）进表时必须带
 * {msg} 占位符——细节随 msg 透传不丢，见下方 DYN_MSG_CODES 断言。
 * 新增服务端 code 未进表时此测试失败，提醒补齐。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(dir, "..");

// 动态文案白名单：当前为空（5 个动态码已用 {msg} 形式进表，见 DYN_MSG_CODES）。
// 机制保留：将来若有无法用 {msg} 表达的服务端文案码，加到这里即可豁免。
const DYNAMIC_CODES = new Set([]);
// 必须带 {msg} 的动态文案码：去掉占位符会丢服务端诊断细节
const DYN_MSG_CODES = ["bad_channel", "bridge_denied", "bridge_error", "bridge_unreachable", "upstream_status"];

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

  // 动态文案码的词条必须带 {msg}：既进表显示英文框架，又保留服务端诊断细节
  for (const c of DYN_MSG_CODES) {
    const m = apiSrc.match(new RegExp(`err_${c}:\\s*\\{\\s*zh:\\s*"([^"]*)",\\s*en:\\s*"([^"]*)"`));
    assert.ok(m, `err_${c} 应有词条`);
    assert.ok(m[1].includes("{msg}") && m[2].includes("{msg}"), `err_${c} 的 zh/en 都必须含 {msg} 占位符`);
  }
});
