# Git Deployment

This service follows the same three-branch deployment model as `7dgame-com/ar-slam`.

| Branch | Purpose | Docker tag |
| --- | --- | --- |
| `develop` | Development integration | `develop` |
| `main` | Mainline stable branch | `main` |
| `publish` | Release branch | `publish`, `latest` |

## CI

Workflow: `.github/workflows/ci.yml`

CI runs on pushes to `main`, `develop`, and `publish`, and on pull requests targeting `main` or `develop`.

It uses the Node.js service stack:

- Node.js 22
- `npm ci`
- `npm run build`
- `npm test`
- upload `dist/` as a 7-day artifact

## Deploy

Workflow: `.github/workflows/deploy.yml`

Deploy runs on pushes to `main`, `develop`, and `publish`, and supports manual `workflow_dispatch`.

Before pushing an image it runs the same build and test commands as CI. If validation passes, it builds the service Docker image and pushes it to:

```text
hkccr.ccs.tencentyun.com/plugins/auth-service
```

Required GitHub Actions secrets:

- `TENCENT_REGISTRY_USERNAME` or `TENCENT_REGISTRY_USER`
- `TENCENT_REGISTRY_PASSWORD`

## Release Flow

1. Merge feature work into `develop`.
2. After validation, promote `develop` into `main`.
3. When ready to release, merge `main` into `publish`.
4. Use the `publish` or `latest` image tag for release deployment.

## Tencent Cloud Deployment Image

The Portainer compose template uses the Tencent Cloud image:

```text
hkccr.ccs.tencentyun.com/plugins/auth-service:latest
```

Use branch tags for environment-specific deployments:

- Development: `hkccr.ccs.tencentyun.com/plugins/auth-service:develop`
- Stable: `hkccr.ccs.tencentyun.com/plugins/auth-service:main`
- Release: `hkccr.ccs.tencentyun.com/plugins/auth-service:publish` or `:latest`
# Identity authority mode

Set `AUTH_DATA_SOURCE=identity`, `AUTH_IDENTITY_API_BASE_URL` to the private Identity service URL, and `AUTH_IDENTITY_API_TOKEN` to the same internal token used by Identity. `AUTH_IDENTITY_API_TIMEOUT_MS` defaults to 5000. This mode never initializes the old MySQL store or Redis client, including when their old environment variables remain present. An unavailable Identity API returns 503.

Keep the existing WeChat provider credentials and `AUTH_TOKEN_SECRET` for signed OAuth state. WeChat callback signatures are mandatory in this mode; `AUTH_WECHAT_OFFICIAL_TOKEN` is required. Mock WeChat is limited to nonproduction instances. Account IDs, provider bindings, authorization codes, refresh credentials and ES256 token signing are owned by Identity. The existing public provider URLs and OAuth callback URLs remain available.

Configure the same OAuth client policy in `AUTH_OAUTH_CLIENTS_JSON` and `IDENTITY_WECHAT_OAUTH_CLIENTS_JSON`. Identity independently checks registered redirect URLs, confidential client secrets and allowed scopes, and binds every refresh session to its client and original scopes. Discovery exposes the Identity issuer and its real public JWKS.

Identity calls `POST /internal/wechat-provider/qrcode` with `{ "scene": "...", "lifetimeSeconds": 60 }` and `POST /internal/wechat-provider/profile` with `{ "openId": "..." }`. Both require `x-identity-internal-token`. Verified provider events are sent to Identity `/internal/wechat-provider/confirm-scan`; scan state and login consumption are stored only there.

Before switching existing clients, import canonical accounts, run the Identity `wechat-identity-import` script for old `auth_users` and `auth_identities`, then import remaining refresh sessions using `identity_auth_subject_maps` and `identity_oauth_session_bindings`. The import defaults to dry-run and requires an explicit `--import-key=<cutover-key>`; `--apply` performs the transaction. Old UUID bindings are retained, including disabled accounts. Old OAuth refresh hashes use SHA256 base64url and must be converted to hex for Identity refresh sessions.

Old HS256 access credentials can be accepted by OAuth userinfo during a bounded cutover window. `IDENTITY_AUTH_LEGACY_JWT_CONFIG_FILE` must name a JSON array of explicit trust entries: `algorithm` (`HS256`), `secretFile`, original `issuer`, exact client `audience`, `allowedScopes`, `issuedBefore` and `acceptUntil` (ISO dates). No trust entry is enabled by default. The original UUID is resolved through the imported map and checked against current account status and revocation. New credentials use the canonical numeric subject. Remove this trust configuration when the old access-token window closes.
