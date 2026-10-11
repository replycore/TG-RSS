/**
 * 路由解析回归（public/route.js，零副作用可直接单测）：
 *  - 坏百分号序列（#/c/%E4）不再抛 URIError 杀死路由（此前首屏卡死）
 *  - 正常路由解析不受影响（feed / channel / media / admin / ?tag=）
 */
import test from "node:test";
import assert from "node:assert/strict";
import { parseRoute } from "../public/route.js";

function withHash(hash) {
  globalThis.location = { hash };
  return parseRoute();
}

test("parseRoute：坏 hash 容错（decodeURIComponent 抛错时返回原值）", () => {
  assert.deepEqual(withHash("#/c/%E4"), { name: "channel", key: "%E4" }, "半个 UTF-8 序列不应炸");
  assert.deepEqual(withHash("#/c/%ZZ"), { name: "channel", key: "%ZZ" }, "非法 % 序列容错");
  assert.deepEqual(withHash("#/media/video/%E4%B8"), { name: "media", type: "video", key: "%E4%B8" });
});

test("parseRoute：正常解析不受影响", () => {
  assert.deepEqual(withHash("#/"), { name: "feed" });
  assert.deepEqual(withHash(""), { name: "feed" });
  assert.deepEqual(withHash("#/"), { name: "feed" });
  assert.deepEqual(withHash("#/c/telegram"), { name: "channel", key: "telegram" });
  assert.deepEqual(withHash("#/c/telegram?tag=AI"), { name: "channel", key: "telegram", tag: "AI" });
  assert.deepEqual(withHash("#/?tag=科技"), { name: "feed", tag: "科技" });
  assert.deepEqual(withHash("#/media/video"), { name: "media", type: "video", key: "" });
  assert.deepEqual(withHash("#/admin/channels"), { name: "admin", tab: "channels" });
  assert.deepEqual(withHash("#/c/%E7%A7%91%E6%8A%80"), { name: "channel", key: "科技" }, "合法中文编码正常解码");
  assert.deepEqual(withHash("#/unknown"), { name: "feed" }, "未知路径回退信息流");
});
