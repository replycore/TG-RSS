/**
 * Cloudflare Turnstile 人机验证（/setup /login /password）。
 *
 * 配置（环境变量，缺省即整体跳过校验，向后兼容）：
 *   TURNSTILE_SECRET    —— 服务端密钥，设置后即启用校验
 *   TURNSTILE_SITE_KEY  —— 前端站点密钥，通过 /api/config 下发给页面渲染
 *
 * 校验走 Cloudflare 官方 siteverify；网络失败时保守拒绝（fail-closed），
 * 避免验证服务不可用时登录口完全敞开。
 *
 * 注意：不传 remoteip。siteverify 的 remoteip 会和令牌生成时的出口 IP 强校验，
 * 移动网络/代理换出口、或页面与提交走不同链路时会误杀合法用户
 * （实测同源同会话也被拒，去掉后 success=true）。令牌本身已绑定站点并证明完成挑战。
 */
import { HttpError } from "./util.js";

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export function turnstileEnabled(env) {
  return !!(env && env.TURNSTILE_SECRET);
}

/** 前端渲染需要的 sitekey；只有配了 secret（即启用）才下发，避免前后端状态不一致 */
export function turnstileSiteKey(env) {
  return turnstileEnabled(env) && env.TURNSTILE_SITE_KEY ? env.TURNSTILE_SITE_KEY : null;
}

/**
 * 校验请求里的人机验证令牌。未配置 secret 时直接放行。
 * body.turnstileToken 为前端提交的令牌。
 */
export async function verifyTurnstile(request, env, body) {
  const secret = env && env.TURNSTILE_SECRET;
  if (!secret) return { enabled: false, ok: true };

  const token = String((body && body.turnstileToken) || "").slice(0, 2048);
  if (!token) {
    throw new HttpError(403, "请先完成人机验证", "turnstile_required");
  }

  let data;
  try {
    const res = await fetch(SITEVERIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret, response: token }).toString(),
    });
    data = await res.json();
  } catch (err) {
    // 验证服务不可用时拒绝登录（fail-closed），不给攻击者绕过窗口
    throw new HttpError(502, `人机验证服务不可用：${err && err.message ? err.message : err}`, "turnstile_error");
  }

  if (!data || data.success !== true) {
    throw new HttpError(403, "人机验证未通过，请重试", "turnstile_failed");
  }
  return { enabled: true, ok: true };
}
