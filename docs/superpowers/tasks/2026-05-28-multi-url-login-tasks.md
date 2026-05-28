# Tasks: Multi-URL Login Support

Status: Draft
Date: 2026-05-28
Spec: ../specs/2026-05-28-multi-url-login.md
Plan: ../plans/2026-05-28-multi-url-login-plan.md

## Milestone 1: Configuration

- [ ] Add `LoginEntry` type in `src/types.ts`.
- [ ] Add `loginEntries: LoginEntry[]` to `AuthServiceConfig` in `src/config.ts`.
- [ ] Implement `readLoginEntries(env, oauthClients)`.
- [ ] Parse `AUTH_LOGIN_ENTRIES_JSON`.
- [ ] Add default entries for `bujiaban` and `3dugc` when matching built-in clients exist.
- [ ] Validate duplicate slugs are rejected.
- [ ] Validate referenced `clientId` exists.
- [ ] Validate `defaultRedirectUri` belongs to the referenced client's `redirectUris`.
- [ ] Validate `defaultScopes` are a subset of the referenced client's scopes.
- [ ] Validate provider is one of the supported identity providers.
- [ ] Add config tests for valid custom entries.
- [ ] Add config tests for invalid entries.

## Milestone 2: Return URL Safety

- [ ] Add a helper to normalize and validate `return_to`.
- [ ] Allow `https:` return URLs by default.
- [ ] Allow local `http://localhost` and `http://127.0.0.1` only for configured local prefixes.
- [ ] Reject URLs with username or password.
- [ ] Drop or reject fragments.
- [ ] Match only against `allowedReturnUrlPrefixes`.
- [ ] Add tests for accepted return URLs.
- [ ] Add tests for rejected external return URLs.
- [ ] Add tests for tricky URL parser cases.

## Milestone 3: Short Login Route

- [ ] Extend `OAuthAuthorizeState` with `provider`, `loginEntrySlug?`, and `returnTo?`.
- [ ] Add `GET /login/:slug` to `src/oauth-routes.ts`.
- [ ] Resolve login entry by slug.
- [ ] Resolve OAuth client by `entry.clientId`.
- [ ] Validate optional `scope` query against client and entry scopes.
- [ ] Preserve `state`, `code_challenge`, and `code_challenge_method`.
- [ ] Create signed state using existing `createSignedState`.
- [ ] Redirect official account entries to `/login/wechat/offiaccount`.
- [ ] Return local error for unsupported providers.
- [ ] Add route test for `/login/bujiaban`.
- [ ] Add route test for unknown slug.

## Milestone 4: Callback Propagation

- [ ] Revalidate client and redirect URI after callback state verification.
- [ ] Append `return_to` to client callback when it exists in signed state.
- [ ] Keep `redirect_uri` exact and unchanged.
- [ ] Verify auth code creation still stores the exact redirect URI.
- [ ] Add mock WeChat flow test with `return_to`.
- [ ] Add mock WeChat flow test without `return_to`.
- [ ] Add regression test for direct `/oauth/authorize`.

## Milestone 5: Documentation

- [ ] Add `AUTH_LOGIN_ENTRIES_JSON` to `.env.example`.
- [ ] Add README section for `/login/:slug`.
- [ ] Add JSON examples for `bujiaban` and `3dugc`.
- [ ] Document `return_to` rules.
- [ ] Document that standard `/oauth/authorize` remains supported.
- [ ] Optionally update `docker-compose.portainer.yml` comments.

## Milestone 6: Verification

- [ ] Run `npm test`.
- [ ] Run `npm run build`.
- [ ] Check `git diff` for unrelated changes.
- [ ] Confirm legacy `/v1/wechat/*` tests still pass.
- [ ] Confirm OAuth token exchange still requires the same client and redirect URI.

## Deferred Tasks

- [ ] Add `auth_login_entries` migration.
- [ ] Add database-backed login entry loading.
- [ ] Add database-backed OAuth client loading.
- [ ] Add admin or seed workflow for login entries.
- [ ] Add per-entry branding on a future login page.
- [ ] Add multi-WeChat-app provider configuration.
- [ ] Implement `/login/wechat/website`.
- [ ] Implement `/login/wechat/miniprogram`.

## Definition of Done

- [ ] `bujiaban` and `3dugc` can start login from different short URLs.
- [ ] Valid `return_to` is preserved through login.
- [ ] Invalid `return_to` is rejected before any external redirect.
- [ ] Existing OAuth clients continue to use `/oauth/authorize`.
- [ ] Existing legacy WeChat endpoints are unchanged.
- [ ] Tests and build pass locally.
