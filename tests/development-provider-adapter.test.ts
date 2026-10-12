import express from 'express';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDevelopmentProviderApp, createDevelopmentProviderConfig } from '../src/development-provider-adapter';
import type { DevelopmentWechatRegistry } from '../src/development-wechat-registry';

const appId = 'wx6f81800f15c9a88c', scene = 's'.repeat(43), openId = 'verified-openid';
const identityKey = 'identity-only-'.repeat(4), capabilityKey = 'capability-only-'.repeat(4), callbackKey = 'callback-only-'.repeat(4);
const servers: Array<ReturnType<express.Express['listen']>> = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())))); });
async function listen(app: express.Express) {
  const server = app.listen(0, '127.0.0.1'); servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', resolve)); return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
function config(f = 'https://auth.bujiaban.com', identity = 'http://identity-private:8086', extra: NodeJS.ProcessEnv = {}) {
  return createDevelopmentProviderConfig({ DEVELOPMENT_PROVIDER_APP_ID: appId,
    DEVELOPMENT_PROVIDER_IDENTITY_API_BASE_URL: identity, DEVELOPMENT_PROVIDER_F_API_BASE_URL: f,
    DEVELOPMENT_PROVIDER_IDENTITY_TOKEN: identityKey, DEVELOPMENT_PROVIDER_CAPABILITY_TOKEN: capabilityKey,
    DEVELOPMENT_PROVIDER_RELAY_TOKEN: callbackKey, DEVELOPMENT_PROVIDER_DATABASE_URL: 'mysql://adapter:secret@127.0.0.1:1/xrugc_identity_dev',
    // These deliberately unreachable old sources must never be read by the adapter.
    AUTH_DATABASE_URL: 'mysql://old:secret@127.0.0.1:1/bujiaban', AUTH_REDIS_URL: 'redis://127.0.0.1:1',
    AUTH_WECHAT_OFFICIAL_APP_SECRET: 'never-used', ...extra });
}
function registry(): DevelopmentWechatRegistry {
  return { register: vi.fn(async () => ({ expiresAt: new Date(Date.now() + 60000) })),
    claim: vi.fn(async () => 'deliver' as const), markDelivered: vi.fn(async () => {}),
    canReadProfile: vi.fn(async () => true), close: vi.fn(async () => {}) };
}
function request(url: string, path: string, body: unknown, key = identityKey, header = 'x-identity-internal-token') {
  return fetch(`${url}/internal/wechat-provider/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', [header]: key }, body: JSON.stringify(body) });
}
describe('isolated development WeChat provider adapter', () => {
  it('requires separate scoped keys, exact provider config and a development-only registry', () => {
    expect(config()).toMatchObject({ providerAppId: appId, host: '0.0.0.0', port: 3011 });
    for (const extra of [{ DEVELOPMENT_PROVIDER_IDENTITY_TOKEN: 'short' }, { DEVELOPMENT_PROVIDER_RELAY_TOKEN: capabilityKey },
      { DEVELOPMENT_PROVIDER_F_API_BASE_URL: 'http://public-remote' }, { DEVELOPMENT_PROVIDER_F_API_BASE_URL: 'https://auth.test/path' },
      { DEVELOPMENT_PROVIDER_IDENTITY_API_BASE_URL: 'http://user:pass@identity' }, { DEVELOPMENT_PROVIDER_APP_ID: '' },
      { DEVELOPMENT_PROVIDER_DATABASE_URL: 'mysql://no:no@host/bujiaban' }, { DEVELOPMENT_PROVIDER_TIMEOUT_MS: '0' }]) {
      expect(() => config(undefined, undefined, extra)).toThrow();
    }
  });
  it('exposes only provider operations and authenticates QR/profile separately from relay callbacks', async () => {
    const db = registry(), url = await listen(createDevelopmentProviderApp(config(), db));
    for (const path of ['qrcode', 'profile']) {
      expect((await request(url, path, {}, callbackKey)).status).toBe(401);
      expect((await request(url, path, {}, capabilityKey, 'x-development-provider-token')).status).toBe(401);
    }
    expect((await request(url, 'confirm-scan', { scene, openId, providerAppId: appId })).status).toBe(401);
    expect((await fetch(`${url}/v1/wechat/refresh?token=anything`)).status).toBe(404);
    expect(db.register).not.toHaveBeenCalled(); expect(db.claim).not.toHaveBeenCalled();
  });
  it('registers before QR issuance, preserves remaining original TTL and never contacts a legacy store', async () => {
    const db = registry(), calls: unknown[] = [];
    vi.mocked(db.register).mockResolvedValue({ expiresAt: new Date(Date.now() + 30000) });
    const f = express(); f.use(express.json());
    f.post('/internal/development-wechat/qrcode', (req, res) => {
      expect(db.register).toHaveBeenCalledWith(scene, appId, expect.any(Date), 60);
      expect(req.header('x-development-provider-token')).toBe(capabilityKey); expect(req.header('x-identity-internal-token')).toBeUndefined();
      expect(req.body.scene).toBe(scene); expect(req.body.lifetimeSeconds).toBeLessThanOrEqual(30);
      calls.push(req.body); res.json({ ticket: 'ticket', url: 'https://weixin.test/qr', expire_seconds: req.body.lifetimeSeconds, providerAppId: appId });
    });
    const url = await listen(createDevelopmentProviderApp(config(await listen(f)), db));
    const response = await request(url, 'qrcode', { scene, lifetimeSeconds: 60 });
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ ticket: 'ticket', providerAppId: appId }); expect(calls).toHaveLength(1);
  });
  it.each([{ scene: 'short', lifetimeSeconds: 60 }, { scene, lifetimeSeconds: 518401 }, { scene, lifetimeSeconds: 0 }, { scene, lifetimeSeconds: 1.5 }])('rejects invalid QR input %#', async (body) => {
    const db = registry(), url = await listen(createDevelopmentProviderApp(config(), db));
    expect((await request(url, 'qrcode', body)).status).toBe(400); expect(db.register).not.toHaveBeenCalled();
  });
  it('cannot recreate a QR after its registry expiry', async () => {
    const db = registry(); vi.mocked(db.register).mockResolvedValue({ expiresAt: new Date(Date.now() - 1) });
    const url = await listen(createDevelopmentProviderApp(config(), db));
    expect((await request(url, 'qrcode', { scene, lifetimeSeconds: 60 })).status).toBe(410);
  });
  it('rejects provider AppID confusion or an extended QR expiry', async () => {
    const f = express(); f.use(express.json()); let wrongApp = true;
    f.post('/internal/development-wechat/qrcode', (req, res) => res.json({ ticket: 'ticket', url: 'https://weixin.test',
      expire_seconds: wrongApp ? req.body.lifetimeSeconds : 518400, providerAppId: wrongApp ? 'another-app' : appId }));
    const url = await listen(createDevelopmentProviderApp(config(await listen(f)), registry()));
    expect((await request(url, 'qrcode', { scene, lifetimeSeconds: 60 })).status).toBe(503);
    wrongApp = false; expect((await request(url, 'qrcode', { scene, lifetimeSeconds: 60 })).status).toBe(503);
  });
  it('reads a profile only after a registered scan has claimed that exact identity', async () => {
    const db = registry(); vi.mocked(db.canReadProfile).mockResolvedValue(false);
    const f = express(); f.use(express.json()); const calls = vi.fn();
    f.post('/internal/development-wechat/profile', (req, res) => { calls(); res.json({ openId: req.body.openId, providerAppId: appId }); });
    const url = await listen(createDevelopmentProviderApp(config(await listen(f)), db));
    expect((await request(url, 'profile', { openId })).status).toBe(403); expect(calls).not.toHaveBeenCalled();
    vi.mocked(db.canReadProfile).mockResolvedValue(true);
    expect((await request(url, 'profile', { openId })).status).toBe(200);
    expect(db.canReadProfile).toHaveBeenCalledWith(appId, openId, expect.any(Date));
  });
  it('rejects a mismatched profile identity or AppID from the upstream provider', async () => {
    const f = express(); f.use(express.json());
    f.post('/internal/development-wechat/profile', (_req, res) => res.json({ openId: 'someone-else', providerAppId: appId }));
    const url = await listen(createDevelopmentProviderApp(config(await listen(f)), registry()));
    expect((await request(url, 'profile', { openId })).status).toBe(503);
  });
  it('delivers only a registered same-app scan, and marks completion only after Identity acknowledges', async () => {
    const db = registry(), identity = express(); identity.use(express.json()); const deliveries: unknown[] = [];
    identity.post('/internal/wechat-provider/confirm-scan', (req, res) => {
      expect(req.header('x-identity-internal-token')).toBe(identityKey); expect(req.header('x-development-relay-token')).toBeUndefined();
      expect(db.markDelivered).not.toHaveBeenCalled(); deliveries.push(req.body); res.json({ success: true });
    });
    const url = await listen(createDevelopmentProviderApp(config(undefined, await listen(identity)), db));
    const response = await request(url, 'confirm-scan', { scene, openId, providerAppId: appId }, callbackKey, 'x-development-relay-token');
    expect(response.status).toBe(200); expect(deliveries).toEqual([{ scene, openId, providerAppId: appId }]);
    expect(db.markDelivered).toHaveBeenCalledWith(scene, appId, openId, expect.any(Date));
    vi.mocked(db.claim).mockResolvedValue('delivered');
    expect((await request(url, 'confirm-scan', { scene, openId, providerAppId: appId }, callbackKey, 'x-development-relay-token')).status).toBe(200);
    expect(deliveries).toHaveLength(1);
  });
  it.each([['missing', 404], ['conflict', 409]] as const)('rejects %s callbacks without invoking Identity', async (claim, status) => {
    const db = registry(); vi.mocked(db.claim).mockResolvedValue(claim);
    const url = await listen(createDevelopmentProviderApp(config(), db));
    expect((await request(url, 'confirm-scan', { scene, openId, providerAppId: appId }, callbackKey, 'x-development-relay-token')).status).toBe(status);
    expect(db.markDelivered).not.toHaveBeenCalled();
  });
  it('rejects cross-app or malformed callbacks before changing registry state', async () => {
    const db = registry(), url = await listen(createDevelopmentProviderApp(config(), db));
    for (const body of [{ scene, openId, providerAppId: 'other-app' }, { scene: 'bad', openId, providerAppId: appId }, { scene, openId: '', providerAppId: appId }]) {
      expect((await request(url, 'confirm-scan', body, callbackKey, 'x-development-relay-token')).status).toBe(400);
    }
    expect(db.claim).not.toHaveBeenCalled();
  });
  it('leaves failed deliveries retryable without exposing provider errors or granting fallback', async () => {
    const db = registry(), identity = express(); identity.post('/internal/wechat-provider/confirm-scan', (_req, res) => res.status(500).send('private-details'));
    const url = await listen(createDevelopmentProviderApp(config(undefined, await listen(identity)), db));
    const response = await request(url, 'confirm-scan', { scene, openId, providerAppId: appId }, callbackKey, 'x-development-relay-token');
    expect(response.status).toBe(503); expect(await response.json()).toEqual({ error: 'provider_unavailable' }); expect(db.markDelivered).not.toHaveBeenCalled();
  });
  it('does not follow provider redirects with scoped keys', async () => {
    const f = express(); f.post('/internal/development-wechat/profile', (_req, res) => res.redirect(307, 'https://unexpected.example/collect'));
    const url = await listen(createDevelopmentProviderApp(config(await listen(f)), registry()));
    expect((await request(url, 'profile', { openId })).status).toBe(503);
  });
});
