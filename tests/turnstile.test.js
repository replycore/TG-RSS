import test from "node:test";
import assert from "node:assert/strict";
import { turnstileEnabled, turnstileSiteKey, verifyTurnstile } from "../src/turnstile.js";

test("#9 只配 SECRET 不算启用（防 setup/login 永久锁死）", async () => {
  const env = { TURNSTILE_SECRET: "s3cr3t" };
  assert.equal(turnstileEnabled(env), false, "单配 SECRET 不得判定启用——前端拿不到 sitekey 会让 getToken() 恒空");
  assert.equal(turnstileSiteKey(env), null);
  const res = await verifyTurnstile({}, env, {});
  assert.deepEqual(res, { enabled: false, ok: true }, "残缺配置下 verifyTurnstile 必须放行而非 403");
});

test("双配 secret+sitekey 才启用", () => {
  const env = { TURNSTILE_SECRET: "s3cr3t", TURNSTILE_SITE_KEY: "sitekey" };
  assert.equal(turnstileEnabled(env), true);
  assert.equal(turnstileSiteKey(env), "sitekey");
});

test("启用状态下缺 token 仍 403（fail-closed 保留）", async () => {
  const env = { TURNSTILE_SECRET: "s3cr3t", TURNSTILE_SITE_KEY: "sitekey" };
  await assert.rejects(
    () => verifyTurnstile({}, env, {}),
    (err) => err.status === 403 && /人机验证/.test(err.message),
  );
});
