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
  assert.equal(containsAdKeywords(post), true, "内置关键词'优惠券' 命中");
});

test("containsAdKeywords：内置关键词不区分大小写", () => {
  assert.equal(containsAdKeywords({ text: "限时优惠券", textPlain: "限时优惠券" }), true);
  assert.equal(containsAdKeywords({ text: "SPONSORED post", textPlain: "SPONSORED post" }), true);
  assert.equal(containsAdKeywords({ text: "sponsored post", textPlain: "sponsored post" }), true);
  assert.equal(containsAdKeywords({ text: "退款失败", textPlain: "退款失败" }), true);
});

test("containsAdKeywords：正常内容不误伤（回归）", () => {
  const normal = [
    "这个开源项目完全免费，代码在 GitHub 上",
    "Telegram 新增了免费的表情包功能",
    "推荐一个基金定投的入门教程",
    "我们和隔壁团队合作完成了这个项目",
    "在京东买了个键盘，手感不错",
    "今天的股市行情：上证指数上涨 1.2%",
    "关注我的微信公众号获取更多内容",
    "今天天气晴朗，适合出门散步",
  ];
  for (const text of normal) {
    assert.equal(containsAdKeywords({ textPlain: text }), false, `不应误判为广告：${text}`);
  }
});

test("containsAdKeywords：ASCII 关键词按词边界匹配", () => {
  assert.equal(containsAdKeywords({ textPlain: "staff meeting notes" }), false, "staff 不应命中");
  assert.equal(containsAdKeywords({ textPlain: "an affair to remember" }), false, "affair 不应命中");
  assert.equal(containsAdKeywords({ textPlain: "grab the affiliate link" }), true);
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
  const post = { text: "优惠券+秒杀", textPlain: "优惠券+秒杀" };
  assert.equal(containsAdKeywords(post), true);
});

/* -------- isAdPost 组合 -------- */

test("isAdPost：标签不命中，正文命中关键词 → 广告", () => {
  const post = { text: "免费秒杀", textPlain: "免费秒杀", tags: ["日常"] };
  assert.equal(isAdPost(post, [], []), true, "正文'秒杀'命中内置关键词");
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

/* -------- isAdPost：无 tag 帖子的关键词检测（回归） -------- */

test("isAdPost：无 tag 但正文命中关键词 → 广告（此前被短路漏网）", () => {
  const post = { text: "免费秒杀", textPlain: "免费秒杀", tags: [] };
  assert.equal(isAdPost(post, [], []), true, "无 tag 时正文关键词也应生效");
  const post2 = { text: "加Vwood123", textPlain: "加Vwood123" }; // tags 缺失
  assert.equal(isAdPost(post2, [], ["wood"]), true, "tags 字段缺失时自定义关键词也应生效");
});

test("isAdPost：无 tag 且正文不命中 → 非广告", () => {
  const post = { text: "今天很开心", textPlain: "今天很开心", tags: [] };
  assert.equal(isAdPost(post, [], []), false);
});
