# TG-RSS 配置说明

配置位置：`wrangler.jsonc` / 环境变量 / 管理后台 / `bridge/.env` / 浏览器 localStorage。
生效优先级：环境变量 > 后台设置 > 代码默认值。

---

## 1. 环境变量（Worker / Pages）

| 变量 | 作用 | 默认值 | 设置命令 |
| --- | --- | --- | --- |
| `ADMIN_USERNAME` | 管理员用户名 | `admin` | `npx wrangler secret put ADMIN_USERNAME` |
| `ADMIN_PASSWORD` | 管理员密码（设了以后后台改密入口失效） | 无 | `npx wrangler secret put ADMIN_PASSWORD` |
| `BRIDGE_URL` | 私密频道桥接地址（设了优先后台配置） | 空 | `npx wrangler secret put BRIDGE_URL` |
| `BRIDGE_TOKEN` | 桥接令牌（设了优先后台配置） | 空 | `npx wrangler secret put BRIDGE_TOKEN` |
| `DEBUG` | 设任意值后，500 错误会回显详情 | 未设 | 控制台 → Workers → tg-rss → Variables |

- 删除变量：`npx wrangler secret delete <名字>`
- Pages 侧：项目 → Settings → Variables and Secrets 里添加

## 2. `wrangler.jsonc`

| 字段 | 说明 | 建议值 |
| --- | --- | --- |
| `name` | Worker 名（决定 `<name>.<子域>.workers.dev`） | `tg-rss` |
| `account_id` | 目标账号 id | 你的账号 id |
| `compatibility_date` | 兼容性日期 | 保持不动 |
| `compatibility_flags` | 运行时兼容开关 | `["nodejs_compat"]`（必须保留） |
| `workers_dev` | 是否开放 workers.dev 访问 | `true` / `false` |
| `routes[].pattern` | 自定义域名，一条一个 | `rss.example.com` |
| `routes[].custom_domain` | 是否按自定义域名方式绑定 | `true` |
| `assets.directory` | 前端静态目录 | `./public` |
| `assets.binding` | 静态资源变量名 | `ASSETS` |
| `assets.not_found_handling` | 找不到文件时的行为 | `single-page-application`（不要改） |
| `assets.run_worker_first` | 先进 Worker 的路径 | `["/api/*", "/rss.xml"]`（RSS 由 Worker 生成） |
| `kv_namespaces[].binding` | KV 变量名 | `TG_RSS_KV` |
| `kv_namespaces[].id` | KV 命名空间 id | 控制台创建后填入 |
| `observability.enabled` | 日志查询 | `true` |
| `logpush` | 日志推送 | `false` |

改完执行：`npm run deploy:worker`

## 3. 管理后台设置（存在 KV）

登录后台：`https://<你的域名>/#/admin`

### 3.1 站点设置（`settings:general`）

| 设置项 | 取值 | 默认 |
| --- | --- | --- |
| 站点标题 `siteTitle` | ≤80 字符 | `TG-RSS` |
| 每页条数 `pageSize` | 5–50 | `20` |
| 缓存时间 `cacheTtl`（秒） | 0–3600 | `120`（不要设 0） |
| 信息流频道数 `feedChannels` | 1–8 | `6` |
| 显示浏览数 `showViews` | true / false | `true` |
| 显示日期 `showDate` | true / false | `true` |
| 主题 `theme` | `auto` / `light` / `dark` | `auto` |

### 3.2 媒体设置（`settings:media`）

| 设置项 | 取值 | 默认 |
| --- | --- | --- |
| 视频 / 图片 / 音频 / 文件 四类开关 | true / false | 全部 `true` |
| 每页数量 `pageSize` | 6–60 | `24` |
| 全站代理 `proxyAll` | true / false | `true` |

### 3.3 频道（`settings:channels`）

| 字段 | 取值 | 说明 |
| --- | --- | --- |
| `type` | `public` / `private` | 公开走 `t.me/s/`，私密走桥接 |
| `username` | `^[A-Za-z0-9_]{4,64}$` | 公开频道用户名（不带 @） |
| `tgId` | `^-?\d{5,25}$` | 私密频道数字 ID，如 `-1001234567890` |
| `name` | ≤80 字符 | 显示名称 |
| `order` | 整数 | 排序，越小越靠前 |
| `hidden` | true / false | true = 未登录不可见 |
| `mediaOnly` | true / false | 「仅媒体」：信息流与频道页只显示该频道带媒体的帖子，纯文字不显示；媒体模式照常收录 |
| `enabled` | true / false | 是否参与抓取 |

操作入口：后台 →「频道」→ 添加 / 测试连通 / 刷新 / 显示隐藏。

### 3.4 私密频道桥接（`settings:bridge`）

| 设置项 | 取值 | 默认 |
| --- | --- | --- |
| 桥接地址 `url` | 必须 `http://` 或 `https://` 开头 | 空 |
| 启用 `enabled` | true / false | `false` |
| 令牌 `token` | 随机长串，≤200 字符 | 空 |

保存后点「连通性测试」确认。

## 4. 主题配置

| 项 | 值 |
| --- | --- |
| 后台默认主题 | 后台 → 站点设置 → 主题：`auto` / `light` / `dark` |
| 浏览器覆盖 | 站内右上角主题按钮，写入 `localStorage.tgrss.theme` |
| 优先级 | `localStorage` > 后台 `theme` > `auto` |

## 5. 桥接 `bridge/.env`

```bash
TG_API_ID=            # https://my.telegram.org/apps 申请
TG_API_HASH=
TG_PHONE=+8613800000000
TG_SESSION=           # npm run login 生成，自动写入
BRIDGE_TOKEN=         # 一长串随机串，要与后台「令牌」一致
PORT=8788             # 监听端口
BRIDGE_HOST=127.0.0.1  # 监听地址，默认仅本机；0.0.0.0 才接受外部连接
PUBLIC_URL=https://    # 桥接的公网地址（https）
```

```bash
cd bridge && cp .env.example .env   # 改完
npm install
npm run login                       # 首次登录
npm start                           # 启动
curl http://127.0.0.1:8788/health   # 应返回 ok
```

## 6. 配置存储位置（KV Key）

| Key | 内容 |
| --- | --- |
| `settings:general` | 站点设置 |
| `settings:channels` | 频道列表 |
| `settings:media` | 媒体设置 |
| `settings:bridge` | 桥接设置 |
| `admin:cred` | 管理员凭据 |
| `auth:sess:<token>` | 会话（7 天） |
| `auth:limit:<ip>` | 登录限流计数（5 分钟） |
| `channel:meta:<key>` | 频道头像/简介 |
| `channel:sync:<key>` | 同步游标 |

```bash
npx wrangler kv key list --namespace-id <id>          # 列出
npx wrangler kv key get "settings:general" --namespace-id <id>   # 查看
npx wrangler kv key put "settings:general" '{"siteTitle":"TG-RSS"}' --namespace-id <id>
```

## 7. 用接口改配置（可脚本化）

```bash
# 登录拿 Cookie
curl -c cookie.txt -X POST https://<域名>/api/admin/login \
  -H 'content-type: application/json' \
  -d '{"username":"admin","password":"你的密码"}'

# 改站点设置
curl -b cookie.txt -X POST https://<域名>/api/admin/settings \
  -H 'content-type: application/json' \
  -d '{"general":{"siteTitle":"我的订阅","pageSize":30,"theme":"dark"}}'

# 改媒体设置
curl -b cookie.txt -X POST https://<域名>/api/admin/settings \
  -H 'content-type: application/json' \
  -d '{"media":{"video":true,"image":false,"pageSize":12}}'

# 改频道列表（整表覆盖）
curl -b cookie.txt -X POST https://<域名>/api/admin/settings \
  -H 'content-type: application/json' \
  -d '{"channels":[{"type":"public","username":"telegram","name":"Telegram 官方","order":0}]}'
```

## 8. 部署相关命令

```bash
npm install
npm run dev:node        # 本地 http://localhost:8787
npm run dev             # wrangler dev（需要 workerd）
npm test                # 41 项测试
node tools/palette-check.mjs     # 主题对比度检查

npm run deploy:worker   # 部署 Workers
npm run pages:project   # 创建 Pages 项目（首次）
npm run deploy:pages    # 部署 Pages

npm run bridge:install  # 装桥接依赖
npm run bridge:login    # 桥接登录
npm run bridge:start    # 启动桥接
```

## 9. 部署后验证

```bash
B=https://<你的域名>
for p in /api/health /api/config /api/channels /api/feed /api/media / /styles.css; do
  printf "%-16s %s\n" "$p" "$(curl -s -o /dev/null -w '%{http_code}' $B$p)"
done
# 期望：全部 200
# 未登录 /api/admin/settings → 401；不存在的 /api/* → 404

curl -s $B/styles.css | md5sum    # 与本地 public/styles.css 的 md5 对比
curl -s -o /dev/null -w '%{http_code}' https://<域名>/admin   # SPA 回退应 200
```

## 10. 常见配置问题

| 现象 | 检查 |
| --- | --- |
| 刷新子路由 404 | `assets.not_found_handling` 是否为 `single-page-application` |
| `/api/*` 返回 404 | `assets.run_worker_first` 是否含 `/api/*` |
| 改了后台设置没生效 | 是否点了保存；或改了同名环境变量（环境变量优先） |
| 改了 CSS 没生效 | `curl $B/styles.css` 对比 md5；强刷或加版本参数 |
| 后台改密被拒 | 是否设置了 `ADMIN_PASSWORD` 环境变量 |
| 登录 429 | 失败超 8 次，等 5 分钟 |
| 桥接连通性测试失败 | `PUBLIC_URL` / `BRIDGE_URL` 是否 https、令牌是否一致 |
| 频道测试报「频道不存在」 | `username`/`tgId` 是否符合上面的正则 |
| 私密频道 403 | 未登录 + `hidden=true` 属于预期 |
| 上游 429 | 把 `cacheTtl` 保持在 120 秒以上 |
