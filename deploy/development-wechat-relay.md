# Development official-account relay (review preparation, disabled)

The confirmed main-site provider is PortF `auth-service` / `auth.bujiaban.com`,
AppID `wx6f81800f15c9a88c`. B0 game is unrelated. This confirmation does not
establish the AppID of the 14 historical development bindings; those still need
an explicitly reviewed binding manifest.

## Current enablement gate

F currently has the official token but no configured AES key. This patch **cannot
be enabled in that configuration**. It neither changes the official-account
security mode nor invents credentials. Do not restart F with the flag enabled.
Plaintext query `signature` covers token/timestamp/nonce, not XML body. The
repository does not establish a non-spoofable Traefik client-IP chain; Express
currently trusts every proxy. `getcallbackip` alone is not proof of the AppID or
body. No plaintext or forwarded-IP bypass is implemented.

Any change to the shared production F baseline or official-account configuration
requires the user's separate authorization. Development migration authorization
does not include production F. Production's existing `redis` DNS failure is a
separate issue; this adapter never uses that Redis.

## Minimal deployment difference

1. Keep one F `WechatClient` managing the official-account access-token cache.
   A second process with the same AppSecret would risk invalidating that cache.
   F gains two default-off capability routes and one AES-verified callback hook.
   F receives no development account writer key and no new DB/Redis dependency.
2. Run the same reviewed image with `node dist/development-provider-run.js` as an
   independent development adapter. It does not load the auth runtime, legacy
   stores, Redis, or WeChat AppSecret. Its separate MySQL registry holds only
   scene/openid SHA256 digests, exact AppID, and original issuance/expiry/delivery
   timestamps. The DB name is limited to the development Identity DB or a rehearsal
   copy. There is no runtime schema creation, deletion, or account-table query.
3. Point development Identity `IDENTITY_WECHAT_PROVIDER_BASE_URL` at the adapter's
   internal origin. Native Identity remains the only account/session/scan authority.
   `IDENTITY_TOKEN_ISSUANCE_INTERNAL_API_TOKEN` equals adapter
   `DEVELOPMENT_PROVIDER_IDENTITY_TOKEN`. The Native 907 contract is unchanged.

F's production-only delta, **still disabled**:

```dotenv
AUTH_WECHAT_DEVELOPMENT_RELAY_ENABLED=false
AUTH_WECHAT_DEVELOPMENT_CAPABILITY_TOKEN=<new separate capability key, >=32 bytes>
AUTH_WECHAT_DEVELOPMENT_CALLBACK_TOKEN=<new separate callback key, >=32 bytes>
AUTH_WECHAT_DEVELOPMENT_CALLBACK_BASE_URL=https://<reviewed-development-adapter-origin>
AUTH_WECHAT_DEVELOPMENT_TIMEOUT_MS=5000
```

The existing verified AppID/token/AES configuration must be complete before an
authorized enablement. No AES key or security-mode change is part of this patch.
The callback URL is fixed configuration, never supplied by a request. The adapter
and F use three distinct keys: Identity authority, F provider capability, F relay.
The adapter's provider token is not accepted by its callback route and vice versa.
Expose only `/internal/wechat-provider/confirm-scan` through the adapter's public
HTTPS ingress; keep QR/profile capabilities on its development internal network.

`deploy/development-wechat.compose.yml` and `development-wechat.env.example` are
review templates with required image/network placeholders. Choose a digest, not a
moving `develop`/`latest` tag, and keep Watchtower disabled. Before any F release,
compare with the exact deployed F revision and carry its legacy behavior forward;
do not replace production with an unrelated development candidate or assume this
local branch is the complete production release baseline.

## Registry and request flow

Apply `deploy/mysql/development-wechat-registry.sql` only to the approved development
DB/rehearsal copy. Grant the adapter DB identity SELECT/INSERT/UPDATE on this table
only. The constructor validates the DB name, and startup verifies the table exists.
No production schema, accounts, or Redis is used or altered.

Identity asks the adapter for a QR using its random 43-character scene. The adapter
registers its digest before calling F. Repeated requests reuse the original expiry;
expired scenes cannot be revived. F adds `idvdev_` to make the official-account scene
50 characters. F accepts only the dedicated capability key for QR/profile calls.

For a scan, F first verifies AES `msg_signature`, decrypts with the configured key
and checks the AppID. Only the reserved scene namespace and a timestamp within five
minutes are relayed to the fixed development adapter. All reserved scenes are kept
out of the legacy production store even while disabled, unknown, malformed, or
plaintext. Existing production scene behavior is unchanged; production scenes are
32 characters and cannot collide with this 50-character namespace.

The adapter requires its callback-only key, exact AppID, registered original scene,
original expiry and a transactional first-openid claim. A different openid cannot
replace that claim. Only a claimed active scan allows its profile lookup. It then
calls Native Identity confirm with the Identity scoped token. Successful delivery
is marked after acknowledgment; failed delivery can retry for the same openid
without extending expiry. Native confirm remains idempotent and independently
validates its own pending scene and provider profile. The relay does not issue
sessions. No callback/query/header decides a target URL or JWT audience.

## Review and acceptance sequence

1. Review the exact F source revision, disabled patch, registry DDL, adapter image
   digest, ingress origin, three key scopes and development-only DB grants.
2. Resolve the AES/security-mode gate with the official-account operator. If no
   authenticated body delivery can be established, keep this plan disabled.
3. On an approved development copy, apply only registry DDL, start the adapter,
   verify `/health` and wrong-key denials. Do not enable F or native authority yet.
4. After separate production-F authorization, publish a fixed reviewed F baseline
   with the flag still false and check existing legacy QR/OAuth flows. Enabling the
   relay is a separate reviewed configuration step; check QR creation, real scan,
   development pending/signup/login, app mismatch, expiry and duplicate callback.
   Confirm production account/Redis write counts do not change for dev scenes.
5. Rollback sets F relay flag false and stops the adapter. Pending dev scenes remain
   blocked from production; never convert them to production scenes. Registry rows
   retain their original expiry. Existing production behavior and provider config
   are preserved.

Local verification: `npm run lint`, `npm test`; for disposable local MySQL enable
`IDENTITY_TEST_MYSQL=1 IDENTITY_TEST_MYSQL_PORT=13316` and run
`tests/development-wechat-registry.mysql.test.ts`. These tests do not call WeChat,
cloud DB/Redis, or any real user. They establish code contracts, not external
official-account success. No deployment or live configuration was changed.
