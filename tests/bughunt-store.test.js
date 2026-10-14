/**
 * Bug-hunt 回归（服务端批）：
 * 1) 私密频道 key 命名空间：priv:-<tgId>，与公开用户名 p<数字> 不再相撞
 * 2) migrateLegacyPrivateKeys：旧 p<数字> key 的 KV 数据迁移（幂等）
 * 3) bumpRateLimit 并发：独立 key + list 聚合，10 并发记账不丢
 * 4) rss-auth failConsume：同形状修复，20 次后 429
 * 5) handleChangePassword：先 bump 纪元再写新密码（fail-closed 顺序）
 * 6) bridge loadEnv：引号感知注释剥离 / 多行值 / 转义 / 未闭合抛错 / PORT 校验
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  normalizeChannel,
  migrateLegacyPrivateKeys,
  bumpRateLimit,
  checkRateLimit,
  consumeRateLimit,
  resetRateLimit,
  createAdminCredential,
  createSession,
  getSession,
  KEYS,
  readJSON,
  writeJSON,
} from "../src/store.js";
import { checkRssToken } from "../src/rss-auth.js";
import { handleChangePassword } from "../src/auth.js";
import { loadEnv } from "../bridge/config.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(dir, "..");

/** 内存 KV（含 list，形状与 Workers KV 一致） */
function mockKV() {
  const map = new Map();
  const expiries = new Map();
  const live = (k) => {
    const exp = expiries.get(k);
    if (exp && exp <= Date.now()) {
      map.delete(k);
      expiries.delete(k);
      return false;
    }
    return map.has(k);
  };
  return {
    _map: map,
    async get(k, type) {
      if (!live(k)) return null;
      const raw = map.get(k);
      if (raw == null) return null;
      return type === "json" ? JSON.parse(raw) : raw;
    },
    async put(k, v, opts = {}) {
      map.set(k, typeof v === "string" ? v : JSON.stringify(v));
      if (opts.expirationTtl) expiries.set(k, Date.now() + opts.expirationTtl * 1000);
      else expiries.delete(k);
    },
    async delete(k) {
      map.delete(k);
      expiries.delete(k);
    },
    async list({ prefix = "" } = {}) {
      const names = [...map.keys()].filter((k) => k.startsWith(prefix) && live(k));
      return { keys: names.map((name) => ({ name })), list_complete: true, cursor: undefined };
    },
  };
}
const env = () => ({ TG_RSS_KV: mockKV() });

/* ---------------------------------------------------------- 1) key 命名空间 */

test("私密 key 用 priv: 命名空间，与公开用户名 p<数字> 不相撞", () => {
  const priv = normalizeChannel({ type: "private", tgId: "-1001234567890", name: "私密" });
  assert.equal(priv.key, "priv:-1001234567890");
  const pub = normalizeChannel({ type: "public", username: "p12345", name: "公开" });
  assert.equal(pub.key, "p12345");
  assert.notEqual(priv.key, pub.key, "公开 p12345 与私密 -12345 的 key 必须不同");
  // 历史正数脏数据归一化后 key 一致
  assert.equal(normalizeChannel({ type: "private", tgId: "1001234567890" }).key, "priv:-1001234567890");
});

/* ---------------------------------------------------------- 2) 存量迁移 */

test("migrateLegacyPrivateKeys：旧 p<数字> key 的 meta 迁移到新 key（幂等）", async () => {
  const e = env();
  const kv = e.TG_RSS_KV;
  await writeJSON(e, KEYS.channels, [
    { type: "private", tgId: "-100111", name: "旧私密", key: "p100111", order: 0 },
    { type: "public", username: "p222", name: "公开p222", key: "p222", order: 1 },
    { type: "private", tgId: "-100333", name: "新私密", key: "priv:-100333", order: 2 },
  ]);
  await writeJSON(e, KEYS.meta + "p100111", { title: "旧元信息" }, { expirationTtl: 3600 });

  const r1 = await migrateLegacyPrivateKeys(e);
  assert.equal(r1.migrated, 1, "只迁移 1 个 legacy 私密频道");
  assert.deepEqual(await readJSON(e, KEYS.meta + "priv:-100111", null), { title: "旧元信息" }, "meta 拷贝到新 key");
  assert.equal(await readJSON(e, KEYS.meta + "p100111", null), null, "旧 key 数据删除");
  const list = await readJSON(e, KEYS.channels, null);
  assert.equal(list[0].key, "priv:-100111", "频道列表 key 更新");
  assert.equal(list[1].key, "p222", "公开 p222 不动");
  assert.equal(list[2].key, "priv:-100333", "已是新格式的不动");

  const r2 = await migrateLegacyPrivateKeys(e);
  assert.equal(r2.migrated, 0, "第二次运行是 no-op");
  assert.equal(await readJSON(e, KEYS.meta + "p100111", null), null);
});

/* ---------------------------------------------------------- 3) 限流并发 */

test("bumpRateLimit：10 并发记账不丢（旧实现只剩 1）", async () => {
  const e = env();
  const ip = `9.9.9.${Date.now() % 250}`;
  const results = await Promise.all(Array.from({ length: 10 }, () => bumpRateLimit(e, ip)));
  const counts = results.map((r) => r.count);
  assert.equal(Math.max(...counts), 10, `并发 10 次后计数应为 10，实际最大 ${Math.max(...counts)}`);
});

test("consumeRateLimit：8 次放行、第 9 次拒绝；reset 后恢复", async () => {
  const e = env();
  const ip = `10.0.0.${Date.now() % 250}`;
  for (let i = 0; i < 8; i += 1) {
    const r = await consumeRateLimit(e, ip);
    assert.equal(r.allowed, true, `第 ${i + 1} 次应放行`);
  }
  const denied = await consumeRateLimit(e, ip);
  assert.equal(denied.allowed, false, "第 9 次应拒绝");
  assert.ok((await checkRateLimit(e, ip)).allowed === false, "check 也应拒绝");
  await resetRateLimit(e, ip);
  assert.equal((await checkRateLimit(e, ip)).allowed, true, "reset 后恢复");
  // 同一 IP 再记账：reset 删掉了全部独立 key，计数从 0 开始
  const r = await consumeRateLimit(e, ip);
  assert.equal(r.allowed, true);
  assert.equal(r.remaining, 7);
});

/* ---------------------------------------------------------- 4) rss 失败限流 */

test("checkRssToken：错误令牌 20 次内记账、第 21 次 429", async () => {
  const e = env();
  const ip = `172.16.0.${Date.now() % 250}`;
  const req = { headers: { get: (k) => (String(k).toLowerCase() === "cf-connecting-ip" ? ip : null) } };
  const url = new URL("https://x/rss.xml?token=wrong-token");
  for (let i = 0; i < 20; i += 1) {
    const r = await checkRssToken(req, e, url);
    assert.equal(r.state, "invalid", `第 ${i + 1} 次应为 invalid 而非抛错`);
  }
  await assert.rejects(() => checkRssToken(req, e, url), (err) => err.code === "rate_limited", "第 21 次应 429");
});

/* ---------------------------------------------------------- 5) 改密码顺序 */

test("handleChangePassword：先 bump 纪元再写新密码（fail-closed）", async () => {
  const puts = [];
  const base = mockKV();
  const kv = {
    ...base,
    async put(k, v, opts) {
      puts.push(k);
      return base.put(k, v, opts);
    },
  };
  const e = { TG_RSS_KV: kv };
  await createAdminCredential(e, "admin", "old-password-123");
  const token = await createSession(e, { username: "admin" });
  const req = { headers: { get: (k) => (String(k).toLowerCase() === "cookie" ? `tgrss_session=${token}` : null) } };

  const res = await handleChangePassword(req, e, { currentPassword: "old-password-123", newPassword: "new-password-456" });
  assert.equal(res.ok, true);
  const epochIdx = puts.lastIndexOf("auth:epoch");
  const credIdx = puts.lastIndexOf("admin:cred");
  assert.ok(epochIdx >= 0 && credIdx >= 0, "两次 KV 写入都应发生");
  assert.ok(epochIdx < credIdx, `应先写 auth:epoch(${epochIdx}) 再写 admin:cred(${credIdx})`);
  assert.equal(await getSession(e, token), null, "旧会话必须失效");
});

/* ---------------------------------------------------------- 6) loadEnv */

function writeEnvFile(name, content) {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dotenv-")), name);
  fs.writeFileSync(p, content);
  return p;
}

test("loadEnv：引号感知剥注释", () => {
  const p = writeEnvFile(".env", 'BRIDGE_TOKEN="abc" # 备注\nK2="a # b"\nK3=val # comment\nK4=a#b\n');
  const out = loadEnv(p);
  assert.equal(out.BRIDGE_TOKEN, "abc", "引号值后的注释剥离后不应保留引号");
  assert.equal(out.K2, "a # b", "双引号内的 # 保留");
  assert.equal(out.K3, "val", "未加引号剥离注释");
  assert.equal(out.K4, "a#b", "无空格的 # 保留（沿用旧行为）");
});

test("loadEnv：单引号 / export 前缀 / 空行注释", () => {
  const p = writeEnvFile(".env", "# 全行注释\n\nexport K1='x y'\nK2=\"\"\n");
  const out = loadEnv(p);
  assert.equal(out.K1, "x y");
  assert.equal(out.K2, "");
});

test("loadEnv：双引号多行值 + 转义", () => {
  const p = writeEnvFile(".env", 'K="line1\nline2"\nE="a\\"b\\\\c\\nd"\n');
  const out = loadEnv(p);
  assert.equal(out.K, "line1\nline2", "多行值保留换行");
  assert.equal(out.E, 'a"b\\c\nd', "转义处理");
});

test("loadEnv：未闭合引号抛错；单个引号字符按普通字符", () => {
  const bad = writeEnvFile(".env", 'K="abc\n');
  assert.throws(() => loadEnv(bad), /未闭合/, "未闭合双引号应抛错而非静默截断");
  const single = writeEnvFile(".env", 'K="\n');
  assert.equal(loadEnv(single).K, '"', '单个 " 按普通字符处理');
});

/* ---------------------------------------------------------- 7) PORT 校验 */

function importConfigWithPort(portValue) {
  const env = { ...process.env };
  if (portValue === undefined) delete env.PORT;
  else env.PORT = portValue;
  return execFileSync(
    process.execPath,
    ["-e", `import(${JSON.stringify(path.join(repoRoot, "bridge", "config.js"))}).then((m) => console.log("PORT=" + m.config.port))`],
    { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
}

test("PORT：非法值启动抛错，合法值通过", () => {
  assert.throws(() => importConfigWithPort("99999"), /PORT/, "99999 应抛错");
  assert.throws(() => importConfigWithPort("0"), /PORT/, "0 应抛错");
  assert.throws(() => importConfigWithPort("-1"), /PORT/, "-1 应抛错");
  assert.throws(() => importConfigWithPort("abc"), /PORT/, "非数字应抛错");
  assert.ok(importConfigWithPort("8788").includes("PORT=8788"), "8788 通过");
  assert.ok(importConfigWithPort("1").includes("PORT=1"), "1 通过");
  assert.ok(importConfigWithPort(undefined).includes("PORT=8788"), "缺省 8788");
});
