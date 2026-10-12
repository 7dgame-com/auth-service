import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { constantTimeSecretEqual } from './crypto';
import { DEVELOPMENT_WECHAT_SCENE_PATTERN } from './development-wechat-relay';
import type { DevelopmentWechatRegistry } from './development-wechat-registry';

export interface DevelopmentProviderConfig {
  providerAppId: string;
  identityApiBaseUrl: string;
  fApiBaseUrl: string;
  identityToken: string;
  capabilityToken: string;
  relayToken: string;
  registryDatabaseUrl: string;
  host: string;
  port: number;
  timeoutMs: number;
}

/** Does not read WeChat secrets, legacy account configuration, or Redis. */
export function createDevelopmentProviderConfig(env: NodeJS.ProcessEnv = process.env): DevelopmentProviderConfig {
  const providerAppId = required(env, 'DEVELOPMENT_PROVIDER_APP_ID');
  if (!/^wx[A-Za-z0-9_-]{1,126}$/.test(providerAppId)) throw new Error('Invalid development provider AppID');
  const identityToken = secret(env, 'DEVELOPMENT_PROVIDER_IDENTITY_TOKEN');
  const capabilityToken = secret(env, 'DEVELOPMENT_PROVIDER_CAPABILITY_TOKEN');
  const relayToken = secret(env, 'DEVELOPMENT_PROVIDER_RELAY_TOKEN');
  if (new Set([identityToken, capabilityToken, relayToken]).size !== 3) throw new Error('Development provider keys must have separate scopes');
  const registryDatabaseUrl = required(env, 'DEVELOPMENT_PROVIDER_DATABASE_URL');
  const database = new URL(registryDatabaseUrl);
  if (database.protocol !== 'mysql:' || !/^\/xrugc_identity_dev(?:_rehearsal_[a-z0-9_]+)?$/.test(database.pathname) || database.search || database.hash) {
    throw new Error('Development provider requires a development-only registry database');
  }
  return { providerAppId, identityToken, capabilityToken, relayToken, registryDatabaseUrl,
    identityApiBaseUrl: serviceUrl(required(env, 'DEVELOPMENT_PROVIDER_IDENTITY_API_BASE_URL'), false),
    fApiBaseUrl: serviceUrl(required(env, 'DEVELOPMENT_PROVIDER_F_API_BASE_URL'), true),
    host: env.DEVELOPMENT_PROVIDER_HOST || '0.0.0.0', port: integer(env.DEVELOPMENT_PROVIDER_PORT, 3011, 1, 65535),
    timeoutMs: integer(env.DEVELOPMENT_PROVIDER_TIMEOUT_MS, 5000, 100, 10000) };
}

export function createDevelopmentProviderApp(config: DevelopmentProviderConfig, registry: DevelopmentWechatRegistry): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);
  app.use(express.json({ limit: '8kb', strict: true }));
  app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'development-wechat-provider' }));
  const identity: express.RequestHandler = (req, res, next) => {
    if (!constantTimeSecretEqual(config.identityToken, req.header('x-identity-internal-token'))) { res.status(401).json({ error: 'unauthorized' }); return; }
    next();
  };
  app.post('/internal/wechat-provider/qrcode', identity, asyncHandler(async (req, res) => {
    const scene = req.body?.scene, ttl = req.body?.lifetimeSeconds;
    if (typeof scene !== 'string' || !DEVELOPMENT_WECHAT_SCENE_PATTERN.test(scene) || !Number.isSafeInteger(ttl) || ttl < 1 || ttl > 518400) {
      res.status(400).json({ error: 'invalid_request' }); return;
    }
    const now = new Date(), registered = await registry.register(scene, config.providerAppId, now, ttl);
    const remaining = Math.floor((registered.expiresAt.getTime() - Date.now()) / 1000);
    if (remaining < 1) { res.status(410).json({ error: 'scene_expired' }); return; }
    const result = await post(config, config.fApiBaseUrl, '/internal/development-wechat/qrcode',
      'x-development-provider-token', config.capabilityToken, { scene, lifetimeSeconds: Math.min(ttl, remaining) });
    if (!record(result) || result.providerAppId !== config.providerAppId || typeof result.ticket !== 'string' || !result.ticket ||
      typeof result.url !== 'string' || !Number.isSafeInteger(result.expire_seconds) || Number(result.expire_seconds) < 1 || Number(result.expire_seconds) > remaining) throw new ProviderUnavailable();
    res.json(result);
  }));
  app.post('/internal/wechat-provider/profile', identity, asyncHandler(async (req, res) => {
    const openId = req.body?.openId;
    if (!validOpenId(openId)) { res.status(400).json({ error: 'invalid_request' }); return; }
    if (!await registry.canReadProfile(config.providerAppId, openId, new Date())) { res.status(403).json({ error: 'unknown_development_scan' }); return; }
    const result = await post(config, config.fApiBaseUrl, '/internal/development-wechat/profile',
      'x-development-provider-token', config.capabilityToken, { openId });
    if (!record(result) || result.providerAppId !== config.providerAppId || result.openId !== openId) throw new ProviderUnavailable();
    res.json(result);
  }));
  app.post('/internal/wechat-provider/confirm-scan', asyncHandler(async (req, res) => {
    if (!constantTimeSecretEqual(config.relayToken, req.header('x-development-relay-token'))) { res.status(401).json({ error: 'unauthorized' }); return; }
    const scene = req.body?.scene, openId = req.body?.openId;
    if (typeof scene !== 'string' || !DEVELOPMENT_WECHAT_SCENE_PATTERN.test(scene) || !validOpenId(openId) || req.body?.providerAppId !== config.providerAppId) {
      res.status(400).json({ error: 'invalid_request' }); return;
    }
    const claim = await registry.claim(scene, config.providerAppId, openId, new Date());
    if (claim === 'missing') { res.status(404).json({ error: 'unknown_development_scene' }); return; }
    if (claim === 'conflict') { res.status(409).json({ error: 'scan_identity_conflict' }); return; }
    if (claim === 'deliver') {
      await post(config, config.identityApiBaseUrl, '/internal/wechat-provider/confirm-scan', 'x-identity-internal-token', config.identityToken,
        { scene, openId, providerAppId: config.providerAppId });
      await registry.markDelivered(scene, config.providerAppId, openId, new Date());
    }
    res.json({ success: true });
  }));
  app.use((_req, res) => res.status(404).json({ error: 'not_found' }));
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) return;
    const badBody = record(error) && (error.type === 'entity.too.large' || error.type === 'entity.parse.failed');
    res.status(badBody ? 400 : 503).json({ error: badBody ? 'invalid_request' : 'provider_unavailable' });
  });
  return app;
}

class ProviderUnavailable extends Error {}
async function post(config: DevelopmentProviderConfig, base: string, path: string, key: string, token: string, body: unknown): Promise<unknown> {
  try {
    const response = await fetch(`${base}${path}`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(config.timeoutMs),
      headers: { 'content-type': 'application/json', [key]: token }, body: JSON.stringify(body) });
    if (!response.ok) { await response.body?.cancel(); throw new ProviderUnavailable(); }
    return await response.json();
  } catch { throw new ProviderUnavailable(); }
}
function asyncHandler(handler: (req: Request, res: Response) => Promise<void>): express.RequestHandler {
  return (req, res, next): void => { handler(req, res).catch(next); };
}
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function validOpenId(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9_-]{1,191}$/.test(value); }
function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]; if (!value || value !== value.trim()) throw new Error(`${key} is required`); return value;
}
function secret(env: NodeJS.ProcessEnv, key: string): string {
  const value = required(env, key); if (Buffer.byteLength(value) < 32) throw new Error(`${key} must contain at least 32 bytes`); return value;
}
function integer(value: string | undefined, fallback: number, min: number, max: number): number {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) throw new Error('Invalid development provider numeric configuration'); return number;
}
function serviceUrl(value: string, secure: boolean): string {
  const url = new URL(value), loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && (!secure || loopback))) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Development provider requires fixed service origins');
  }
  return url.origin;
}
