# TG-RSS

> 🌐 **Live demo: https://rss.new.tg** · [简体中文](./README.md)

A self-hosted **Telegram channel reader & RSS generator** that runs on Cloudflare Workers or Cloudflare Pages (one codebase, both deployment modes).

- **Public channels**: fetched directly from `t.me/s/<channel>` preview pages — no external services required.
- **Private channels**: relayed by the bundled [`bridge/`](./bridge) program (your own Telegram account), with HMAC signing in both directions (worker ↔ bridge).
- **Reading**: reverse-chronological multi-channel feed, media mode (video / image / audio / files with native browser playback), tag filtering, dark mode.
- **Multilingual UI**: 简体中文 (default) / English, switchable from the header button (dictionaries live in each file's `reg()` block, see `public/i18n.js`).
- **RSS**: `/rss.xml` (all channels) or per-channel `/api/rss?channel=<key>`, optionally token-gated.
- **Admin panel**: channels, visibility, sorting, RSS token, Turnstile login protection — everything stored in Workers KV; private channels are enforced **server-side (403)**, not just hidden in the UI.

## Docs

| Doc | Contents |
| --- | --- |
| [README.md](./README.md) | Full documentation (简体中文)：features, architecture, deployment, admin usage, API, tests |
| [PAGES.md](./PAGES.md) | Cloudflare Pages deployment (project creation, KV binding, custom domains incl. third-party CNAME, Worker fallback) |
| [CONFIG.md](./CONFIG.md) | Configuration reference (where to change each item, values, defaults, verification) |

## Quick start

```bash
npm install   # install wrangler and friends
npm test      # run the test suite
npm run dev   # http://localhost:8787 (wrangler dev, needs workerd)
```

Deploy to Pages:

```bash
npx wrangler pages project create tg-rss --production-branch=main
npx wrangler pages deploy public --project-name tg-rss
# then bind KV in Dashboard: Settings → Bindings → TG_RSS_KV (re-deploy afterwards!)
```

See [PAGES.md](./PAGES.md) for full deployment instructions (GitHub auto-deploy, one-click Deploy button, CLI, KV binding, custom domains, bridge upgrade order).
