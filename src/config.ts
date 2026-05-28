import fs from 'fs';
import type { OAuthClient } from './types';

export interface WechatConfig {
  officialAppId?: string;
  officialAppSecret?: string;
  officialToken?: string;
  officialEncodingAesKey?: string;
  apiBaseUrl: string;
  oauthBaseUrl: string;
  signatureRequired: boolean;
}

export interface AuthServiceConfig {
  host: string;
  port: number;
  publicBaseUrl: string;
  corsOrigins: string[];
  databaseUrl?: string;
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
  wechat: WechatConfig;
}

export function createConfig(env: NodeJS.ProcessEnv = process.env): AuthServiceConfig {
  const publicBaseUrl = stripTrailingSlash(readString(env, 'AUTH_PUBLIC_BASE_URL', 'http://localhost:3010'));
  const officialToken = readFirstString(env, ['AUTH_WECHAT_OFFICIAL_TOKEN', 'WECHAT_TOKEN']);

  return {
    host: readString(env, 'AUTH_SERVICE_HOST', '0.0.0.0'),
    port: readNumber(env, 'AUTH_SERVICE_PORT', 3010),
    publicBaseUrl,
    corsOrigins: readCsv(env, 'AUTH_CORS_ORIGINS', [publicBaseUrl, 'https://bujiaban.com', 'https://3dugc.com']),
    databaseUrl: readDatabaseUrl(env),
    databaseAutoMigrate: readBoolean(env, 'AUTH_DATABASE_AUTO_MIGRATE', false),
    tokenSecret: readTokenSecret(env),
    accessTokenTtlSeconds: readNumber(env, 'AUTH_ACCESS_TOKEN_TTL_SECONDS', 15 * 60),
    refreshTokenTtlSeconds: readNumber(env, 'AUTH_REFRESH_TOKEN_TTL_SECONDS', 30 * 24 * 60 * 60),
    authorizationCodeTtlSeconds: readNumber(env, 'AUTH_AUTHORIZATION_CODE_TTL_SECONDS', 10 * 60),
    legacyScanTokenTtlSeconds: readNumber(env, 'AUTH_LEGACY_SCAN_TOKEN_TTL_SECONDS', 60 * 60),
    legacyLoginTokenTtlSeconds: readNumber(env, 'AUTH_LEGACY_LOGIN_TOKEN_TTL_SECONDS', 30 * 24 * 60 * 60),
    enableLegacyDebugEndpoints: readBoolean(env, 'AUTH_ENABLE_LEGACY_DEBUG_ENDPOINTS', false),
    allowMockWechat: readBoolean(env, 'AUTH_ALLOW_MOCK_WECHAT', false),
    oauthClients: readOAuthClients(env, publicBaseUrl),
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

function readTokenSecret(env: NodeJS.ProcessEnv): string {
  const configured = readOptionalString(env, 'AUTH_TOKEN_SECRET');
  if (configured) return configured;

  const jwtKey = readOptionalString(env, 'JWT_KEY');
  if (jwtKey && fs.existsSync(jwtKey)) return fs.readFileSync(jwtKey, 'utf8').trim();
  if (jwtKey) return jwtKey;

  return 'dev-auth-token-secret-change-me';
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
