# Minimal F relay baseline (not deployed)

Base: the **actual deployed** `7dgame-com/auth-service` revision
`48856f180abe06058630cf3461af2231768bcb8c`, committed 2026-07-11.
Observed production image: `latest@sha256:de0a6a4f905f42714219da0c6bdea8deb61fa7ca729a8e3ebea43ca356821a96`.
Local branch: `codex/auth-production-relay-baseline-20261012`.

This branch is separate from development adapter revision `eae1dbc`. Do not deploy
the adapter branch to F. Its `619e959` ancestor differs in 25 files from deployed
488, including new legacy scene-metadata SQL/DDL behavior, Identity account/OAuth
delegation, and removals of existing website OAuth/widget, official scan-status,
and account hints. Those changes are deliberately absent here.

## Concrete production difference requiring authorization

| Files | Change |
| --- | --- |
| `src/development-wechat-relay.ts` | Default-off, capability-key protected QR/profile operations using the existing F `WechatClient`, plus a fixed-destination AES-only dev-scene callback relay. No DB/Redis/account dependencies. |
| `src/config.ts` | Optional relay settings parsed after existing config; website, legacy DB/Redis, client and login-entry settings remain intact. When disabled, no new settings or credentials are required. |
| `src/server.ts` | Mount two capability routes only when enabled; hand an optional relay to the existing callback router; generic redacted 503 for delivery failure. Existing health and store/bootstrap behavior are unchanged. |
| `src/legacy-routes.ts` | Reserve the `idvdev_` scene namespace from production writes; only verified encrypted callbacks enter relay. Ordinary legacy QR creation/poll/login retain their exact original paths and storage. No metadata table or DDL is added. |
| `src/crypto.ts` | Reject an empty decrypted AppID whenever an expected AppID is configured, as well as mismatching AppIDs. |
| `package*.json` | Same Express 4 framework; patched runtime dependencies and transitive overrides, Vitest 4.1.11 for patched CI tooling. Full and production audit are zero. |
| `Dockerfile`, workflows, examples/docs/tests | Record the exact build revision, require audit before publication, provide a manual immutable candidate workflow and disabled relay configuration. No automatic production deployment or moving-tag publication from this branch. |

`production-baseline.json` records SHA256 parity for the unchanged database store,
Redis adapter, memory store, OAuth router, WeChat client, shared types/interfaces,
entrypoint and original production tests. `node deploy/verify-production-baseline.cjs`
checks it without Git history or network access. In particular, there is no new
production table, migration, connection, or alternate account-authority mode.

Local verification: npm 10 clean install, TypeScript build/type-check, and all
**26 tests pass (17 unchanged production tests + 9 relay tests, zero skips)**.
These include website OAuth/widget, authorization-code/PKCE/logout, ordinary
official-account callbacks, encrypted wrong/empty AppID rejection, and isolation
of reserved scenes. The separate development adapter's 53-test result is not
added to this production total. Full and production npm audits both report zero;
redacted JSON is saved under `deploy/evidence`. All ten preserved file hashes were
also compared directly with the exact 488 Git blobs before local commit.

## Activation remains blocked

F has a configured AppID/token but no configured AES key. Enabling the flag in this
state is rejected. No change to the official-account security mode or credentials
is included. Plaintext signature covers query token/timestamp/nonce, not XML body;
repo evidence does not prove an unforgeable Traefik source-IP chain. No forwarded-IP
or `getcallbackip` bypass is implemented.

The user must separately authorize the shared production F baseline/configuration
change. After official-account authenticated AES delivery is established, the
operator must review the fixed development callback HTTPS origin and two separate
>=32-byte scoped keys. F does not receive the development Identity writer token.
The independent adapter has that third key and the development-only hash registry.
See the separately reviewed development adapter deployment assets at `eae1dbc`.
Historical 14 bindings still require their own reviewed AppID manifest.

Keep `AUTH_WECHAT_DEVELOPMENT_RELAY_ENABLED=false` for the initial authorized
compatibility baseline release. Confirm existing main-site QR polling and
website/official OAuth flows before any enablement. Count any old pending scenes
using the reserved prefix without exposing their raw values; do not claim they are
compatible if such a historical collision exists. Use a fixed reviewed image digest
and disable automatic Watchtower upgrades. Rollback keeps the relay false and
restores the previous fixed digest/config; pending development scenes never move
into production account storage.

The new `Production provider relay candidate` workflow validates on pushes to this
isolated branch. Only an explicit manual `publish_candidate=true` publishes
`candidate-relay-<full SHA>` for linux/amd64; it never publishes develop/latest or
deploys a stack. No push, candidate publication, or deployment has been performed
as part of this local preparation.

## Existing Redis DNS failure: read-only investigation

The observed F poll error is `ENOTFOUND redis`. This occurs before a Redis request
or account lookup. The deployed config resolves `AUTH_REDIS_URL`, then `REDIS_URL`,
then `REDIS_HOST`/`REDIS_PORT`/`REDIS_DB`/credentials. Changing only REDIS_HOST has
no effect if either URL variable is present. Preserve the actual configured DB,
TLS and authentication; do not guess an endpoint from B0 or another environment.

Read-only operator checks, separate from this patch:

1. Record only selected host/port/DB/TLS and credential-presence booleans from F's
   effective config; never print URLs containing passwords or env dumps.
2. Inspect F's Docker networks and the intended existing Redis service's network
   aliases/health. Resolve the configured hostname **inside F**. Determine whether
   a missing network/alias or an obsolete configured hostname explains ENOTFOUND.
3. For a proven existing endpoint with the same credential and selected DB, make
   a bounded connection using AUTH/SELECT/PING only. Report DNS/connect/auth/PONG
   stage and error code; no KEYS/SCAN, data reads/writes, config changes or restart.
4. Produce the exact network/host configuration delta for separate authorization.
   Fixing production Redis DNS is not implied by development migration approval.

This preparation did not connect to production Redis or alter any live settings.
