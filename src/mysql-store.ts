import mysql from 'mysql2/promise';
import type { FieldPacket, Pool, PoolOptions, QueryResult, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { randomUUID } from 'crypto';
import type { RedisConfig } from './config';
import type {
  AuthIdentity,
  AuthIdentityProvider,
  AuthUser,
  LegacyLoginToken,
  LegacyScanToken,
  LegacyWechatLoginResult,
  OAuthAuthorizationCode,
  OAuthRefreshToken,
  UpsertIdentityResult,
  WechatProfile,
} from './types';
import type { AuthStore } from './store';
import { randomToken } from './crypto';
import { LegacyRedisOpenIdStore } from './legacy-redis';

interface MySqlQueryable {
  execute<T extends QueryResult = RowDataPacket[]>(sql: string, values?: any): Promise<[T, FieldPacket[]]>;
}

export interface MySqlAuthStoreOptions {
  autoMigrate?: boolean;
  legacyRedis?: RedisConfig;
}

interface UserRow extends RowDataPacket {
  id: string;
  primary_unionid: string | null;
  display_name: string | null;
  avatar_url: string | null;
  status: 'active' | 'disabled';
  created_at: string | Date;
  updated_at: string | Date;
}

interface IdentityRow extends RowDataPacket {
  id: string;
  user_id: string;
  provider: AuthIdentityProvider;
  provider_app_id: string;
  openid: string;
  unionid: string | null;
  profile_json: string | Record<string, unknown> | null;
  created_at: string | Date;
  updated_at: string | Date;
}

interface LegacyScanTokenRow extends RowDataPacket {
  token: string;
  provider_app_id: string;
  openid: string;
  scene: string | null;
  expires_at: string | Date;
  consumed_at: string | Date | null;
  created_at: string | Date;
}

interface LegacyWechatRow extends RowDataPacket {
  id: number;
  openid: string;
  unionid: string | null;
  user_id: number | null;
  token: string | null;
  created_at: string | Date | null;
  updated_at: string | Date | null;
}

interface OAuthAuthorizationCodeRow extends RowDataPacket {
  code_hash: string;
  client_id: string;
  user_id: string;
  redirect_uri: string;
  code_challenge: string | null;
  code_challenge_method: 'plain' | 'S256' | null;
  scopes_json: string | string[];
  expires_at: string | Date;
  consumed_at: string | Date | null;
  created_at: string | Date;
}

interface OAuthRefreshTokenRow extends RowDataPacket {
  token_hash: string;
  client_id: string;
  user_id: string;
  scopes_json: string | string[];
  expires_at: string | Date;
  revoked_at: string | Date | null;
  created_at: string | Date;
}

export class MySqlAuthStore implements AuthStore {
  private migrationPromise: Promise<void> | undefined;
  private readonly autoMigrate: boolean;
  private readonly legacyRedis?: LegacyRedisOpenIdStore;
  private readonly pool: Pool;

  constructor(databaseUrl: string, options: MySqlAuthStoreOptions = {}) {
    this.autoMigrate = options.autoMigrate ?? true;
    this.legacyRedis = options.legacyRedis ? new LegacyRedisOpenIdStore(options.legacyRedis) : undefined;
    this.pool = mysql.createPool(createPoolOptions(databaseUrl));
  }

  async migrate(): Promise<void> {
    if (!this.migrationPromise) this.migrationPromise = runMigrations(this.pool);
    return this.migrationPromise;
  }

  async saveLegacyScanToken(token: LegacyScanToken): Promise<void> {
    if (this.legacyRedis) {
      await this.legacyRedis.saveOpenId(token.token, token.openId);
      return;
    }

    await this.ensureSchema();
    await this.pool.execute(
      `
        INSERT INTO auth_legacy_scan_tokens
          (token, provider_app_id, openid, scene, expires_at, consumed_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          provider_app_id = VALUES(provider_app_id),
          openid = VALUES(openid),
          scene = VALUES(scene),
          expires_at = VALUES(expires_at),
          consumed_at = NULL
      `,
      [
        token.token,
        token.providerAppId,
        token.openId,
        token.scene || null,
        mysqlDateTime(token.expiresAt),
        mysqlDateTime(token.consumedAt),
        mysqlDateTime(token.createdAt),
      ]
    );
  }

  async findLegacyScanToken(token: string): Promise<LegacyScanToken | undefined> {
    if (this.legacyRedis) {
      const openId = await this.legacyRedis.findOpenId(token);
      if (!openId) return undefined;
      const now = new Date().toISOString();
      return {
        token,
        providerAppId: 'legacy-redis',
        openId,
        expiresAt: '9999-12-31T23:59:59.999Z',
        createdAt: now,
      };
    }

    await this.ensureSchema();
    const [rows] = await this.pool.execute<LegacyScanTokenRow[]>(
      `
        SELECT * FROM auth_legacy_scan_tokens
        WHERE token = ? AND consumed_at IS NULL AND expires_at > UTC_TIMESTAMP(3)
        LIMIT 1
      `,
      [token]
    );
    return rows[0] ? scanTokenFromRow(rows[0]) : undefined;
  }

  async upsertWechatIdentity(profile: WechatProfile): Promise<UpsertIdentityResult> {
    await this.ensureSchema();
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const existingIdentity = await findIdentity(connection, profile.provider, profile.providerAppId, profile.openId);
      const now = new Date().toISOString();

      if (existingIdentity) {
        const existingUser = await findUserById(connection, existingIdentity.userId);
        if (!existingUser) throw new Error(`Auth user ${existingIdentity.userId} is missing`);
        const user = mergeUserProfile(existingUser, profile, now);
        const identity: AuthIdentity = {
          ...existingIdentity,
          unionId: profile.unionId || existingIdentity.unionId,
          profile: profile.raw || existingIdentity.profile,
          updatedAt: now,
        };
        await upsertUser(connection, user);
        await upsertIdentity(connection, identity);
        await connection.commit();
        return { user, identity, isNewIdentity: false };
      }

      const matchedUser = profile.unionId ? await findUserByUnionId(connection, profile.unionId) : undefined;
      const user = mergeUserProfile(matchedUser || createUser(profile, now), profile, now);
      const identity: AuthIdentity = {
        id: randomUUID(),
        userId: user.id,
        provider: profile.provider,
        providerAppId: profile.providerAppId,
        openId: profile.openId,
        unionId: profile.unionId,
        profile: profile.raw,
        createdAt: now,
        updatedAt: now,
      };
      await upsertUser(connection, user);
      await upsertIdentity(connection, identity);
      await connection.commit();
      return { user, identity, isNewIdentity: true };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async completeLegacyWechatLogin(profile: WechatProfile): Promise<LegacyWechatLoginResult> {
    await this.ensureSchema();
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute<LegacyWechatRow[]>(
        'SELECT * FROM wechat WHERE openid = ? LIMIT 1 FOR UPDATE',
        [profile.openId]
      );
      const token = randomToken(32);
      const now = mysqlDateTime(new Date());
      const existing = rows[0];

      if (existing) {
        await connection.execute<ResultSetHeader>(
          `
            UPDATE wechat
            SET
              token = ?,
              unionid = COALESCE(unionid, ?),
              updated_at = ?
            WHERE id = ?
          `,
          [token, profile.unionId || null, now, existing.id]
        );
        await connection.commit();
        return {
          openId: existing.openid,
          unionId: existing.unionid || profile.unionId || undefined,
          userId: existing.user_id == null ? undefined : String(existing.user_id),
          token,
          isRegistered: existing.user_id != null,
        };
      }

      await connection.execute<ResultSetHeader>(
        `
          INSERT INTO wechat
            (openid, unionid, user_id, token, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `,
        [profile.openId, profile.unionId || null, null, token, now, now]
      );
      await connection.commit();
      return {
        openId: profile.openId,
        unionId: profile.unionId,
        token,
        isRegistered: false,
      };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async createLegacyLoginToken(token: LegacyLoginToken): Promise<void> {
    await this.ensureSchema();
    await this.pool.execute(
      `
        INSERT INTO auth_legacy_login_tokens
          (token_hash, user_id, provider_app_id, openid, unionid, expires_at, revoked_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        token.tokenHash,
        token.userId,
        token.providerAppId,
        token.openId,
        token.unionId || null,
        mysqlDateTime(token.expiresAt),
        mysqlDateTime(token.revokedAt),
        mysqlDateTime(token.createdAt),
      ]
    );
  }

  async createAuthorizationCode(code: OAuthAuthorizationCode): Promise<void> {
    await this.ensureSchema();
    await this.pool.execute(
      `
        INSERT INTO auth_oauth_authorization_codes
          (code_hash, client_id, user_id, redirect_uri, code_challenge, code_challenge_method, scopes_json, expires_at, consumed_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, CAST(? AS JSON), ?, ?, ?)
      `,
      [
        code.codeHash,
        code.clientId,
        code.userId,
        code.redirectUri,
        code.codeChallenge || null,
        code.codeChallengeMethod || null,
        JSON.stringify(code.scopes),
        mysqlDateTime(code.expiresAt),
        mysqlDateTime(code.consumedAt),
        mysqlDateTime(code.createdAt),
      ]
    );
  }

  async consumeAuthorizationCode(codeHash: string): Promise<OAuthAuthorizationCode | undefined> {
    await this.ensureSchema();
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute<OAuthAuthorizationCodeRow[]>(
        `
          SELECT * FROM auth_oauth_authorization_codes
          WHERE code_hash = ? AND consumed_at IS NULL AND expires_at > UTC_TIMESTAMP(3)
          FOR UPDATE
        `,
        [codeHash]
      );
      const code = rows[0] ? authorizationCodeFromRow(rows[0]) : undefined;
      if (!code) {
        await connection.commit();
        return undefined;
      }
      await connection.execute('UPDATE auth_oauth_authorization_codes SET consumed_at = UTC_TIMESTAMP(3) WHERE code_hash = ?', [codeHash]);
      await connection.commit();
      return code;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async createRefreshToken(token: OAuthRefreshToken): Promise<void> {
    await this.ensureSchema();
    await this.pool.execute(
      `
        INSERT INTO auth_oauth_refresh_tokens
          (token_hash, client_id, user_id, scopes_json, expires_at, revoked_at, created_at)
        VALUES (?, ?, ?, CAST(? AS JSON), ?, ?, ?)
      `,
      [
        token.tokenHash,
        token.clientId,
        token.userId,
        JSON.stringify(token.scopes),
        mysqlDateTime(token.expiresAt),
        mysqlDateTime(token.revokedAt),
        mysqlDateTime(token.createdAt),
      ]
    );
  }

  async findRefreshToken(tokenHash: string): Promise<OAuthRefreshToken | undefined> {
    await this.ensureSchema();
    const [rows] = await this.pool.execute<OAuthRefreshTokenRow[]>(
      `
        SELECT * FROM auth_oauth_refresh_tokens
        WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > UTC_TIMESTAMP(3)
        LIMIT 1
      `,
      [tokenHash]
    );
    return rows[0] ? refreshTokenFromRow(rows[0]) : undefined;
  }

  async revokeRefreshToken(tokenHash: string): Promise<void> {
    await this.ensureSchema();
    await this.pool.execute('UPDATE auth_oauth_refresh_tokens SET revoked_at = UTC_TIMESTAMP(3) WHERE token_hash = ?', [tokenHash]);
  }

  async findUserById(userId: string): Promise<AuthUser | undefined> {
    await this.ensureSchema();
    return findUserById(this.pool, userId);
  }

  async findPrimaryWechatIdentity(userId: string): Promise<AuthIdentity | undefined> {
    await this.ensureSchema();
    const [rows] = await this.pool.execute<IdentityRow[]>(
      `
        SELECT * FROM auth_identities
        WHERE user_id = ?
        ORDER BY updated_at DESC
        LIMIT 1
      `,
      [userId]
    );
    return rows[0] ? identityFromRow(rows[0]) : undefined;
  }

  private async ensureSchema(): Promise<void> {
    if (this.autoMigrate) await this.migrate();
  }
}

export function mysqlDateTime(value: string | Date | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const pad = (part: number, size = 2) => String(part).padStart(size, '0');
  return [
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`,
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}.${pad(date.getUTCMilliseconds(), 3)}`,
  ].join(' ');
}

function createPoolOptions(databaseUrl: string): PoolOptions {
  const url = new URL(databaseUrl);
  if (url.protocol !== 'mysql:' && url.protocol !== 'mysql2:') {
    throw new Error(`Unsupported MySQL AUTH_DATABASE_URL protocol: ${url.protocol}`);
  }
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.replace(/^\//, '')),
    charset: 'utf8mb4',
    dateStrings: true,
    supportBigNumbers: true,
    waitForConnections: true,
    connectionLimit: 10,
    ssl: url.searchParams.get('ssl') === 'true'
      ? { rejectUnauthorized: url.searchParams.get('sslRejectUnauthorized') !== 'false' }
      : undefined,
  };
}

async function runMigrations(client: MySqlQueryable): Promise<void> {
  await client.execute(`
    CREATE TABLE IF NOT EXISTS wechat (
      id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      openid VARCHAR(255) NOT NULL,
      unionid VARCHAR(255),
      user_id INT,
      token VARCHAR(255),
      created_at DATETIME,
      updated_at DATETIME,
      UNIQUE KEY wechat_openid_idx (openid),
      UNIQUE KEY wechat_unionid_idx (unionid),
      UNIQUE KEY wechat_token_idx (token),
      KEY idx_wechat_user_id (user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS auth_users (
      id VARCHAR(128) PRIMARY KEY,
      primary_unionid VARCHAR(191),
      display_name VARCHAR(191),
      avatar_url TEXT,
      status VARCHAR(32) NOT NULL DEFAULT 'active',
      created_at DATETIME(3) NOT NULL,
      updated_at DATETIME(3) NOT NULL,
      UNIQUE KEY auth_users_primary_unionid_idx (primary_unionid),
      KEY auth_users_status_idx (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS auth_identities (
      id VARCHAR(128) PRIMARY KEY,
      user_id VARCHAR(128) NOT NULL,
      provider VARCHAR(64) NOT NULL,
      provider_app_id VARCHAR(191) NOT NULL,
      openid VARCHAR(191) NOT NULL,
      unionid VARCHAR(191),
      profile_json JSON,
      created_at DATETIME(3) NOT NULL,
      updated_at DATETIME(3) NOT NULL,
      UNIQUE KEY auth_identities_provider_openid_idx (provider, provider_app_id, openid),
      KEY auth_identities_user_idx (user_id),
      KEY auth_identities_unionid_idx (unionid)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS auth_legacy_scan_tokens (
      token VARCHAR(191) PRIMARY KEY,
      provider_app_id VARCHAR(191) NOT NULL,
      openid VARCHAR(191) NOT NULL,
      scene VARCHAR(191),
      expires_at DATETIME(3) NOT NULL,
      consumed_at DATETIME(3),
      created_at DATETIME(3) NOT NULL,
      KEY auth_legacy_scan_tokens_openid_idx (openid),
      KEY auth_legacy_scan_tokens_expiry_idx (expires_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS auth_legacy_login_tokens (
      token_hash VARCHAR(191) PRIMARY KEY,
      user_id VARCHAR(128) NOT NULL,
      provider_app_id VARCHAR(191) NOT NULL,
      openid VARCHAR(191) NOT NULL,
      unionid VARCHAR(191),
      expires_at DATETIME(3) NOT NULL,
      revoked_at DATETIME(3),
      created_at DATETIME(3) NOT NULL,
      KEY auth_legacy_login_tokens_user_idx (user_id),
      KEY auth_legacy_login_tokens_openid_idx (openid)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS auth_oauth_authorization_codes (
      code_hash VARCHAR(191) PRIMARY KEY,
      client_id VARCHAR(128) NOT NULL,
      user_id VARCHAR(128) NOT NULL,
      redirect_uri TEXT NOT NULL,
      code_challenge VARCHAR(191),
      code_challenge_method VARCHAR(16),
      scopes_json JSON NOT NULL,
      expires_at DATETIME(3) NOT NULL,
      consumed_at DATETIME(3),
      created_at DATETIME(3) NOT NULL,
      KEY auth_oauth_codes_client_idx (client_id),
      KEY auth_oauth_codes_user_idx (user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS auth_oauth_refresh_tokens (
      token_hash VARCHAR(191) PRIMARY KEY,
      client_id VARCHAR(128) NOT NULL,
      user_id VARCHAR(128) NOT NULL,
      scopes_json JSON NOT NULL,
      expires_at DATETIME(3) NOT NULL,
      revoked_at DATETIME(3),
      created_at DATETIME(3) NOT NULL,
      KEY auth_refresh_tokens_client_user_idx (client_id, user_id),
      KEY auth_refresh_tokens_expiry_idx (expires_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

async function findIdentity(
  client: MySqlQueryable,
  provider: AuthIdentityProvider,
  providerAppId: string,
  openId: string
): Promise<AuthIdentity | undefined> {
  const [rows] = await client.execute<IdentityRow[]>(
    'SELECT * FROM auth_identities WHERE provider = ? AND provider_app_id = ? AND openid = ? LIMIT 1',
    [provider, providerAppId, openId]
  );
  return rows[0] ? identityFromRow(rows[0]) : undefined;
}

async function findUserById(client: MySqlQueryable, userId: string): Promise<AuthUser | undefined> {
  const [rows] = await client.execute<UserRow[]>('SELECT * FROM auth_users WHERE id = ? LIMIT 1', [userId]);
  return rows[0] ? userFromRow(rows[0]) : undefined;
}

async function findUserByUnionId(client: MySqlQueryable, unionId: string): Promise<AuthUser | undefined> {
  const [rows] = await client.execute<UserRow[]>('SELECT * FROM auth_users WHERE primary_unionid = ? LIMIT 1', [unionId]);
  return rows[0] ? userFromRow(rows[0]) : undefined;
}

async function upsertUser(client: MySqlQueryable, user: AuthUser): Promise<void> {
  await client.execute<ResultSetHeader>(
    `
      INSERT INTO auth_users
        (id, primary_unionid, display_name, avatar_url, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        primary_unionid = COALESCE(auth_users.primary_unionid, VALUES(primary_unionid)),
        display_name = COALESCE(VALUES(display_name), auth_users.display_name),
        avatar_url = COALESCE(VALUES(avatar_url), auth_users.avatar_url),
        status = VALUES(status),
        updated_at = VALUES(updated_at)
    `,
    [
      user.id,
      user.primaryUnionId || null,
      user.displayName || null,
      user.avatarUrl || null,
      user.status,
      mysqlDateTime(user.createdAt),
      mysqlDateTime(user.updatedAt),
    ]
  );
}

async function upsertIdentity(client: MySqlQueryable, identity: AuthIdentity): Promise<void> {
  await client.execute<ResultSetHeader>(
    `
      INSERT INTO auth_identities
        (id, user_id, provider, provider_app_id, openid, unionid, profile_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, CAST(? AS JSON), ?, ?)
      ON DUPLICATE KEY UPDATE
        user_id = VALUES(user_id),
        unionid = COALESCE(VALUES(unionid), auth_identities.unionid),
        profile_json = COALESCE(VALUES(profile_json), auth_identities.profile_json),
        updated_at = VALUES(updated_at)
    `,
    [
      identity.id,
      identity.userId,
      identity.provider,
      identity.providerAppId,
      identity.openId,
      identity.unionId || null,
      JSON.stringify(identity.profile || {}),
      mysqlDateTime(identity.createdAt),
      mysqlDateTime(identity.updatedAt),
    ]
  );
}

function userFromRow(row: UserRow): AuthUser {
  return {
    id: row.id,
    primaryUnionId: row.primary_unionid || undefined,
    displayName: row.display_name || undefined,
    avatarUrl: row.avatar_url || undefined,
    status: row.status,
    createdAt: dateFromRow(row.created_at),
    updatedAt: dateFromRow(row.updated_at),
  };
}

function identityFromRow(row: IdentityRow): AuthIdentity {
  return {
    id: row.id,
    userId: row.user_id,
    provider: row.provider,
    providerAppId: row.provider_app_id,
    openId: row.openid,
    unionId: row.unionid || undefined,
    profile: parseJson(row.profile_json),
    createdAt: dateFromRow(row.created_at),
    updatedAt: dateFromRow(row.updated_at),
  };
}

function scanTokenFromRow(row: LegacyScanTokenRow): LegacyScanToken {
  return {
    token: row.token,
    providerAppId: row.provider_app_id,
    openId: row.openid,
    scene: row.scene || undefined,
    expiresAt: dateFromRow(row.expires_at),
    consumedAt: row.consumed_at ? dateFromRow(row.consumed_at) : undefined,
    createdAt: dateFromRow(row.created_at),
  };
}

function authorizationCodeFromRow(row: OAuthAuthorizationCodeRow): OAuthAuthorizationCode {
  return {
    codeHash: row.code_hash,
    clientId: row.client_id,
    userId: row.user_id,
    redirectUri: row.redirect_uri,
    codeChallenge: row.code_challenge || undefined,
    codeChallengeMethod: row.code_challenge_method || undefined,
    scopes: parseStringArray(row.scopes_json),
    expiresAt: dateFromRow(row.expires_at),
    consumedAt: row.consumed_at ? dateFromRow(row.consumed_at) : undefined,
    createdAt: dateFromRow(row.created_at),
  };
}

function refreshTokenFromRow(row: OAuthRefreshTokenRow): OAuthRefreshToken {
  return {
    tokenHash: row.token_hash,
    clientId: row.client_id,
    userId: row.user_id,
    scopes: parseStringArray(row.scopes_json),
    expiresAt: dateFromRow(row.expires_at),
    revokedAt: row.revoked_at ? dateFromRow(row.revoked_at) : undefined,
    createdAt: dateFromRow(row.created_at),
  };
}

function createUser(profile: WechatProfile, now: string): AuthUser {
  return {
    id: randomUUID(),
    primaryUnionId: profile.unionId,
    displayName: profile.nickname,
    avatarUrl: profile.avatarUrl,
    status: 'active',
    createdAt: now,
    updatedAt: now,
  };
}

function mergeUserProfile(user: AuthUser, profile: WechatProfile, now: string): AuthUser {
  return {
    ...user,
    primaryUnionId: user.primaryUnionId || profile.unionId,
    displayName: profile.nickname || user.displayName,
    avatarUrl: profile.avatarUrl || user.avatarUrl,
    updatedAt: now,
  };
}

function parseStringArray(value: string | string[]): string[] {
  if (Array.isArray(value)) return value;
  const parsed = JSON.parse(value) as unknown;
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
}

function parseJson(value: string | Record<string, unknown> | null): Record<string, unknown> | undefined {
  if (!value) return undefined;
  if (typeof value !== 'string') return value;
  return JSON.parse(value) as Record<string, unknown>;
}

function dateFromRow(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(`${value}Z`).toISOString();
}
