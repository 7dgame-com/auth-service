# Unified Auth Service Design

## 1. 背景

当前 `bujiaban.com` 的注册和登录依赖旧仓库 `gdgeek/auth`。旧服务是 Yii2/PHP 实现，主要围绕微信公众号扫码登录工作，能力比较专用：

- 公众号临时二维码生成。
- 微信消息推送事件接收。
- 扫码后通过 `token -> openid` 轮询完成登录。
- 在旧 `wechat` 表里保存 `openid`、`unionid`、`user_id` 和登录 token。

新服务的目标不是简单重写 Yii2，而是用新的技术栈替代旧实现，并把“专用公众号 auth”升级为“通用身份中心”。

第一阶段必须兼容旧接口，保证 `bujiaban.com` 可以低风险灰度切换；第二阶段逐步让 `bujiaban.com`、`3dugc.com` 和其他服务接入标准 OAuth/OIDC 风格登录。

## 2. 目标

- 使用独立项目和独立 Docker 镜像部署，不放进 `3D-Model-Optimizer` 或其他业务仓库。
- 用 Node.js 22 + TypeScript 替代旧 Yii2/PHP。
- 保留旧 `gdgeek/auth` 的关键接口形状，让 `bujiaban.com` 可无痛替换。
- 抽象通用用户模型，支持多个业务系统共用同一套账号。
- 微信体系内使用 `unionid` 合并公众号、网站扫码、小程序身份。
- 业务系统通过 OAuth Authorization Code + PKCE 接入，不再直接保存微信 AppSecret。
- 后续可扩展手机号、邮箱、企业微信、Apple、GitHub、Google 等登录方式。
- 能在 Portainer + Traefik 下直接替换旧 `auth.bujiaban.com` 服务。

## 3. 非目标

- 第一阶段不重做 `bujiaban.com` 前端登录体验。
- 第一阶段不强制 `bujiaban.com` 立刻改 OAuth。
- 第一阶段不迁移所有历史用户业务数据，只迁移身份映射。
- 不把真实数据库密码、微信 AppSecret、Token 写入 Git。
- 不继续维护 Yii2 技术栈。

## 4. 推荐技术栈

第一版建议：

- Runtime: Node.js 22 LTS。
- Language: TypeScript。
- HTTP: Express 或 Fastify。若追求最小迁移成本，Express 足够；若新项目从零做，也可选 Fastify。
- DB: 腾讯云 TDSQL-C MySQL。
- DB Access: Prisma 或 `mysql2`。如果团队要标准 migration，推荐 Prisma；如果要最少依赖，`mysql2` 也可以。
- Cache: Redis 可选。旧流程的扫码 token 可存在 MySQL，Redis 后续用于 session 和限流。
- Token: Access Token + Refresh Token。
- OAuth: Authorization Code + PKCE。
- Deploy: Docker + GitHub Actions + Portainer + Traefik。
- Image: `hkccr.ccs.tencentyun.com/plugins/auth-service:latest`。

## 5. 域名与部署形态

生产域名沿用：

```text
https://auth.bujiaban.com
```

灰度建议：

```text
https://auth-next.bujiaban.com
```

服务内部端口：

```text
3010
```

Traefik 需要明确内部端口，避免默认猜错：

```yaml
- "traefik.http.services.b1_bujiaban_com.loadbalancer.server.port=3010"
```

## 6. 旧 Yii2 兼容接口

为了让 `bujiaban.com` 低风险切换，第一阶段保留以下接口。

### 微信服务器验证

```text
GET /v1/wechat
GET /v1/wechat/check
```

Query:

```text
signature
timestamp
nonce
echostr
```

行为：

- 使用 `WECHAT_TOKEN` 或 `AUTH_WECHAT_OFFICIAL_TOKEN` 校验签名。
- 校验成功返回纯文本 `echostr`。
- 校验失败返回 `403`。

### 创建扫码二维码

```text
GET /v1/wechat/qrcode
```

行为：

- 生成随机 `scan_token`。
- 调用微信公众号临时二维码 API。
- 返回旧格式，保持 `bujiaban.com` 兼容。

Response:

```json
{
  "success": true,
  "message": "create qrcode",
  "qrcode": {
    "ticket": "...",
    "expire_seconds": 3600,
    "url": "..."
  },
  "token": "scan-token"
}
```

### 接收微信扫码事件

```text
POST /v1/wechat
```

微信推送 XML，处理：

- `SCAN`
- `subscribe`

行为：

- 从 `EventKey` 取 scene token。
- 兼容 `qrscene_<token>` 前缀。
- 保存 `scan_token -> openid` 映射。
- 回复微信 XML 文本。

### 轮询扫码结果

```text
GET /v1/wechat/refresh?token=<scan_token>
```

未扫码：

```json
{
  "success": false,
  "message": "token not found"
}
```

已扫码：

```json
{
  "success": true,
  "message": "signin",
  "token": "legacy-login-token"
}
```

或首次注册：

```json
{
  "success": true,
  "message": "signup",
  "token": "legacy-login-token"
}
```

兼容点：

- `success/message/token` 字段保持旧 Yii2 形状。
- `message` 仍使用 `signin` / `signup`。
- 后端内部可以把 token hash 后存储。

## 7. 新通用 OAuth 接口

第二阶段逐步让业务系统接入这些接口。

```text
GET  /.well-known/openid-configuration
GET  /.well-known/jwks.json
GET  /oauth/authorize
POST /oauth/token
POST /oauth/revoke
GET  /userinfo
POST /logout
```

微信登录入口：

```text
GET  /login/wechat/offiaccount
GET  /login/wechat/offiaccount/callback
GET  /login/wechat/website
GET  /login/wechat/website/callback
POST /login/wechat/miniprogram
```

### Web OAuth 流程

```text
Browser -> App: 点击登录
App -> Auth: GET /oauth/authorize?client_id=...&redirect_uri=...&scope=openid profile&state=...&code_challenge=...
Auth -> WeChat: 公众号网页授权或网站扫码
WeChat -> Auth: callback with code
Auth: 换 openid/unionid，创建或绑定用户
Auth -> App: redirect_uri?code=...&state=...
App -> Auth: POST /oauth/token
Auth -> App: access_token + refresh_token + id_token
App -> Auth: GET /userinfo
```

### OAuth Client 示例

```text
client_id=bujiaban-web
redirect_uri=https://bujiaban.com/auth/callback
scope=openid profile
```

```text
client_id=3dugc-web
redirect_uri=https://3dugc.com/auth/callback
scope=openid profile
```

## 8. 数据模型

### auth_users

通用用户主表。

```text
id                   varchar primary key
primary_unionid      varchar unique nullable
display_name         varchar nullable
avatar_url           text nullable
status               active / disabled
created_at
updated_at
```

### auth_identities

外部身份表。一个用户可以绑定多个身份。

```text
id                   varchar primary key
user_id              varchar
provider             varchar
provider_app_id      varchar
openid               varchar
unionid              varchar nullable
profile_json         json nullable
created_at
updated_at

unique(provider, provider_app_id, openid)
index(user_id)
index(unionid)
```

Provider 建议：

```text
wechat_official_account
wechat_website
wechat_mini_program
phone
email
wechat_work
apple
github
google
```

### auth_legacy_scan_tokens

兼容旧扫码轮询。

```text
token                varchar primary key
provider_app_id      varchar
openid               varchar
scene                varchar nullable
expires_at
consumed_at nullable
created_at
```

### auth_legacy_login_tokens

兼容旧站登录 token。

```text
token_hash           varchar primary key
user_id              varchar
provider_app_id      varchar
openid               varchar
unionid              varchar nullable
expires_at
revoked_at nullable
created_at
```

### oauth_clients

OAuth 客户端。第一阶段也可以先用环境变量配置，后续入库。

```text
id
client_id unique
client_secret_hash nullable
name
allowed_redirect_uris_json
allowed_origins_json
scopes_json
status
created_at
updated_at
```

### oauth_authorization_codes

```text
code_hash primary key
client_id
user_id
redirect_uri
code_challenge
code_challenge_method
scopes_json
expires_at
consumed_at
created_at
```

### oauth_refresh_tokens

```text
token_hash primary key
client_id
user_id
scopes_json
expires_at
revoked_at
created_at
```

### auth_audit_logs

后续建议补：

```text
id
user_id nullable
event
client_id nullable
ip
user_agent
metadata_json
created_at
```

## 9. 身份合并规则

优先级：

1. 如果同一 `provider + provider_app_id + openid` 已存在，更新 profile，并返回同一个用户。
2. 如果新身份有 `unionid`，且已有用户 `primary_unionid = unionid`，绑定到已有用户。
3. 如果没有匹配身份，也没有匹配 `unionid`，创建新 `auth_user`。
4. 如果小程序暂时拿不到 `unionid`，先用小程序 `openid` 建 identity，后续拿到 `unionid` 再合并。

风险控制：

- 自动合并只依赖微信开放平台下的 `unionid`。
- 人工合并需要管理端和审计日志。
- 不要用昵称、头像、手机号明文做自动合并依据。

## 10. 环境变量

新变量优先：

```text
AUTH_SERVICE_HOST=0.0.0.0
AUTH_SERVICE_PORT=3010
AUTH_PUBLIC_BASE_URL=https://auth.bujiaban.com
AUTH_CORS_ORIGINS=https://auth.bujiaban.com,https://bujiaban.com,https://3dugc.com
AUTH_DATABASE_URL=mysql://user:password@host:3306/database
AUTH_DATABASE_AUTO_MIGRATE=true
AUTH_TOKEN_SECRET=<random-secret-or-private-key-content>
AUTH_ACCESS_TOKEN_TTL_SECONDS=900
AUTH_REFRESH_TOKEN_TTL_SECONDS=2592000
AUTH_LEGACY_SCAN_TOKEN_TTL_SECONDS=3600
AUTH_LEGACY_LOGIN_TOKEN_TTL_SECONDS=2592000
AUTH_WECHAT_OFFICIAL_APP_ID=wx...
AUTH_WECHAT_OFFICIAL_APP_SECRET=...
AUTH_WECHAT_OFFICIAL_TOKEN=...
AUTH_WECHAT_OFFICIAL_AES_KEY=
AUTH_OAUTH_CLIENTS_JSON=[...]
```

兼容旧 Yii2 Compose 变量：

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
```

兼容策略：

- 如果 `AUTH_DATABASE_URL` 为空，用 `MYSQL_HOST/MYSQL_DB/MYSQL_USERNAME/MYSQL_PASSWORD` 拼 MySQL URL。
- 如果 `AUTH_TOKEN_SECRET` 为空，读取 `JWT_KEY` 指向的文件内容；如果文件不存在，可把 `JWT_KEY` 当作字符串密钥。
- 如果 `AUTH_WECHAT_OFFICIAL_*` 为空，读取旧的 `WECHAT_*`。

## 11. Portainer Compose 模板

不要提交真实密钥，以下只保留结构：

```yaml
services:
  auth:
    image: hkccr.ccs.tencentyun.com/plugins/auth-service:latest
    networks:
      - proxy
    labels:
      - "traefik.enable=true"
      - "traefik.docker.network=proxy"
      - "traefik.http.routers.b1_bujiaban_com-secure.entrypoints=websecure"
      - "traefik.http.routers.b1_bujiaban_com-secure.rule=Host(`auth.bujiaban.com`)"
      - "traefik.http.routers.b1_bujiaban_com-secure.middlewares=test-compress@file"
      - "traefik.http.services.b1_bujiaban_com.loadbalancer.server.port=3010"
    environment:
      - NODE_ENV=production
      - AUTH_SERVICE_PORT=3010
      - AUTH_PUBLIC_BASE_URL=https://auth.bujiaban.com
      - AUTH_DATABASE_AUTO_MIGRATE=true
      - AUTH_ALLOW_MOCK_WECHAT=false
      - AUTH_CORS_ORIGINS=https://auth.bujiaban.com,https://bujiaban.com,https://3dugc.com

      - MYSQL_HOST=<mysql-host>
      - MYSQL_PORT=3306
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

networks:
  proxy:
    external: true
```

## 12. Dockerfile 要求

建议：

```dockerfile
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production AUTH_SERVICE_HOST=0.0.0.0 AUTH_SERVICE_PORT=3010
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
EXPOSE 3010
CMD ["node", "dist/run.js"]
```

## 13. CI 要求

CI 模仿 `7dgame-com/ar-slam` 的三分支发布模型，推送分支标签，不推短哈希标签，避免私有镜像仓库容量被占满。

分支与镜像标签：

```text
develop -> hkccr.ccs.tencentyun.com/plugins/auth-service:develop
main    -> hkccr.ccs.tencentyun.com/plugins/auth-service:main
publish -> hkccr.ccs.tencentyun.com/plugins/auth-service:publish
publish -> hkccr.ccs.tencentyun.com/plugins/auth-service:latest
```

```text
hkccr.ccs.tencentyun.com/plugins/auth-service
```

GitHub Secrets：

```text
TENCENT_REGISTRY_USERNAME
TENCENT_REGISTRY_PASSWORD
```

CI 步骤：

```text
npm ci
npm run build
npm test
docker buildx build --push -t ...:latest .
```

## 14. 迁移步骤

### P0: 新服务可运行

- [ ] 新建独立仓库 `git@github.com:7dgame-com/auth-service.git`。
- [ ] 初始化 Node.js 22 + TypeScript 项目。
- [ ] 实现 `/health`。
- [ ] 实现 MySQL 配置和自动建表。
- [ ] 实现旧环境变量兼容。
- [ ] 实现 Dockerfile。
- [ ] 实现 Portainer Compose 模板。
- [ ] CI 构建并推 `latest` 镜像。

### P1: 兼容旧 bujiaban.com

- [ ] 实现 `GET /v1/wechat` 微信服务器验证。
- [ ] 实现 `GET /v1/wechat/qrcode`。
- [ ] 实现 `POST /v1/wechat` 事件接收。
- [ ] 实现 `GET /v1/wechat/refresh`。
- [ ] 保持 `success/message/token` 返回结构。
- [ ] 使用 MySQL 保存扫码 token 和 legacy login token。
- [ ] 在 `auth-next.bujiaban.com` 灰度验证。
- [ ] 切换 `auth.bujiaban.com` 到新服务。
- [ ] 保留旧 Yii2 容器回滚窗口。

### P2: 通用 OAuth

- [ ] 实现 OAuth Client 配置。
- [ ] 实现 Authorization Code + PKCE。
- [ ] 实现 Refresh Token。
- [ ] 实现 `/userinfo`。
- [ ] 实现 `/.well-known/openid-configuration`。
- [ ] `bujiaban.com` 从 legacy token 升级到 OAuth。
- [ ] `3dugc.com` 接入统一登录中心。

### P3: 多登录方式

- [ ] 微信开放平台网站扫码。
- [ ] 微信小程序登录。
- [ ] 手机号登录。
- [ ] 邮箱登录。
- [ ] 管理端用户合并。
- [ ] 审计日志。
- [ ] 风控和限流。

## 15. 验证清单

部署前：

- [ ] `npm run build` 通过。
- [ ] `npm test` 通过。
- [ ] Docker 镜像本地可启动。
- [ ] `/health` 返回 ok。
- [ ] MySQL 表能自动创建。

灰度验证：

- [ ] `GET /v1/wechat` 能通过微信服务器验证。
- [ ] `/v1/wechat/qrcode` 能返回真实二维码。
- [ ] 扫码后 `POST /v1/wechat` 能收到事件。
- [ ] `/v1/wechat/refresh` 能返回 `signin/signup`。
- [ ] 旧 `bujiaban.com` 登录/注册流程不需要前端改动。
- [ ] 日志中不打印 AppSecret、Token、数据库密码。

切换后：

- [ ] 旧 Yii2 容器保留回滚。
- [ ] 观察登录成功率。
- [ ] 观察 MySQL 错误率。
- [ ] 观察微信 API 错误码。
- [ ] 确认无异常后再做 OAuth 升级。

## 16. 回滚方案

如果新服务异常：

1. Portainer 把 `auth` stack 镜像切回旧 tag。
2. 保持 `auth.bujiaban.com` 域名不变。
3. 微信公众号后台回调 URL 不需要变。
4. 新服务写入的 `auth_*` 表保留，不影响旧 Yii2 表。
5. 修复后再次灰度。

## 17. 后续与业务系统的关系

`bujiaban.com`：

- 第一阶段继续使用旧扫码接口。
- 第二阶段升级到 OAuth。

`3dugc.com`：

- 不再直接配置公众号 AppSecret。
- 通过 `client_id=3dugc-web` 接统一登录。
- 钱包用户表绑定 `auth_user_id` 和 `unionid`。

其他重后端服务：

- 统一跳 OAuth。
- 只保存 `auth_user_id`。
- 不关心微信 AppID/AppSecret。

## 18. 关键原则

- 新技术栈替代旧 Yii2。
- 旧接口只是兼容层，不是新架构核心。
- 用户身份模型必须通用，不绑定 `bujiaban.com`。
- 微信 `openid` 只在具体渠道内唯一，跨渠道统一靠 `unionid`。
- 业务系统不直接保存第三方登录密钥。
- 部署和密钥管理与业务代码分离。
