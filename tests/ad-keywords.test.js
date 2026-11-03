/**
 * 广告关键词过滤回归：
 *  - 内置关键词命中 → 视为广告
 *  - 自定义关键词命中 → 视为广告
 *  - 大小写不敏感
 *  - 无正文时不触发
 */
import test from "node:test";
import assert from "node:assert/strict";
import { isAdPost, containsAdKeywords, AD_KEYWORDS } from "../src/util.js";

/* -------- containsAdKeywords 单元 -------- */

test("containsAdKeywords：内置关键词命中", () => {
  const post = { text: "免费领优惠券", textPlain: "免费领优惠券" };
  assert.equal(containsAdKeywords(post), true, "内置关键词'免费' 命中");
});

test("containsAdKeywords：内置关键词不区分大小写", () => {
  const post = { text: "免费优惠", textPlain: "免费优惠" };
  assert.equal(containsAdKeywords(post), true);
  const post2 = { text: "混 合 免费", textPlain: "混 合 免费" };
  assert.equal(containsAdKeywords(post2), true);
  const post3 = { text: "退款失败", textPlain: "退款失败" };
  assert.equal(containsAdKeywords(post3), true);
});

test("containsAdKeywords：自定义关键词命中", () => {
  const post = { text: "我的自定义推广词", textPlain: "我的自定义推广词" };
  assert.equal(containsAdKeywords(post, ["推广词"]), true);
});

test("containsAdKeywords：无正文不触发", () => {
  assert.equal(containsAdKeywords({}), false);
  assert.equal(containsAdKeywords({ text: "" }), false);
  assert.equal(containsAdKeywords({ text: null }), false);
});

test("containsAdKeywords：关键词不在本列表中，不触发", () => {
  const post = { text: "今天天气晴朗", textPlain: "今天天气晴朗" };
  assert.equal(containsAdKeywords(post), false);
});

test("containsAdKeywords：包含多个内置词，命中一个即 true", () => {
  const post = { text: "免费领优惠券+免费试用", textPlain: "免费领优惠券+免费试用" };
  assert.equal(containsAdKeywords(post), true);
});

/* -------- isAdPost 组合 -------- */

test("isAdPost：标签不命中，正文命中关键词 → 广告", () => {
  const post = { text: "免费秒杀", textPlain: "免费秒杀", tags: ["日常"] };
  assert.equal(isAdPost(post, [], []), true, "正文'免费秒杀'命中内置关键词");
});

test("isAdPost：标签不命中，正文不命中 → 非广告", () => {
  const post = { text: "今天很开心", textPlain: "今天很开心", tags: ["日常"] };
  assert.equal(isAdPost(post, [], []), false);
});

test("isAdPost：标签命中 → 广告（原有行为）", () => {
  const post = { tags: ["广告"] };
  assert.equal(isAdPost(post, [], []), true);
});

test("isAdPost：自定义关键词命中 → 广告", () => {
  const post = { text: "加Vwood123", textPlain: "加Vwood123", tags: ["日常"] };
  assert.equal(isAdPost(post, [], ["wood"]), true, "自定义关键词'wood'命中");
});

test("是 AdPost 返回 false 当且仅当 tags 和正文均无匹配", () => {
  const post = { text: "经济日报", textPlain: "经济日报", tags: ["新闻"] };
  assert.equal(isAdPost(post, [], []), false);
});
