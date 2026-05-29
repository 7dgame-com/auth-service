# 规格：支持多 URL 登录

状态：草稿
日期：2026-05-28
仓库：auth-service

## 背景

当前服务已经具备标准 OAuth Authorization Code + PKCE 流程，并且 `OAuthClient.redirectUris` 会精确校验 `redirect_uri`。默认配置里已经有 `bujiaban-web` 和 `3dugc-web` 两个 client，但“登录入口 URL”本身还不是一等配置。

现状问题：

- `/oauth/authorize` 要求业务方显式传 `client_id`、`redirect_uri`、`scope`、`state`、PKCE 参数。
- `/login/wechat/offiaccount` 是 OAuth 内部步骤，只接收签名后的 state，不适合作为业务方直接入口。
- 微信网页授权 callback 使用单个 `AUTH_PUBLIC_BASE_URL` 拼接，服务实例目前只有一个公开 issuer/callback 域名。
- 菜单和 legacy 流程里仍有偏向单站点的默认行为。

本规格设计一个可扩展模型，让不同业务 URL 都能通过统一认证服务登录，同时避免开放重定向、client 混淆和跨站 token 泄露。

## 目标

- 支持多个业务站点从不同 URL 发起登录，例如 `https://bujiaban.com/login`、`https://3dugc.com/login`、后续更多服务。
- 支持短登录入口，例如业务方跳到 `https://auth.bujiaban.com/login/:slug?...`，由认证服务补齐 client、默认 redirect URI、scope 和登录方式。
- 保持已有 `/oauth/authorize` 标准入口兼容，已经接 OAuth 的业务不需要改。
- 所有回跳 URL 必须可配置、可校验、可审计，不能接受任意外部 URL。
- 为后续微信网站扫码、小程序、更多品牌展示留接口；第一阶段只落地公众号网页授权。

## 非目标

- 第一阶段不实现完整登录页 UI。
- 不改变 access token、refresh token、id token 的签发格式。
- 不允许通过 query 传任意 `redirect_uri` 或 `return_to` 绕过 client 白名单。
- 不要求立刻把 OAuth client 全部迁移到数据库；可以先支持环境变量 JSON，数据库作为下一步。

## 核心概念

### OAuth Client

OAuth client 继续作为安全边界。一个 client 表示一个可信业务应用，包含：

- `clientId`
- `redirectUris`
- `allowedOrigins`
- `scopes`
- `publicClient`
- 可选 `clientSecret`

当前代码已有这个结构，后续主要补充加载来源和校验能力。

### 登录入口 Login Entry

新增“登录入口”配置，负责把用户访问的登录 URL 映射到一个 OAuth client 和默认登录行为。

建议结构：

```ts
interface LoginEntry {
  slug: string;
  clientId: string;
  defaultRedirectUri: string;
  allowedReturnUrlPrefixes: string[];
  defaultScopes: string[];
  provider: 'wechat_official_account' | 'wechat_website' | 'wechat_mini_program';
  displayName?: string;
}
```

示例：

```json
[
  {
    "slug": "bujiaban",
    "clientId": "bujiaban-web",
    "defaultRedirectUri": "https://bujiaban.com/auth/callback",
    "allowedReturnUrlPrefixes": ["https://bujiaban.com/", "https://www.bujiaban.com/"],
    "defaultScopes": ["openid", "profile"],
    "provider": "wechat_official_account",
    "displayName": "不加班"
  },
  {
    "slug": "3dugc",
    "clientId": "3dugc-web",
    "defaultRedirectUri": "https://3dugc.com/auth/callback",
    "allowedReturnUrlPrefixes": ["https://3dugc.com/"],
    "defaultScopes": ["openid", "profile"],
    "provider": "wechat_official_account",
    "displayName": "3DUGC"
  }
]
```

## 入口设计

### 标准 OAuth 入口保持不变

业务方仍可直接访问：

```text
GET /oauth/authorize?client_id=bujiaban-web&redirect_uri=https%3A%2F%2Fbujiaban.com%2Fauth%2Fcallback&response_type=code&scope=openid%20profile&state=...&code_challenge=...&code_challenge_method=S256
```

该路径继续做精确 `client_id + redirect_uri` 校验。

### 新增短登录入口

新增：

```text
GET /login/:slug
```

支持参数：

```text
return_to=https://bujiaban.com/projects/123
state=<business-state>
code_challenge=<pkce-challenge>
code_challenge_method=S256
scope=openid profile
```

处理流程：

1. 根据 `slug` 找到 Login Entry。
2. 根据 entry 找到 OAuth Client。
3. 校验 `entry.defaultRedirectUri` 必须存在于 `client.redirectUris`。
4. 如果传了 `return_to`，只允许匹配 `allowedReturnUrlPrefixes`。
5. 生成认证服务自己的 signed state，保存：
   - `clientId`
   - `redirectUri`
   - `returnTo`
   - `scopes`
   - `provider`
   - 原始 `state`
   - PKCE 参数
6. 跳转到对应 provider 的内部登录路由。

第一阶段 provider 只支持：

```text
GET /login/wechat/offiaccount?state=<signed-state>
GET /login/wechat/website?state=<signed-state>
```

### OAuth callback 回跳

微信回调完成后：

1. 校验 signed state。
2. 换取微信 profile。
3. upsert `auth_users` / `auth_identities`。
4. 创建 authorization code。
5. 回跳到 `redirectUri`，携带：

```text
code=<authorization-code>
state=<business-state>
return_to=<validated-return-to>
```

建议不要把 `return_to` 动态塞进 OAuth `redirect_uri` 的 path/query，而是作为独立参数交给业务 callback 处理。这样 `redirect_uri` 可以继续精确匹配，安全边界更清楚。

## 配置设计

新增环境变量：

```text
AUTH_LOGIN_ENTRIES_JSON='[...]'
```

`createConfig` 增加：

```ts
loginEntries: LoginEntry[];
```

默认值可由现有 OAuth clients 派生：

- `bujiaban` -> `bujiaban-web`
- `3dugc` -> `3dugc-web`

生产环境建议显式配置 `AUTH_LOGIN_ENTRIES_JSON`，避免新增域名时隐藏使用默认值。

## 数据库演进

第一阶段不必建表，使用环境变量配置即可。

第二阶段可新增：

```text
auth_login_entries
id
slug unique
client_id
default_redirect_uri
allowed_return_url_prefixes_json
default_scopes_json
provider
display_name nullable
status
created_at
updated_at
```

`oauth_clients` 也可以从当前文档里的预留模型落地，替代环境变量 JSON。

## 安全要求

- `redirect_uri` 永远精确匹配 `OAuthClient.redirectUris`，不要做 host-only 或 prefix-only 放行。
- `return_to` 可以 prefix 匹配，但必须先规范化 URL：
  - 只允许 `https:`，本地开发可显式允许 `http://localhost` / `http://127.0.0.1`。
  - 去掉 fragment。
  - username、password 字段必须为空。
  - host 使用 URL parser 解析结果，不手写字符串判断。
- `return_to` 不允许覆盖 `redirect_uri`。
- signed state 必须包含 `clientId`、`redirectUri`、`provider`，callback 时重新验证 client 和 redirect URI 仍有效。
- token endpoint 仍要求同一个 client 兑换同一个 authorization code。
- 对未知 `slug` 返回 404 或 400，不回跳到外部 URL。

## 代码改动建议

### 类型

- 在 `src/types.ts` 增加 `LoginEntry`。
- `AuthServiceConfig` 增加 `loginEntries: LoginEntry[]`。

### 配置

- 在 `src/config.ts` 增加 `readLoginEntries(env, oauthClients)`。
- 支持 `AUTH_LOGIN_ENTRIES_JSON`。
- 增加启动期校验：entry 引用的 client 存在，default redirect URI 在 client 白名单中。

### 路由

- 在 `src/oauth-routes.ts` 新增 `GET /login/:slug`，它只负责把短入口转换成已有 OAuth signed state。
- 扩展 `OAuthAuthorizeState`，加入：
  - `provider`
  - `loginEntrySlug?`
  - `returnTo?`
- `/oauth/authorize` 默认 provider 使用 `wechat_official_account`，保持兼容。
- `/login/wechat/offiaccount/callback` 回跳时追加已校验的 `return_to`。

### 微信客户端

- 第一阶段不需要改 `WechatClient` 的实际 API 调用。
- 后续如果支持多个公众号 appid/secret，则把 `providerAppId` 或 `wechatAppKey` 放进 signed state，并让 `WechatClient` 能按 app 配置选择凭据。

### 测试

新增测试覆盖：

- `/login/bujiaban` 会生成 OAuth 流程并最终回跳 `https://bujiaban.com/auth/callback`。
- `return_to=https://bujiaban.com/projects/1` 被保留。
- `return_to=https://evil.example/` 被拒绝。
- entry 的 `defaultRedirectUri` 不在 client redirect list 时配置加载失败。
- 已有 `/oauth/authorize` 流程不回归。

## 示例流程

```text
Browser -> Auth:
  GET /login/bujiaban?return_to=https%3A%2F%2Fbujiaban.com%2Fprojects%2F123&state=abc&code_challenge=xyz&code_challenge_method=S256

Auth:
  slug=bujiaban
  client=bujiaban-web
  redirect_uri=https://bujiaban.com/auth/callback
  return_to allowed

Auth -> WeChat:
  GET /connect/oauth2/authorize?...&redirect_uri=https%3A%2F%2Fauth.bujiaban.com%2Flogin%2Fwechat%2Foffiaccount%2Fcallback&state=<signed>

WeChat -> Auth:
  GET /login/wechat/offiaccount/callback?code=...&state=<signed>

Auth -> App:
  302 https://bujiaban.com/auth/callback?code=...&state=abc&return_to=https%3A%2F%2Fbujiaban.com%2Fprojects%2F123

App -> Auth:
  POST /oauth/token
```

## 分阶段计划

1. 增加 `LoginEntry` 类型、配置解析、配置校验。
2. 新增 `/login/:slug`，复用现有 signed state 和公众号登录流程。
3. 给 callback 增加 `return_to` 传递。
4. 补测试和 README 配置示例。
5. 后续把 OAuth clients 和 login entries 入库，增加管理接口或迁移脚本。

## 验收标准

- `bujiaban` 和 `3dugc` 可以通过不同短 URL 发起登录。
- 任意未配置的外部 URL 不能成为回跳目标。
- 现有 legacy `/v1/wechat/*` 不受影响。
- 现有标准 `/oauth/authorize`、`/oauth/token` 流程不受影响。
- 新配置错误能在启动或测试阶段暴露，而不是登录中途失败。

## 待确认问题

- 是否需要支持多个认证服务公开域名，例如 `auth.bujiaban.com` 和 `auth.3dugc.com` 同时作为 issuer？
- `return_to` 是由业务 callback 消费，还是希望认证服务直接回跳到最终业务页面？
- 微信开放平台网站扫码是否已有 appid/secret？如果有，需要把 provider 配置也做成多实例。
