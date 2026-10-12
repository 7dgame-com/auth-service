import { randomUUID } from 'crypto';
import mysql, { type Connection, type RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MySqlAuthStore } from '../src/mysql-store';
import { sceneDigest } from '../src/legacy-routes';

const options = { host: process.env.IDENTITY_DB_HOST || '127.0.0.1', port: Number(process.env.IDENTITY_DB_PORT || 3306),
  user: process.env.IDENTITY_DB_USER || 'root', password: process.env.IDENTITY_DB_PASSWORD || '', timezone: 'Z' };
const database = `test_auth_metadata_${randomUUID().replaceAll('-', '')}`;
let admin: Connection, db: Connection, store: MySqlAuthStore;
describe.skipIf(process.env.IDENTITY_TEST_MYSQL !== '1')('legacy QR issuance MySQL metadata', () => {
  beforeAll(async () => {
    admin = await mysql.createConnection(options); await admin.query(`CREATE DATABASE ${database}`);
    db = await mysql.createConnection({ ...options, database });
    store = new MySqlAuthStore(`mysql://${encodeURIComponent(options.user)}:${encodeURIComponent(options.password)}@${options.host}:${options.port}/${database}`, { autoMigrate: true });
    await store.migrate();
  });
  afterAll(async () => { await store?.close(); await db?.end(); if (admin) { await admin.query(`DROP DATABASE IF EXISTS ${database}`); await admin.end(); } });
  it('persists UTC issuance without raw scenes or scanned identities and refuses expiry extension', async () => {
    const scene = 'issued-raw-scene', issuedAt = new Date().toISOString(), expiresAt = new Date(Date.now() + 60000).toISOString();
    const metadata = { sceneDigest: sceneDigest(scene), providerAppId: 'wx-exact-app', issuedAt, expiresAt };
    await store.saveLegacySceneMetadata(metadata);
    expect(await store.findLegacySceneMetadata(metadata.sceneDigest)).toEqual(metadata);
    expect(await store.findLegacyScanToken(scene)).toBeUndefined();
    await expect(store.saveLegacySceneMetadata({ ...metadata, expiresAt: new Date(Date.now() + 120000).toISOString() })).rejects.toMatchObject({ code: 'ER_DUP_ENTRY' });
    expect(await store.findLegacySceneMetadata(metadata.sceneDigest)).toEqual(metadata);
    const [rows] = await db.query<RowDataPacket[]>('SELECT * FROM auth_legacy_scene_metadata');
    expect(Object.keys(rows[0]).sort()).toEqual(['expires_at', 'issued_at', 'provider_app_id', 'scene_digest']);
    expect(JSON.stringify(rows)).not.toContain(scene);
  });
  it('stores scan expiry at the issuance boundary rather than at callback time', async () => {
    const scene = 'scanned-scene', issuedAt = new Date(Date.now() - 30000).toISOString(), expiresAt = new Date(Date.now() + 30000).toISOString();
    await store.saveLegacySceneMetadata({ sceneDigest: sceneDigest(scene), providerAppId: 'wx-exact-app', issuedAt, expiresAt });
    await store.saveLegacyScanToken({ token: scene, scene, providerAppId: 'wx-exact-app', openId: 'scanned-openid', createdAt: issuedAt, expiresAt });
    expect(await store.findLegacyScanToken(scene)).toMatchObject({ createdAt: issuedAt, expiresAt, openId: 'scanned-openid' });
  });
});
