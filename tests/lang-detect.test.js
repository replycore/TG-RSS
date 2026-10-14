/** i18n 浏览器语言检测回归：en 用英文/中文区用中文/Node 跳过/保存值优先
 *  （依赖 Node 全局状态增删，四个分支共享状态必须串行写在一个 test() 内） */
import test from "node:test";
import assert from "node:assert/strict";

test("语言检测四分支：浏览器按 navigator.language，Node 跳过，保存值优先", async () => {

  // 分支1/2：删除 process = 模拟浏览器（typeof process === "undefined"）
  const navDesc = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const proc = globalThis.process; // 先存引用：delete 后裸标识符 process 也会消失
  function freshI18n(lang) {
    // 覆盖 navigator.language
    const fake = { ...globalThis.navigator, language: lang };
    Object.defineProperty(globalThis, "navigator", { value: fake, configurable: true });
    delete globalThis.process; // 浏览器无 process
    delete globalThis.localStorage;
    return import(`../public/i18n.js?case=${lang}-${Math.random()}`);
  }

  // en-US → 英文
  let m = await freshI18n("en-US");
  assert.equal(m.getLang(), "en", "en-US 浏览器应默认英文");

  // zh-CN → 中文
  m = await freshI18n("zh-CN");
  assert.equal(m.getLang(), "zh-CN", "zh-CN 浏览器应默认中文");

  // en-GB 前缀
  m = await freshI18n("en-GB");
  assert.equal(m.getLang(), "en", "en-GB 应默认英文");

  // 分支3：存在 process（Node/测试环境）→ 跳过检测保持 zh-CN
  if (navDesc) Object.defineProperty(globalThis, "navigator", navDesc);
  globalThis.process = proc;
  delete globalThis.localStorage;
  m = await import(`../public/i18n.js?case=withprocess-${Math.random()}`);
  assert.equal(m.getLang(), "zh-CN", "Node 环境应跳过检测保持默认中文");

  // 分支4：localStorage 有保存值 → 保存值优先（浏览器）
  globalThis.localStorage = {
    getItem: (k) => (k === "tg_rss_lang" ? "zh-CN" : null),
    setItem: () => {},
    removeItem: () => {},
  };
  delete globalThis.process;
  Object.defineProperty(globalThis, "navigator", { value: { ...navDesc?.value, language: "en-US" }, configurable: true });
  m = await import(`../public/i18n.js?case=saved-${Math.random()}`);
  assert.equal(m.getLang(), "zh-CN", "已保存值应优先于浏览器语言");

  // 全部分支断言通过
});
