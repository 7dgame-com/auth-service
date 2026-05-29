import crypto from 'crypto';
import type { AddressInfo } from 'net';
import { afterEach, describe, expect, it } from 'vitest';
import { createConfig } from '../src/config';
import { createWechatMessageSignature, decryptWechatMessage, encryptWechatMessage } from '../src/crypto';
import { yiiRedisOpenIdKey } from '../src/legacy-redis';
import { createApp } from '../src/server';
import { MemoryAuthStore } from '../src/memory-store';
import { WechatClient } from '../src/wechat-client';

interface StartedApp {
  baseUrl: string;
  close: () => Promise<void>;
}

const startedApps: StartedApp[] = [];

afterEach(async () => {
  await Promise.all(startedApps.splice(0).map((app) => app.close()));
});

describe('unified auth service', () => {
  it('accepts legacy gdgeek/auth compose environment names', () => {
    const config = createConfig({
      MYSQL_HOST: '10.0.0.5',
      MYSQL_PORT: '3307',
      MYSQL_DB: 'bujiaban',
      MYSQL_USERNAME: 'legacy-user',
      MYSQL_PASSWORD: 'legacy-pass',
      JWT_KEY: 'legacy-jwt-secret',
      WECHAT_APP_ID: 'wx-legacy',
      WECHAT_SECRET: 'wechat-secret',
      WECHAT_TOKEN: 'wechat-token',
      AUTH_WECHAT_WEBSITE_APP_ID: 'wx-website',
      AUTH_WECHAT_WEBSITE_APP_SECRET: 'website-secret',
      REDIS_HOST: '10.0.0.6',
      REDIS_PORT: '6380',
      REDIS_DB: '2',
      REDIS_PASSWORD: 'redis-pass',
    });

    expect(config.databaseUrl).toBe('mysql://legacy-user:legacy-pass@10.0.0.5:3307/bujiaban');
    expect(config.redis).toEqual({ host: '10.0.0.6', port: 6380, database: 2, password: 'redis-pass' });
    expect(config.tokenSecret).toBe('legacy-jwt-secret');
    expect(config.wechat.officialAppId).toBe('wx-legacy');
    expect(config.wechat.officialAppSecret).toBe('wechat-secret');
    expect(config.wechat.websiteAppId).toBe('wx-website');
    expect(config.wechat.websiteAppSecret).toBe('website-secret');
    expect(config.wechat.officialToken).toBe('wechat-token');
  });

  it('uses WeChat website QR login for the built-in 3dugc entry', () => {
    const config = createConfig({ AUTH_TOKEN_SECRET: 'test-secret' });

    expect(config.loginEntries.find((entry) => entry.slug === '3dugc')).toMatchObject({
      clientId: '3dugc-web',
      provider: 'wechat_website',
      defaultRedirectUri: 'https://3dugc.com/auth/callback',
    });
  });

  it('accepts configured login entries and rejects invalid login entry wiring', () => {
    const loginEntries = [
      {
        slug: 'custom',
        clientId: 'bujiaban-web',
        defaultRedirectUri: 'https://bujiaban.com/auth/callback',
        allowedReturnUrlPrefixes: ['https://bujiaban.com/app/'],
        defaultScopes: ['openid'],
        provider: 'wechat_official_account',
        displayName: 'Custom Login',
      },
    ];
    const config = createConfig({
      AUTH_LOGIN_ENTRIES_JSON: JSON.stringify(loginEntries),
      AUTH_TOKEN_SECRET: 'test-secret',
    });

    expect(config.loginEntries).toEqual(loginEntries);
    expect(() => createConfig({
      AUTH_LOGIN_ENTRIES_JSON: JSON.stringify([
        { ...loginEntries[0], defaultRedirectUri: 'https://evil.example/callback' },
      ]),
      AUTH_TOKEN_SECRET: 'test-secret',
    })).toThrow(/defaultRedirectUri/);
    expect(() => createConfig({
      AUTH_LOGIN_ENTRIES_JSON: JSON.stringify([loginEntries[0], { ...loginEntries[0] }]),
      AUTH_TOKEN_SECRET: 'test-secret',
    })).toThrow(/Duplicate login entry slug/);
  });

  it('matches Yii Redis ActiveRecord keys for legacy scan tokens', () => {
    expect(yiiRedisOpenIdKey('abc123')).toBe('open_id:a:abc123');
    expect(yiiRedisOpenIdKey('token-with-dash')).toBe(
      `open_id:a:${crypto.createHash('md5').update('token-with-dash').digest('hex')}`
    );
    expect(yiiRedisOpenIdKey('a'.repeat(33))).toBe(
      `open_id:a:${crypto.createHash('md5').update('a'.repeat(33)).digest('hex')}`
    );
  });

  it('preserves the legacy qrcode, event push, and refresh flow', async () => {
    const config = createConfig({
      AUTH_PUBLIC_BASE_URL: 'http://127.0.0.1',
      AUTH_ALLOW_MOCK_WECHAT: 'true',
      AUTH_WECHAT_SIGNATURE_REQUIRED: 'false',
      AUTH_WECHAT_OFFICIAL_APP_ID: 'wx-test',
      AUTH_TOKEN_SECRET: 'test-secret',
    });
    const store = new MemoryAuthStore();
    const app = await startApp(config, store);

    const qrcodeResponse = await fetch(`${app.baseUrl}/v1/wechat/qrcode`);
    const qrcode = await qrcodeResponse.json() as { success: boolean; message: string; token: string };
    expect(qrcode).toMatchObject({ success: true, message: 'create qrcode' });
    expect(qrcode.token).toBeTruthy();

    const pushResponse = await fetch(`${app.baseUrl}/v1/wechat`, {
      method: 'POST',
      headers: { 'content-type': 'application/xml' },
      body: createWechatEventXml(qrcode.token, 'openid-1'),
    });
    expect(await pushResponse.text()).toContain('欢迎登陆平台');

    const refreshResponse = await fetch(`${app.baseUrl}/v1/wechat/refresh?token=${encodeURIComponent(qrcode.token)}`);
    const refresh = await refreshResponse.json() as { success: boolean; message: string; token: string };
    expect(refresh.success).toBe(true);
    expect(refresh.message).toBe('signup');
    expect(refresh.token).toBeTruthy();

    store.seedLegacyWechatUser('openid-1', '42');
    const secondRefreshResponse = await fetch(`${app.baseUrl}/v1/wechat/refresh?token=${encodeURIComponent(qrcode.token)}`);
    const secondRefresh = await secondRefreshResponse.json() as { success: boolean; message: string; token: string };
    expect(secondRefresh.success).toBe(true);
    expect(secondRefresh.message).toBe('signin');
  });

  it('verifies the WeChat server check endpoint with the configured token', async () => {
    const token = 'wechat-token';
    const config = createConfig({
      AUTH_PUBLIC_BASE_URL: 'http://127.0.0.1',
      AUTH_WECHAT_OFFICIAL_TOKEN: token,
      AUTH_TOKEN_SECRET: 'test-secret',
    });
    const app = await startApp(config, new MemoryAuthStore());
    const timestamp = '1770000000';
    const nonce = 'nonce';
    const signature = crypto.createHash('sha1').update([token, timestamp, nonce].sort().join('')).digest('hex');

    const response = await fetch(
      `${app.baseUrl}/v1/wechat?signature=${signature}&timestamp=${timestamp}&nonce=${nonce}&echostr=hello`
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('hello');
  });

  it('accepts encrypted WeChat checks and event pushes', async () => {
    const token = 'wechat-token';
    const appId = 'wx-test';
    const aesKey = crypto.randomBytes(32).toString('base64').slice(0, 43);
    const config = createConfig({
      AUTH_PUBLIC_BASE_URL: 'http://127.0.0.1',
      AUTH_ALLOW_MOCK_WECHAT: 'true',
      AUTH_WECHAT_OFFICIAL_APP_ID: appId,
      AUTH_WECHAT_OFFICIAL_TOKEN: token,
      AUTH_WECHAT_OFFICIAL_AES_KEY: aesKey,
      AUTH_TOKEN_SECRET: 'test-secret',
    });
    const app = await startApp(config, new MemoryAuthStore());
    const timestamp = '1770000001';
    const nonce = 'encrypted-nonce';
    const encryptedEcho = encryptWechatMessage('hello-encrypted', aesKey, appId);
    const echoSignature = createWechatMessageSignature(token, timestamp, nonce, encryptedEcho);

    const checkResponse = await fetch(
      `${app.baseUrl}/v1/wechat?msg_signature=${echoSignature}&timestamp=${timestamp}&nonce=${nonce}&echostr=${encodeURIComponent(encryptedEcho)}`
    );
    expect(checkResponse.status).toBe(200);
    expect(await checkResponse.text()).toBe('hello-encrypted');

    const sceneToken = 'encrypted-scene-token';
    const encryptedMessage = encryptWechatMessage(createWechatEventXml(sceneToken, 'openid-encrypted'), aesKey, appId);
    const messageSignature = createWechatMessageSignature(token, timestamp, nonce, encryptedMessage);
    const pushResponse = await fetch(
      `${app.baseUrl}/v1/wechat?encrypt_type=aes&msg_signature=${messageSignature}&timestamp=${timestamp}&nonce=${nonce}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/xml' },
        body: createEncryptedWechatEnvelope(encryptedMessage),
      }
    );
    expect(pushResponse.status).toBe(200);
    const encryptedReplyEnvelope = await pushResponse.text();
    const encryptedReply = extractXml(encryptedReplyEnvelope, 'Encrypt');
    const replySignature = extractXml(encryptedReplyEnvelope, 'MsgSignature');
    expect(encryptedReply).toBeTruthy();
    expect(replySignature).toBe(createWechatMessageSignature(token, timestamp, nonce, encryptedReply || ''));
    expect(decryptWechatMessage(encryptedReply || '', aesKey, appId)).toContain('欢迎登陆平台');

    const refreshResponse = await fetch(`${app.baseUrl}/v1/wechat/refresh?token=${encodeURIComponent(sceneToken)}`);
    expect(await refreshResponse.json()).toMatchObject({ success: true, message: 'signup' });
  });

  it('keeps the legacy WeChat menu endpoint available', async () => {
    const config = createConfig({
      AUTH_PUBLIC_BASE_URL: 'http://127.0.0.1',
      AUTH_ALLOW_MOCK_WECHAT: 'true',
      AUTH_WECHAT_OFFICIAL_APP_ID: 'wx-test',
      AUTH_TOKEN_SECRET: 'test-secret',
    });
    const app = await startApp(config, new MemoryAuthStore());

    const response = await fetch(`${app.baseUrl}/v1/wechat/menu`);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ errcode: 0, errmsg: 'ok' });
  });

  it('keeps legacy debug endpoints disabled by default and available by opt-in', async () => {
    const disabledConfig = createConfig({
      AUTH_PUBLIC_BASE_URL: 'http://127.0.0.1',
      AUTH_TOKEN_SECRET: 'test-secret',
    });
    const disabledApp = await startApp(disabledConfig, new MemoryAuthStore());

    expect((await fetch(`${disabledApp.baseUrl}/v1/wechat/test`)).status).toBe(404);
    expect((await fetch(`${disabledApp.baseUrl}/v1/wechat/the`)).status).toBe(404);

    const enabledConfig = createConfig({
      AUTH_PUBLIC_BASE_URL: 'http://127.0.0.1',
      AUTH_ENABLE_LEGACY_DEBUG_ENDPOINTS: 'true',
      AUTH_ALLOW_MOCK_WECHAT: 'true',
      AUTH_WECHAT_OFFICIAL_APP_ID: 'wx-test',
      AUTH_TOKEN_SECRET: 'test-secret',
    });
    const enabledApp = await startApp(enabledConfig, new MemoryAuthStore());

    const testResponse = await fetch(`${enabledApp.baseUrl}/v1/wechat/test`);
    expect(testResponse.status).toBe(200);
    expect(await testResponse.json()).toMatchObject({ success: true });

    const theResponse = await fetch(`${enabledApp.baseUrl}/v1/wechat/the`);
    expect(theResponse.status).toBe(200);
    expect(await theResponse.json()).toMatchObject({ token: 'token', openid: 'the id' });

    const refreshResponse = await fetch(`${enabledApp.baseUrl}/v1/wechat/refresh?token=token`);
    expect(await refreshResponse.json()).toMatchObject({ success: true, message: 'signup' });
  });

  it('completes OAuth authorization code with PKCE and revokes refresh tokens on logout', async () => {
    const config = createConfig({
      AUTH_PUBLIC_BASE_URL: 'http://127.0.0.1',
      AUTH_ALLOW_MOCK_WECHAT: 'true',
      AUTH_WECHAT_SIGNATURE_REQUIRED: 'false',
      AUTH_WECHAT_OFFICIAL_APP_ID: 'wx-test',
      AUTH_TOKEN_SECRET: 'test-secret',
    });
    const app = await startApp(config, new MemoryAuthStore());
    const redirectUri = 'https://bujiaban.com/auth/callback';
    const verifier = 'oauth-pkce-test-verifier';
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');

    const authorizeUrl = new URL(`${app.baseUrl}/oauth/authorize`);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('client_id', 'bujiaban-web');
    authorizeUrl.searchParams.set('redirect_uri', redirectUri);
    authorizeUrl.searchParams.set('scope', 'openid profile');
    authorizeUrl.searchParams.set('state', 'client-state');
    authorizeUrl.searchParams.set('code_challenge', challenge);
    authorizeUrl.searchParams.set('code_challenge_method', 'S256');

    const loginLocation = await expectRedirect(authorizeUrl.toString());
    const mockWechatCallback = await expectRedirect(loginLocation);
    const callbackLocation = await expectRedirect(mockWechatCallback);
    const callbackUrl = new URL(callbackLocation);
    expect(callbackUrl.origin + callbackUrl.pathname).toBe(redirectUri);
    expect(callbackUrl.searchParams.get('state')).toBe('client-state');
    const code = callbackUrl.searchParams.get('code');
    expect(code).toBeTruthy();

    const tokenResponse = await fetch(`${app.baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: 'bujiaban-web',
        redirect_uri: redirectUri,
        code: code || '',
        code_verifier: verifier,
      }),
    });
    expect(tokenResponse.status).toBe(200);
    const tokenSet = await tokenResponse.json() as { access_token: string; refresh_token: string; id_token: string };
    expect(tokenSet.access_token).toBeTruthy();
    expect(tokenSet.refresh_token).toBeTruthy();
    expect(tokenSet.id_token).toBeTruthy();

    const userInfoResponse = await fetch(`${app.baseUrl}/userinfo`, {
      headers: { authorization: `Bearer ${tokenSet.access_token}` },
    });
    expect(userInfoResponse.status).toBe(200);
    const userInfo = await userInfoResponse.json() as { sub: string; unionid?: string };
    expect(userInfo.sub).toBeTruthy();
    expect(userInfo.unionid).toContain('mock-union-');

    const refreshedResponse = await fetch(`${app.baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: 'bujiaban-web',
        refresh_token: tokenSet.refresh_token,
      }),
    });
    expect(refreshedResponse.status).toBe(200);
    const refreshed = await refreshedResponse.json() as { refresh_token: string };
    expect(refreshed.refresh_token).toBeTruthy();

    const logoutResponse = await fetch(`${app.baseUrl}/logout`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ refresh_token: refreshed.refresh_token }),
    });
    expect(logoutResponse.status).toBe(200);

    const revokedResponse = await fetch(`${app.baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: 'bujiaban-web',
        refresh_token: refreshed.refresh_token,
      }),
    });
    expect(revokedResponse.status).toBe(400);
    expect(await revokedResponse.json()).toMatchObject({ error: 'invalid_grant' });
  });

  it('starts OAuth from a short login URL and preserves validated return_to', async () => {
    const config = createConfig({
      AUTH_PUBLIC_BASE_URL: 'http://127.0.0.1',
      AUTH_ALLOW_MOCK_WECHAT: 'true',
      AUTH_WECHAT_SIGNATURE_REQUIRED: 'false',
      AUTH_WECHAT_OFFICIAL_APP_ID: 'wx-test',
      AUTH_TOKEN_SECRET: 'test-secret',
    });
    const app = await startApp(config, new MemoryAuthStore());
    const verifier = 'short-login-pkce-verifier';
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');

    const loginUrl = new URL(`${app.baseUrl}/login/bujiaban`);
    loginUrl.searchParams.set('return_to', 'https://bujiaban.com/dashboard');
    loginUrl.searchParams.set('state', 'short-login-state');
    loginUrl.searchParams.set('code_challenge', challenge);
    loginUrl.searchParams.set('code_challenge_method', 'S256');

    const loginLocation = await expectRedirect(loginUrl.toString());
    expect(loginLocation).toContain('/login/wechat/offiaccount?state=');
    const mockWechatCallback = await expectRedirect(loginLocation);
    const callbackLocation = await expectRedirect(mockWechatCallback);
    const callbackUrl = new URL(callbackLocation);
    expect(callbackUrl.origin + callbackUrl.pathname).toBe('https://bujiaban.com/auth/callback');
    expect(callbackUrl.searchParams.get('state')).toBe('short-login-state');
    expect(callbackUrl.searchParams.get('return_to')).toBe('https://bujiaban.com/dashboard');
    const code = callbackUrl.searchParams.get('code');
    expect(code).toBeTruthy();

    const tokenResponse = await fetch(`${app.baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: 'bujiaban-web',
        redirect_uri: 'https://bujiaban.com/auth/callback',
        code: code || '',
        code_verifier: verifier,
      }),
    });
    expect(tokenResponse.status).toBe(200);
  });

  it('routes a WeChat website login entry to qrconnect', async () => {
    const config = createConfig({
      AUTH_PUBLIC_BASE_URL: 'http://127.0.0.1',
      AUTH_WECHAT_WEBSITE_APP_ID: 'wx-website',
      AUTH_WECHAT_WEBSITE_APP_SECRET: 'website-secret',
      AUTH_TOKEN_SECRET: 'test-secret',
      AUTH_LOGIN_ENTRIES_JSON: JSON.stringify([
        {
          slug: '3dugc',
          clientId: '3dugc-web',
          defaultRedirectUri: 'https://3dugc.com/auth/callback',
          allowedReturnUrlPrefixes: ['https://3dugc.com/'],
          defaultScopes: ['openid', 'profile'],
          provider: 'wechat_website',
          displayName: '3DUGC',
        },
      ]),
    });
    const app = await startApp(config, new MemoryAuthStore());

    const widgetUrl = new URL(`${app.baseUrl}/login/3dugc/widget-config`);
    widgetUrl.searchParams.set('state', 'widget-state');
    const widgetResponse = await fetch(widgetUrl);
    expect(widgetResponse.status).toBe(200);
    const widget = await widgetResponse.json() as {
      provider: string;
      mode: string;
      appId: string;
      redirectUri: string;
      scope: string;
      state: string;
      selfRedirect: boolean;
    };
    expect(widget).toMatchObject({
      provider: 'wechat_website',
      mode: 'widget',
      appId: 'wx-website',
      redirectUri: `${app.baseUrl}/login/wechat/website/callback`,
      scope: 'snsapi_login',
      selfRedirect: false,
    });
    expect(widget.state).toBeTruthy();

    const loginLocation = await expectRedirect(`${app.baseUrl}/login/3dugc`);
    expect(loginLocation).toContain('/login/wechat/website?state=');
    const qrConnectLocation = await expectRedirect(loginLocation);
    const qrConnectUrl = new URL(qrConnectLocation.replace('#wechat_redirect', ''));
    expect(qrConnectUrl.origin + qrConnectUrl.pathname).toBe('https://open.weixin.qq.com/connect/qrconnect');
    expect(qrConnectUrl.searchParams.get('appid')).toBe('wx-website');
    expect(qrConnectUrl.searchParams.get('redirect_uri')).toBe(`${app.baseUrl}/login/wechat/website/callback`);
    expect(qrConnectUrl.searchParams.get('scope')).toBe('snsapi_login');
  });

  it('uses an official account QR widget when website login credentials are not configured', async () => {
    const config = createConfig({
      AUTH_PUBLIC_BASE_URL: 'http://127.0.0.1',
      AUTH_ALLOW_MOCK_WECHAT: 'true',
      AUTH_WECHAT_OFFICIAL_APP_ID: 'wx-official',
      AUTH_TOKEN_SECRET: 'test-secret',
    });
    const store = new MemoryAuthStore();
    const app = await startApp(config, store);
    const verifier = 'official-qr-pkce-verifier';
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');

    const widgetUrl = new URL(`${app.baseUrl}/login/3dugc/widget-config`);
    widgetUrl.searchParams.set('state', 'official-qr-state');
    widgetUrl.searchParams.set('code_challenge', challenge);
    widgetUrl.searchParams.set('code_challenge_method', 'S256');
    const widgetResponse = await fetch(widgetUrl);
    expect(widgetResponse.status).toBe(200);
    const widget = await widgetResponse.json() as {
      provider: string;
      mode: string;
      token: string;
      state: string;
      qrImageUrl: string;
      pollUrl: string;
      expiresIn: number;
    };
    expect(widget).toMatchObject({
      provider: 'wechat_official_account',
      mode: 'official_qr',
      pollUrl: `${app.baseUrl}/login/wechat/offiaccount/scan-status`,
    });
    expect(widget.token).toBeTruthy();
    expect(widget.qrImageUrl).toContain('/cgi-bin/showqrcode');
    expect(widget.state).toBeTruthy();
    expect(widget.expiresIn).toBeGreaterThan(0);

    const pendingUrl = new URL(widget.pollUrl);
    pendingUrl.searchParams.set('token', widget.token);
    pendingUrl.searchParams.set('state', widget.state);
    const pendingResponse = await fetch(pendingUrl);
    expect(await pendingResponse.json()).toMatchObject({ status: 'pending' });

    const pushResponse = await fetch(`${app.baseUrl}/v1/wechat`, {
      method: 'POST',
      headers: { 'content-type': 'application/xml' },
      body: createWechatEventXml(widget.token, 'openid-official-qr'),
    });
    expect(pushResponse.status).toBe(200);

    const confirmedResponse = await fetch(pendingUrl);
    expect(confirmedResponse.status).toBe(200);
    const confirmed = await confirmedResponse.json() as { status: string; redirectUrl: string };
    expect(confirmed.status).toBe('confirmed');
    const callbackUrl = new URL(confirmed.redirectUrl);
    expect(callbackUrl.origin + callbackUrl.pathname).toBe('https://3dugc.com/auth/callback');
    expect(callbackUrl.searchParams.get('state')).toBe('official-qr-state');
    const code = callbackUrl.searchParams.get('code');
    expect(code).toBeTruthy();

    const tokenResponse = await fetch(`${app.baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: '3dugc-web',
        redirect_uri: 'https://3dugc.com/auth/callback',
        code: code || '',
        code_verifier: verifier,
      }),
    });
    expect(tokenResponse.status).toBe(200);
    const tokenSet = await tokenResponse.json() as { access_token: string };
    const userInfoResponse = await fetch(`${app.baseUrl}/userinfo`, {
      headers: { authorization: `Bearer ${tokenSet.access_token}` },
    });
    expect(await userInfoResponse.json()).toMatchObject({
      account_hint: '微信 UnionID 后8位 icial-qr',
      wechat_openid_tail: 'icial-qr',
      wechat_unionid_tail: 'icial-qr',
    });
  });

  it('completes OAuth through a mocked WeChat website callback', async () => {
    const config = createConfig({
      AUTH_PUBLIC_BASE_URL: 'http://127.0.0.1',
      AUTH_ALLOW_MOCK_WECHAT: 'true',
      AUTH_WECHAT_WEBSITE_APP_ID: 'wx-website',
      AUTH_WECHAT_WEBSITE_APP_SECRET: 'website-secret',
      AUTH_TOKEN_SECRET: 'test-secret',
      AUTH_LOGIN_ENTRIES_JSON: JSON.stringify([
        {
          slug: '3dugc',
          clientId: '3dugc-web',
          defaultRedirectUri: 'https://3dugc.com/auth/callback',
          allowedReturnUrlPrefixes: ['https://3dugc.com/'],
          defaultScopes: ['openid', 'profile'],
          provider: 'wechat_website',
          displayName: '3DUGC',
        },
      ]),
    });
    const app = await startApp(config, new MemoryAuthStore());
    const redirectUri = 'https://3dugc.com/auth/callback';
    const verifier = 'website-login-pkce-verifier';
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const loginUrl = new URL(`${app.baseUrl}/login/3dugc`);
    loginUrl.searchParams.set('return_to', 'https://3dugc.com/dashboard');
    loginUrl.searchParams.set('state', 'website-login-state');
    loginUrl.searchParams.set('code_challenge', challenge);
    loginUrl.searchParams.set('code_challenge_method', 'S256');

    const loginLocation = await expectRedirect(loginUrl.toString());
    expect(loginLocation).toContain('/login/wechat/website?state=');
    const mockWechatCallback = await expectRedirect(loginLocation);
    const callbackLocation = await expectRedirect(mockWechatCallback);
    const callbackUrl = new URL(callbackLocation);
    expect(callbackUrl.origin + callbackUrl.pathname).toBe(redirectUri);
    expect(callbackUrl.searchParams.get('state')).toBe('website-login-state');
    expect(callbackUrl.searchParams.get('return_to')).toBe('https://3dugc.com/dashboard');
    const code = callbackUrl.searchParams.get('code');
    expect(code).toBeTruthy();

    const tokenResponse = await fetch(`${app.baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: '3dugc-web',
        redirect_uri: redirectUri,
        code: code || '',
        code_verifier: verifier,
      }),
    });
    expect(tokenResponse.status).toBe(200);
    const tokenSet = await tokenResponse.json() as { access_token: string };
    const userInfoResponse = await fetch(`${app.baseUrl}/userinfo`, {
      headers: { authorization: `Bearer ${tokenSet.access_token}` },
    });
    expect(await userInfoResponse.json()).toMatchObject({ unionid: expect.stringContaining('mock-website-union-') });
  });

  it('rejects unknown login slugs and untrusted return_to URLs before redirecting', async () => {
    const config = createConfig({
      AUTH_PUBLIC_BASE_URL: 'http://127.0.0.1',
      AUTH_ALLOW_MOCK_WECHAT: 'true',
      AUTH_WECHAT_OFFICIAL_APP_ID: 'wx-test',
      AUTH_TOKEN_SECRET: 'test-secret',
    });
    const app = await startApp(config, new MemoryAuthStore());

    const unknownResponse = await fetch(`${app.baseUrl}/login/missing`, { redirect: 'manual' });
    expect(unknownResponse.status).toBe(404);

    for (const returnTo of [
      'https://evil.example/dashboard',
      'https://bujiaban.com:pass@evil.example/dashboard',
      'https://bujiaban.com/dashboard#fragment',
    ]) {
      const externalReturnUrl = new URL(`${app.baseUrl}/login/bujiaban`);
      externalReturnUrl.searchParams.set('return_to', returnTo);
      const externalResponse = await fetch(externalReturnUrl, { redirect: 'manual' });
      expect(externalResponse.status).toBe(400);
      expect(await externalResponse.json()).toMatchObject({ error: 'invalid_request' });
    }
  });
});

async function startApp(config: ReturnType<typeof createConfig>, store: MemoryAuthStore): Promise<StartedApp> {
  const wechat = new WechatClient(config);
  const app = createApp(config, store, wechat);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address() as AddressInfo;
  config.publicBaseUrl = `http://127.0.0.1:${address.port}`;
  const started = {
    baseUrl: config.publicBaseUrl,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
  startedApps.push(started);
  return started;
}

async function expectRedirect(url: string): Promise<string> {
  const response = await fetch(url, { redirect: 'manual' });
  expect(response.status).toBe(302);
  const location = response.headers.get('location');
  expect(location).toBeTruthy();
  return location || '';
}

function createWechatEventXml(token: string, openId: string): string {
  return [
    '<xml>',
    '<ToUserName><![CDATA[gh_test]]></ToUserName>',
    `<FromUserName><![CDATA[${openId}]]></FromUserName>`,
    '<CreateTime>1770000000</CreateTime>',
    '<MsgType><![CDATA[event]]></MsgType>',
    '<Event><![CDATA[SCAN]]></Event>',
    `<EventKey><![CDATA[${token}]]></EventKey>`,
    '</xml>',
  ].join('');
}

function createEncryptedWechatEnvelope(encrypted: string): string {
  return [
    '<xml>',
    `<Encrypt><![CDATA[${encrypted}]]></Encrypt>`,
    '</xml>',
  ].join('');
}

function extractXml(xml: string, tag: string): string | undefined {
  const match = xml.match(new RegExp(`<${tag}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>|<${tag}>([\\s\\S]*?)</${tag}>`));
  return (match?.[1] || match?.[2])?.trim();
}
