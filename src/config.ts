import fs from 'fs';
import { randomBytes } from 'crypto';
import type { AuthIdentityProvider, LoginEntry, OAuthClient } from './types';

// Development instances need a signing secret too, but it must not be a
// repository-known value that could accidentally be promoted to production.
const ephemeralDevelopmentTokenSecret = randomBytes(32).toString('hex');

export interface WechatConfig {
  officialAppId?: string;
  officialAppSecret?: string;
  officialToken?: string;
  officialEncodingAesKey?: string;
  apiBaseUrl: string;
  oauthBaseUrl: string;
  signatureRequired: boolean;
}

export interface RedisConfig {
  host: string;
  port: number;
  database: number;
  tls?: boolean;
  username?: string;
  password?: string;
}

export interface AuthServiceConfig {
  host: string;
  port: number;
  publicBaseUrl: string;
  corsOrigins: string[];
  databaseUrl?: string;
  redis?: RedisConfig;
  databaseAutoMigrate: boolean;
  tokenSecret: string;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  authorizationCodeTtlSeconds: number;
  legacyScanTokenTtlSeconds: number;
  legacyLoginTokenTtlSeconds: number;
  enableLegacyDebugEndpoints: boolean;
  allowMockWechat: boolean;
  oauthClients: OAuthClient[];
  loginEntries: LoginEntry[];
  wechat: WechatConfig;
}

export function createConfig(env: NodeJS.ProcessEnv = process.env): AuthServiceConfig {
  const publicBaseUrl = stripTrailingSlash(readString(env, 'AUTH_PUBLIC_BASE_URL', 'http://localhost:3010'));
  const officialToken = readFirstString(env, ['AUTH_WECHAT_OFFICIAL_TOKEN', 'WECHAT_TOKEN']);
  const oauthClients = readOAuthClients(env, publicBaseUrl);

  return {
    host: readString(env, 'AUTH_SERVICE_HOST', '0.0.0.0'),
    port: readNumber(env, 'AUTH_SERVICE_PORT', 3010),
    publicBaseUrl,
    corsOrigins: readCsv(env, 'AUTH_CORS_ORIGINS', [publicBaseUrl, 'https://bujiaban.com', 'https://3dugc.com']),
    databaseUrl: readDatabaseUrl(env),
    redis: readRedisConfig(env),
    databaseAutoMigrate: readBoolean(env, 'AUTH_DATABASE_AUTO_MIGRATE', false),
    tokenSecret: readTokenSecret(env),
    accessTokenTtlSeconds: readNumber(env, 'AUTH_ACCESS_TOKEN_TTL_SECONDS', 15 * 60),
    refreshTokenTtlSeconds: readNumber(env, 'AUTH_REFRESH_TOKEN_TTL_SECONDS', 30 * 24 * 60 * 60),
    authorizationCodeTtlSeconds: readNumber(env, 'AUTH_AUTHORIZATION_CODE_TTL_SECONDS', 10 * 60),
    legacyScanTokenTtlSeconds: readNumber(env, 'AUTH_LEGACY_SCAN_TOKEN_TTL_SECONDS', 60 * 60),
    legacyLoginTokenTtlSeconds: readNumber(env, 'AUTH_LEGACY_LOGIN_TOKEN_TTL_SECONDS', 30 * 24 * 60 * 60),
    enableLegacyDebugEndpoints: readBoolean(env, 'AUTH_ENABLE_LEGACY_DEBUG_ENDPOINTS', false),
    allowMockWechat: readBoolean(env, 'AUTH_ALLOW_MOCK_WECHAT', false),
    oauthClients,
    loginEntries: readLoginEntries(env, oauthClients),
    wechat: {
      officialAppId: readFirstString(env, ['AUTH_WECHAT_OFFICIAL_APP_ID', 'WECHAT_APP_ID']),
      officialAppSecret: readFirstString(env, ['AUTH_WECHAT_OFFICIAL_APP_SECRET', 'WECHAT_SECRET']),
      officialToken,
      officialEncodingAesKey: readFirstString(env, ['AUTH_WECHAT_OFFICIAL_AES_KEY', 'WECHAT_AES_KEY']),
      apiBaseUrl: stripTrailingSlash(readString(env, 'AUTH_WECHAT_API_BASE_URL', 'https://api.weixin.qq.com')),
      oauthBaseUrl: stripTrailingSlash(readString(env, 'AUTH_WECHAT_OAUTH_BASE_URL', 'https://open.weixin.qq.com')),
      signatureRequired: readBoolean(env, 'AUTH_WECHAT_SIGNATURE_REQUIRED', Boolean(officialToken)),
    },
  };
}

function readOAuthClients(env: NodeJS.ProcessEnv, publicBaseUrl: string): OAuthClient[] {
  const configured = readOptionalString(env, 'AUTH_OAUTH_CLIENTS_JSON');
  if (configured) return (JSON.parse(configured) as OAuthClient[]).map(normalizeClient);

  return [
    normalizeClient({
      clientId: 'bujiaban-web',
      name: 'bujiaban.com',
      redirectUris: ['https://bujiaban.com/auth/callback', `${publicBaseUrl}/auth/callback`],
      allowedOrigins: ['https://bujiaban.com', publicBaseUrl],
      scopes: ['openid', 'profile'],
      publicClient: true,
    }),
    normalizeClient({
      clientId: '3dugc-web',
      name: '3dugc.com',
      redirectUris: ['https://3dugc.com/auth/callback'],
      allowedOrigins: ['https://3dugc.com'],
      scopes: ['openid', 'profile'],
      publicClient: true,
    }),
  ];
}

function normalizeClient(client: OAuthClient): OAuthClient {
  return {
    ...client,
    allowedOrigins: client.allowedOrigins || [],
    scopes: client.scopes?.length ? client.scopes : ['openid', 'profile'],
    publicClient: client.publicClient ?? !client.clientSecret,
  };
}

function readLoginEntries(env: NodeJS.ProcessEnv, oauthClients: OAuthClient[]): LoginEntry[] {
  const configured = readOptionalString(env, 'AUTH_LOGIN_ENTRIES_JSON');
  const entries = configured
    ? (JSON.parse(configured) as LoginEntry[]).map(normalizeLoginEntry)
    : defaultLoginEntries(oauthClients);
  validateLoginEntries(entries, oauthClients);
  return entries;
}

function defaultLoginEntries(oauthClients: OAuthClient[]): LoginEntry[] {
  const defaults: LoginEntry[] = [];
  const bujiaban = oauthClients.find((client) => client.clientId === 'bujiaban-web');
  if (bujiaban?.redirectUris.includes('https://bujiaban.com/auth/callback')) {
    defaults.push({
      slug: 'bujiaban',
      clientId: 'bujiaban-web',
      defaultRedirectUri: 'https://bujiaban.com/auth/callback',
      allowedReturnUrlPrefixes: ['https://bujiaban.com/', 'https://www.bujiaban.com/'],
      defaultScopes: ['openid', 'profile'],
      provider: 'wechat_official_account',
      displayName: '不加班',
    });
  }

  const threeDugc = oauthClients.find((client) => client.clientId === '3dugc-web');
  if (threeDugc?.redirectUris.includes('https://3dugc.com/auth/callback')) {
    defaults.push({
      slug: '3dugc',
      clientId: '3dugc-web',
      defaultRedirectUri: 'https://3dugc.com/auth/callback',
      allowedReturnUrlPrefixes: ['https://3dugc.com/'],
      defaultScopes: ['openid', 'profile'],
      provider: 'wechat_official_account',
      displayName: '3DUGC',
    });
  }
  return defaults;
}

function normalizeLoginEntry(entry: LoginEntry): LoginEntry {
  return {
    slug: String(entry.slug || '').trim(),
    clientId: String(entry.clientId || '').trim(),
    defaultRedirectUri: String(entry.defaultRedirectUri || '').trim(),
    allowedReturnUrlPrefixes: normalizeStringArray(entry.allowedReturnUrlPrefixes),
    defaultScopes: normalizeStringArray(entry.defaultScopes),
    provider: String(entry.provider || '').trim() as AuthIdentityProvider,
    displayName: readOptionalObjectString(entry, 'displayName'),
  };
}

function validateLoginEntries(entries: LoginEntry[], oauthClients: OAuthClient[]): void {
  const seenSlugs = new Set<string>();
  for (const entry of entries) {
    if (!entry.slug || !/^[a-z0-9][a-z0-9-]*$/i.test(entry.slug)) {
      throw new Error(`Invalid login entry slug: ${entry.slug || '<empty>'}`);
    }
    if (seenSlugs.has(entry.slug)) throw new Error(`Duplicate login entry slug: ${entry.slug}`);
    seenSlugs.add(entry.slug);

    const client = oauthClients.find((candidate) => candidate.clientId === entry.clientId);
    if (!client) throw new Error(`Login entry ${entry.slug} references unknown OAuth client: ${entry.clientId}`);
    if (!client.redirectUris.includes(entry.defaultRedirectUri)) {
      throw new Error(`Login entry ${entry.slug} defaultRedirectUri is not allowed for client ${entry.clientId}`);
    }
    if (!entry.defaultScopes.length) throw new Error(`Login entry ${entry.slug} must define defaultScopes`);
    if (!entry.defaultScopes.every((scope) => client.scopes.includes(scope))) {
      throw new Error(`Login entry ${entry.slug} defaultScopes must be allowed by client ${entry.clientId}`);
    }
    if (!entry.allowedReturnUrlPrefixes.length) {
      throw new Error(`Login entry ${entry.slug} must define allowedReturnUrlPrefixes`);
    }
    for (const prefix of entry.allowedReturnUrlPrefixes) validateReturnUrlPrefix(entry.slug, prefix);
    if (!isSupportedProvider(entry.provider)) {
      throw new Error(`Login entry ${entry.slug} has unsupported provider: ${entry.provider}`);
    }
  }
}

function validateReturnUrlPrefix(slug: string, prefix: string): void {
  let url: URL;
  try {
    url = new URL(prefix);
  } catch {
    throw new Error(`Login entry ${slug} has invalid return URL prefix: ${prefix}`);
  }
  if (url.username || url.password) {
    throw new Error(`Login entry ${slug} return URL prefix must not include credentials`);
  }
  if (url.hash) throw new Error(`Login entry ${slug} return URL prefix must not include a fragment`);
  if (!isHttpsOrLocalHttp(url)) {
    throw new Error(`Login entry ${slug} return URL prefix must use https or local http`);
  }
}

function isSupportedProvider(provider: string): provider is AuthIdentityProvider {
  return provider === 'wechat_official_account' || provider === 'wechat_website' || provider === 'wechat_mini_program';
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item).trim()).filter(Boolean) : [];
}

function readOptionalObjectString(source: object, key: string): string | undefined {
  const value = (source as Record<string, unknown>)[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isHttpsOrLocalHttp(url: URL): boolean {
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
}

function readTokenSecret(env: NodeJS.ProcessEnv): string {
  const configured = readOptionalString(env, 'AUTH_TOKEN_SECRET');
  if (configured) return assertTokenSecretStrength(configured, env);

  const jwtKey = readOptionalString(env, 'JWT_KEY');
  if (jwtKey && fs.existsSync(jwtKey)) return assertTokenSecretStrength(fs.readFileSync(jwtKey, 'utf8').trim(), env);

  // Keep compatibility with legacy deployments that supplied the secret value
  // directly as JWT_KEY.  A filesystem-looking value is never a valid secret.
  if (jwtKey && !looksLikeFilePath(jwtKey)) return assertTokenSecretStrength(jwtKey, env);

  // A path is not a secret.  Falling back to it made a missing mounted key
  // equivalent to publishing a predictable signing key in production.
  if (isProduction(env)) {
    throw new Error('AUTH_TOKEN_SECRET or a readable JWT_KEY file is required in production');
  }

  // Development can run without extra setup, but gets a fresh process-local
  // secret rather than a predictable repository default.
  return readOptionalString(env, 'AUTH_DEV_TOKEN_SECRET') ?? ephemeralDevelopmentTokenSecret;
}

function assertTokenSecretStrength(secret: string, env: NodeJS.ProcessEnv): string {
  if (isProduction(env) && Buffer.byteLength(secret, 'utf8') < 32) {
    throw new Error('AUTH_TOKEN_SECRET must contain at least 32 bytes in production');
  }
  return secret;
}

function isProduction(env: NodeJS.ProcessEnv): boolean {
  return (env.NODE_ENV ?? env.APP_ENV ?? '').trim().toLowerCase() === 'production';
}

function looksLikeFilePath(value: string): boolean {
  return value.startsWith('/') || value.startsWith('./') || value.startsWith('../');
}

function readDatabaseUrl(env: NodeJS.ProcessEnv): string | undefined {
  const direct = readOptionalString(env, 'AUTH_DATABASE_URL') || readOptionalString(env, 'DATABASE_URL');
  if (direct) return direct;

  const host = readOptionalString(env, 'MYSQL_HOST');
  const database = readOptionalString(env, 'MYSQL_DB');
  const username = readOptionalString(env, 'MYSQL_USERNAME') || readOptionalString(env, 'MYSQL_USER');
  const password = readOptionalString(env, 'MYSQL_PASSWORD');
  if (!host || !database || !username) return undefined;

  const port = readOptionalString(env, 'MYSQL_PORT') || '3306';
  const credentials = `${encodeURIComponent(username)}:${encodeURIComponent(password || '')}`;
  return `mysql://${credentials}@${host}:${port}/${encodeURIComponent(database)}`;
}

function readRedisConfig(env: NodeJS.ProcessEnv): RedisConfig | undefined {
  const redisUrl = readOptionalString(env, 'AUTH_REDIS_URL') || readOptionalString(env, 'REDIS_URL');
  if (redisUrl) {
    const url = new URL(redisUrl);
    if (url.protocol !== 'redis:' && url.protocol !== 'rediss:') {
      throw new Error(`Unsupported Redis URL protocol: ${url.protocol}`);
    }
    const useTls = url.protocol === 'rediss:';
    return {
      host: url.hostname,
      port: url.port ? Number(url.port) : 6379,
      database: Math.max(0, Number(url.pathname.replace(/^\//, '') || '0')),
      ...(useTls ? { tls: true } : {}),
      username: url.username ? decodeURIComponent(url.username) : undefined,
      password: url.password ? decodeURIComponent(url.password) : undefined,
    };
  }

  const host = readOptionalString(env, 'REDIS_HOST');
  if (!host) return undefined;
  const database = readNumber(env, 'REDIS_DB', 0);
  return {
    host,
    port: readNumber(env, 'REDIS_PORT', 6379),
    database: Math.max(0, database),
    tls: readBoolean(env, 'AUTH_REDIS_TLS', readBoolean(env, 'REDIS_TLS', false)) || undefined,
    username: readOptionalString(env, 'REDIS_USERNAME'),
    password: readOptionalString(env, 'REDIS_PASSWORD'),
  };
}

function readString(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  return readOptionalString(env, name) || fallback;
}

function readFirstString(env: NodeJS.ProcessEnv, names: string[]): string | undefined {
  for (const name of names) {
    const value = readOptionalString(env, name);
    if (value) return value;
  }
  return undefined;
}

function readOptionalString(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value || undefined;
}

function readNumber(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = readOptionalString(env, name);
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readBoolean(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const value = readOptionalString(env, name);
  if (!value) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function readCsv(env: NodeJS.ProcessEnv, name: string, fallback: string[]): string[] {
  const value = readOptionalString(env, name);
  if (!value) return fallback;
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}
