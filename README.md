# Unified Auth Service

## Identity authority 与二维码迁移基线

`AUTH_DATA_SOURCE=identity` 时，此服务仅验证微信 provider 回调并调用 Identity API；账户、绑定、令牌和二维码状态均由 Identity 私库管理，不创建旧 MySQL/Redis store。

最终切换前，旧模式的所有实例必须先运行包含发行记录的兼容版本，持续至少实际最大二维码有效期，然后短暂停止发行与回调、导出最终快照。`GET /v1/wechat/qrcode` 会在返回原响应前写入 `auth_legacy_scene_metadata(scene_digest,provider_app_id,issued_at,expires_at)`；摘要为原 scene 的 SHA256 hex，时间按 UTC DATETIME(3) 保存。发行时间取 provider 请求前的时间，过期时间使用 provider 返回的有效期，避免网络延迟延长原二维码寿命。该记录不表示已扫码，`refresh` 对未扫码的 scene 仍返回原来的 `token not found`。

配置旧 Redis 时，还写入 `identity:legacy_scene:<scene_digest>` hash，字段同 SQL，时间为 UTC ISO 字符串，通过原始绝对毫秒时间 `PEXPIREAT` 过期。回调保留首次发行的过期时间；已过期 scene 不会复活。基线版本之前且没有记录的 scene 保留旧行为，但离线导入不得凭空推算其 TTL。

基线部署前显式运行 schema migration（`AUTH_DATABASE_AUTO_MIGRATE=true` 或独立迁移流程）。SQL 导出应将时间格式化为明确的 UTC，且不包含密码/刷新令牌：

```sql
SET time_zone = '+00:00';
SELECT scene_digest, provider_app_id,
  DATE_FORMAT(issued_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS issued_at,
  DATE_FORMAT(expires_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS expires_at
FROM auth_legacy_scene_metadata
WHERE expires_at > UTC_TIMESTAMP(3);
```

这是一个独立部署的统一登录中心，用新的 Node.js 22 + TypeScript 技术栈替代旧的 `gdgeek/auth` Yii2 实现。

第一阶段目标不是做一个只服务 `bujiaban.com` 的专用登录服务，而是先兼容 `bujiaban.com` 当前依赖的旧接口，再把底层模型升级成通用身份中心，供 `bujiaban.com`、`3dugc.com` 和后续其他服务复用。

## 目标

- 替代旧 Yii2/PHP `gdgeek/auth`。
- 保持旧 `/v1/wechat/*` 接口兼容，让 `bujiaban.com` 可以无痛灰度切换。
- 用 `auth_users` + `auth_identities` 作为通用用户身份模型。
- 以微信 `unionid` 作为公众号、网站扫码、小程序身份合并锚点。
- 提供 OAuth Authorization Code + PKCE 基础接口，后续各业务站点不再直接保存公众号 AppSecret。
- 作为独立 Docker 服务部署，不污染 3D Model Optimizer 或其他业务仓库。

## 当前实现

- `GET /health`
- `GET /v1/wechat`、`GET /v1/wechat/check`
- `POST /v1/wechat`
- `GET /v1/wechat/qrcode`
- `GET /v1/wechat/refresh?token=...`
- `GET /v1/wechat/menu`
- `GET /v1/wechat/test`、`GET /v1/wechat/the`（旧调试接口，默认关闭）
- 微信明文模式、兼容模式、AES 安全模式消息处理
- `GET /oauth/authorize`
- `POST /oauth/token`
- `POST /oauth/revoke`
- `GET /userinfo`
- `POST /logout`
- `GET /.well-known/openid-configuration`
- MySQL 自动建表
- 内存模式用于本地开发和测试
- 兼容旧 Compose 环境变量
- GitHub Actions CI：`develop/main/publish` 三分支 build/test，发布到腾讯云 TCR

## 本地运行

```bash
npm install
npm run build
npm test
npm run dev
```

本地 Docker：

```bash
docker compose up --build
```

## Git 部署

分支模型和 `7dgame-com/ar-slam` 保持一致：

| Branch | Purpose | Docker tag |
| --- | --- | --- |
| `develop` | 开发集成 | `develop` |
| `main` | 主干稳定 | `main` |
| `publish` | 发布分支 | `publish`、`latest` |

CI 和部署工作流位于 `.github/workflows/`，规则见 [DEPLOYMENT.md](DEPLOYMENT.md)。

## CI 镜像

GitHub Actions 发布到腾讯云 TCR：

```text
hkccr.ccs.tencentyun.com/plugins/auth-service
```

需要在 GitHub 仓库配置：

```text
TENCENT_REGISTRY_USERNAME
TENCENT_REGISTRY_PASSWORD
```

兼容 `ar-slam` 的写法，也支持把用户名放在 `TENCENT_REGISTRY_USER`。

## 旧 Compose 兼容

旧服务类似这样部署：

```yaml
auth:
  image: hkccr.ccs.tencentyun.com/plugins/auth-service:<tag>
  networks:
    - proxy
  labels:
    - "traefik.enable=true"
    - "traefik.docker.network=proxy"
    - "traefik.http.routers.b1_bujiaban_com-secure.entrypoints=websecure"
    - "traefik.http.routers.b1_bujiaban_com-secure.rule=Host(`auth.bujiaban.com`)"
    - "traefik.http.routers.b1_bujiaban_com-secure.middlewares=test-compress@file"
  environment:
    - MYSQL_HOST=<mysql-host>
    - MYSQL_DB=<mysql-db>
    - MYSQL_USERNAME=<mysql-user>
    - MYSQL_PASSWORD=<mysql-password>
    - JWT_KEY=/var/www/.ssh/ecc-private-key.pem
    - WECHAT_APP_ID=<wechat-official-account-appid>
    - WECHAT_SECRET=<wechat-official-account-secret>
    - WECHAT_TOKEN=<wechat-message-token>
    - WECHAT_AES_KEY=
    - REDIS_HOST=redis
    - REDIS_PORT=6379
    - REDIS_DB=0
  security_opt:
    - seccomp:unconfined
  restart: always
  volumes:
    - /home/ubuntu/src/ssh/:/var/www/.ssh/
```

新服务继续识别这些变量。推荐新部署使用 `docker-compose.portainer.yml`，其中额外明确了 Traefik 内部端口：

```yaml
- "traefik.http.services.b1_bujiaban_com.loadbalancer.server.port=3010"
```

不要把真实数据库密码、微信 AppSecret、Token 写入仓库。

## 环境变量

新变量优先：

```text
AUTH_PUBLIC_BASE_URL=https://auth.bujiaban.com
AUTH_DATABASE_URL=mysql://user:pass@host:3306/db
AUTH_DATABASE_AUTO_MIGRATE=true
AUTH_TOKEN_SECRET=<random-secret-or-private-key-content>
AUTH_LOGIN_ENTRIES_JSON='[{"slug":"bujiaban","clientId":"bujiaban-web","defaultRedirectUri":"https://bujiaban.com/auth/callback","allowedReturnUrlPrefixes":["https://bujiaban.com/"],"defaultScopes":["openid","profile"],"provider":"wechat_official_account","displayName":"不加班"}]'
AUTH_WECHAT_OFFICIAL_APP_ID=wx...
AUTH_WECHAT_OFFICIAL_APP_SECRET=...
AUTH_WECHAT_OFFICIAL_TOKEN=...
AUTH_WECHAT_OFFICIAL_AES_KEY=
```

## 多 URL 登录入口

标准 OAuth 入口 `/oauth/authorize` 继续可用。为了让业务站少拼 OAuth 参数，也可以配置短登录入口：

```text
GET /login/:slug
```

示例：

```text
https://auth.bujiaban.com/login/bujiaban?return_to=https%3A%2F%2Fbujiaban.com%2Fdashboard&state=client-state&code_challenge=...&code_challenge_method=S256
```

服务会根据 `slug` 找到对应 OAuth client、默认 `redirect_uri`、scope 和登录方式。登录成功后回跳业务 callback：

```text
https://bujiaban.com/auth/callback?code=...&state=client-state&return_to=https%3A%2F%2Fbujiaban.com%2Fdashboard
```

`redirect_uri` 仍然必须精确匹配 OAuth client 白名单；`return_to` 只允许匹配 `allowedReturnUrlPrefixes`，不能传任意外部 URL。

兼容旧变量：

```text
MYSQL_HOST
MYSQL_PORT
MYSQL_DB
MYSQL_USERNAME
MYSQL_PASSWORD
JWT_KEY
WECHAT_APP_ID
WECHAT_SECRET
WECHAT_TOKEN
WECHAT_AES_KEY
REDIS_HOST
REDIS_PORT
REDIS_DB
REDIS_PASSWORD
```

配置 `REDIS_HOST` 后，legacy 扫码登录会读写旧 Yii Redis 结构：

```text
open_id
open_id:a:<Yii buildKey(token)>
```

旧 Yii 里还暴露了 `/v1/wechat/test` 和 `/v1/wechat/the` 两个调试接口。新服务默认关闭它们，确实需要临时兼容验证时再设置：

```text
AUTH_ENABLE_LEGACY_DEBUG_ENDPOINTS=true
```

## 数据模型

核心表：

- `wechat`（旧 Yii 表，legacy 扫码登录继续读写）
- `auth_users`
- `auth_identities`
- `auth_legacy_scan_tokens`（未配置 Redis 时的扫码 token 后备表）
- `auth_oauth_authorization_codes`
- `auth_oauth_refresh_tokens`

旧 `/v1/wechat/refresh` 会先按旧 Redis 的 `token -> openid` 找扫码用户，再按 `wechat.openid` 查旧绑定；`wechat.user_id` 有值返回 `signin`，否则返回 `signup`。
