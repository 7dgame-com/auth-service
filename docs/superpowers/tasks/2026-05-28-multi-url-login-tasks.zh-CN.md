# 任务：支持多 URL 登录

状态：草稿
日期：2026-05-28
规格：../specs/2026-05-28-multi-url-login.zh-CN.md
计划：../plans/2026-05-28-multi-url-login-plan.zh-CN.md

## 里程碑 1：配置模型

- [ ] 在 `src/types.ts` 增加 `LoginEntry` 类型。
- [ ] 在 `src/config.ts` 的 `AuthServiceConfig` 增加 `loginEntries: LoginEntry[]`。
- [ ] 实现 `readLoginEntries(env, oauthClients)`。
- [ ] 解析 `AUTH_LOGIN_ENTRIES_JSON`。
- [ ] 当内置 client 存在时，为 `bujiaban` 和 `3dugc` 添加默认 entry。
- [ ] 校验重复 slug 会被拒绝。
- [ ] 校验引用的 `clientId` 必须存在。
- [ ] 校验 `defaultRedirectUri` 必须属于对应 client 的 `redirectUris`。
- [ ] 校验 `defaultScopes` 必须是对应 client scopes 的子集。
- [ ] 校验 provider 必须是受支持的身份 provider。
- [ ] 添加有效自定义 entry 的配置测试。
- [ ] 添加非法 entry 的配置测试。

## 里程碑 2：Return URL 安全

- [ ] 增加 helper，用于规范化和校验 `return_to`。
- [ ] 默认允许 `https:` return URL。
- [ ] 只有配置了本地前缀时，才允许 `http://localhost` 和 `http://127.0.0.1`。
- [ ] 拒绝带 username 或 password 的 URL。
- [ ] 移除或拒绝 fragment。
- [ ] 只匹配 `allowedReturnUrlPrefixes`。
- [ ] 添加合法 return URL 测试。
- [ ] 添加外部非法 return URL 测试。
- [ ] 添加容易误判的 URL parser case 测试。

## 里程碑 3：短登录路由

- [ ] 扩展 `OAuthAuthorizeState`，加入 `provider`、`loginEntrySlug?`、`returnTo?`。
- [ ] 在 `src/oauth-routes.ts` 增加 `GET /login/:slug`。
- [ ] 根据 slug 解析 login entry。
- [ ] 根据 `entry.clientId` 解析 OAuth client。
- [ ] 校验可选 `scope` query 同时满足 client 和 entry scopes。
- [ ] 保留 `state`、`code_challenge`、`code_challenge_method`。
- [ ] 使用现有 `createSignedState` 创建 signed state。
- [ ] 公众号 entry 跳转到 `/login/wechat/offiaccount`。
- [ ] 对未支持 provider 返回本地错误。
- [ ] 添加 `/login/bujiaban` 路由测试。
- [ ] 添加未知 slug 路由测试。

## 里程碑 4：Callback 传递

- [ ] callback 验证 state 后，重新校验 client 和 redirect URI。
- [ ] 当 signed state 中存在 `return_to` 时，把它追加到业务 callback。
- [ ] 保持 `redirect_uri` 精确且不动态改写。
- [ ] 确认 auth code 创建时仍保存精确 redirect URI。
- [ ] 添加带 `return_to` 的 mock 微信流程测试。
- [ ] 添加不带 `return_to` 的 mock 微信流程测试。
- [ ] 添加直接 `/oauth/authorize` 的回归测试。

## 里程碑 5：文档

- [ ] 在 `.env.example` 增加 `AUTH_LOGIN_ENTRIES_JSON`。
- [ ] 在 README 增加 `/login/:slug` 说明。
- [ ] 增加 `bujiaban` 和 `3dugc` JSON 示例。
- [ ] 说明 `return_to` 规则。
- [ ] 说明标准 `/oauth/authorize` 仍然支持。
- [ ] 可选更新 `docker-compose.portainer.yml` 注释。

## 里程碑 6：验证

- [ ] 运行 `npm test`。
- [ ] 运行 `npm run build`。
- [ ] 检查 `git diff`，确认没有无关改动。
- [ ] 确认 legacy `/v1/wechat/*` 测试仍通过。
- [ ] 确认 OAuth token exchange 仍要求同一 client 和 redirect URI。

## 延后任务

- [ ] 增加 `auth_login_entries` migration。
- [ ] 增加数据库版 login entry 加载。
- [ ] 增加数据库版 OAuth client 加载。
- [ ] 增加 login entries 管理接口或 seed workflow。
- [ ] 在未来登录页增加按 entry 区分的品牌展示。
- [ ] 增加多微信 app provider 配置。
- [x] 实现 `/login/wechat/website`。
- [ ] 实现 `/login/wechat/miniprogram`。

## 完成定义

- [ ] `bujiaban` 和 `3dugc` 可以通过不同短 URL 发起登录。
- [ ] 合法 `return_to` 能完整穿过登录流程。
- [ ] 非法 `return_to` 会在任何外部跳转前被拒绝。
- [ ] 现有 OAuth clients 继续可用 `/oauth/authorize`。
- [ ] 现有 legacy 微信 endpoints 不变。
- [ ] 测试和构建在本地通过。
