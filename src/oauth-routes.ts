import { Router, type Request, type Response } from 'express';
import type { AuthServiceConfig } from './config';
import {
  constantTimeSecretEqual,
  createSignedState,
  createSignedToken,
  randomToken,
  sha256Base64Url,
  verifyPkceChallenge,
  verifySignedState,
  verifySignedToken,
} from './crypto';
import type { AuthStore } from './store';
import { addSeconds } from './store';
import type { AuthIdentityProvider, AuthUser, LoginEntry, OAuthAuthorizationCode, OAuthClient, WechatProfile } from './types';
import type { WechatClient } from './wechat-client';

interface OAuthAuthorizeState extends Record<string, unknown> {
  clientId: string;
  redirectUri: string;
  scopes: string[];
  provider?: 'wechat_official_account' | 'wechat_website' | 'wechat_mini_program';
  loginEntrySlug?: string;
  returnTo?: string;
  state?: string;
  codeChallenge?: string;
  codeChallengeMethod?: 'plain' | 'S256';
}

interface TokenSet {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
  id_token: string;
  scope: string;
}

export function createOAuthRouter(config: AuthServiceConfig, store: AuthStore, wechat: WechatClient): Router {
  const router = Router();

  router.get('/.well-known/openid-configuration', (_req, res) => {
    res.json({
      issuer: config.publicBaseUrl,
      authorization_endpoint: `${config.publicBaseUrl}/oauth/authorize`,
      token_endpoint: `${config.publicBaseUrl}/oauth/token`,
      userinfo_endpoint: `${config.publicBaseUrl}/userinfo`,
      end_session_endpoint: `${config.publicBaseUrl}/logout`,
      jwks_uri: `${config.publicBaseUrl}/.well-known/jwks.json`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      scopes_supported: ['openid', 'profile'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
      code_challenge_methods_supported: ['plain', 'S256'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['HS256'],
    });
  });

  router.get('/.well-known/jwks.json', (_req, res) => {
    res.json({ keys: [] });
  });

  router.get('/oauth/authorize', (req, res) => {
    const client = findClient(config, queryString(req, 'client_id'));
    const redirectUri = queryString(req, 'redirect_uri');
    if (!client || !redirectUri || !client.redirectUris.includes(redirectUri)) {
      res.status(400).json({ error: 'invalid_request', error_description: 'invalid client_id or redirect_uri' });
      return;
    }
    if (queryString(req, 'response_type') !== 'code') {
      redirectWithError(res, redirectUri, 'unsupported_response_type', queryString(req, 'state'));
      return;
    }

    const scopes = parseScopes(queryString(req, 'scope'));
    if (!scopes.every((scope) => client.scopes.includes(scope))) {
      redirectWithError(res, redirectUri, 'invalid_scope', queryString(req, 'state'));
      return;
    }

    const provider = parseProvider(queryString(req, 'provider')) || 'wechat_official_account';
    const state = createSignedState(
      {
        clientId: client.clientId,
        redirectUri,
        scopes,
        provider,
        state: queryString(req, 'state'),
        codeChallenge: queryString(req, 'code_challenge'),
        codeChallengeMethod: parseCodeChallengeMethod(queryString(req, 'code_challenge_method')),
      },
      config.tokenSecret,
      config.authorizationCodeTtlSeconds
    );
    redirectToProviderLogin(config, res, provider, state);
  });

  router.get('/login/:slug/widget-config', asyncHandler(async (req, res) => {
    const entry = findLoginEntry(config, req.params.slug);
    if (!entry) {
      res.status(404).json({ error: 'not_found', error_description: 'unknown login entry' });
      return;
    }
    if (entry.provider !== 'wechat_website' && entry.provider !== 'wechat_official_account') {
      res.status(400).json({
        error: 'unsupported_provider',
        error_description: `${entry.provider} cannot be embedded as a WeChat QR login widget`,
      });
      return;
    }

    const prepared = prepareLoginEntryState(config, req, entry);
    if ('error' in prepared) {
      res.status(prepared.status).json({ error: prepared.error, error_description: prepared.errorDescription });
      return;
    }
    if (config.allowMockWechat && entry.provider === 'wechat_website' && wechat.hasWebsiteOAuthConfig()) {
      res.json({
        provider: 'wechat_website',
        mode: 'mock',
        callbackUrl: `${config.publicBaseUrl}/login/wechat/website/callback?code=mock-code&state=${encodeURIComponent(prepared.state)}`,
      });
      return;
    }

    try {
      if (entry.provider === 'wechat_website' && wechat.hasWebsiteOAuthConfig()) {
        res.json({
          provider: 'wechat_website',
          mode: 'widget',
          ...wechat.buildWebsiteOAuthWidgetConfig(prepared.state),
          selfRedirect: false,
        });
        return;
      }
      if (!wechat.hasOfficialQrCodeConfig()) {
        res.status(503).json({
          error: 'wechat_official_qr_not_configured',
          error_description: 'AUTH_WECHAT_OFFICIAL_APP_ID and AUTH_WECHAT_OFFICIAL_APP_SECRET are required for official account QR login.',
        });
        return;
      }
      const sceneToken = randomToken(24);
      const qrCode = await wechat.createTemporaryQrCode(sceneToken, Math.min(config.legacyScanTokenTtlSeconds, config.authorizationCodeTtlSeconds));
      res.json({
        provider: 'wechat_official_account',
        mode: 'official_qr',
        token: sceneToken,
        state: prepared.state,
        qrImageUrl: wechat.buildOfficialQrCodeImageUrl(qrCode.ticket),
        expiresIn: qrCode.expire_seconds,
        pollUrl: `${config.publicBaseUrl}/login/wechat/offiaccount/scan-status`,
        pollIntervalMs: 2000,
        selfRedirect: false,
      });
    } catch (error) {
      res.status(503).json({
        error: 'wechat_qr_not_configured',
        error_description: error instanceof Error ? error.message : 'WeChat QR login is not configured.',
      });
    }
  }));

  router.get('/login/:slug', (req, res) => {
    const entry = findLoginEntry(config, req.params.slug);
    if (!entry) {
      res.status(404).json({ error: 'not_found', error_description: 'unknown login entry' });
      return;
    }
    const prepared = prepareLoginEntryState(config, req, entry);
    if ('error' in prepared) {
      res.status(prepared.status).json({ error: prepared.error, error_description: prepared.errorDescription });
      return;
    }

    redirectToProviderLogin(config, res, entry.provider, prepared.state);
  });

  router.get('/login/wechat/offiaccount', (req, res) => {
    const state = queryString(req, 'state');
    const payload = state ? verifySignedState<OAuthAuthorizeState>(state, config.tokenSecret) : undefined;
    if (!state || !payload || (payload.provider && payload.provider !== 'wechat_official_account')) {
      res.status(400).json({ error: 'invalid_state' });
      return;
    }
    if (config.allowMockWechat) {
      res.redirect(302, `${config.publicBaseUrl}/login/wechat/offiaccount/callback?code=mock-code&state=${encodeURIComponent(state)}`);
      return;
    }
    res.redirect(302, wechat.buildOfficialOAuthAuthorizeUrl(state));
  });

  router.get('/login/wechat/offiaccount/callback', asyncHandler(async (req, res) => {
    await handleWechatCallback(config, store, req, res, 'wechat_official_account', (code) => wechat.exchangeOfficialOAuthCode(code));
  }));

  router.get('/login/wechat/offiaccount/scan-status', asyncHandler(async (req, res) => {
    const token = queryString(req, 'token');
    const signedState = queryString(req, 'state');
    const state = signedState ? verifySignedState<OAuthAuthorizeState>(signedState, config.tokenSecret) : undefined;
    if (!token || !state || (state.provider !== 'wechat_website' && state.provider !== 'wechat_official_account')) {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }

    const scanToken = await store.findLegacyScanToken(token);
    if (!scanToken) {
      res.json({ status: 'pending' });
      return;
    }

    const profile = await wechat.getOfficialUserInfo(scanToken.openId);
    const redirectUrl = await createAuthorizationRedirectUrl(config, store, state, profile);
    if (!redirectUrl) {
      res.status(400).json({ error: 'invalid_client' });
      return;
    }
    res.json({
      status: 'confirmed',
      redirectUrl,
      user: {
        displayName: profile.nickname,
        avatarUrl: profile.avatarUrl,
        accountHint: buildWechatAccountHint(profile),
      },
    });
  }));

  router.get('/login/wechat/website', (req, res) => {
    const state = queryString(req, 'state');
    const payload = state ? verifySignedState<OAuthAuthorizeState>(state, config.tokenSecret) : undefined;
    if (!state || !payload || payload.provider !== 'wechat_website') {
      res.status(400).json({ error: 'invalid_state' });
      return;
    }
    if (config.allowMockWechat) {
      res.redirect(302, `${config.publicBaseUrl}/login/wechat/website/callback?code=mock-code&state=${encodeURIComponent(state)}`);
      return;
    }
    try {
      res.redirect(302, wechat.buildWebsiteOAuthAuthorizeUrl(state));
    } catch (error) {
      res.status(503).json({
        error: 'wechat_website_not_configured',
        error_description: error instanceof Error ? error.message : 'WeChat website login is not configured.',
      });
    }
  });

  router.get('/login/wechat/website/callback', asyncHandler(async (req, res) => {
    await handleWechatCallback(config, store, req, res, 'wechat_website', (code) => wechat.exchangeWebsiteOAuthCode(code));
  }));

  router.post('/login/wechat/miniprogram', (_req, res) => {
    res.status(501).json({
      error: 'not_implemented',
      error_description: 'wechat mini program login is reserved for the next integration step',
    });
  });

  router.post('/oauth/token', asyncHandler(async (req, res) => {
    const client = authenticateClient(config, req);
    if (!client) {
      res.status(401).json({ error: 'invalid_client' });
      return;
    }

    const grantType = bodyString(req, 'grant_type');
    if (grantType === 'authorization_code') {
      await handleAuthorizationCodeGrant(config, store, client, req, res);
      return;
    }
    if (grantType === 'refresh_token') {
      await handleRefreshTokenGrant(config, store, client, req, res);
      return;
    }
    res.status(400).json({ error: 'unsupported_grant_type' });
  }));

  router.post('/oauth/revoke', asyncHandler(async (req, res) => {
    const token = bodyString(req, 'token');
    if (token) await store.revokeRefreshToken(sha256Base64Url(token));
    res.status(200).json({ success: true });
  }));

  router.post('/logout', asyncHandler(async (req, res) => {
    const token = bodyString(req, 'refresh_token') || bodyString(req, 'token');
    if (token) await store.revokeRefreshToken(sha256Base64Url(token));
    res.status(200).json({ success: true });
  }));

  router.get('/userinfo', asyncHandler(async (req, res) => {
    const payload = readAccessToken(config, req);
    if (!payload) {
      res.status(401).json({ error: 'invalid_token' });
      return;
    }
    const user = await store.findUserById(payload.sub);
    if (!user || user.status !== 'active') {
      res.status(401).json({ error: 'invalid_token' });
      return;
    }
    res.json(userInfoFromUser(user));
  }));

  return router;
}

type PreparedLoginEntryState =
  | { state: string }
  | { status: number; error: string; errorDescription?: string };

function prepareLoginEntryState(config: AuthServiceConfig, req: Request, entry: LoginEntry): PreparedLoginEntryState {
  const client = findClient(config, entry.clientId);
  if (!client || !client.redirectUris.includes(entry.defaultRedirectUri)) {
    return { status: 500, error: 'server_error', errorDescription: 'login entry is not valid' };
  }

  const scopes = queryString(req, 'scope') ? parseScopes(queryString(req, 'scope')) : entry.defaultScopes;
  if (!scopes.every((scope) => entry.defaultScopes.includes(scope) && client.scopes.includes(scope))) {
    return { status: 400, error: 'invalid_scope' };
  }

  const returnTo = validateReturnTo(queryString(req, 'return_to'), entry);
  if (returnTo instanceof Error) {
    return { status: 400, error: 'invalid_request', errorDescription: returnTo.message };
  }

  return {
    state: createSignedState(
      {
        clientId: client.clientId,
        redirectUri: entry.defaultRedirectUri,
        scopes,
        provider: entry.provider,
        loginEntrySlug: entry.slug,
        returnTo,
        state: queryString(req, 'state'),
        codeChallenge: queryString(req, 'code_challenge'),
        codeChallengeMethod: parseCodeChallengeMethod(queryString(req, 'code_challenge_method')),
      },
      config.tokenSecret,
      config.authorizationCodeTtlSeconds
    ),
  };
}

async function handleWechatCallback(
  config: AuthServiceConfig,
  store: AuthStore,
  req: Request,
  res: Response,
  expectedProvider: AuthIdentityProvider,
  exchangeCode: (code: string) => Promise<WechatProfile>
): Promise<void> {
  const code = queryString(req, 'code');
  const signedState = queryString(req, 'state');
  const state = signedState ? verifySignedState<OAuthAuthorizeState>(signedState, config.tokenSecret) : undefined;
  if (!code || !state || state.provider !== expectedProvider) {
    res.status(400).json({ error: 'invalid_callback' });
    return;
  }

  const profile = await exchangeCode(code);
  const redirectUrl = await createAuthorizationRedirectUrl(config, store, state, profile);
  if (!redirectUrl) {
    res.status(400).json({ error: 'invalid_client' });
    return;
  }
  res.redirect(302, redirectUrl);
}

async function createAuthorizationRedirectUrl(
  config: AuthServiceConfig,
  store: AuthStore,
  state: OAuthAuthorizeState,
  profile: WechatProfile
): Promise<string | undefined> {
  const client = findClient(config, state.clientId);
  if (!client || !client.redirectUris.includes(state.redirectUri)) return undefined;

  const result = await store.upsertWechatIdentity(profile);
  const authCode = randomToken(32);
  const now = new Date();
  await store.createAuthorizationCode({
    codeHash: sha256Base64Url(authCode),
    clientId: client.clientId,
    userId: result.user.id,
    redirectUri: state.redirectUri,
    codeChallenge: state.codeChallenge,
    codeChallengeMethod: state.codeChallengeMethod,
    scopes: state.scopes,
    expiresAt: addSeconds(now, config.authorizationCodeTtlSeconds),
    createdAt: now.toISOString(),
  });

  const redirectUrl = new URL(state.redirectUri);
  redirectUrl.searchParams.set('code', authCode);
  if (state.state) redirectUrl.searchParams.set('state', state.state);
  if (state.returnTo) redirectUrl.searchParams.set('return_to', state.returnTo);
  return redirectUrl.toString();
}

async function handleAuthorizationCodeGrant(
  config: AuthServiceConfig,
  store: AuthStore,
  client: OAuthClient,
  req: Request,
  res: Response
): Promise<void> {
  const code = bodyString(req, 'code');
  const redirectUri = bodyString(req, 'redirect_uri');
  if (!code || !redirectUri) {
    res.status(400).json({ error: 'invalid_request' });
    return;
  }
  const authorizationCode = await store.consumeAuthorizationCode(sha256Base64Url(code));
  if (!authorizationCode || authorizationCode.clientId !== client.clientId || authorizationCode.redirectUri !== redirectUri) {
    res.status(400).json({ error: 'invalid_grant' });
    return;
  }
  if (!isValidPkce(req, authorizationCode)) {
    res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE verification failed' });
    return;
  }
  const user = await store.findUserById(authorizationCode.userId);
  if (!user || user.status !== 'active') {
    res.status(400).json({ error: 'invalid_grant' });
    return;
  }
  res.json(await issueTokens(config, store, client, user, authorizationCode.scopes));
}

async function handleRefreshTokenGrant(
  config: AuthServiceConfig,
  store: AuthStore,
  client: OAuthClient,
  req: Request,
  res: Response
): Promise<void> {
  const refreshToken = bodyString(req, 'refresh_token');
  if (!refreshToken) {
    res.status(400).json({ error: 'invalid_request' });
    return;
  }
  const token = await store.findRefreshToken(sha256Base64Url(refreshToken));
  if (!token || token.clientId !== client.clientId) {
    res.status(400).json({ error: 'invalid_grant' });
    return;
  }
  const user = await store.findUserById(token.userId);
  if (!user || user.status !== 'active') {
    res.status(400).json({ error: 'invalid_grant' });
    return;
  }
  await store.revokeRefreshToken(token.tokenHash);
  res.json(await issueTokens(config, store, client, user, token.scopes));
}

async function issueTokens(
  config: AuthServiceConfig,
  store: AuthStore,
  client: OAuthClient,
  user: AuthUser,
  scopes: string[]
): Promise<TokenSet> {
  const now = new Date();
  const issuedAt = Math.floor(now.getTime() / 1000);
  const refreshToken = randomToken(32);
  await store.createRefreshToken({
    tokenHash: sha256Base64Url(refreshToken),
    clientId: client.clientId,
    userId: user.id,
    scopes,
    expiresAt: addSeconds(now, config.refreshTokenTtlSeconds),
    createdAt: now.toISOString(),
  });

  const commonPayload = {
    iss: config.publicBaseUrl,
    sub: user.id,
    aud: client.clientId,
    scope: scopes.join(' '),
    unionid: user.primaryUnionId,
    iat: issuedAt,
  };
  return {
    access_token: createSignedToken(
      { ...commonPayload, exp: issuedAt + config.accessTokenTtlSeconds, jti: randomToken(16), typ: 'access' },
      config.tokenSecret
    ),
    token_type: 'Bearer',
    expires_in: config.accessTokenTtlSeconds,
    refresh_token: refreshToken,
    id_token: createSignedToken(
      { ...commonPayload, exp: issuedAt + config.accessTokenTtlSeconds, jti: randomToken(16), typ: 'id' },
      config.tokenSecret
    ),
    scope: scopes.join(' '),
  };
}

function isValidPkce(req: Request, code: OAuthAuthorizationCode): boolean {
  if (!code.codeChallenge) return true;
  const verifier = bodyString(req, 'code_verifier');
  return Boolean(verifier && verifyPkceChallenge(verifier, code.codeChallenge, code.codeChallengeMethod));
}

function authenticateClient(config: AuthServiceConfig, req: Request): OAuthClient | undefined {
  const client = findClient(config, bodyString(req, 'client_id'));
  if (!client) return undefined;
  if (client.publicClient) return client;
  return constantTimeSecretEqual(client.clientSecret, bodyString(req, 'client_secret')) ? client : undefined;
}

function findClient(config: AuthServiceConfig, clientId: string | undefined): OAuthClient | undefined {
  if (!clientId) return undefined;
  return config.oauthClients.find((client) => client.clientId === clientId);
}

function findLoginEntry(config: AuthServiceConfig, slug: string | undefined): LoginEntry | undefined {
  if (!slug) return undefined;
  return config.loginEntries.find((entry) => entry.slug === slug);
}

function validateReturnTo(value: string | undefined, entry: LoginEntry): string | undefined | Error {
  if (!value) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return new Error('return_to must be an absolute URL');
  }
  if (url.username || url.password) return new Error('return_to must not include credentials');
  if (url.hash) return new Error('return_to must not include a fragment');
  if (!isHttpsOrLocalHttp(url)) return new Error('return_to must use https or configured local http');

  const normalized = url.toString();
  const allowed = entry.allowedReturnUrlPrefixes.some((prefix) => normalized.startsWith(normalizeReturnUrlPrefix(prefix)));
  return allowed ? normalized : new Error('return_to is not allowed for this login entry');
}

function normalizeReturnUrlPrefix(prefix: string): string {
  const url = new URL(prefix);
  url.hash = '';
  return url.toString();
}

function isHttpsOrLocalHttp(url: URL): boolean {
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
}

function parseScopes(scope: string | undefined): string[] {
  const scopes = scope?.split(/\s+/).filter(Boolean) || [];
  return scopes.length ? scopes : ['openid', 'profile'];
}

function parseCodeChallengeMethod(value: string | undefined): 'plain' | 'S256' | undefined {
  return value === 'plain' || value === 'S256' ? value : undefined;
}

function parseProvider(value: string | undefined): AuthIdentityProvider | undefined {
  if (value === 'wechat_official_account' || value === 'wechat_website' || value === 'wechat_mini_program') return value;
  return undefined;
}

function redirectToProviderLogin(
  config: AuthServiceConfig,
  res: Response,
  provider: AuthIdentityProvider,
  state: string
): void {
  if (provider === 'wechat_official_account') {
    res.redirect(302, `${config.publicBaseUrl}/login/wechat/offiaccount?state=${encodeURIComponent(state)}`);
    return;
  }
  if (provider === 'wechat_website') {
    res.redirect(302, `${config.publicBaseUrl}/login/wechat/website?state=${encodeURIComponent(state)}`);
    return;
  }
  res.status(501).json({ error: 'not_implemented', error_description: `${provider} login is not implemented` });
}

function redirectWithError(res: Response, redirectUri: string, error: string, state: string | undefined): void {
  const url = new URL(redirectUri);
  url.searchParams.set('error', error);
  if (state) url.searchParams.set('state', state);
  res.redirect(302, url.toString());
}

function readAccessToken(config: AuthServiceConfig, req: Request) {
  const header = req.header('authorization');
  if (!header?.startsWith('Bearer ')) return undefined;
  const payload = verifySignedToken(header.slice('Bearer '.length), config.tokenSecret);
  return payload?.typ === 'access' ? payload : undefined;
}

function userInfoFromUser(user: AuthUser): Record<string, string | undefined> {
  return {
    sub: user.id,
    unionid: user.primaryUnionId,
    name: user.displayName,
    picture: user.avatarUrl,
  };
}

function buildWechatAccountHint(profile: WechatProfile): string {
  const stableId = profile.unionId || `${profile.provider}:${profile.providerAppId}:${profile.openId}`;
  return `微信账号 ${sha256Base64Url(stableId).slice(0, 8)}`;
}

function queryString(req: Request, key: string): string | undefined {
  const value = req.query[key];
  return typeof value === 'string' ? value : undefined;
}

function bodyString(req: Request, key: string): string | undefined {
  const body = req.body as Record<string, unknown> | undefined;
  const value = body?.[key];
  return typeof value === 'string' ? value : undefined;
}

function asyncHandler(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: (error: unknown) => void): void => {
    handler(req, res).catch(next);
  };
}
