# TG-RSS

基于 Cloudflare Workers 与 Pages 的自托管 **Telegram 频道阅读器 & RSS 生成器**。

[![仓库](https://img.shields.io/badge/View%20on-GitHub-blue.svg)](https://github.com/replycore/TG-RSS)
[![在线演示](https://img.shields.io/badge/Live%20Demo-rss.new.tg-green.svg)](https://rss.new.tg)

**[English](README.md)**

## 功能

- 支持 Cloudflare Workers 与 Pages 部署（一份代码，两种形态）
- **公开频道**：直接抓取 `t.me/s/<频道>` 预览页，无需任何外部服务
- **私密频道**：通过仓库内的 [`bridge/`](./bridge) 程序转发（你自己的 Telegram 账号），Worker ↔ 桥接双向 HMAC 签名
- 全频道聚合信息流，**按发布时间倒序**，游标分页
- **媒体模式**：视频 / 图片 / 音频 / 文件四类分类浏览，浏览器原生播放器，支持 Range 拖动
- 标签筛选（`?tag=` + 正文 `#话题` 点击筛选）
- **广告自动隐藏**：带 `#广告` `#ad` `#推广` `#sponsor` 等标签的消息全局隐藏（信息流 / 频道页 / RSS）
- **多语言界面**：简体中文（默认）/ English，顶栏按钮切换
- **RSS 2.0**：`/rss.xml` 聚合订阅、`/api/rss?channel=<key>` 单频道订阅，可选令牌保护
- **管理后台**：频道、可见性、排序、RSS 令牌、Turnstile 登录保护，配置全存 Workers KV
- **服务端可见性**：隐藏频道对未登录用户直接 403，不只是前端隐藏
- 媒体代理（SSRF 白名单）+ `?dl=1` 附件下载（中文文件名 RFC 5987）

## 快速部署

### 部署到 Pages.dev（生产形态，推荐）

1. Fork 本仓库到你的 GitHub 账号
2. 新建 Pages 项目：Cloudflare Dashboard → Workers & Pages → Create → Pages → Connect to Git → 选你的 Fork
   - 构建命令：*留空*
   - 构建输出目录：`public`
   - 根目录的 `functions/[[path]].js` 会被自动识别为 Functions
3. 绑定 KV：项目 → Settings → Bindings → Add → `TG_RSS_KV` → 你的 KV 命名空间（**之后必须重新部署一次！**）
4. 绑定域名（可选）：项目 → Custom domains → Add。第三方 DNS 也行——在你的 DNS 商加一条 `CNAME 子域 → <你的项目>.pages.dev` 即可，**无需把 zone 迁入 Cloudflare**（Workers 做不到这点）。

KV 细节、第三方 CNAME、Worker 回退、桥接升级顺序见 [PAGES.md](./PAGES.md)。

### 部署到 Worker.dev

复制配置模板、填好值、部署：

```bash
cp wrangler.worker.example.jsonc wrangler.deploy.jsonc  # 填 account_id / KV id / 域名
npx wrangler deploy --config wrangler.deploy.jsonc
```

或点下面的按钮直接部署：

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/replycore/TG-RSS)

> 注意：按钮建的是 **Worker**（回退形态），不是 Pages。生产配置（Pages + KV + 自定义域）请按上面的 Pages 步骤走。

## 配置指南

### 环境变量（Worker / Pages 侧，全可选）

| 变量 | 示例 | 说明 |
|----------|---------|-------------|
| `ADMIN_USERNAME` | `admin` | 管理员用户名（默认 `admin`） |
| `ADMIN_PASSWORD` | — | 设置后**优先生效**，后台无法改密，只能改环境变量 |
| `SETUP_CODE` | — | 设置后首次初始化管理员需带此口令（防裸站被人抢先初始化） |
| `BRIDGE_URL` | `https://tg-bridge.example.com` | 私密频道桥接地址，优先于后台配置 |
| `BRIDGE_TOKEN` | — | 桥接令牌 |

优先级：**环境变量 > 后台首次初始化 > 未初始化（要求先初始化）**。

设置方式：`npx wrangler secret put <变量名>`（Worker）或项目 Settings → Variables and Secrets（Pages，**改完需重新部署**）。

### 管理后台设置（存在 KV）

| 分区 | 内容 |
|---------|-------|
| 站点 | 标题、每页条数、抓取缓存 TTL、信息流并发、主题 |
| 频道 | 增删改、显示名、排序、连通性测试、元信息刷新、隐藏 / 仅媒体 / 启用开关 |
| 媒体 | 四类开关、每页数量、全站走代理 |
| 桥接 | 地址、令牌、启用、连通性测试 |
| 安全 | 改密、会话、RSS 令牌（生成 / 复制 / 吊销） |

### 桥接 `bridge/.env`

| 变量 | 必填 | 示例 | 说明 |
|----------|----------|---------|-------------|
| `TG_API_ID` / `TG_API_HASH` | 是 | — | https://my.telegram.org/apps 申请 |
| `TG_PHONE` | 是 | `+8613800138000` | 账号手机号，国际格式 |
| `TG_SESSION` | 是 | — | `npm run login` 打印的会话字符串 |
| `BRIDGE_TOKEN` | 是 | — | 与 TG-RSS 后台「私密频道桥接 → 访问令牌」保持一致 |
| `PORT` | 否 | `8788` | 监听端口（默认 8788） |
| `BRIDGE_HOST` | 否 | `127.0.0.1` | 监听地址（默认仅本机） |
| `PUBLIC_URL` | 是 | `https://tg-bridge.example.com` | 公网 HTTPS 地址，供 Worker 访问 |
| `BRIDGE_SIGN_WINDOW_SEC` | 否 | `300` | HMAC 签名时间窗，60~3600（默认 300） |
| `BRIDGE_ALLOWED_ORIGINS` | 否 | — | Origin 白名单，仅约束头认证请求 |

运行（需**整仓 clone**，`bridge/` 不能脱离仓库单独运行）：

```bash
cd bridge
cp .env.example .env   # 按上表填写
npm install
npm run login          # 输入 Telegram 验证码，写入 TG_SESSION
npm start              # 监听 8788，需公网 HTTPS（推荐 Cloudflare Tunnel）
```

> ⚠️ **升级顺序：先升 bridge，再升 TG-RSS。** 双向不兼容且无开关可绕（新 TG-RSS 只发 HMAC 签名头，新 bridge 移除了 `?token=` 支持）。请安排在同一时段升级。详见 [PAGES.md](./PAGES.md#桥接bridge用户须知)。

### 桥接接口（`/health` 免鉴权，其余需 HMAC 签名头）

| 路径 | 说明 |
| --- | --- |
| `GET /health` | 存活检查 |
| `GET /feed?channel=&before=&limit=` | 频道消息（与公开频道同结构） |
| `GET /media?ch=&m=` | 媒体文件，支持 `Range`，磁盘缓存 |
| `GET /thumb?ch=&m=` | 视频缩略图（`<video poster>` 用） |
| `GET /avatar?ch=` | 频道头像 |

## 使用方法

1. 打开站点，点右上角**登录**（或 `#/admin`）
2. 首次是**初始化**页：设置用户名 + 密码（≥8 位），写入 KV
3. **频道**页：选`公开频道`，输入用户名（如 `telegram`）→ **测试** → 自动带出显示名 → **添加**；私密频道选`私密频道`填数字 ID（如 `-1001234567890`，需先配桥接）
4. 每行可切**隐藏**（未登录不可见）、**仅媒体**、**启用**，可上移下移排序，改完点**保存全部修改**
5. **媒体**页：四类开关、每页数量、全站代理；**常规**页：标题、条数、缓存 TTL、并发、主题；**安全**页：改密、会话、RSS 令牌

## API 一览

公开（无需登录）：

```
GET  /api/health
GET  /api/config
GET  /api/channels                      # 仅返回当前身份可见的频道
GET  /api/feed?c=<游标>[&tag=<标签>]   # 聚合信息流，游标分页，#话题过滤
GET  /api/channels/:key/posts?before=&limit=
GET  /api/media?type=video|image|audio|file&c=<游标>&key=
GET  /api/media/proxy?u=<base64url(地址)>  # Range 直通、白名单
GET  /api/media/doc?key=&post=&i=        # 文件直链按需解析
GET  /rss.xml                            # 聚合 RSS 2.0
GET  /api/rss[?channel=<key>[&limit=]]   # 聚合或单频道 RSS
```

管理（需登录）：

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

## 注意事项

- **公开频道的"文件"没有直链**：`t.me/s/` 预览页只给文件名与大小。媒体模式展示文件名/大小，点「获取文件」会尝试单条 embed 页解析，仍拿不到就跳 Telegram 原文。要直接下载文件请配私密频道走桥接。
- **抓取缓存不要设 0**：`t.me` 有频率限制，默认 120 秒缓存足够阅读场景。
- 只订阅你有权访问的频道，遵守 Telegram 服务条款与当地法律。
- CDN 媒体链接带过期 token，TTL 过期后重新抓取即更新（自动）。
- 一旦设置 `ADMIN_PASSWORD` 环境变量，后台改密入口会提示由环境变量管理。

## 本地开发

```bash
npm install          # 安装 wrangler 等依赖
npm test             # 运行单测（155 项）
npm run dev          # http://localhost:8787（wrangler dev，需要 workerd）
npm run dev:node     # 同端口，纯 Node（tools/dev-server.mjs），不需要 workerd
```

测试用 `tests/fixtures/` 里真实抓取的 t.me 页面快照。`tests/frontend.test.js` 用 happy-dom 驱动真实视图请求真实后端，需另开终端先启动 `npm run dev`（或 `dev:node`）提供 `http://localhost:8787`；未启动自动跳过。

## 目录结构

```
├─ src/                     # 服务端（Worker 与 Pages 共用）
│  ├─ index.js              # 入口 { fetch }
│  ├─ router.js             # 路由 /api/*
│  ├─ store.js              # KV 读写、频道模型、凭据、会话、限流
│  ├─ auth.js               # 初始化 / 登录 / 会话 Cookie / 改密
│  ├─ util.js               # HTML 清洗、编码、PBKDF2、Cookie
│  ├─ api/                  # content.js（信息流/帖子/可见性）/ media.js / admin.js / rss.js
│  └─ tg/                   # parser.js（t.me 解析）/ fetcher.js（抓取+缓存+桥接）
├─ public/                  # 无构建原生 ESM 前端（app/api/ui/views/media/admin + i18n.js）
├─ functions/[[path]].js    # Pages 桥接层
├─ bridge/                  # 私密频道桥接（Node ≥20，teleproto 会话）
├─ tests/  tools/           # node --test 单测 / dev-server + 对比度审计工具
├─ wrangler.jsonc           # Workers 配置
└─ package.json
```

## 安全设计

- 会话 Cookie：`HttpOnly + SameSite=Lax + Secure(HTTPS)`，服务端 TTL 校验
- 密码：PBKDF2-SHA256 + 随机盐（10 万轮），定长比较
- 登录限流：同 IP 5 分钟 8 次失败 → `429`
- 媒体代理 SSRF 防护：仅放行 `telesco.pe / t.me / telegram.org / telegram-cdn.*` 与桥接自身域名，仅 `https`
- 消息 HTML 服务端白名单清洗：去 `script/style/iframe` 与全部事件属性，外链强制 `target=_blank rel=noopener`
- 频道标识强校验：用户名 `^[A-Za-z0-9_]{4,64}$`，数字 ID `^-?\d{5,25}$`

## 参与贡献

欢迎 Pull Request！请确保：

1. 代码符合项目规范
2. 添加必要的测试
3. 更新相关文档
4. 清楚描述改动原因

## 获取帮助

- GitHub 仓库：[TG-RSS](https://github.com/replycore/TG-RSS)
- 在线演示：[rss.new.tg](https://rss.new.tg)
- 问题反馈：[Create New Issue](https://github.com/replycore/TG-RSS/issues)
