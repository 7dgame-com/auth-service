import express from 'express';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createConfig } from '../src/config';
import { createApp } from '../src/server';
import { MemoryAuthStore } from '../src/memory-store';
import type { WechatClient } from '../src/wechat-client';
import { createWechatMessageSignature, encryptWechatMessage, verifyWechatSignature } from '../src/crypto';

const appId = 'wx-reviewed-development-provider';
const aes = randomBytes(32).toString('base64').slice(0, 43);
const capability = 'capability-only-'.repeat(4), callback = 'callback-only-'.repeat(4);
const scene = 'n'.repeat(43), openId = 'openid-development';
const servers: Array<ReturnType<express.Express['listen']>> = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())))); });
async function listen(app: express.Express) {
  const server = app.listen(0, '127.0.0.1'); servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
function config(target = 'https://dev-provider.example', extra: NodeJS.ProcessEnv = {}) {
  return createConfig({ AUTH_WECHAT_OFFICIAL_APP_ID: appId, AUTH_WECHAT_OFFICIAL_APP_SECRET: 'provider-secret',
    AUTH_WECHAT_OFFICIAL_TOKEN: 'existing-provider-token', AUTH_WECHAT_OFFICIAL_AES_KEY: aes,
    AUTH_WECHAT_DEVELOPMENT_RELAY_ENABLED: 'true', AUTH_WECHAT_DEVELOPMENT_CAPABILITY_TOKEN: capability,
    AUTH_WECHAT_DEVELOPMENT_CALLBACK_TOKEN: callback, AUTH_WECHAT_DEVELOPMENT_CALLBACK_BASE_URL: target, ...extra });
}
function provider() {
  const createTemporaryQrCode = vi.fn(async (_scene: string, ttl: number) => ({ ticket: 'ticket', url: 'https://weixin.test/qr', expire_seconds: ttl }));
  const getOfficialUserInfo = vi.fn(async (id: string) => ({ providerAppId: appId, openId: id }));
  return { client: { createTemporaryQrCode, getOfficialUserInfo } as unknown as WechatClient, createTemporaryQrCode, getOfficialUserInfo };
}
function xml(token: string, id = openId) {
  return `<xml><ToUserName>official</ToUserName><FromUserName>${id}</FromUserName><MsgType>event</MsgType><Event>SCAN</Event><EventKey>${token}</EventKey></xml>`;
}
function encryptedRequest(token: string, options: { app?: string; seconds?: number; signature?: string; id?: string } = {}) {
  const timestamp = String(options.seconds ?? Math.floor(Date.now() / 1000)), nonce = 'nonce-test';
  const encrypted = encryptWechatMessage(xml(token, options.id), aes, options.app ?? appId);
  const signature = options.signature ?? createWechatMessageSignature('existing-provider-token', timestamp, nonce, encrypted);
  return { query: new URLSearchParams({ timestamp, nonce, msg_signature: signature, encrypt_type: 'aes' }),
    body: `<xml><Encrypt><![CDATA[${encrypted}]]></Encrypt></xml>` };
}
async function postCallback(url: string, request: ReturnType<typeof encryptedRequest>) {
  return fetch(`${url}/v1/wechat?${request.query}`, { method: 'POST', headers: { 'content-type': 'application/xml' }, body: request.body });
}

describe('default-off development WeChat relay', () => {
  it('does not enable without AES, signature, distinct keys, or a fixed secure callback origin', () => {
    expect(config().developmentWechatRelay).toMatchObject({ providerAppId: appId });
    for (const extra of [
      { AUTH_WECHAT_OFFICIAL_AES_KEY: '' }, { AUTH_WECHAT_OFFICIAL_APP_SECRET: '' }, { AUTH_WECHAT_SIGNATURE_REQUIRED: 'false' },
      { AUTH_ALLOW_MOCK_WECHAT: 'true' }, { AUTH_WECHAT_DEVELOPMENT_CAPABILITY_TOKEN: 'short' },
      { AUTH_WECHAT_DEVELOPMENT_CALLBACK_TOKEN: capability },
      { AUTH_WECHAT_OFFICIAL_APP_SECRET: capability },
      { AUTH_WECHAT_DEVELOPMENT_CALLBACK_BASE_URL: 'http://remote.example' },
      { AUTH_WECHAT_DEVELOPMENT_CALLBACK_BASE_URL: 'https://dev.example/path' },
    ]) expect(() => config(undefined, extra)).toThrow();
    expect(createConfig({ AUTH_WECHAT_OFFICIAL_TOKEN: 'existing-token' }).developmentWechatRelay).toBeUndefined();
  });
  it('exposes no capability route by default and reserves development scenes without legacy reads/writes', async () => {
    const store = new MemoryAuthStore(), client = provider();
    const read = vi.spyOn(store, 'findLegacyScanToken'), write = vi.spyOn(store, 'saveLegacyScanToken');
    const url = await listen(createApp(createConfig(), store, client.client));
    expect((await fetch(`${url}/internal/development-wechat/qrcode`, { method: 'POST' })).status).toBe(404);
    const response = await fetch(`${url}/v1/wechat`, { method: 'POST', headers: { 'content-type': 'application/xml' }, body: xml(`idvdev_${scene}`) });
    expect(response.status).toBe(200); expect(read).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
  });
  it('scopes QR/profile capabilities to their own key and creates only the reserved scene namespace', async () => {
    const store = new MemoryAuthStore(), client = provider();
    const url = await listen(createApp(config(), store, client.client));
    const request = (token: string, body: unknown, path = 'qrcode') => fetch(`${url}/internal/development-wechat/${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-development-provider-token': token }, body: JSON.stringify(body) });
    expect((await request(callback, { scene, lifetimeSeconds: 60 })).status).toBe(401);
    expect((await request(capability, { scene, lifetimeSeconds: 60 })).status).toBe(200);
    expect(client.createTemporaryQrCode).toHaveBeenCalledWith(`idvdev_${scene}`, 60);
    for (const body of [{ scene: 'short', lifetimeSeconds: 60 }, { scene, lifetimeSeconds: 518401 }, { scene, lifetimeSeconds: 1.5 }]) {
      expect((await request(capability, body)).status).toBe(400);
    }
    expect((await request(capability, { openId }, 'profile')).status).toBe(200);
    expect(client.getOfficialUserInfo).toHaveBeenCalledWith(openId);
    expect(await store.findLegacyScanToken(`idvdev_${scene}`)).toBeUndefined();
  });
  it('relays only authenticated AES dev events to the fixed adapter without any legacy access', async () => {
    const target = express(); target.use(express.json());
    const deliveries: unknown[] = [];
    target.post('/internal/wechat-provider/confirm-scan', (req, res) => {
      expect(req.header('x-development-relay-token')).toBe(callback); expect(req.header('x-identity-internal-token')).toBeUndefined();
      deliveries.push(req.body); res.json({ success: true });
    });
    const targetUrl = await listen(target), store = new MemoryAuthStore(), client = provider();
    const read = vi.spyOn(store, 'findLegacyScanToken'), write = vi.spyOn(store, 'saveLegacyScanToken');
    const url = await listen(createApp(config(targetUrl), store, client.client));
    expect((await postCallback(url, encryptedRequest(`idvdev_${scene}`))).status).toBe(200);
    expect(deliveries).toEqual([{ scene, openId, providerAppId: appId }]);
    expect(read).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
    for (const options of [{ signature: 'wrong' }, { app: 'another-app' }, { app: '' }]) {
      expect((await postCallback(url, encryptedRequest(`idvdev_${scene}`, options))).status).toBeGreaterThanOrEqual(400);
    }
    await postCallback(url, encryptedRequest(`idvdev_${scene}`, { seconds: Math.floor(Date.now() / 1000) - 301 }));
    await postCallback(url, encryptedRequest('idvdev_invalid'));
    expect(deliveries).toHaveLength(1);
    expect(read).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
  });
  it.each(['', 'different-app'])('rejects encrypted missing/wrong AppID %j before any legacy production write', async (wrongApp) => {
    const store = new MemoryAuthStore(), client = provider();
    const write = vi.spyOn(store, 'saveLegacyScanToken');
    const url = await listen(createApp(config(), store, client.client));
    expect((await postCallback(url, encryptedRequest('ordinary-production-scene', { app: wrongApp }))).status).toBe(400);
    expect(write).not.toHaveBeenCalled();
  });
  it('never trusts a forged forwarded IP or query-only signature to authenticate plaintext dev XML', async () => {
    const target = express(); const delivery = vi.fn(); target.post('/internal/wechat-provider/confirm-scan', (_req, res) => { delivery(); res.json({}); });
    const targetUrl = await listen(target), store = new MemoryAuthStore(), client = provider();
    const save = vi.spyOn(store, 'saveLegacyScanToken'); const url = await listen(createApp(config(targetUrl), store, client.client));
    const timestamp = String(Math.floor(Date.now() / 1000)), nonce = 'query-nonce';
    // A valid old query signature deliberately authenticates no XML body.
    const crypto = await import('node:crypto');
    const signature = crypto.createHash('sha1').update(['existing-provider-token', timestamp, nonce].sort().join('')).digest('hex');
    expect(verifyWechatSignature('existing-provider-token', signature, timestamp, nonce)).toBe(true);
    const response = await fetch(`${url}/v1/wechat?${new URLSearchParams({ timestamp, nonce, signature })}`, {
      method: 'POST', headers: { 'content-type': 'application/xml', 'x-forwarded-for': '101.226.62.77' }, body: xml(`idvdev_${scene}`) });
    expect(response.status).toBe(200); expect(delivery).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled();
  });
  it('keeps ordinary production scenes on their existing store path', async () => {
    const store = new MemoryAuthStore(), client = provider();
    const url = await listen(createApp(config(), store, client.client));
    expect((await postCallback(url, encryptedRequest('ordinary-production-scene'))).status).toBe(200);
    expect(await store.findLegacyScanToken('ordinary-production-scene')).toMatchObject({ openId, providerAppId: appId });
  });
  it('fails closed on adapter failure and does not log or expose its response body', async () => {
    const target = express(); target.post('/internal/wechat-provider/confirm-scan', (_req, res) => res.status(500).send('sensitive-openid'));
    const targetUrl = await listen(target), store = new MemoryAuthStore(), client = provider();
    const url = await listen(createApp(config(targetUrl), store, client.client));
    const response = await postCallback(url, encryptedRequest(`idvdev_${scene}`));
    expect(response.status).toBe(503); expect(await response.json()).toEqual({ error: 'development_relay_unavailable' });
    expect(await store.findLegacyScanToken(`idvdev_${scene}`)).toBeUndefined();
  });
});
