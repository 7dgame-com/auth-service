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
import type { AuthUser, OAuthAuthorizationCode, OAuthClient } from './types';
import type { WechatClient } from './wechat-client';

interface OAuthAuthorizeState extends Record<string, unknown> {
  clientId: string;
  redirectUri: string;
  scopes: string[];
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

    const state = createSignedState(
      {
        clientId: client.clientId,
        redirectUri,
        scopes,
        state: queryString(req, 'state'),
        codeChallenge: queryString(req, 'code_challenge'),
        codeChallengeMethod: parseCodeChallengeMethod(queryString(req, 'code_challenge_method')),
      },
      config.tokenSecret,
      config.authorizationCodeTtlSeconds
    );
    res.redirect(302, `${config.publicBaseUrl}/login/wechat/offiaccount?state=${encodeURIComponent(state)}`);
  });

  router.get('/login/wechat/offiaccount', (req, res) => {
    const state = queryString(req, 'state');
    if (!state || !verifySignedState<OAuthAuthorizeState>(state, config.tokenSecret)) {
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
    const code = queryString(req, 'code');
    const signedState = queryString(req, 'state');
    const state = signedState ? verifySignedState<OAuthAuthorizeState>(signedState, config.tokenSecret) : undefined;
    if (!code || !state) {
      res.status(400).json({ error: 'invalid_callback' });
      return;
    }

    const client = findClient(config, state.clientId);
    if (!client || !client.redirectUris.includes(state.redirectUri)) {
      res.status(400).json({ error: 'invalid_client' });
      return;
    }

    const profile = await wechat.exchangeOfficialOAuthCode(code);
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
    res.redirect(302, redirectUrl.toString());
  }));

  router.get('/login/wechat/website', (_req, res) => {
    res.status(501).json({
      error: 'not_implemented',
      error_description: 'wechat website QR login requires a WeChat Open Platform website app',
    });
  });

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

function parseScopes(scope: string | undefined): string[] {
  const scopes = scope?.split(/\s+/).filter(Boolean) || [];
  return scopes.length ? scopes : ['openid', 'profile'];
}

function parseCodeChallengeMethod(value: string | undefined): 'plain' | 'S256' | undefined {
  return value === 'plain' || value === 'S256' ? value : undefined;
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
