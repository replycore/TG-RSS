# Cloudflare Pages 部署说明

TG-RSS 同一份代码兼容 **Cloudflare Workers** 与 **Cloudflare Pages** 两种部署形态：

```
                    src/index.js (export default { fetch })
                              │
              ┌───────────────┴────────────────┐
              ▼                                ▼
   Workers（直接执行）              Pages（经桥接层）
   wrangler.deploy.jsonc           functions/[[path]].js
   wrangler deploy                  import worker from "../src/index.js"
```

两条路径共享全部业务代码（`src/`），互不影响；哪边部署哪边生效。

## 架构

| 文件 | 作用 |
|---|---|
| `src/index.js` | Worker 入口：`export default { fetch }`（Pages 经桥接层复用同一 handler） |
| `src/router.js` → `src/api/*` → `src/tg/*` | 业务代码（API / RSS / 解析 / 签名） |
| `functions/[[path]].js` | **Pages 桥接层**：API/RSS 请求转交 `handleRequest`；其余走静态资源或 `context.next()`（SPA 回退） |
| `public/` | 静态资源（`_headers`、前端 JS/CSS/HTML） |
| `wrangler.deploy.jsonc` | Workers 部署配置（本地文件，含真实账号/域名，不入库；模板见 `wrangler.worker.example.jsonc`） |

## 当前状态

- **生产：Cloudflare Pages**，项目 `tg-rss`，生产地址 `https://<你的项目>.pages.dev`，生产分支 `main`
- **Workers：保留作回退**（不再声明自定义域名，可经 `workers.dev` 访问）

## 首次部署（新账号/新机器）

前置：已安装 wrangler 并登录（`wrangler login` 或环境变量 `CLOUDFLARE_API_KEY` / `CLOUDFLARE_EMAIL`）。

```bash
# 1. 创建 Pages 项目（只需一次）
wrangler pages project create tg-rss --production-branch main --compatibility-date 2026-10-01

# 2. 绑定 KV（只需一次，Dashboard 操作）
#    Pages 项目 → Settings → Bindings → Add（Production）：
#      TG_RSS_KV  →  KV namespace  →  选择 TG_RSS_KV 所在的 namespace
#    ASSETS 是 Pages 内置绑定，无需手动添加

# 3. 部署
wrangler pages deploy public --project-name tg-rss --branch main
```

> **重要：绑定只对新部署生效。** 新增/修改 bindings（KV、环境变量等）后必须重新
> `wrangler pages deploy`，否则旧部署的运行时里没有该绑定（表现为 health `kv:false`、空信息流）。

## 域名绑定

### Cloudflare 托管的 zone

在 Pages 项目 → Custom domains → Add 即可；也可在 zone 的 DNS 面板手动加记录（CDN 边缘按 Host 路由）：

```
CNAME  rss.example.com  →  <你的项目>.pages.dev   （代理开启）
```

加完即生效（Pages domain 验证状态可能滞后，不用等）。

### 第三方 DNS 托管的域名（Pages 独有能力，Workers 做不到）

在该域名的 DNS 管理面板加一条 CNAME 即可，**无需把 zone 迁入 Cloudflare**：

```
CNAME  你的子域  →  <你的项目>.pages.dev
```

CF 边缘按 Host 头路由到 Pages 项目，立即生效。可选地在 Pages 项目里把该域名
加进 Custom domains（纯展示/验证，路由不依赖它）。

> 如果要在 Workers 上绑定域名，则必须把该域名的 zone 托管在 CF 账号内——这是 Workers 的限制。

## 桥接（bridge）用户须知

TG-RSS 部署在 Pages，私密频道桥接 `bridge/` **仍跑在你自己机器上**，需自行 `git pull` + 重启。

> ⚠️ **升级顺序：必须先升 bridge，再升 TG-RSS。** 两侧双向不兼容且无开关可绕：
> 新版 TG-RSS 只发 HMAC 签名头（旧的 `x-token` 回退已按安全要求移除），
> 旧版 TG-RSS 用 `?token=` 而新版 bridge 已删除该支持——任一方向错序都会让私密频道 401。
> 请把 bridge 与 TG-RSS 的升级安排在同一时段。详见 [README §9 私密频道桥接](./README.md#9-私密频道桥接bridge)。

## 环境变量与 Secrets

- **全部配置存储在 KV**（`TG_RSS_KV`），Worker 与 Pages 共用同一个 namespace，切换部署形态零数据迁移。
- **无 secret**：后台密码、桥接 token 等都通过管理后台写入 KV，不在环境变量里。
- 若以后新增环境变量：Worker 侧 `wrangler secret put`（名字见 `wrangler.deploy.jsonc` vars）；
  Pages 侧在项目 Settings → Environment variables 添加同名变量，**同样需要重新部署生效**。

## 回退到 Workers

```bash
# 首次：从模板创建本地配置（不入库），填入 account_id / KV id / 域名
cp wrangler.worker.example.jsonc wrangler.deploy.jsonc

wrangler deploy --config wrangler.deploy.jsonc
```

Worker 无自定义域名时会经 `workers.dev` 访问（如 `tg-rss.<subdomain>.workers.dev`）。
注意：自定义域名（如 `rss.example.com`）目前绑定在 Pages；要切回 Workers，需先在
Pages 侧删除该域名，再在 Worker 侧重新绑定。

## 版本号维护

`package.json`、`src/router.js`、`public/app.js`、`public/index.html` 四处保持一致；
两条部署路径从同一仓库分支构建，版本天然一致。

## 常见问题

| 现象 | 原因与处理 |
|---|---|
| health 显示 `kv:false` / 信息流为空 | bindings 改动后未重新部署 → 重新 `wrangler pages deploy` |
| 部署后首页 404/白屏 | `functions/[[path]].js` 未编译进产物 → 确认 `public/` 同级的 `functions/` 存在并提交 |
| 别名域名短暂路由到旧部署 | Pages 别名切换瞬间现象，片刻恢复 |
| 静态资源 CSP 失效 | `public/_headers` 丢失或未提交 |
