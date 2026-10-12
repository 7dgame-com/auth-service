import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import mysql, { type Connection, type RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MySqlDevelopmentWechatRegistry } from '../src/development-wechat-registry';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createDevelopmentProviderApp, createDevelopmentProviderConfig } from '../src/development-provider-adapter';
import { createConfig } from '../src/config';
import { createApp } from '../src/server';
import { MemoryAuthStore } from '../src/memory-store';
import type { WechatClient } from '../src/wechat-client';
import { createWechatMessageSignature, encryptWechatMessage } from '../src/crypto';

const options = { host: '127.0.0.1', port: Number(process.env.IDENTITY_TEST_MYSQL_PORT || process.env.IDENTITY_DB_PORT || 13316),
  user: process.env.IDENTITY_TEST_MYSQL_USER || 'root', password: process.env.IDENTITY_TEST_MYSQL_PASSWORD || '', timezone: 'Z' };
const database = `xrugc_identity_dev_rehearsal_test_${randomUUID().replaceAll('-', '').slice(0, 24)}`;
let admin: Connection, db: Connection, registry: MySqlDevelopmentWechatRegistry;
const now = new Date(), app = 'wx-exact-app';
describe.skipIf(process.env.IDENTITY_TEST_MYSQL !== '1')('isolated development WeChat registry', () => {
  beforeAll(async () => {
    admin = await mysql.createConnection(options); await admin.query(`CREATE DATABASE ${database}`);
    db = await mysql.createConnection({ ...options, database });
    await db.query(readFileSync(new URL('../deploy/mysql/development-wechat-registry.sql', import.meta.url), 'utf8'));
    registry = new MySqlDevelopmentWechatRegistry(`mysql://${encodeURIComponent(options.user)}:${encodeURIComponent(options.password)}@127.0.0.1:${options.port}/${database}`);
    await registry.ensureReady();
  });
  afterAll(async () => { await registry?.close(); await db?.end(); if (admin) { await admin.query(`DROP DATABASE IF EXISTS ${database}`); await admin.end(); } });
  it('rejects production and ambiguous registry targets before opening a connection', () => {
    for (const name of ['bujiaban', 'bujiaban_development', 'xrugc_identity_prod', '', 'xrugc_identity_dev?multipleStatements=true']) {
      expect(() => new MySqlDevelopmentWechatRegistry(`mysql://never:secret@127.0.0.1:1/${name}`)).toThrow(/development Identity database/);
    }
  });
  it('preserves original UTC expiry on retries and refuses expired scene revival or a different app', async () => {
    const first = await registry.register('original-expiry', app, now, 60);
    expect(await registry.register('original-expiry', app, new Date(now.getTime() + 1000), 600)).toEqual(first);
    await expect(registry.register('original-expiry', 'WX-exact-app', now, 60)).rejects.toThrow();
    await expect(registry.register('original-expiry', app, new Date(now.getTime() + 60001), 60)).rejects.toThrow();
    expect(first.expiresAt.getTime()).toBe(now.getTime() + 60000);
  });
  it('allows one openid under concurrent callbacks, with no raw scene or openid persisted', async () => {
    const scene = 'concurrent-private-scene', ids = ['openid-one', 'openid-two'];
    await registry.register(scene, app, now, 60);
    const results = await Promise.all(ids.map((id) => registry.claim(scene, app, id, now)));
    expect([...results].sort()).toEqual(['conflict', 'deliver']);
    const eligible = await Promise.all(ids.map((id) => registry.canReadProfile(app, id, now)));
    expect(eligible.filter(Boolean)).toHaveLength(1);
    const actual = ids[eligible[0] ? 0 : 1];
    expect(await registry.claim(scene, app, actual, now)).toBe('deliver');
    await registry.markDelivered(scene, app, actual, now);
    expect(await registry.claim(scene, app, actual, now)).toBe('delivered');
    expect(await registry.canReadProfile('WX-exact-app', actual, now)).toBe(false);
    expect(await registry.canReadProfile(app, actual, new Date(now.getTime() + 60000))).toBe(false);
    const [rows] = await db.query<RowDataPacket[]>('SELECT * FROM auth_development_wechat_scenes');
    expect(JSON.stringify(rows)).not.toContain(scene); for (const id of ids) expect(JSON.stringify(rows)).not.toContain(id);
  });
  it('cannot deliver an unknown, expired, or differently scoped scene', async () => {
    expect(await registry.claim('unknown', app, 'openid', now)).toBe('missing');
    await registry.register('scope-bound', app, now, 1);
    expect(await registry.claim('scope-bound', 'other-app', 'openid', now)).toBe('missing');
    expect(await registry.claim('scope-bound', app, 'openid', new Date(now.getTime() + 1000))).toBe('missing');
    await registry.markDelivered('scope-bound', app, 'openid', now);
    expect(await registry.canReadProfile(app, 'openid', now)).toBe(false);
  });
  it('routes an AES scan through F and the real isolated registry into Identity without production store writes', async () => {
    const servers: Array<ReturnType<express.Express['listen']>> = [];
    async function listen(application: express.Express) {
      const server = application.listen(0, '127.0.0.1'); servers.push(server);
      await new Promise<void>((resolve) => server.once('listening', resolve)); return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    }
    try {
      const providerAppId = 'wx6f81800f15c9a88c', scene = 'z'.repeat(43), openId = 'confirmed-dev-user';
      const identityKey = 'identity-scope-'.repeat(4), capabilityKey = 'capability-scope-'.repeat(4), callbackKey = 'callback-scope-'.repeat(4);
      const aesKey = Buffer.alloc(32, 7).toString('base64').slice(0, 43), officialToken = 'real-provider-token-fixture';
      const native = express(); native.use(express.json()); let adapterUrl = '', nativeConfirmations = 0;
      native.post('/internal/wechat-provider/confirm-scan', (req, res, next) => {
        (async () => {
          expect(req.header('x-identity-internal-token')).toBe(identityKey);
          expect(req.body).toEqual({ scene, openId, providerAppId });
          const profile = await fetch(`${adapterUrl}/internal/wechat-provider/profile`, { method: 'POST',
            headers: { 'content-type': 'application/json', 'x-identity-internal-token': identityKey }, body: JSON.stringify({ openId }) });
          expect(profile.status).toBe(200); expect(await profile.json()).toMatchObject({ providerAppId, openId });
          nativeConfirmations++; res.json({ success: true });
        })().catch(next);
      });
      const nativeUrl = await listen(native);
      const adapterConfig = createDevelopmentProviderConfig({ DEVELOPMENT_PROVIDER_APP_ID: providerAppId,
        DEVELOPMENT_PROVIDER_IDENTITY_API_BASE_URL: nativeUrl, DEVELOPMENT_PROVIDER_F_API_BASE_URL: 'http://127.0.0.1:1',
        DEVELOPMENT_PROVIDER_IDENTITY_TOKEN: identityKey, DEVELOPMENT_PROVIDER_CAPABILITY_TOKEN: capabilityKey,
        DEVELOPMENT_PROVIDER_RELAY_TOKEN: callbackKey, DEVELOPMENT_PROVIDER_DATABASE_URL: `mysql://test@127.0.0.1/${database}` });
      adapterUrl = await listen(createDevelopmentProviderApp(adapterConfig, registry));
      const productionStore = new MemoryAuthStore(); let productionReads = 0, productionWrites = 0;
      productionStore.findLegacySceneMetadata = async () => { productionReads++; throw new Error('production read forbidden'); };
      productionStore.saveLegacyScanToken = async () => { productionWrites++; throw new Error('production write forbidden'); };
      let officialScene = '';
      const provider = { createTemporaryQrCode: async (value: string, ttl: number) => { officialScene = value; return { ticket: 'ticket', url: 'https://weixin.test/qr', expire_seconds: ttl }; },
        getOfficialUserInfo: async (id: string) => ({ providerAppId, openId: id, nickname: 'private fixture' }) } as unknown as WechatClient;
      const fConfig = createConfig({ AUTH_WECHAT_OFFICIAL_APP_ID: providerAppId, AUTH_WECHAT_OFFICIAL_APP_SECRET: 'fixture-secret', AUTH_WECHAT_OFFICIAL_TOKEN: officialToken,
        AUTH_WECHAT_OFFICIAL_AES_KEY: aesKey, AUTH_WECHAT_DEVELOPMENT_RELAY_ENABLED: 'true', AUTH_WECHAT_DEVELOPMENT_CAPABILITY_TOKEN: capabilityKey,
        AUTH_WECHAT_DEVELOPMENT_CALLBACK_TOKEN: callbackKey, AUTH_WECHAT_DEVELOPMENT_CALLBACK_BASE_URL: adapterUrl });
      const fUrl = await listen(createApp(fConfig, productionStore, provider)); adapterConfig.fApiBaseUrl = fUrl;
      const qr = await fetch(`${adapterUrl}/internal/wechat-provider/qrcode`, { method: 'POST',
        headers: { 'content-type': 'application/json', 'x-identity-internal-token': identityKey }, body: JSON.stringify({ scene, lifetimeSeconds: 60 }) });
      expect(qr.status).toBe(200); expect(officialScene).toBe(`idvdev_${scene}`);
      const timestamp = String(Math.floor(Date.now() / 1000)), nonce = 'test-nonce';
      const encrypted = encryptWechatMessage(`<xml><FromUserName>${openId}</FromUserName><MsgType>event</MsgType><Event>SCAN</Event><EventKey>${officialScene}</EventKey></xml>`, aesKey, providerAppId);
      const signature = createWechatMessageSignature(officialToken, timestamp, nonce, encrypted);
      const send = () => fetch(`${fUrl}/v1/wechat?${new URLSearchParams({ timestamp, nonce, msg_signature: signature })}`, {
        method: 'POST', headers: { 'content-type': 'application/xml' }, body: `<xml><Encrypt>${encrypted}</Encrypt></xml>` });
      expect((await send()).status).toBe(200); expect((await send()).status).toBe(200);
      expect(nativeConfirmations).toBe(1); expect(productionReads).toBe(0); expect(productionWrites).toBe(0);
      expect(await registry.claim(scene, providerAppId, 'another-openid', new Date())).toBe('conflict');
    } finally { await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve())))); }
  });
});
