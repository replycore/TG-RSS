/**
 * 鉴权：管理员初始化、登录、会话 Cookie、登录限流。
 */
import {
  HttpError,
  getClientIp,
  parseCookies,
  serializeCookie,
  isValidToken,
} from "./util.js";
import {
  getAdminCredential,
  isInitialized,
  verifyPassword,
  createAdminCredential,
  createSession,
  getSession,
  destroySession,
  checkRateLimit,
  bumpRateLimit,
  resetRateLimit,
} from "./store.js";

export const SESSION_COOKIE = "tgrss_session";

function isSecureRequest(request) {
  const url = new URL(request.url);
  if (url.protocol === "https:") return true;
  const proto = request.headers.get("x-forwarded-proto");
  return proto === "https";
}

export function sessionCookie(token, request, opts = {}) {
  return serializeCookie(SESSION_COOKIE, token, {
    maxAge: opts.maxAge ?? 7 * 24 * 3600,
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
    secure: isSecureRequest(request),
  });
}

export function clearSessionCookie(request) {
  return serializeCookie(SESSION_COOKIE, "", { maxAge: 0, path: "/", httpOnly: true, secure: isSecureRequest(request) });
}

export function readSessionToken(request) {
  const cookies = parseCookies(request);
  const token = cookies[SESSION_COOKIE];
  return isValidToken(token) ? token : null;
}

export async function getAuthState(request, env) {
  const credential = await getAdminCredential(env);
  const token = readSessionToken(request);
  const session = token ? await getSession(env, token) : null;
  return {
    initialized: isInitialized(credential),
    credentialSource: credential.source,
    authenticated: !!session,
    session: session || null,
    token,
  };
}

export async function requireAdmin(request, env) {
  const state = await getAuthState(request, env);
  if (!state.authenticated) throw new HttpError(401, "需要管理员登录", "unauthorized");
  return state;
}

export async function handleSetup(request, env, body) {
  const credential = await getAdminCredential(env);
  if (isInitialized(credential)) {
    throw new HttpError(409, "管理员已初始化，无法重复初始化", "already_initialized");
  }
  const username = String(body?.username || "admin").trim().slice(0, 64) || "admin";
  const password = String(body?.password || "");
  if (password.length < 8) throw new HttpError(400, "密码至少 8 位", "weak_password");
  if (!/^[\w.-]{1,64}$/.test(username)) throw new HttpError(400, "用户名仅允许字母数字 . _ -", "bad_username");

  await createAdminCredential(env, username, password);
  const session = await createSession(env, { username });
  return { token: session, username };
}

export async function handleLogin(request, env, body) {
  const ip = getClientIp(request);
  const limit = await checkRateLimit(env, ip);
  if (!limit.allowed) {
    const err = new HttpError(429, "尝试次数过多，请稍后再试", "rate_limited");
    err.retryAfter = Math.max(30, limit.retryAfter || 300);
    throw err;
  }

  const credential = await getAdminCredential(env);
  if (!isInitialized(credential)) throw new HttpError(409, "请先完成初始化", "not_initialized");

  const username = String(body?.username || credential.username).trim();
  const password = String(body?.password || "");
  const userOk = username === credential.username;
  const passOk = await verifyPassword(credential, password);

  if (!userOk || !passOk) {
    await bumpRateLimit(env, ip);
    throw new HttpError(401, "用户名或密码错误", "bad_credentials");
  }

  await resetRateLimit(env, ip);
  const session = await createSession(env, { username });
  return { token: session, username: credential.username };
}

export async function handleLogout(request, env) {
  const token = readSessionToken(request);
  if (token) await destroySession(env, token);
  return { ok: true };
}

export async function handleChangePassword(request, env, body) {
  const state = await requireAdmin(request, env);
  const current = String(body?.currentPassword || "");
  const next = String(body?.newPassword || "");
  if (next.length < 8) throw new HttpError(400, "新密码至少 8 位", "weak_password");

  const credential = await getAdminCredential(env);
  const ok = await verifyPassword(credential, current);
  if (!ok) throw new HttpError(401, "当前密码不正确", "bad_credentials");

  if (credential.source === "env") {
    throw new HttpError(400, "当前使用环境变量 ADMIN_PASSWORD，请修改环境变量而非数据库凭据", "env_managed");
  }
  await createAdminCredential(env, credential.username, next);
  // 换密码后强制重新登录
  if (state.token) await destroySession(env, state.token);
  return { ok: true, reauth: true };
}
