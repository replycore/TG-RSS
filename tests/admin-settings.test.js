/**
 * saveSettings 原子性回归：
 *  - 校验失败（如非法桥接地址）→ 抛 400 且任何 KV 都不落盘
 *    （此前：错误抛出前 patch 已写入 KV → 媒体代理/私密抓取拿着脏配置持续 500）
 *  - 校验通过 → 正常写入
 */
import test from "node:test";
import assert from "node:assert/strict";

import { createSession } from "../src/store.js";
import { saveSettings, getSettings } from "../src/api/admin.js";

class MockKV {
  constructor() { this.map = new Map(); }
  async get(key, type) {
    const raw = this.map.get(key);
    if (raw == null) return null;
    return type === "json" ? JSON.parse(raw) : raw;
  }
  async put(key, value) { this.map.set(key, String(value)); }
  async delete(key) { this.map.delete(key); }
}

async function authedReq(e) {
  const token = await createSession(e, { username: "root" });
  return {
    headers: { get: (k) => (String(k).toLowerCase() === "cookie" ? `tgrss_session=${token}` : null) },
  };
}

test("非法桥接地址：400 且 bridge/general 都不落盘", async () => {
  const e = { TG_RSS_KV: new MockKV() };
  const req = await authedReq(e);
  await assert.rejects(
    () => saveSettings(req, e, {
      general: { siteTitle: "should-not-persist" },
      bridge: { url: "ftp://bad", enabled: true, token: "t" },
    }),
    (err) => err.status === 400 && /http/.test(err.message),
    "应抛 400 并提示协议问题",
  );
  assert.equal(e.TG_RSS_KV.map.has("settings:bridge"), false, "非法 URL 不得写入 KV");
  assert.equal(e.TG_RSS_KV.map.has("settings:general"), false, "同一请求里其它 section 也不得落盘（原子性）");
});

test("桥接地址 'https://'（无主机名）拒绝，不落盘", async () => {
  // Bug B：仅前缀匹配会放过 "https://"，strip 尾斜杠后变 "https:" 入库 → 媒体代理全挂
  const e = { TG_RSS_KV: new MockKV() };
  const req = await authedReq(e);
  await assert.rejects(
    () => saveSettings(req, e, { bridge: { url: "https://", enabled: true, token: "t" } }),
    (err) => err.status === 400 && /URL/.test(err.message),
  );
  assert.equal(e.TG_RSS_KV.map.has("settings:bridge"), false, "不得落盘");
});

test("合法桥接地址：正常写入", async () => {
  const e = { TG_RSS_KV: new MockKV() };
  const req = await authedReq(e);
  const res = await saveSettings(req, e, {
    bridge: { url: "https://bridge.example.com/", enabled: true, token: "secret" },
  });
  assert.equal(res.ok, true);
  assert.equal(res.bridge.url, "https://bridge.example.com", "尾部斜杠去除");
  assert.equal(res.bridge.enabled, true);
});

test("channels 校验失败：也不得写入", async () => {
  const e = { TG_RSS_KV: new MockKV() };
  const req = await authedReq(e);
  await assert.rejects(
    () => saveSettings(req, e, { channels: [{ type: "public", username: "bad name!" }] }),
    (err) => err.status === 400,
  );
  assert.equal(e.TG_RSS_KV.map.has("settings:channels"), false);
});
