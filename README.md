# Unified Auth Service

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
AUTH_WECHAT_OFFICIAL_APP_ID=wx...
AUTH_WECHAT_OFFICIAL_APP_SECRET=...
AUTH_WECHAT_OFFICIAL_TOKEN=...
AUTH_WECHAT_OFFICIAL_AES_KEY=
```

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
```

旧 Yii 里还暴露了 `/v1/wechat/test` 和 `/v1/wechat/the` 两个调试接口。新服务默认关闭它们，确实需要临时兼容验证时再设置：

```text
AUTH_ENABLE_LEGACY_DEBUG_ENDPOINTS=true
```

## 数据模型

核心表：

- `auth_users`
- `auth_identities`
- `auth_legacy_scan_tokens`
- `auth_legacy_login_tokens`
- `auth_oauth_authorization_codes`
- `auth_oauth_refresh_tokens`

旧 `wechat.openid/unionid/user_id` 后续可以导入到 `auth_identities`，再通过 `unionid` 合并到 `auth_users`。
