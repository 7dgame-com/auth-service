import { createHash } from 'node:crypto';
import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise';

/** A separate development registry: no account, legacy store, or Redis access. */
export interface DevelopmentWechatRegistry {
  register(scene: string, app: string, now: Date, ttlSeconds: number): Promise<{ expiresAt: Date }>;
  claim(scene: string, app: string, openId: string, now: Date): Promise<'deliver' | 'delivered' | 'missing' | 'conflict'>;
  markDelivered(scene: string, app: string, openId: string, now: Date): Promise<void>;
  canReadProfile(app: string, openId: string, now: Date): Promise<boolean>;
  close(): Promise<void>;
}

export class MySqlDevelopmentWechatRegistry implements DevelopmentWechatRegistry {
  private readonly pool: Pool;
  constructor(databaseUrl: string) {
    const url = new URL(databaseUrl);
    const database = decodeURIComponent(url.pathname.slice(1));
    // This process must never be pointed at either production account database.
    if (url.protocol !== 'mysql:' || !/^xrugc_identity_dev(?:_rehearsal_[a-z0-9_]+)?$/.test(database) || url.search || url.hash) {
      throw new Error('Development WeChat registry requires an explicit development Identity database');
    }
    this.pool = mysql.createPool({ host: url.hostname, port: Number(url.port || 3306), database,
      user: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
      timezone: 'Z', connectionLimit: 4, multipleStatements: false });
  }
  async ensureReady(): Promise<void> {
    // Schema installation is a reviewed deployment step, never a runtime side effect.
    await this.pool.query('SELECT scene_hash, provider_app_id, expires_at, openid_hash, delivered_at FROM auth_development_wechat_scenes LIMIT 0');
  }
  async register(scene: string, app: string, now: Date, ttlSeconds: number): Promise<{ expiresAt: Date }> {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.execute(`INSERT INTO auth_development_wechat_scenes
        (scene_hash,provider_app_id,issued_at,expires_at) VALUES (?,?,?,?)
        ON DUPLICATE KEY UPDATE scene_hash=scene_hash`, [digest(scene), app, now, new Date(now.getTime() + ttlSeconds * 1000)]);
      const [rows] = await connection.execute<RowDataPacket[]>(
        'SELECT provider_app_id, expires_at FROM auth_development_wechat_scenes WHERE scene_hash=? FOR UPDATE', [digest(scene)]);
      const row = rows[0];
      if (!row || row.provider_app_id !== app || row.expires_at.getTime() <= now.getTime()) {
        throw new Error('Development WeChat scene cannot be registered');
      }
      await connection.commit();
      return { expiresAt: row.expires_at as Date };
    } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
  }
  async claim(scene: string, app: string, openId: string, now: Date): Promise<'deliver' | 'delivered' | 'missing' | 'conflict'> {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute<RowDataPacket[]>(
        'SELECT provider_app_id,expires_at,openid_hash,delivered_at FROM auth_development_wechat_scenes WHERE scene_hash=? FOR UPDATE', [digest(scene)]);
      const row = rows[0];
      if (!row || row.provider_app_id !== app || row.expires_at.getTime() <= now.getTime()) {
        await connection.rollback(); return 'missing';
      }
      if (row.openid_hash && row.openid_hash !== digest(openId)) { await connection.rollback(); return 'conflict'; }
      await connection.execute('UPDATE auth_development_wechat_scenes SET openid_hash=? WHERE scene_hash=?', [digest(openId), digest(scene)]);
      await connection.commit();
      return row.delivered_at ? 'delivered' : 'deliver';
    } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
  }
  async markDelivered(scene: string, app: string, openId: string, now: Date): Promise<void> {
    await this.pool.execute(`UPDATE auth_development_wechat_scenes SET delivered_at=COALESCE(delivered_at,?)
      WHERE scene_hash=? AND BINARY provider_app_id=BINARY ? AND openid_hash=? AND expires_at>?`, [now, digest(scene), app, digest(openId), now]);
  }
  async canReadProfile(app: string, openId: string, now: Date): Promise<boolean> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(`SELECT scene_hash FROM auth_development_wechat_scenes
      WHERE BINARY provider_app_id=BINARY ? AND openid_hash=? AND expires_at>? LIMIT 1`, [app, digest(openId), now]);
    // The profile is needed during Native confirm, before delivery can be marked complete.
    return rows.length === 1;
  }
  async close(): Promise<void> { await this.pool.end(); }
}

function digest(value: string): string { return createHash('sha256').update(value).digest('hex'); }
