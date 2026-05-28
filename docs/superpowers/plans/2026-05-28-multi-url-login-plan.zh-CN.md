# 计划：支持多 URL 登录

状态：草稿
日期：2026-05-28
规格：../specs/2026-05-28-multi-url-login.zh-CN.md

## 摘要

在现有 OAuth client 模型上增加一层“一等登录入口”配置。OAuth client 继续作为安全边界，登录入口负责提供更适合业务使用的短 URL，例如 `/login/bujiaban` 和 `/login/3dugc`。

实现应保持当前 OAuth Authorization Code + PKCE 流程不变，复用已有 signed state 机制，并确保 legacy `/v1/wechat/*` 行为不受影响。

## 当前架构

- `src/types.ts` 定义了 `OAuthClient`、authorization code、refresh token、user、identity 等类型。
- `src/config.ts` 从 `AUTH_OAUTH_CLIENTS_JSON` 或内置默认值加载静态 OAuth clients。
- `src/oauth-routes.ts` 校验 `client_id + redirect_uri`，签发 authorize state，把用户送到 `/login/wechat/offiaccount`，并最终把 authorization code 回给业务 callback。
- `src/wechat-client.ts` 使用 `AUTH_PUBLIC_BASE_URL` 构造公众号网页授权 URL。
- 当前测试覆盖配置兼容、legacy 微信流程、Redis key 兼容和 OAuth 基础行为。

## 设计方向

引入 `LoginEntry`：

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

`GET /login/:slug` 作为便捷入口，把配置好的登录入口转换成 `/oauth/authorize` 当前已经使用的 signed authorization state。

## 实施阶段

### 阶段 1：配置模型

先加入类型和配置读取，不改变路由行为。

- 在 `src/types.ts` 增加 `LoginEntry` 类型。
- 在 `AuthServiceConfig` 增加 `loginEntries`。
- 在 `src/config.ts` 增加 `AUTH_LOGIN_ENTRIES_JSON` 解析。
- 从现有内置 OAuth clients 派生保守默认值：`bujiaban` 和 `3dugc`。
- 在配置创建阶段校验 login entries。

退出标准：

- 配置测试覆盖有效 entry、默认 entry、非法 entry。
- 现有配置行为保持兼容。

### 阶段 2：短登录入口

新增短登录 URL，并接入当前 OAuth state 流程。

- 在 `src/oauth-routes.ts` 增加 `GET /login/:slug`。
- 根据 slug 解析 entry。
- 根据 `entry.clientId` 解析 OAuth client。
- 校验请求 scope 同时满足 entry 默认 scope 和 client 允许 scope。
- 校验可选 `return_to`。
- 创建 signed state，包含 `clientId`、`redirectUri`、`provider`、`returnTo`、原始 `state` 和 PKCE 字段。
- 跳转到内部 provider 路由。

退出标准：

- `/login/bujiaban` 能进入与 `/oauth/authorize` 相同的微信登录流程。
- 未知 slug 在本地失败，不发生外部跳转。

### 阶段 3：Callback 上下文传递

把已校验的最终业务页面上下文传回业务 callback。

- 扩展 `OAuthAuthorizeState`，加入 `provider`、`loginEntrySlug`、`returnTo`。
- 在 `/login/wechat/offiaccount/callback` 中，如果 signed state 包含 `returnTo`，则把 `return_to` 追加到业务 callback。
- 保持 `redirect_uri` 精确且不动态改写。

退出标准：

- 业务 callback 能收到 `code`、原始 `state`、已校验的 `return_to`。
- token exchange 行为不变。

### 阶段 4：文档和示例

更新部署和接入文档。

- 在 `.env.example` 增加 `AUTH_LOGIN_ENTRIES_JSON`。
- 在 README 增加 `/login/:slug` 说明。
- 说明安全模型：精确 redirect URI、受控 return_to。
- 可选更新 `docker-compose.portainer.yml` 注释或示例。

退出标准：

- 部署者只改 JSON 配置即可增加新的业务登录 URL。

### 阶段 5：后续存储演进

配置模型验证稳定后，再考虑数据库存储。

- 只有需要运行时编辑或管理后台时，才新增 `auth_login_entries` 表。
- `oauth_clients` 可同一阶段或稍早迁移到数据库。
- 环境变量加载继续作为 bootstrap/fallback 路径。

退出标准：

- 第一版实现不需要数据库 migration。

## 安全计划

- `redirect_uri` 必须精确匹配 OAuth client。
- `return_to` 必须先规范化 URL，再做 prefix 匹配。
- 拒绝带 username/password、fragment、不支持协议、未配置 host/path 的 `return_to`。
- 保持 token endpoint 的 client 绑定。
- callback 验证 signed state 后，重新校验 client 和 redirect URI 仍有效。
- signed state TTL 继续绑定 `authorizationCodeTtlSeconds`。

## 测试计划

配置/单元测试：

- 能解析 `AUTH_LOGIN_ENTRIES_JSON`。
- 缺失 client 的 entry 会失败。
- 默认 redirect URI 不属于 client 的 entry 会失败。
- 重复 slug 会失败。
- 不支持的 provider 会失败。

路由测试：

- `/login/bujiaban` 会跳到 `/login/wechat/offiaccount`。
- mock 微信流程最终回到 `https://bujiaban.com/auth/callback`。
- 合法 `return_to` 会被传递。
- 非法 `return_to` 会被拒绝。
- `/oauth/authorize` 仍可工作。
- legacy `/v1/wechat/*` 仍可工作。

回归测试：

- `npm test`
- `npm run build`

## 发布计划

1. 以配置能力发布；现有 OAuth 和 legacy 流程继续工作。
2. 在 staging 配置 `bujiaban` 短入口。
3. 在 staging 配置 `3dugc` 短入口。
4. 验证微信 callback 域名和业务 callback 行为。
5. 发布生产 entries。
6. 保留直接 `/oauth/authorize` 支持，供标准 OAuth 接入方继续使用。

## 风险

- `return_to` 校验过宽会带来开放重定向风险。
- slug 如果指向了另一个 client 的 redirect URI，会产生 client 混淆。
- 微信 callback 域名仍绑定 `AUTH_PUBLIC_BASE_URL`；多认证域名可能需要后续 issuer/callback 设计。
- 网站扫码和小程序登录需要 provider 级凭据，不应被第一版短入口隐式承诺。

## 待确认问题

- `return_to` 应由业务 callback 消费，还是认证服务需要直接跳到最终页面？
- 生产环境是否要求显式配置 `AUTH_LOGIN_ENTRIES_JSON`，而不是使用默认 entries？
- 第一版是否需要按登录入口展示不同品牌信息？
