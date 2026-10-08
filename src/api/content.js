/**
 * 内容 API：频道列表、频道帖子、全站信息流。
 * 隐藏频道（hidden=true）在未登录时：列表不返回、帖子 403、媒体 403。
 */
import {
  extractTags,
  HttpError,
  clampInt,
  decodeState,
} from "../util.js";
import {
  getGeneral,
  getMediaSettings,
  getChannels,
  getChannelMeta,
  putChannelMeta,
} from "../store.js";
import {
  fetchPublicChannelPage,
  fetchBridgeFeed,
  decoratePostMedia,
} from "../tg/fetcher.js";

const MAX_FEED_CHANNELS = 8;

export async function loadContext(env, request) {
  const [general, mediaSettings, channels] = await Promise.all([
    getGeneral(env),
    getMediaSettings(env),
    getChannels(env),
  ]);
  return { general, mediaSettings, channels };
}

export function visibleChannels(channels, authenticated) {
  // 私密频道即使没勾「隐藏」也一律需要认证（登录会话或 RSS token），
  // 否则元信息与桥接内容会经列表/信息流/RSS 公开流出
  return channels.filter(
    (ch) => ch.enabled !== false && (authenticated || (!ch.hidden && ch.type !== "private")),
  );
}

export function findChannel(channels, key) {
  return channels.find((ch) => ch.key === key) || null;
}

export function assertVisible(channel, authenticated) {
  if (!channel) throw new HttpError(404, "频道不存在", "channel_not_found");
  if ((channel.hidden || channel.type === "private") && !authenticated) {
    throw new HttpError(403, "该频道需要登录或有效令牌后查看", "hidden_channel");
  }
  if (channel.enabled === false) throw new HttpError(404, "频道已停用", "channel_disabled");
}

async function hydrateMeta(env, ctx, channel, pageChannel) {
  const existing = await getChannelMeta(env, channel.key).catch(() => null);
  const merged = {
    key: channel.key,
    title: (pageChannel && pageChannel.title) || existing?.title || channel.name,
    username: (pageChannel && pageChannel.username) || existing?.username || channel.username || null,
    avatar: (pageChannel && pageChannel.avatar) || existing?.avatar || null,
    description: (pageChannel && pageChannel.description) || existing?.description || "",
    counters: (pageChannel && pageChannel.counters) || existing?.counters || {},
    fetchedAt: (pageChannel && pageChannel.avatar) ? Date.now() : (existing?.fetchedAt || 0),
  };

  // 把抓到的频道元信息回写 KV（节流 10 分钟），让侧栏头像/简介无需手动刷新
  const nz = (v) => v || null;
  const stale = !existing || Date.now() - (existing.fetchedAt || 0) > 10 * 60 * 1000;
  const changed = !!pageChannel &&
    (nz(pageChannel.avatar) !== nz(existing?.avatar) ||
      nz(pageChannel.title) !== nz(existing?.title) ||
      nz(pageChannel.description) !== nz(existing?.description));
  if (changed || (stale && merged.avatar)) {
    putChannelMeta(env, channel.key, merged).catch(() => {});
  }

  return {
    key: channel.key,
    name: channel.name,
    type: channel.type,
    username: merged.username,
    tgId: channel.tgId || null,
    hidden: !!channel.hidden,
    mediaOnly: !!channel.mediaOnly,
    avatar: merged.avatar,
    description: merged.description,
    counters: merged.counters,
    fetchedAt: existing?.fetchedAt || null,
  };
}

/**
 * 读取某频道一页内容（公开走 t.me，私密走桥接）。
 */
export async function loadChannelPage(env, ctx, channel, before = null, limit = 20) {
  const mediaSettings = await getMediaSettings(env);
  let parsed;
  if (channel.type === "public") {
    const general = await getGeneral(env);
    parsed = await fetchPublicChannelPage(env, ctx, channel.username, before, general.cacheTtl ?? 120);
  } else {
    parsed = await fetchBridgeFeed(env, channel, before, limit);
  }
  const info = await hydrateMeta(env, ctx, channel, parsed.channel);
  const posts = parsed.posts
    .map((p) => decoratePostMedia(p, mediaSettings))
    // 统一补 #标签：公开频道解析出的与桥接返回的帖子都走到这里
    .map((p) => ({ ...p, tags: p.tags?.length ? p.tags : extractTags(p.textPlain || p.text || "") }));
  return { info, posts, next: parsed.nextBefore ?? null };
}

/** 帖子是否携带媒体（图片/视频/音频/文件任一） */
export function postHasMedia(post) {
  return Array.isArray(post.media) && post.media.length > 0;
}

/** 仅媒体频道连续翻页时的页数上限，避免纯文字频道一次请求打太多上游 */
const MEDIA_ONLY_MAX_PAGES = 5;

/**
 * 「仅媒体」频道读页：只保留带媒体的帖子。
 * 一页全是纯文字时继续沿游标向前翻，直到凑够 limit 条媒体帖或翻完
 * （最多 MEDIA_ONLY_MAX_PAGES 页），避免整页被过滤空导致前端误判「到底了」。
 * 返回结构与 loadChannelPage 一致；游标 next 指向已消费掉的位置。
 */
export async function loadMediaOnlyChannelPage(env, ctx, channel, before = null, limit = 20) {
  let cursor = before;
  let next = null;
  let info = null;
  const collected = [];
  const seen = new Set();
  for (let page = 0; page < MEDIA_ONLY_MAX_PAGES; page += 1) {
    const result = await loadChannelPage(env, ctx, channel, cursor, limit);
    info = info || result.info;
    next = result.next;
    for (const post of result.posts) {
      if (!postHasMedia(post)) continue;
      const id = post.id || `${post.channel}/${post.postId}`;
      if (seen.has(id)) continue;
      seen.add(id);
      collected.push(post);
    }
    if (collected.length >= limit || !result.next) break;
    cursor = result.next;
  }
  return { info, posts: collected, next };
}

/* ---------------------------------------------------------------- GET /api/channels */

export async function listChannels(request, env, ctx, url, authenticated) {
  const channels = await getChannels(env);
  const list = visibleChannels(channels, authenticated);
  const metas = await Promise.all(list.map((ch) => getChannelMeta(env, ch.key).catch(() => null)));
  return {
    channels: list.map((ch, i) => ({
      key: ch.key,
      name: ch.name,
      type: ch.type,
      username: ch.username || null,
      tgId: ch.type === "private" ? ch.tgId : null,
      hidden: !!ch.hidden,
      mediaOnly: !!ch.mediaOnly,
      avatar: metas[i]?.avatar || null,
      description: metas[i]?.description || "",
      counters: metas[i]?.counters || {},
      hasMeta: !!metas[i],
    })),
    authenticated,
  };
}

/* ------------------------------------------------------ GET /api/channels/:key/posts */

export async function getChannelPosts(request, env, ctx, url, key, authenticated) {
  const channels = await getChannels(env);
  const channel = findChannel(channels, key);
  assertVisible(channel, authenticated);

  const general = await getGeneral(env);
  const limit = clampInt(url.searchParams.get("limit"), 5, 50, general.pageSize || 20);
  const before = url.searchParams.get("before") || null;

  //「仅媒体」频道：无论频道页还是信息流，都只投放带媒体的帖子
  const { info, posts: allPosts, next } = channel.mediaOnly
    ? await loadMediaOnlyChannelPage(env, ctx, channel, before, limit)
    : await loadChannelPage(env, ctx, channel, before, limit);
  // 与信息流一致的 #标签 过滤
  const tag = String(url.searchParams.get("tag") || "").replace(/^#/, "").trim().toLowerCase();
  const posts = tag
    ? allPosts.filter((p) => (p.tags || []).some((t) => String(t).toLowerCase() === tag))
    : allPosts;
  return { channel: info, posts, next, count: posts.length };
}

/* --------------------------------------------------------------- GET /api/feed */

export async function getFeed(request, env, ctx, url, authenticated) {
  const channels = await getChannels(env);
  const general = await getGeneral(env);
  //「仅媒体」频道保留在信息流里，但只投放带媒体的帖子（loadMediaOnlyChannelPage 过滤纯文字帖）
  const visible = visibleChannels(channels, authenticated);
  const limit = clampInt(url.searchParams.get("limit"), 10, 120, Math.max(40, (general.pageSize || 20) * 3));
  const cap = clampInt(url.searchParams.get("n"), 1, MAX_FEED_CHANNELS, general.feedChannels || 6);

  const cursors = decodeState(url.searchParams.get("c"), {}) || {};
  // null 表示该频道已翻完
  const pending = visible.filter((ch) => cursors[ch.key] === undefined || typeof cursors[ch.key] === "string");
  const batch = pending.slice(0, cap);

  const nextCursors = { ...cursors };
  const perChannel = [];

  await Promise.all(
    batch.map(async (ch) => {
      try {
        const before = typeof cursors[ch.key] === "string" ? cursors[ch.key] : null;
        const page = ch.mediaOnly
          ? await loadMediaOnlyChannelPage(env, ctx, ch, before, general.pageSize || 20)
          : await loadChannelPage(env, ctx, ch, before, general.pageSize || 20);
        nextCursors[ch.key] = page.next ? String(page.next) : null;
        perChannel.push({ channel: page.info, posts: page.posts });
      } catch (err) {
        nextCursors[ch.key] = null; // 出错的频道本次不再重试，避免整页失败
        perChannel.push({ channel: { key: ch.key, name: ch.name }, posts: [], error: err?.message || "fetch_failed" });
      }
    }),
  );

  let posts = perChannel
    .flatMap((entry) => entry.posts)
    .sort((a, b) => {
      const ta = a.date ? Date.parse(a.date) : 0;
      const tb = b.date ? Date.parse(b.date) : 0;
      if (tb !== ta) return tb - ta;
      return (b.postId || 0) - (a.postId || 0);
    });
  // 按 #标签 过滤（标签取自消息正文里的 #话题 词）
  const tag = String(url.searchParams.get("tag") || "").replace(/^#/, "").trim().toLowerCase();
  if (tag) posts = posts.filter((p) => (p.tags || []).some((t) => String(t).toLowerCase() === tag));
  posts = posts.slice(0, limit);

  return {
    posts,
    cursors: nextCursors,
    channels: perChannel.map((e) => e.channel),
    errors: perChannel.filter((e) => e.error).map((e) => ({ key: e.channel.key, message: e.error })),
    done: batch.length === 0,
  };
}
