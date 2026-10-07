import test from "node:test";
import assert from "node:assert/strict";

import {
  sanitizeHtml,
  htmlToText,
  escapeHtml,
  b64urlEncode,
  b64urlDecodeToString,
  encodeState,
  decodeState,
  serializeCookie,
  parseCookies,
  pbkdf2Hex,
  sha256Hex,
  timingSafeEqual,
  randomToken,
  isValidToken,
  clampInt,
  styleUrl,
  absoluteUrl,
  decodeDataView,
  mapPool,
} from "../src/util.js";

test("sanitizeHtml：只保留白名单标签", () => {
  const out = sanitizeHtml('<b>x</b><iframe src="evil"></iframe><img src=x onerror=alert(1)>');
  assert.equal(out, "<b>x</b>");
});

test("sanitizeHtml：链接强制安全属性", () => {
  const out = sanitizeHtml('<a href="https://a.com/x?a=1&amp;b=2">link</a>');
  // 属性值里的 & 需保持实体形式，浏览器渲染为 a=1&b=2
  assert.match(out, /href="https:\/\/a\.com\/x\?a=1&amp;b=2"/);
  assert.match(out, /target="_blank"/);
  assert.match(out, /rel="noopener noreferrer nofollow"/);
});

test("sanitizeHtml：危险协议被剥离但保留文字", () => {
  const out = sanitizeHtml('<a href="javascript:alert(1)">click</a>');
  assert.ok(!out.includes("javascript:"));
  assert.match(out, /click/);
});

test("sanitizeHtml：转义裸尖括号，丢弃未知标签", () => {
  const out = sanitizeHtml("1 < 2 && 3 > 2 <notatag>tail</notatag>");
  assert.ok(!out.includes("<notatag>"), "未知标签必须移除");
  assert.match(out, /1 &lt; 2/);
  assert.match(out, /tail/, "未知标签的内容应保留");
});

test("sanitizeHtml：script/style 连同内容一起丢弃", () => {
  const out = sanitizeHtml("a<script>alert('x')</script>b<style>body{}</style>c");
  assert.ok(!out.includes("alert"));
  assert.ok(!out.includes("body{"));
  assert.match(out, /a/);
  assert.match(out, /c/);
});

test("htmlToText / escapeHtml", () => {
  assert.equal(htmlToText("<b>a</b><br>b"), "a\nb");
  assert.equal(escapeHtml('<a href="x">'), '&lt;a href=&quot;x&quot;&gt;');
  assert.equal(sanitizeHtml(""), "");
  assert.equal(sanitizeHtml(null), "");
});

test("b64url / state 编解码", () => {
  const s = JSON.stringify({ a: 1, 中文: "值" });
  assert.equal(b64urlDecodeToString(b64urlEncode(s)), s);
  assert.ok(!/[+/=]/.test(b64urlEncode(s)), "不能出现 + / =");
  assert.deepEqual(decodeState(encodeState({ x: 1 })), { x: 1 });
  assert.deepEqual(decodeState("!!!not-base64!!!"), null);
  assert.deepEqual(decodeState(null, { d: 1 }), { d: 1 });
});

test("Cookie 序列化与解析", () => {
  const cookie = serializeCookie("tok", "abc 123", { maxAge: 60, secure: true });
  assert.match(cookie, /^tok=abc%20123/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /Max-Age=60/);

  const parsed = parseCookies({ headers: { get: (k) => (k === "cookie" ? "a=1; tok=abc%20123" : null) } });
  assert.equal(parsed.a, "1");
  assert.equal(parsed.tok, "abc 123");
});

test("PBKDF2 与 SHA-256 稳定且盐值敏感", async () => {
  const h1 = await pbkdf2Hex("password123", "00112233445566778899aabbccddeeff", 1000);
  const h2 = await pbkdf2Hex("password123", "00112233445566778899aabbccddeeff", 1000);
  const h3 = await pbkdf2Hex("password123", "ffeeddccbbaa99887766554433221100", 1000);
  assert.equal(h1, h2);
  assert.notEqual(h1, h3);
  assert.equal(h1.length, 64);
  assert.equal((await sha256Hex("abc")).length, 64);
});

test("timingSafeEqual", () => {
  assert.ok(timingSafeEqual("abc", "abc"));
  assert.ok(!timingSafeEqual("abc", "abd"));
  assert.ok(!timingSafeEqual("abc", "abcd"));
});

test("token 生成与校验", () => {
  const t = randomToken(32);
  assert.ok(t.length > 20);
  assert.ok(isValidToken(t) || /^[A-Za-z0-9_-]+$/.test(t));
  assert.ok(!isValidToken("short"));
  assert.ok(!isValidToken("<script>"));
});

test("clampInt", () => {
  assert.equal(clampInt("10", 5, 50, 20), 10);
  assert.equal(clampInt("999", 5, 50, 20), 50);
  assert.equal(clampInt("abc", 5, 50, 20), 20);
  assert.equal(clampInt(undefined, 5, 50, 20), 20);
});

test("styleUrl / absoluteUrl / decodeDataView", () => {
  assert.equal(styleUrl("width:10px;background-image:url('https://a/b.jpg')"), "https://a/b.jpg");
  assert.equal(styleUrl(null), null);
  assert.equal(absoluteUrl("/foo"), "https://t.me/foo");
  assert.equal(absoluteUrl("not a url"), null);
  const view = b64urlEncode(JSON.stringify({ c: -1001, p: 42 }));
  assert.deepEqual(decodeDataView(view), { c: -1001, p: 42 });
  assert.deepEqual(decodeDataView("zzz"), {});
});

test("mapPool 保序且限流", async () => {
  let active = 0;
  let peak = 0;
  const items = [1, 2, 3, 4, 5, 6, 7];
  const out = await mapPool(items, 3, async (n) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 5));
    active -= 1;
    return n * 2;
  });
  assert.deepEqual(out, [2, 4, 6, 8, 10, 12, 14]);
  assert.ok(peak <= 3, `peak=${peak}`);
});
