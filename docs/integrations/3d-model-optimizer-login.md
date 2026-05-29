# 3D-Model-Optimizer 登录接入文档

本文档说明 `3D-Model-Optimizer` 如何接入统一认证服务 `auth-service`。当前推荐使用短登录入口 `/login/3dugc`，底层仍是 OAuth Authorization Code + PKCE。

## 1. 约定信息

生产环境默认约定：

```text
Auth Service: https://auth.bujiaban.com
业务站点: https://3dugc.com
登录入口: https://auth.bujiaban.com/login/3dugc
OAuth client_id: 3dugc-web
OAuth redirect_uri: https://3dugc.com/auth/callback
默认 scope: openid profile
登录方式: 微信开放平台网站应用扫码登录（provider: wechat_website）
```

`auth-service` 当前内置了 `3dugc-web` 和 `/login/3dugc` 默认配置。如果生产环境显式配置了 `AUTH_OAUTH_CLIENTS_JSON` 或 `AUTH_LOGIN_ENTRIES_JSON`，请确保包含本文档第 2 节中的配置。

## 2. Auth Service 配置

如果使用默认内置 client，可以不额外配置 `3dugc`。如果生产环境使用显式 JSON，至少包含：

```text
AUTH_OAUTH_CLIENTS_JSON='[
  {
    "clientId": "3dugc-web",
    "name": "3dugc.com",
    "redirectUris": ["https://3dugc.com/auth/callback"],
    "allowedOrigins": ["https://3dugc.com"],
    "scopes": ["openid", "profile"],
    "publicClient": true
  }
]'

AUTH_LOGIN_ENTRIES_JSON='[
  {
    "slug": "3dugc",
    "clientId": "3dugc-web",
    "defaultRedirectUri": "https://3dugc.com/auth/callback",
    "allowedReturnUrlPrefixes": ["https://3dugc.com/"],
    "defaultScopes": ["openid", "profile"],
    "provider": "wechat_website",
    "displayName": "3DUGC"
  }
]'
```

`wechat_website` 建议配置微信开放平台网站应用凭据：

```text
AUTH_WECHAT_WEBSITE_APP_ID=<wechat-open-platform-website-appid>
AUTH_WECHAT_WEBSITE_APP_SECRET=<wechat-open-platform-website-secret>
```

未配置时 auth-service 会沿用 `AUTH_WECHAT_OFFICIAL_*` / `WECHAT_*` 作为灰度 fallback。公众号网页授权使用 `wechat_official_account`，只能在微信客户端内正常打开；PC 浏览器扫码登录应使用 `wechat_website`，长期生产应替换为真正的网站应用凭据。

如果同一个 auth-service 还服务 `bujiaban`，不要只配置 `3dugc` 而漏掉其他 client/entry；显式 JSON 会覆盖内置默认值。

## 3. 登录流程

### 3.1 前端生成 PKCE

业务前端点击登录时，生成：

- `code_verifier`：随机字符串，保存在当前浏览器会话中。
- `code_challenge`：`SHA256(code_verifier)` 后 base64url 编码。
- `state`：随机字符串，防 CSRF，也保存在当前浏览器会话中。

示例：

```ts
function base64Url(buffer: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function sha256Base64Url(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  return base64Url(await crypto.subtle.digest('SHA-256', data));
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64Url(bytes.buffer);
}
```

### 3.2 跳转到统一登录

整页跳转登录 URL：

```text
https://auth.bujiaban.com/login/3dugc?return_to=<业务最终页面>&state=<state>&code_challenge=<challenge>&code_challenge_method=S256
```

例子：

```text
https://auth.bujiaban.com/login/3dugc?return_to=https%3A%2F%2F3dugc.com%2Fdashboard&state=abc123&code_challenge=xyz&code_challenge_method=S256
```

参数说明：

- `return_to`：登录完成后业务站最终要去的页面，必须是 `https://3dugc.com/` 下的 URL。
- `state`：业务站生成并校验的随机字符串。
- `code_challenge` / `code_challenge_method`：PKCE 参数。

PC 端也可以用模态窗渲染微信官方扫码组件。业务站先请求：

```http
GET https://auth.bujiaban.com/login/3dugc/widget-config?return_to=<业务最终页面>&state=<state>&code_challenge=<challenge>&code_challenge_method=S256
```

返回公开参数：

```json
{
  "provider": "wechat_website",
  "mode": "widget",
  "appId": "wx...",
  "redirectUri": "https://auth.bujiaban.com/login/wechat/website/callback",
  "scope": "snsapi_login",
  "state": "<signed-state>",
  "selfRedirect": false
}
```

前端用微信官方 `WxLogin` 将二维码渲染到模态窗，授权完成后仍回到第 4 节的业务 callback。

## 4. Callback 处理

微信授权完成后，auth-service 会回跳：

```text
https://3dugc.com/auth/callback?code=<AUTH_CODE>&state=<STATE>&return_to=<RETURN_TO>
```

业务站 `/auth/callback` 需要做：

1. 校验 `state` 与登录前保存的一致。
2. 读取 `code`。
3. 用之前保存的 `code_verifier` 调用 `/oauth/token`。
4. 使用返回的 token 建立业务站自己的登录态。
5. 跳转到 `return_to`，没有 `return_to` 时跳默认首页。

Token 请求：

```http
POST https://auth.bujiaban.com/oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code
client_id=3dugc-web
redirect_uri=https://3dugc.com/auth/callback
code=<AUTH_CODE>
code_verifier=<CODE_VERIFIER>
```

成功返回：

```json
{
  "access_token": "...",
  "token_type": "Bearer",
  "expires_in": 900,
  "refresh_token": "...",
  "id_token": "...",
  "scope": "openid profile"
}
```

## 5. 获取用户信息

业务站可以用 `access_token` 调用：

```http
GET https://auth.bujiaban.com/userinfo
Authorization: Bearer <ACCESS_TOKEN>
```

返回示例：

```json
{
  "sub": "auth-user-id",
  "unionid": "wechat-unionid",
  "name": "用户昵称",
  "picture": "https://..."
}
```

业务数据库建议保存映射关系，不要和 auth-service 共用业务表：

```text
users
id
auth_user_id      对应 userinfo.sub
wechat_unionid    可选，对应 userinfo.unionid
display_name
avatar_url
created_at
updated_at
```

`auth_user_id` 应加唯一索引。业务站后续用自己的 session/cookie 表示登录态。

## 6. 刷新登录态

`access_token` 默认有效期较短。需要刷新时：

```http
POST https://auth.bujiaban.com/oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=refresh_token
client_id=3dugc-web
refresh_token=<REFRESH_TOKEN>
```

返回新的 token set。旧 refresh token 会被撤销，业务站需要保存新的 refresh token。

## 7. 退出登录

业务站退出时：

```http
POST https://auth.bujiaban.com/logout
Content-Type: application/x-www-form-urlencoded

refresh_token=<REFRESH_TOKEN>
```

然后清理业务站自己的 session/cookie。

## 8. 本地开发

如果本地调试 3D-Model-Optimizer，需要为本地 callback 增加显式配置，例如：

```text
AUTH_OAUTH_CLIENTS_JSON='[
  {
    "clientId": "3dugc-web",
    "name": "3dugc.com",
    "redirectUris": [
      "https://3dugc.com/auth/callback",
      "http://localhost:3000/auth/callback"
    ],
    "allowedOrigins": [
      "https://3dugc.com",
      "http://localhost:3000"
    ],
    "scopes": ["openid", "profile"],
    "publicClient": true
  }
]'

AUTH_LOGIN_ENTRIES_JSON='[
  {
    "slug": "3dugc-local",
    "clientId": "3dugc-web",
    "defaultRedirectUri": "http://localhost:3000/auth/callback",
    "allowedReturnUrlPrefixes": ["http://localhost:3000/"],
    "defaultScopes": ["openid", "profile"],
    "provider": "wechat_website",
    "displayName": "3DUGC Local"
  }
]'
```

本地登录入口：

```text
http://localhost:3010/login/3dugc-local?return_to=http%3A%2F%2Flocalhost%3A3000%2Fdashboard&state=...&code_challenge=...&code_challenge_method=S256
```

## 9. 安全要求

- 业务站必须校验 `state`。
- 业务站必须使用 PKCE，不能省略 `code_verifier`。
- `redirect_uri` 必须与配置完全一致。
- `return_to` 只能使用业务站自己的 URL，不要把用户输入直接拼进去。
- 不要把 `refresh_token` 暴露给前端持久存储；如果是服务端渲染或有后端，推荐放服务端 session。
- 不要在 3D-Model-Optimizer 里保存微信公众号 AppSecret，微信凭据只放 auth-service。

## 10. 快速检查清单

- [ ] auth-service 已部署 `latest` 或包含多 URL 登录的版本。
- [ ] 已配置微信开放平台网站应用 `AUTH_WECHAT_WEBSITE_APP_ID` / `AUTH_WECHAT_WEBSITE_APP_SECRET`。
- [ ] `https://auth.bujiaban.com/login/3dugc` 可访问并能跳转微信扫码授权。
- [ ] `https://3dugc.com/auth/callback` 已实现。
- [ ] callback 能用 `code + code_verifier` 换 token。
- [ ] `/userinfo` 能返回 `sub`。
- [ ] 业务库能用 `auth_user_id` 找到或创建本地用户。
- [ ] 登录成功后能跳回 `return_to`。
- [ ] 退出登录会调用 `/logout` 并清理业务 session。
