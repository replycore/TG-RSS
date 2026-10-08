/**
 * 管理后台 API：初始化 / 登录 / 设置 CRUD / 频道连通性测试。
 */
import { HttpError, clampInt, json } from "../util.js";
import {
  getGeneral,
  getMediaSettings,
  getChannels,
  getBridgeSettings,
  saveChannels,
  validateChannel,
  writeJSON,
  KEYS,
  DEFAULTS,
  getAdminCredential,
} from "../store.js";
import {
  getAuthState,
  handleSetup,
  handleLogin,
  handleLogout,
  handleChangePassword,
  sessionCookie,
  clearSessionCookie,
  requireAdmin,
} from "../auth.js";
import { fetchPublicChannelPage, fetchBridgeFeed, resolvePublicChannelMeta } from "../tg/fetcher.js";
import { getRssTokenInfo, rotateRssToken, revokeRssToken } from "../rss-auth.js";

/* ------------------------------------------------------------------ 状态 */

export async function adminState(request, env) {
  const state = await getAuthState(request, env);
  return {
    initialized: state.initialized,
    authenticated: state.authenticated,
    credentialSource: state.credentialSource,
    username: state.session?.username || null,
    envManaged: state.credentialSource === "env",
    hasBridge: !!(env.BRIDGE_URL) || !!(await getBridgeSettings(env)).url,
  };
}

/* ------------------------------------------------------------ 初始化 / 登录 */

export async function setup(request, env, body) {
  const result = await handleSetup(request, env, body);
  return json(
    { ok: true, username: result.username },
    { headers: { "set-cookie": sessionCookie(result.token, request) } },
  );
}

export async function login(request, env, body) {
  const result = await handleLogin(request, env, body);
  return json(
    { ok: true, username: result.username },
    { headers: { "set-cookie": sessionCookie(result.token, request) } },
  );
}

export async function logout(request, env) {
  await handleLogout(request, env);
  return json({ ok: true }, { headers: { "set-cookie": clearSessionCookie(request) } });
}

export async function changePassword(request, env, body) {
  const result = await handleChangePassword(request, env, body);
  const headers = result.reauth ? { "set-cookie": clearSessionCookie(request) } : {};
  return json({ ok: true, reauth: !!result.reauth }, { headers });
}

/* -------------------------------------------------------- RSS 订阅令牌 */

export async function rssTokenState(request, env) {
  await requireAdmin(request, env);
  const info = await getRssTokenInfo(env);
  return { enabled: !!info, masked: info?.masked || null, createdAt: info?.createdAt || null };
}

/**
 * action: "rotate"（生成/轮换，旧令牌立即失效）| "revoke"（吊销）
 * 明文令牌只在 rotate 的响应里出现一次，库里仅存 SHA-256 哈希。
 */
export async function rssTokenAction(request, env, body) {
  await requireAdmin(request, env);
  const action = String(body?.action || "rotate");
  if (action === "revoke") {
    await revokeRssToken(env);
    return { ok: true, enabled: false };
  }
  if (action !== "rotate") throw new HttpError(400, "action 必须是 rotate 或 revoke", "bad_action");
  const origin = new URL(request.url).origin;
  const t = await rotateRssToken(env, origin);
  return { ok: true, enabled: true, token: t.token, masked: t.masked, url: t.url };
}

/* ------------------------------------------------------------------ 设置 */

export async function getSettings(request, env) {
  await requireAdmin(request, env);
  const [general, mediaSettings, channels, bridge, credential] = await Promise.all([
    getGeneral(env),
    getMediaSettings(env),
    getChannels(env),
    getBridgeSettings(env),
    getAdminCredential(env),
  ]);
  return {
    general,
    media: mediaSettings,
    channels,
    bridge: {
      url: bridge.url || env.BRIDGE_URL || "",
      enabled: !!bridge.enabled || !!env.BRIDGE_URL,
      hasToken: !!(bridge.token || env.BRIDGE_TOKEN),
      fromEnv: !!env.BRIDGE_URL,
    },
    credential: {
      source: credential.source,
      username: credential.username,
    },
  };
}

export async function saveSettings(request, env, body) {
  await requireAdmin(request, env);
  const errors = [];

  if (body.general) {
    const general = {
      ...DEFAULTS.general,
      ...getGeneralPatch(body.general),
    };
    general.siteTitle = String(general.siteTitle || "TG-RSS").slice(0, 80);
    general.pageSize = clampInt(general.pageSize, 5, 50, 20);
    general.cacheTtl = clampInt(general.cacheTtl, 0, 3600, 120);
    general.feedChannels = clampInt(general.feedChannels, 1, 8, 6);
    general.showViews = !!general.showViews;
    general.showDate = !!general.showDate;
    general.theme = ["auto", "light", "dark"].includes(general.theme) ? general.theme : "auto";
    await writeJSON(env, KEYS.general, general);
  }

  if (body.media) {
    const mediaSettings = {
      ...DEFAULTS.media,
      video: body.media.video !== false,
      image: body.media.image !== false,
      audio: body.media.audio !== false,
      file: body.media.file !== false,
      proxyAll: body.media.proxyAll !== false,
      pageSize: clampInt(body.media.pageSize, 6, 60, 24),
    };
    await writeJSON(env, KEYS.media, mediaSettings);
  }

  if (body.bridge) {
    const url = String(body.bridge.url || "").trim();
    if (url && !/^https?:\/\//i.test(url)) errors.push("桥接地址必须以 http(s):// 开头");
    const patch = {
      url: url.replace(/\/+$/, ""),
      enabled: !!body.bridge.enabled && !!url,
      token: body.bridge.token ? String(body.bridge.token).slice(0, 200) : "",
    };
    if (body.bridge.token === undefined || body.bridge.token === "") {
      const existing = await getBridgeSettings(env);
      patch.token = existing.token || "";
    }
    if (!patch.token && (env.BRIDGE_TOKEN || "")) patch.token = env.BRIDGE_TOKEN;
    await writeJSON(env, KEYS.bridge, patch);
  }

  if (body.channels) {
    if (!Array.isArray(body.channels)) errors.push("channels 必须是数组");
    else {
      const normalized = [];
      const seen = new Set();
      for (const raw of body.channels) {
        const { channel, error } = validateChannel({ ...raw });
        if (error) {
          errors.push(error);
          continue;
        }
        if (seen.has(channel.key)) {
          errors.push(`频道重复：${channel.name}`);
          continue;
        }
        seen.add(channel.key);
        normalized.push(channel);
      }
      if (!errors.length) await saveChannels(env, normalized);
    }
  }

  if (errors.length) throw new HttpError(400, errors.join("；"), "invalid_settings");

  return { ok: true, ...(await getSettings(request, env)) };
}

function getGeneralPatch(input) {
  const out = {};
  for (const key of Object.keys(DEFAULTS.general)) {
    if (input[key] !== undefined) out[key] = input[key];
  }
  return out;
}

/* ------------------------------------------------------------ 频道连通性测试 */

export async function testChannel(request, env, ctx, body) {
  await requireAdmin(request, env);
  const { channel, error } = validateChannel(body?.channel || body || {});
  if (error) throw new HttpError(400, error, "bad_channel");

  if (channel.type === "public") {
    try {
      const parsed = await fetchPublicChannelPage(env, ctx, channel.username, null, 0);
      const latest = parsed.posts[0] || null;
      return {
        ok: true,
        channel,
        meta: parsed.channel,
        count: parsed.posts.length,
        sample: latest
          ? {
              date: latest.date,
              text: (latest.textPlain || "").slice(0, 200),
              mediaTypes: [...new Set((latest.media || []).map((m) => m.type))],
            }
          : null,
        note: parsed.posts.length ? null : "该频道最新一页没有可解析的消息",
      };
    } catch (err) {
      if (err instanceof HttpError) return { ok: false, channel, error: err.message, code: err.code };
      throw err;
    }
  }

  try {
    const parsed = await fetchBridgeFeed(env, channel, null, 5);
    return {
      ok: true,
      channel,
      meta: parsed.channel,
      count: parsed.posts.length,
      sample: parsed.posts[0]
        ? {
            date: parsed.posts[0].date,
            text: (parsed.posts[0].textPlain || "").slice(0, 200),
            mediaTypes: [...new Set((parsed.posts[0].media || []).map((m) => m.type))],
          }
        : null,
    };
  } catch (err) {
    if (err instanceof HttpError) return { ok: false, channel, error: err.message, code: err.code };
    throw err;
  }
}

export async function refreshChannel(request, env, ctx, body) {
  await requireAdmin(request, env);
  const key = String(body?.key || "");
  const channels = await getChannels(env);
  const channel = channels.find((c) => c.key === key);
  if (!channel) throw new HttpError(404, "频道不存在", "channel_not_found");

  if (channel.type === "public") {
    const meta = await resolvePublicChannelMeta(env, ctx, channel.username, 0);
    return { ok: true, meta };
  }
  const parsed = await fetchBridgeFeed(env, channel, null, 5);
  return { ok: true, meta: parsed.channel, count: parsed.posts.length };
}
