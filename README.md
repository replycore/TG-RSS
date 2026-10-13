# TG-RSS

A self-hosted **Telegram channel reader & RSS generator** based on Cloudflare Workers and Pages.

[![Repository](https://img.shields.io/badge/View%20on-GitHub-blue.svg)](https://github.com/replycore/TG-RSS)
[![Live Demo](https://img.shields.io/badge/Live%20Demo-rss.new.tg-green.svg)](https://rss.new.tg)

**[中文文档](README_CN.md)**

## Features

- Support for Cloudflare Workers and Pages deployment (one codebase, both modes)
- **Public channels** fetched directly from `t.me/s/<channel>` preview pages — no external services required
- **Private channels** relayed by the bundled [`bridge/`](./bridge) program (your own Telegram account), with HMAC signing in both directions
- Reverse-chronological multi-channel feed with cursor pagination
- **Media mode**: video / image / audio / files with native browser playback, Range support
- Tag filtering (`?tag=` + clickable `#topics` in post bodies)
- **Auto-hide ads**: posts tagged `#ad` `#sponsor` `#promo` etc. are hidden globally (feed / channel / RSS)
- **Bilingual UI**: 简体中文 (default) / English, switchable from the header
- **RSS 2.0**: `/rss.xml` (all channels) or per-channel `/api/rss?channel=<key>`, optionally token-gated
- **Admin panel**: channels, visibility, sorting, RSS token, Turnstile login protection — all stored in Workers KV
- **Server-side visibility**: hidden channels return 403 for guests, not just hidden in the UI
- Media proxy with SSRF allowlist + `?dl=1` attachment download (RFC 5987 Chinese filenames)

## Quick Deployment

### Deploy on Pages.dev (production, recommended)

1. Fork this repository to your GitHub account
2. Create a Pages project: Cloudflare Dashboard → Workers & Pages → Create → Pages → Connect to Git → select your fork
   - Build command: *(empty)*
   - Build output directory: `public`
   - The `functions/[[path]].js` in the repo root is auto-detected as Functions
3. Bind KV: project → Settings → Bindings → Add → `TG_RSS_KV` → your KV namespace (**re-deploy afterwards!**)
4. Add custom domain (optional): project → Custom domains → Add. Third-party DNS works too — just add a `CNAME your-subdomain → <your-project>.pages.dev` at your DNS provider, **no zone migration needed** (Workers can't do this).

See [PAGES.md](./PAGES.md) for KV details, third-party CNAME, Worker fallback, and the bridge upgrade order.

### Deploy on Worker.dev

Copy the config template, fill in your values, and deploy:

```bash
cp wrangler.worker.example.jsonc wrangler.deploy.jsonc  # fill in account_id / KV id / domain
npx wrangler deploy --config wrangler.deploy.jsonc
```

Or click the button below to deploy directly:

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/replycore/TG-RSS)

> Note: the button creates a **Worker** (fallback mode), not Pages. For the production setup (Pages + KV + custom domain), follow the Pages steps above.

## Configuration Guide

### Environment Variables (Worker / Pages side, all optional)

| Variable | Example | Description |
|----------|---------|-------------|
| `ADMIN_USERNAME` | `admin` | Admin username (default: `admin`) |
| `ADMIN_PASSWORD` | — | When set, **takes precedence**; password can't be changed in the admin panel, only via env var |
| `SETUP_CODE` | — | When set, first-time admin setup requires this code (prevents strangers from initializing your site) |
| `BRIDGE_URL` | `https://tg-bridge.example.com` | Private-channel bridge address (takes precedence over admin panel setting) |
| `BRIDGE_TOKEN` | — | Bridge token |

Priority: **environment variables > admin panel setup > uninitialized (setup required)**.

Set via `npx wrangler secret put <NAME>` (Worker) or project Settings → Variables and Secrets (Pages, **re-deploy to take effect**).

### Admin Panel Settings (stored in KV)

| Section | Items |
|---------|-------|
| Site | title, page size, fetch cache TTL, feed concurrency, theme |
| Channels | add / edit / delete, display name, reorder, connectivity test, meta refresh, hidden / media-only / enabled switches |
| Media | per-type toggles, page size, force-proxy-all |
| Bridge | address, token, enabled, connectivity test |
| Security | change password, sessions, RSS token (generate / copy / revoke) |

### Bridge `bridge/.env`

| Variable | Required | Example | Description |
|----------|----------|---------|-------------|
| `TG_API_ID` / `TG_API_HASH` | Yes | — | From https://my.telegram.org/apps |
| `TG_PHONE` | Yes | `+8613800138000` | Account phone, international format |
| `TG_SESSION` | Yes | — | Printed by `npm run login` |
| `BRIDGE_TOKEN` | Yes | — | Must match the token in TG-RSS admin → Bridge |
| `PORT` | No | `8788` | Listen port (default: 8788) |
| `BRIDGE_HOST` | No | `127.0.0.1` | Listen address (default: localhost only) |
| `PUBLIC_URL` | Yes | `https://tg-bridge.example.com` | Public HTTPS URL so the worker can reach it |
| `BRIDGE_SIGN_WINDOW_SEC` | No | `300` | HMAC signature time window, 60–3600 (default: 300) |
| `BRIDGE_ALLOWED_ORIGINS` | No | — | Origin allowlist, only constrains header-auth requests |

Run it (needs the **whole repo cloned**, `bridge/` can't run standalone):

```bash
cd bridge
cp .env.example .env   # fill in the values above
npm install
npm run login          # enter the Telegram code, writes TG_SESSION
npm start              # listen on 8788, needs public HTTPS (Cloudflare Tunnel recommended)
```

> ⚠️ **Upgrade order: bridge first, then TG-RSS.** Both directions are mutually incompatible with no bypass switch (new TG-RSS only sends HMAC signature headers, new bridge dropped `?token=` support). Upgrade both in the same window. See [PAGES.md](./PAGES.md#bridge-notes).

### Bridge Endpoints (`/health` is public, the rest need HMAC signature headers)

| Path | Description |
| --- | --- |
| `GET /health` | Liveness check |
| `GET /feed?channel=&before=&limit=` | Channel messages (same shape as public channels) |
| `GET /media?ch=&m=` | Media files, `Range` support, disk cache |
| `GET /thumb?ch=&m=` | Video thumbnails (for `<video poster>`) |
| `GET /avatar?ch=` | Channel avatar |

## Usage

1. Open the site, click **Login** (top right) or visit `#/admin`
2. First visit is the **setup** page: set username + password (≥8 chars), written to KV
3. **Channels** tab: pick `Public`, enter a username (e.g. `telegram`) → **Test** → auto-fills display name → **Add**. For private channels pick `Private` and enter the numeric ID (e.g. `-1001234567890`, bridge required)
4. Toggle per-channel **hidden** (invisible to guests), **media-only**, **enabled**; reorder with up/down; click **Save all**
5. **Media** tab: per-type toggles, page size, force-proxy. **General** tab: title, page size, cache TTL, concurrency, theme. **Security** tab: password, sessions, RSS token

## API Reference

Public (no login):

```
GET  /api/health
GET  /api/config
GET  /api/channels                      # only channels visible to current identity
GET  /api/feed?c=<cursor>[&tag=<tag>]   # aggregated feed, cursor pagination, #topic filter
GET  /api/channels/:key/posts?before=&limit=
GET  /api/media?type=video|image|audio|file&c=<cursor>&key=
GET  /api/media/proxy?u=<base64url(url)>  # Range passthrough, SSRF allowlist
GET  /api/media/doc?key=&post=&i=        # on-demand file direct-link resolution
GET  /rss.xml                            # aggregate RSS 2.0
GET  /api/rss[?channel=<key>[&limit=]]   # aggregate or single-channel RSS
```

Admin (login required):

```
GET  /api/admin/state
POST /api/admin/setup        {username,password[,code]}
POST /api/admin/login        {username,password}
POST /api/admin/logout
POST /api/admin/password     {currentPassword,newPassword}
GET  /api/admin/settings
POST /api/admin/settings     {general?,media?,bridge?,channels?}
POST /api/admin/channels/test    {channel}
POST /api/admin/channels/refresh {key}
GET  /api/admin/stats
```

## Notes

- **"No direct link" for files in public channels**: `t.me/s/` preview pages only expose filename + size. Media mode shows the name/size; "fetch file" tries the single-post embed page, then falls back to the Telegram original. For direct downloads, configure the channel as private via bridge.
- **Don't set fetch cache to 0**: `t.me` rate-limits; the default 120s cache is enough for reading.
- Only subscribe to channels you have the right to access; follow Telegram's ToS and local laws.
- CDN media links carry expiring tokens — re-fetch the page after TTL for fresh URLs (automatic).
- Once `ADMIN_PASSWORD` env var is set, the admin panel shows "managed by environment variable".

## Development

```bash
npm install          # install wrangler and friends
npm test             # run the test suite (155 tests)
npm run dev          # http://localhost:8787 (wrangler dev, needs workerd)
npm run dev:node     # same port, pure Node (tools/dev-server.mjs), no workerd needed
```

Tests use real `t.me` page snapshots in `tests/fixtures/`. `tests/frontend.test.js` drives real views against a real backend — start `npm run dev` (or `dev:node`) in another terminal first; it auto-skips otherwise.

## Project Structure

```
├─ src/                     # server (shared by Worker & Pages)
│  ├─ index.js              # entry { fetch }
│  ├─ router.js             # routes /api/*
│  ├─ store.js              # KV access, channel model, credentials, sessions, rate limits
│  ├─ auth.js               # setup / login / session cookies / password change
│  ├─ util.js               # HTML sanitizing, encoding, PBKDF2, cookies
│  ├─ api/                  # content.js (feed/posts/visibility) / media.js / admin.js / rss.js
│  └─ tg/                   # parser.js (t.me HTML) / fetcher.js (fetch + cache + bridge)
├─ public/                  # build-free native ESM frontend (app/api/ui/views/media/admin + i18n.js)
├─ functions/[[path]].js    # Pages bridge layer
├─ bridge/                  # private-channel bridge (Node ≥20, teleproto sessions)
├─ tests/  tools/           # node --test suite / dev-server + contrast audit tools
├─ wrangler.jsonc           # Workers config
└─ package.json
```

## Security

- Session cookies: `HttpOnly + SameSite=Lax + Secure(HTTPS)`, server-side TTL check
- Passwords: PBKDF2-SHA256 + random salt (100k rounds), constant-time comparison
- Login rate limit: 8 failures per IP in 5 min → `429`
- Media proxy SSRF guard: allowlist (`telesco.pe / t.me / telegram.org / telegram-cdn.*` + bridge host), `https` only
- Post HTML sanitized server-side: drops `script/style/iframe` + all event attrs, external links forced `target=_blank rel=noopener`
- Channel identifier validation: usernames `^[A-Za-z0-9_]{4,64}$`, numeric IDs `^-?\d{5,25}$`

## Contributing

Pull Requests welcome! Please ensure:

1. Code follows project standards
2. Add necessary tests
3. Update relevant documentation
4. Clearly describe the reasons for changes

## Get Help

- GitHub Repository: [TG-RSS](https://github.com/replycore/TG-RSS)
- Live Demo: [rss.new.tg](https://rss.new.tg)
- Issue Report: [Create New Issue](https://github.com/replycore/TG-RSS/issues)
