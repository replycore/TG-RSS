# TG-RSS

部署在 **Cloudflare Workers** 或 **Cloudflare Pages** 上的 Telegram 频道阅读器。

- 公开频道：Cloudflare 直接抓取 `t.me/s/<频道>` 预览页，无需任何外部服务
- 私密频道：配置自己的 Telegram 账号，通过仓库内的 `bridge/` 程序转发到网页
- 管理员登录后台配置 **频道 ID / 显示名称 / 排序 / 可见性**，配置全部保存在 **KV**
- **未登录访客看不到指定频道**（服务端 403，不只是前端隐藏）
- **媒体模式**：视频 / 图片 / 音频 / 文件四类分类浏览，视频使用**浏览器原生播放器**播放，支持新窗口交给系统默认播放器
- **信息流**：全频道聚合，**按发布时间倒序**展示
- **下载**：图片 / 视频 / 音频 / 文件在消息卡片、媒体模式卡片和大图查看器里都有「下载」按钮，跨域地址由代理下发 `Content-Disposition: attachment`（带正确文件名）
- **RSS 订阅**：`/rss.xml` 聚合订阅、`/api/rss?channel=<key>` 单频道订阅，任意 RSS 客户端可用
- **分享链接添加频道**：直接粘贴 `t.me/xxx`、`t.me/s/xxx`、`@xxx`、`tg://resolve?domain=xxx` 等
- **#标签筛选**：信息流顶部一键按 `#话题` 过滤，正文里的 `#标签` 可直接点
- **侧栏底部**：关于 / 版本号 / 仓库地址

**文档导航**

| 文档 | 内容 |
| --- | --- |
| [README.md](./README.md) | 功能、架构、部署、后台使用、API、测试 |
| [CONFIG.md](./CONFIG.md) | **配置说明**：每个配置项在哪改、取值、默认值、验证方法 |

---

## 1. 功能清单

| 模块 | 说明 |
| --- | --- |
| 信息流 | 聚合所有可见频道，**按发布时间倒序**分页加载 |
| 频道页 | 单频道阅读，游标翻页，浏览数 / 评论数 / 时间 |
| 媒体模式 | `视频 / 图片 / 音频 / 文件` 四类分类、频道筛选、灯箱播放 |
| 媒体代理 | `/api/media/proxy` 统一回源，支持 Range 拖动，SSRF 白名单 |
| 管理后台 | 首次初始化 / 登录 / 会话（KV，7 天）/ 登录限流 / 改密 |
| 频道管理 | 增删改、显示名、上移下移、连通性测试、元信息刷新、隐藏开关、停用开关、仅媒体开关 |
| 可见性 | `hidden` 频道对未登录用户：列表不返回、帖子 403、媒体 403 |
| 私密频道 | `bridge/` 账号桥接：读取历史消息、媒体、头像，支持 Range 断点 |
| RSS 订阅 | `GET /rss.xml` 聚合 / `GET /api/rss?channel=<key>` 单频道，输出 RSS 2.0 |
| 分享链接 | 后台添加频道接受 t.me 分享链接、@用户名、tg:// 链接，自动归一化 |
| #标签筛选 | 信息流 `?tag=` 过滤 + 正文 `#话题` 点击筛选 |
| 媒体下载 | `?dl=1` 走代理回 `attachment`，支持中文文件名（RFC 5987） |

## 2. 架构

```
浏览器 ──▶ Cloudflare Worker / Pages Function
             │
             ├─ /api/*           业务逻辑（src/）
             │    ├─ 公开频道 ──▶ https://t.me/s/<频道>   （Cache API 缓存）
             │    ├─ 私密频道 ──▶ https://<你的桥接>/feed （bridge/ 账号）
             │    └─ 设置/会话 ─▶ KV  TG_RSS_KV
             │
             └─ 其余路径 ──▶ 静态资源 public/（SPA）

bridge/（跑在你的 VPS / 家里 / 内网穿透）
  Telethon 类账号会话 ──▶ Telegram MTProto ──▶ 私密频道消息与媒体
```

同一份 `src/index.js` 同时被两种部署方式复用：

- **Workers**：`wrangler.jsonc` 的 `main` 指向 `src/index.js`，`assets` 提供静态资源
- **Pages**：`functions/[[path]].js` 把请求转交给同一个 `fetch` 处理器

## 3. 目录结构

```
├─ src/                     # 服务端（Worker 与 Pages 共用）
│  ├─ index.js              # 入口 { fetch }
│  ├─ router.js             # 路由 /api/*
│  ├─ store.js              # KV 读写、频道模型、凭据、会话、限流
│  ├─ auth.js               # 初始化 / 登录 / 会话 Cookie / 改密
│  ├─ util.js               # HTML 清洗、编码、PBKDF2、Cookie
│  ├─ api/
│  │  ├─ content.js         # 频道列表 / 帖子 / 信息流 / 可见性
│  │  ├─ media.js           # 媒体分类 / 文件直链解析 / 媒体代理
│  │  └─ admin.js           # 后台设置 CRUD / 连通性测试
│  └─ tg/
│     ├─ parser.js          # t.me HTML 解析（纯字符串，可单测）
│     └─ fetcher.js         # 抓取 + 缓存 + 桥接调用
├─ public/                  # 无构建原生 ESM 前端
│  ├─ index.html  styles.css
│  ├─ app.js       # 路由 / 启动 / 侧栏 / 主题
│  ├─ api.js  ui.js  views.js  media.js  admin.js
├─ functions/[[path]].js    # Pages 桥接层
├─ bridge/                  # 私密频道桥接（Node ≥20）
│  ├─ server.js login.js client.js post.js config.js
│  ├─ .env.example
├─ tests/                   # node --test 单测（41 项，含 tests/styles.test.js 主题回归）
├─ tools/                   # dev-server.mjs 本地服务 / palette-check.mjs 对比度审计
│                            # contrast.mjs 逐元素审计 / screenshot.mjs 截图（后两个需 Chrome）
├─ wrangler.jsonc           # Workers 配置
└─ package.json
```

## 4. 本地开发

```bash
npm install          # 安装 wrangler 等依赖
npm test             # 运行单测（41 项）
npm run dev          # http://localhost:8787（wrangler dev，需要 workerd）
npm run dev:node     # 同端口，纯 Node 启动（tools/dev-server.mjs），不需要 workerd
```

本地 `wrangler dev` 使用本地模拟 KV，`wrangler.jsonc` 里的占位 id 可以直接用。
如果 `wrangler dev` 因为 workerd 起不来（例如 musl/Alpine 容器），改用 `npm run dev:node`：
它用同一份 `src/index.js` + 内存版 KV/Cache 提供完全一样的 HTTP 接口。

> 可读性检查：`node tools/palette-check.mjs` 不需要浏览器即可审计两套主题的文字对比度
> （任何文字项低于 4.5:1 退出码 1）；`node tools/contrast.mjs` 需要真实 Chrome，逐元素取计算样式。

## 5. 部署到 Cloudflare Workers

> 首次部署前，先把 `wrangler.jsonc` 里的 3 处占位符换成你自己的值：
> `account_id`（账号 ID）、`routes[0].pattern`（你的域名，或删掉 routes 只用 workers.dev）、
> `kv_namespaces[0].id`（执行 `npx wrangler kv namespace create TG_RSS_KV` 后得到）。

```bash
# 1) 创建 KV 命名空间，把输出的 id 填进 wrangler.jsonc 的 kv_namespaces[0].id
npx wrangler kv namespace create TG_RSS_KV

# 2) 部署
npx wrangler deploy
```

`wrangler.jsonc` 关键配置：

```jsonc
{
  "main": "src/index.js",
  "assets": {
    "directory": "./public",
    "binding": "ASSETS",
    "not_found_handling": "single-page-application",
    "run_worker_first": ["/api/*"]   // 只让 /api/* 先进 Worker，其余走静态资源
  },
  "kv_namespaces": [{ "binding": "TG_RSS_KV", "id": "你的 id" }]
}
```

## 6. 部署到 Cloudflare Pages

```bash
# 1) 创建 Pages 项目
npx wrangler pages project create tg-rss --production-branch=main

# 2) 部署（构建目录 = public，functions/ 目录会自动打包）
npx wrangler pages deploy public --project-name tg-rss

# 3) 在控制台给项目绑定 KV：
#    Workers & Pages → tg-rss → Settings → Bindings → KV Namespace
#    变量名必须是 TG_RSS_KV
```

> Pages 上静态资源请求默认也会经过 `functions/[[path]].js`（内部再转发给资源服务器）。
> 若站点流量较大、想省掉这部分 Functions 额度，可在 `public/` 下加 `_routes.json`：
> ```json
> { "version": 1, "include": ["/api/*"], "exclude": ["/*"] }
> ```
> 代价是直接访问 `https://你的域名/media` 这类路径会 404（站内路由全部使用 `#/` 哈希，不受影响）。

## 7. 使用管理后台

1. 打开站点，点右上角 **登录**（或 `#/admin`）
2. 首次进入是 **初始化** 页：设置用户名 + 密码（≥8 位），写入 KV
3. **频道** 页：
   - 选择 `公开频道`，输入用户名（如 `telegram`）→ **测试** → 自动带出显示名 → **添加**
   - 私密频道选 `私密频道`，填数字 ID（如 `-1001234567890`），需先配好桥接
   - 每行可切换 **隐藏**（未登录不可见）、**仅媒体**、**启用**，可上移下移排序
   - 改完点 **保存全部修改**
4. **媒体** 页：开关四类分类、每页数量、是否全站走代理
5. **常规** 页：站点标题、每页条数、抓取缓存 TTL、信息流并发频道数、主题
6. **安全** 页：修改密码、退出登录

### 隐藏频道（未登录不显示）

把频道行的可见性切换成 `隐藏中` 并保存即可：

- `GET /api/channels` 不返回该频道
- `GET /api/channels/<key>/posts` → `403 hidden_channel`
- `GET /api/media` 不包含该频道的媒体

## 8. 环境变量

### Worker / Pages 侧（可选）

| 变量 | 作用 |
| --- | --- |
| `ADMIN_USERNAME` | 管理员用户名（默认 `admin`） |
| `ADMIN_PASSWORD` | 设置后**优先生效**，后台无法改密，只能改环境变量 |
| `BRIDGE_URL` | 私密频道桥接地址，设置后优先后台配置 |
| `BRIDGE_TOKEN` | 桥接令牌 |

设置方式：

```bash
# Worker
npx wrangler secret put ADMIN_PASSWORD
# 或在 wrangler.jsonc 中加 "vars": { "ADMIN_USERNAME": "admin" }

# Pages：项目 Settings → Variables and Secrets
```

> 凭据优先级：**环境变量 > 后台首次初始化 > 未初始化（要求先初始化）**

### 桥接侧 `bridge/.env`

参考 `bridge/.env.example`：

```
TG_API_ID=...            # https://my.telegram.org/apps
TG_API_HASH=...
TG_PHONE=+8613800138000
TG_SESSION=              # npm run login 生成
BRIDGE_TOKEN=一长串随机串
PORT=8788
PUBLIC_URL=https://tg-bridge.example.com
```

## 9. 私密频道桥接（bridge/）

桥接是跑在**你自己的机器**上的常驻程序：用你的 Telegram 账号登录一次，之后向 Worker 提供 HTTPS 接口。

```bash
cd bridge
cp .env.example .env        # 填 TG_API_ID / TG_API_HASH / TG_PHONE / BRIDGE_TOKEN
npm install
npm run login               # 按提示输入验证码，自动写入 TG_SESSION
npm start                   # 启动，监听 8788

鉴权三选一：`x-token` 头（TG-RSS Worker 用）、`Authorization: Bearer`、`?token=` 查询参数。
监听地址默认只绑 `127.0.0.1`；要让局域网访问需显式 `BRIDGE_HOST=0.0.0.0`。
```

### 让 Worker 能访问到它

桥接必须**公网可达**，任选其一：

```bash
# 1) Cloudflare Tunnel（推荐，免费且带 HTTPS）
cloudflared tunnel --url http://127.0.0.1:8788
# 把得到的 https 地址写入 PUBLIC_URL 与 TG-RSS 后台「私密频道桥接」

# 2) 直接跑在 VPS 上，配 Nginx/Caddy 反代 + HTTPS
# 3) frp / tailscale funnel 等内网穿透
```

### 在 TG-RSS 后台配置

`管理 → 私密频道桥接`：填地址 + 令牌 + 勾选启用 → 保存 → **连通性测试**。

桥接接口（全部需要 `x-token`，`/health` 除外）：

| 路径 | 说明 |
| --- | --- |
| `GET /health` | 存活检查 |
| `GET /feed?channel=&before=&limit=` | 频道消息（结构与公开频道一致） |
| `GET /media?ch=&m=` | 媒体文件，支持 `Range`，磁盘缓存 |
| `GET /avatar?ch=` | 频道头像 |

> 媒体首次播放/下载会触发桥接去 Telegram 拉取并缓存到 `bridge/cache/`，之后走本地缓存。
> 桥接收到的媒体 URL 会由 Worker 的 `/api/media/proxy` 转发（自动附加令牌）。

## 10. KV 数据结构

| Key | 内容 |
| --- | --- |
| `settings:general` | 站点标题、每页条数、缓存 TTL、信息流并发、主题、显示开关 |
| `settings:channels` | 频道数组：`{key,type,username,tgId,name,order,hidden,mediaOnly,enabled}` |
| `settings:media` | 四类分类开关、每页数量、是否全站代理 |
| `settings:bridge` | 桥接地址 / 令牌 / 启用状态 |
| `admin:cred` | `{username,salt,hash,iterations}`（PBKDF2-SHA256，100000 轮） |
| `auth:sess:<token>` | 会话记录，TTL 7 天 |
| `auth:limit:<ip>` | 登录失败计数，5 分钟窗口，超过 8 次 429 |
| `channel:meta:<key>` | 频道头像 / 简介 / 计数（10 分钟节流回写） |
| `channel:sync:<key>` | 同步游标 |

抓取到的页面正文走 **Cache API**（`caches.default`），不占 KV 写配额。

## 11. API 一览

公开：

```
GET  /api/health
GET  /api/config
GET  /api/channels                      # 仅返回当前身份可见的频道
GET  /api/feed?c=<游标>
GET  /api/feed?c=<游标>&tag=<标签>   # 按 #话题 过滤（可与游标组合）
GET  /api/channels/:key/posts?before=&limit=
GET  /api/media?type=video|image|audio|file&c=<游标>&key=
GET  /api/media/proxy?u=<base64url(地址)>  # Range 直通、白名单
GET  /api/media/doc?key=&post=&i=        # 文件直链按需解析
```

管理（需登录）：

```
GET  /api/admin/state
POST /api/admin/setup        {username,password}
POST /api/admin/login        {username,password}
POST /api/admin/logout
POST /api/admin/password     {currentPassword,newPassword}
GET  /api/admin/settings
POST /api/admin/settings     {general?,media?,bridge?,channels?}
POST /api/admin/channels/test    {channel}
POST /api/admin/channels/refresh {key}
GET  /api/admin/stats

# RSS 订阅（公开，无需登录）
GET  /rss.xml                    # 聚合全部可见频道
GET  /api/rss                    # 同上
GET  /api/rss?channel=<key>      # 单个频道
```

## 12. 测试

```bash
npm test        # node --test，41 项（解析器 / 清洗 / 存储 / 鉴权 / 桥接归一化 / 样式回归 / 前端集成）
```

解析器测试使用 `tests/fixtures/` 中真实抓取的 t.me 页面快照。

`tests/frontend.test.js` 用 happy-dom 驱动真实视图请求真实后端，需要先在另一个终端启动
`npm run dev`（或 `npm run dev:node`）提供 `http://localhost:8787`；未启动时该用例自动跳过，不影响其它测试。

`tests/styles.test.js` 是主题回归：锁死 `[hidden]` 全局规则、三套主题的 `color-scheme` 声明，
以及「文字不得直接用 `var(--accent)`」这三条，防止主题回归。
配色数值本身由 `node tools/palette-check.mjs` 兜底，无需浏览器。

## 13. 已知限制与注意事项

1. **公开频道的“文件”没有直链**：`t.me/s/` 预览页只给出文件名与大小，不暴露下载地址。
   媒体模式会展示文件名 / 大小，点「获取文件」会尝试从单条 embed 页解析，仍拿不到就跳转 Telegram 原文。
   需要直接下载文件时，请把频道配成私密频道走桥接。
2. **视频源**来自预览页给出的视频地址，超长视频可能是 Telegram 的预览片段。
3. **不要把抓取缓存调到 0**：`t.me` 有频率限制，默认 120 秒缓存足够阅读场景。
4. 仅抓取你有权访问的频道，请遵守 Telegram 服务条款与当地法律。
5. CDN 上的媒体链接带 `token`，过期后重新抓取页面即可拿到新地址（缓存 TTL 过期后自动更新）。
6. 环境变量一旦设置 `ADMIN_PASSWORD`，后台改密入口会提示由环境变量管理。

## 14. 安全设计

- 会话 Cookie：`HttpOnly + SameSite=Lax + Secure(HTTPS)`，服务端 TTL 校验
- 密码：PBKDF2-SHA256 + 随机盐（100k 轮，workerd 上限），环境变量路径用 SHA-256 定长比较
- 登录限流：同 IP 5 分钟内 8 次失败 → `429`
- 媒体代理 SSRF 防护：仅放行 `telesco.pe / t.me / telegram.org / telegram-cdn.*` 与桥接自身域名，仅 `https`
- 消息 HTML 服务端白名单清洗：去掉 `script/style/iframe` 与全部事件属性，外链强制 `target=_blank rel=noopener`
- 频道标识强校验：用户名 `^[A-Za-z0-9_]{4,64}$`，数字 ID `^-?\d{5,25}$`
