/**
 * 内容 API：频道列表、频道帖子、全站信息流。
 * 隐藏频道（hidden=true）在未登录时：列表不返回、帖子 403、媒体 403。
 */
import {
  extractTags,
  isAdPost,
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
  resolveBridge,
} from "../tg/fetcher.js";

const MAX_FEED_CHANNELS = 8;

export function visibleChannels(channels, authenticated) {
  // 私密频道即使没勾「隐藏」也一律需要认证（登录会话或 RSS token），
  // 否则元信息与桥接内容会经列表/信息流/RSS 公开流出
  return channels.filter(
    (ch) => ch.enabled !== false && (authenticated || (!ch.hidden && ch.type !== "private")),
  );
}

export function findChannel(channels, key) {
  // 大小写不敏感：频道 key 是小写的（store.js），用户手输 #/c/Xiaomi 与 #/c/xiaomi 同义
  if (typeof key === "string") {
    const lower = key.toLowerCase();
    const direct = channels.find((ch) => ch.key === key);
    if (direct) return direct;
    return channels.find((ch) => typeof ch.key === "string" && ch.key.toLowerCase() === lower) || null;
  }
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
    // M-4：写 KV 用 waitUntil 后台化，不阻塞本请求（失败也保留已抓到的内容）
    if (ctx && typeof ctx.waitUntil === "function") {
      ctx.waitUntil(putChannelMeta(env, channel.key, merged).catch(() => {}));
    } else {
      putChannelMeta(env, channel.key, merged).catch(() => {});
    }
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
  const [mediaSettings, general] = await Promise.all([getMediaSettings(env), getGeneral(env)]);
  const adTagsExtra = Array.isArray(general.adTagsExtra) ? general.adTagsExtra : [];
  let parsed;
  if (channel.type === "public") {
    parsed = await fetchPublicChannelPage(env, ctx, channel.username, before, general.cacheTtl ?? 120);
  } else {
    parsed = await fetchBridgeFeed(env, channel, before, limit);
  }
  const info = await hydrateMeta(env, ctx, channel, parsed.channel);
  // H-1：桥接媒体的站内代理 URL 需用 bridge token 签名（signSettings 携带密钥/host），
  // proxyMedia 据此拒绝伪造 u（否则未登录者可枚举私密频道的任意媒体）。
  const bridge = await resolveBridge(env);
  const signSettings = {
    ...mediaSettings,
    _bridgeToken: bridge?.token || null,
    _bridgeHost: bridge?.host || null,
  };
  const decorated = await Promise.all(parsed.posts.map((p) => decoratePostMedia(p, signSettings)));
  const posts = decorated
    // 统一补 #标签：公开频道解析出的与桥接返回的帖子都走到这里
    .map((p) => ({ ...p, tags: p.tags?.length ? p.tags : extractTags(p.textPlain || p.text || "") }))
    // 广告帖识别（内置 AD_TAGS + 后台自定义 adTagsExtra）→ 单页出口即过滤，信息流/频道页/RSS 全局隐藏
    .filter((p) => !isAdPost(p, adTagsExtra));
  return { info, posts, next: parsed.nextBefore ?? null, cacheStatus: parsed.cacheStatus || null };
}

/** 帖子是否携带媒体（图片/视频/音频/文件任一） */
export function postHasMedia(post) {
  return Array.isArray(post.media) && post.media.length > 0;
}

/** 单页被过滤光时继续向前补翻的页数上限，避免一次请求打太多上游 */
const PAGE_FILL_MAX_PAGES = 5;

/**
 * 连续翻页读取：只保留符合投放规则的帖子——
 *  - 广告帖（isAdPost，loadChannelPage 已过滤）任何频道都不投；
 *  - mediaOnly 频道只投带媒体的帖子。
 * 一页被过滤空时沿游标续翻，直到凑够 limit 条或翻完
 * （最多 PAGE_FILL_MAX_PAGES 页），避免整页被过滤空导致前端误判「到底了」。
 * 返回结构与 loadChannelPage 一致；游标 next 指向已消费掉的位置。
 */
export async function loadFilledChannelPage(env, ctx, channel, before = null, limit = 20, budget = null) {
  let cursor = before;
  let next = null;
  let info = null;
  const collected = [];
  const seen = new Set();
  const statuses = new Set(); // N-2 调试标：各页上游缓存状态
  for (let page = 0; page < PAGE_FILL_MAX_PAGES; page += 1) {
    // L-1：总抓取预算——多个频道并发补页时，用共享 budget 收敛 t.me 请求总量，
    // 防「多频道 × 每频道多页」叠加超出单次 CPU/子请求预算。
    if (budget && budget.remaining <= 0) break;
    if (budget) budget.remaining -= 1;
    const result = await loadChannelPage(env, ctx, channel, cursor, limit);
    if (result.cacheStatus) statuses.add(result.cacheStatus);
    info = info || result.info;
    next = result.next;
    for (const post of result.posts) {
      if (channel.mediaOnly && !postHasMedia(post)) continue;
      const id = post.id || `${post.channel}/${post.postId}`;
      if (seen.has(id)) continue;
      seen.add(id);
      collected.push(post);
    }
    if (collected.length >= limit || !result.next) break;
    cursor = result.next;
  }
  // N-2 调试标聚合：任一页未命中即 MISS；全 BYPASS 即 BYPASS；全命中即 HIT
  const cacheStatus = statuses.size === 0 ? null
    : statuses.has("MISS") ? "MISS"
    : statuses.has("BYPASS") ? "BYPASS"
    : "HIT";
  return { info, posts: collected, next, cacheStatus };
}

/** 兼容旧调用：等价于 loadFilledChannelPage，强制只投媒体帖 */
export function loadMediaOnlyChannelPage(env, ctx, channel, before = null, limit = 20) {
  return loadFilledChannelPage(env, ctx, { ...channel, mediaOnly: true }, before, limit);
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

  // 统一走补页循环：仅媒体频道只投媒体帖；广告帖任何频道都不投（loadChannelPage 已过滤）
  const { info, posts: allPosts, next, cacheStatus } = await loadFilledChannelPage(env, ctx, channel, before, limit);
  // 与信息流一致的 #标签 过滤
  const tag = String(url.searchParams.get("tag") || "").replace(/^#/, "").trim().toLowerCase();
  const posts = tag
    ? allPosts.filter((p) => (p.tags || []).some((t) => String(t).toLowerCase() === tag))
    : allPosts;
  // _up：上游页面缓存状态（HIT/MISS/BYPASS），供真实 Workers 上验证 N-2 缓存命中
  return { channel: info, posts, next, count: posts.length, _up: cacheStatus || null };
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
  // 轮转切片（防靠后频道饥饿）：固定取前 cap 个会让第 cap+1 个之后的频道
  // 永远等前面翻完。轮转锚点是上次 batch 的尾频道（存在 __lastBatchTail 里），
  // 本轮从「锚点之后（按频道配置序）」开始取，保证每轮优先取上次没取到的频道。
  const ordered = [...pending];
  const anchor = typeof cursors.__lastBatchTail === "string" ? cursors.__lastBatchTail : null;
  const anchorIdx = anchor ? ordered.findIndex((ch) => ch.key === anchor) : -1;
  const start = anchorIdx >= 0 ? (anchorIdx + 1) % ordered.length : 0;
  const rotated = start > 0 ? [...ordered.slice(start), ...ordered.slice(0, start)] : ordered;
  const batch = rotated.slice(0, cap);

  const nextCursors = { ...cursors };
  delete nextCursors.__lastBatchTail;
  const perChannel = [];
  // L-1：整次 feed 的总抓取预算（8 频道 × 每频道最多 5 页 = 40 次），并发共享、先到先得
  const budget = { remaining: MAX_FEED_CHANNELS * PAGE_FILL_MAX_PAGES };

  await Promise.all(
    batch.map(async (ch) => {
      try {
        const before = typeof cursors[ch.key] === "string" ? cursors[ch.key] : null;
        // 统一走补页循环：仅媒体频道只投媒体帖；广告帖任何频道都不投（loadChannelPage 已过滤）
        const page = await loadFilledChannelPage(env, ctx, ch, before, general.pageSize || 20, budget);
        nextCursors[ch.key] = page.next ? String(page.next) : null;
        perChannel.push({ channel: page.info, posts: page.posts, cacheStatus: page.cacheStatus || null });
      } catch (err) {
        // 出错的频道本次不再重试，避免整页失败。但游标不能写成 null（null = 已翻完），
        // 否则瞬时上游错误会导致本轮分页永久丢内容：恢复原游标，下次仍可继续翻
        if (typeof cursors[ch.key] === "string") nextCursors[ch.key] = cursors[ch.key];
        else delete nextCursors[ch.key];
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
  const kept = posts.slice(0, limit);

  // ---- 游标回退（防分页静默丢数据）----
  // 上面各频道的游标已推进到页尾；若全局 slice 截掉了某频道「应展示却没展示」的帖，
  // 游标越过的内容下一页永远取不回（默认 6×20=120 > limit=60 即命中）。
  // 频道内本就新→旧、全局按时间倒序 → 被保留的必是该频道较新的前缀：
  //   ① 展示帖全保留 → 维持 page.next 推进；
  //   ② 部分被截   → 回退到「最后一条保留的展示帖」（before=它，下页正好从截断点续上，无重复无丢失）；
  //   ③ 展示帖全被截 → 游标不推进（恢复原值/删除，下次重抓本页）。
  // 被 tag 筛掉、被广告/仅媒体过滤的帖不算「被截」——游标翻过它们才是筛选语义。
  const keptKeys = new Set(kept.map((p) => feedPostKey(p)));
  for (const entry of perChannel) {
    if (entry.error) continue;
    const key = entry.channel.key;
    if (!(key in nextCursors)) continue;
    const shown = tag
      ? entry.posts.filter((p) => (p.tags || []).some((t) => String(t).toLowerCase() === tag))
      : entry.posts;
    if (!shown.length) continue;
    const keptShown = shown.filter((p) => keptKeys.has(feedPostKey(p)));
    if (keptShown.length === shown.length) continue; // ① 全保留
    if (keptShown.length === 0) {
      // ③ 全被截：恢复原游标（首次请求为 undefined → 删除键，保持「未开始」语义）
      if (typeof cursors[key] === "string") nextCursors[key] = cursors[key];
      else delete nextCursors[key];
      continue;
    }
    // ② 部分被截：回退到最后保留帖
    const lastKept = keptShown[keptShown.length - 1];
    if (lastKept.postId != null) nextCursors[key] = String(lastKept.postId);
  }

  // 轮转锚点写回：本轮 batch 的尾频道，供下轮 rotate。
  // 注意 __lastBatchTail 是内部字段，会随 cursors 发给前端透传回来——
  // 前端的 hasPending 判断必须忽略它（见 views.js / media.js），否则"没有更多了"永远出不来
  if (batch.length) nextCursors.__lastBatchTail = batch[batch.length - 1].key;

  // N-2 调试标聚合：本轮各频道上游缓存状态（HIT/MISS/BYPASS 去重集合）
  const upStatuses = new Set(perChannel.filter((e) => !e.error && e.cacheStatus).map((e) => e.cacheStatus));
  return {
    posts: kept,
    cursors: nextCursors,
    channels: perChannel.map((e) => e.channel),
    errors: perChannel.filter((e) => e.error).map((e) => ({ key: e.channel.key, message: e.error })),
    done: batch.length === 0,
    _up: [...upStatuses].sort(),
  };
}

/** feed 帖子去重键：优先全局 id，退化为 频道/消息号（与 loadFilledChannelPage 的 seen 一致） */
function feedPostKey(p) {
  return p.id != null ? String(p.id) : `${p.channel}/${p.postId}`;
}
