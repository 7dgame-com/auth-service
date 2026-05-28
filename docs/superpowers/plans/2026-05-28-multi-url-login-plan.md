# Plan: Multi-URL Login Support

Status: Draft
Date: 2026-05-28
Spec: ../specs/2026-05-28-multi-url-login.md

## Summary

Add a first-class login entry layer on top of the existing OAuth client model. OAuth clients remain the security boundary, while login entries provide short, business-friendly URLs such as `/login/bujiaban` and `/login/3dugc`.

The implementation should preserve the current OAuth Authorization Code + PKCE flow, reuse the existing signed state mechanism, and keep legacy `/v1/wechat/*` behavior untouched.

## Current Architecture

- `src/types.ts` defines `OAuthClient`, authorization code, refresh token, user, and identity types.
- `src/config.ts` loads static OAuth clients from `AUTH_OAUTH_CLIENTS_JSON` or built-in defaults.
- `src/oauth-routes.ts` validates `client_id + redirect_uri`, signs authorize state, sends users to `/login/wechat/offiaccount`, and returns an authorization code to the client callback.
- `src/wechat-client.ts` builds the WeChat official account authorize URL using `AUTH_PUBLIC_BASE_URL`.
- Tests currently cover config compatibility, legacy WeChat flow, Redis key compatibility, and OAuth basics.

## Design Direction

Introduce `LoginEntry`:

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

`GET /login/:slug` becomes a convenience entrypoint that resolves a configured login entry into the same signed authorization state used by `/oauth/authorize`.

## Implementation Phases

### Phase 1: Config Model

Add the type and configuration reader without changing routing behavior.

- Add `LoginEntry` type to `src/types.ts`.
- Add `loginEntries` to `AuthServiceConfig`.
- Add `AUTH_LOGIN_ENTRIES_JSON` parsing in `src/config.ts`.
- Provide conservative defaults for `bujiaban` and `3dugc` from existing built-in OAuth clients.
- Validate login entries at config creation time.

Exit criteria:

- Config tests cover valid entries, default entries, and invalid entry failures.
- Existing config behavior remains compatible.

### Phase 2: Route Entry Point

Add the short login URL and route it into the current OAuth state flow.

- Add `GET /login/:slug` in `src/oauth-routes.ts`.
- Resolve entry by slug.
- Resolve OAuth client by entry `clientId`.
- Validate requested scopes are included in both entry defaults and client allowed scopes.
- Validate optional `return_to`.
- Create signed state with `clientId`, `redirectUri`, `provider`, `returnTo`, original `state`, and PKCE fields.
- Redirect to the internal provider route.

Exit criteria:

- `/login/bujiaban` starts the same WeChat login flow as `/oauth/authorize`.
- Unknown slugs fail locally and never redirect externally.

### Phase 3: Callback Propagation

Preserve validated final destination context through callback.

- Extend `OAuthAuthorizeState` with `provider`, `loginEntrySlug`, and `returnTo`.
- In `/login/wechat/offiaccount/callback`, append `return_to` to the client callback only when present in signed state.
- Keep `redirect_uri` exact and unchanged.

Exit criteria:

- Client receives `code`, original `state`, and validated `return_to`.
- Token exchange remains unchanged.

### Phase 4: Documentation and Examples

Update docs and deployment examples.

- Add `AUTH_LOGIN_ENTRIES_JSON` to `.env.example`.
- Add README section with `/login/:slug` examples.
- Mention the security model: exact redirect URI, validated return_to.
- Optionally add a Portainer sample entry for `bujiaban` and `3dugc`.

Exit criteria:

- A deployer can add a new business URL by editing JSON config only.

### Phase 5: Follow-Up Storage

Defer database storage until after the config-based model is proven.

- Add `auth_login_entries` table only if runtime editing or admin management is needed.
- Move `oauth_clients` to database at the same time or shortly before.
- Keep environment loading as a bootstrap/fallback path.

Exit criteria:

- No database migration is required for the first implementation.

## Security Plan

- Exact-match `redirect_uri` against the OAuth client.
- Prefix-match `return_to` only after URL normalization.
- Reject `return_to` with credentials, fragment, unsupported protocol, or unconfigured host/path.
- Preserve token endpoint client binding.
- Revalidate client and redirect URI after callback state verification.
- Keep signed state TTL bound to `authorizationCodeTtlSeconds`.

## Test Plan

Unit/config tests:

- Parses `AUTH_LOGIN_ENTRIES_JSON`.
- Rejects entry for missing client.
- Rejects entry with default redirect URI not owned by client.
- Rejects duplicate slugs.
- Rejects unsupported provider values.

Route tests:

- `/login/bujiaban` redirects into `/login/wechat/offiaccount`.
- Mock WeChat flow returns to `https://bujiaban.com/auth/callback`.
- Valid `return_to` is propagated.
- Invalid `return_to` is rejected.
- `/oauth/authorize` still works.
- Legacy `/v1/wechat/*` still works.

Regression tests:

- `npm test`
- `npm run build`

## Rollout Plan

1. Ship behind configuration only; existing OAuth and legacy flows keep working.
2. Configure `bujiaban` short entry in staging.
3. Configure `3dugc` short entry in staging.
4. Verify WeChat callback domain and business callback behavior.
5. Roll out production entries.
6. Keep direct `/oauth/authorize` support for clients that prefer standard OAuth.

## Risks

- Open redirect risk if `return_to` validation is loose.
- Client confusion if one slug points to a redirect URI owned by another client.
- WeChat callback domain remains tied to `AUTH_PUBLIC_BASE_URL`; multiple auth domains may need a later issuer/callback design.
- Website QR login and mini program login require provider-specific credentials and should not be implied by the first implementation.

## Open Questions

- Should `return_to` be passed to business callback or should the auth service ever redirect directly to it?
- Should production require explicit `AUTH_LOGIN_ENTRIES_JSON` rather than default entries?
- Do we need per-login-entry branding before the first release?
