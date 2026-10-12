import { Router } from 'express';
import { constantTimeSecretEqual } from './crypto';
import type { AuthServiceConfig } from './config';
import type { WechatClient } from './wechat-client';

export const DEVELOPMENT_WECHAT_SCENE_PREFIX = 'idvdev_';
export const DEVELOPMENT_WECHAT_SCENE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export interface DevelopmentWechatRelayConfig {
  providerAppId: string;
  capabilityToken: string;
  callbackToken: string;
  callbackBaseUrl: string;
  timeoutMs: number;
}

export function readDevelopmentWechatRelayConfig(env: NodeJS.ProcessEnv, wechat: AuthServiceConfig['wechat'], allowMockWechat: boolean): DevelopmentWechatRelayConfig | undefined {
  const enabled = env.AUTH_WECHAT_DEVELOPMENT_RELAY_ENABLED;
  if (!enabled || enabled === 'false') return undefined;
  if (enabled !== 'true') throw new Error('AUTH_WECHAT_DEVELOPMENT_RELAY_ENABLED must be true or false');
  if (!wechat.officialAppId || !wechat.officialAppSecret || !wechat.officialToken || !wechat.officialEncodingAesKey || !wechat.signatureRequired || allowMockWechat) {
    throw new Error('Development WeChat relay requires verified AES callbacks and real provider configuration');
  }
  // Key format is validated now rather than accepting a configuration that can never decrypt.
  if (!/^[A-Za-z0-9+/]{43}$/.test(wechat.officialEncodingAesKey)) throw new Error('Development WeChat relay requires a valid AES key');
  const capabilityToken = secret(env, 'AUTH_WECHAT_DEVELOPMENT_CAPABILITY_TOKEN');
  const callbackToken = secret(env, 'AUTH_WECHAT_DEVELOPMENT_CALLBACK_TOKEN');
  if (constantTimeSecretEqual(capabilityToken, callbackToken) || constantTimeSecretEqual(capabilityToken, wechat.officialToken) || constantTimeSecretEqual(callbackToken, wechat.officialToken)
      || constantTimeSecretEqual(capabilityToken, wechat.officialAppSecret) || constantTimeSecretEqual(callbackToken, wechat.officialAppSecret)) {
    throw new Error('Development WeChat relay keys must have separate scopes');
  }
  const callbackBaseUrl = serviceUrl(env.AUTH_WECHAT_DEVELOPMENT_CALLBACK_BASE_URL);
  const timeoutMs = Number(env.AUTH_WECHAT_DEVELOPMENT_TIMEOUT_MS || 5000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 10000) throw new Error('Invalid development relay timeout');
  return { providerAppId: wechat.officialAppId, capabilityToken, callbackToken, callbackBaseUrl, timeoutMs };
}

export class DevelopmentWechatRelay {
  constructor(private readonly config: DevelopmentWechatRelayConfig, private readonly wechat: WechatClient) {}
  router(): Router {
    const router = Router();
    router.use((req, res, next) => {
      if (!constantTimeSecretEqual(this.config.capabilityToken, req.header('x-development-provider-token'))) { res.status(401).json({ error: 'unauthorized' }); return; }
      next();
    });
    router.post('/qrcode', (req, res) => {
      const scene = req.body?.scene; const ttl = req.body?.lifetimeSeconds;
      if (typeof scene !== 'string' || !DEVELOPMENT_WECHAT_SCENE_PATTERN.test(scene) || !Number.isSafeInteger(ttl) || ttl < 1 || ttl > 518400) {
        res.status(400).json({ error: 'invalid_request' }); return;
      }
      this.wechat.createTemporaryQrCode(`${DEVELOPMENT_WECHAT_SCENE_PREFIX}${scene}`, ttl)
        .then((qrcode) => res.json({ ...qrcode, providerAppId: this.config.providerAppId }))
        .catch(() => res.status(503).json({ error: 'provider_unavailable' }));
    });
    router.post('/profile', (req, res) => {
      const openId = req.body?.openId;
      if (typeof openId !== 'string' || !/^[A-Za-z0-9_-]{1,191}$/.test(openId)) { res.status(400).json({ error: 'invalid_request' }); return; }
      this.wechat.getOfficialUserInfo(openId)
        .then((profile) => res.json(profile))
        .catch(() => res.status(503).json({ error: 'provider_unavailable' }));
    });
    return router;
  }
  async confirm(scene: string, openId: string, timestamp: string | undefined): Promise<boolean> {
    if (!scene.startsWith(DEVELOPMENT_WECHAT_SCENE_PREFIX)) return false;
    const original = scene.slice(DEVELOPMENT_WECHAT_SCENE_PREFIX.length);
    if (!DEVELOPMENT_WECHAT_SCENE_PATTERN.test(original) || !/^[A-Za-z0-9_-]{1,191}$/.test(openId)) return true;
    const seconds = Number(timestamp), now = Date.now() / 1000;
    if (!timestamp || !/^\d{1,12}$/.test(timestamp) || !Number.isSafeInteger(seconds) || seconds < now - 300 || seconds > now + 30) return true;
    try {
      const response = await fetch(`${this.config.callbackBaseUrl}/internal/wechat-provider/confirm-scan`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(this.config.timeoutMs),
        headers: { 'content-type': 'application/json', 'x-development-relay-token': this.config.callbackToken },
        body: JSON.stringify({ scene: original, openId, providerAppId: this.config.providerAppId }),
      });
      if (!response.ok) throw new Error('Relay delivery failed');
      await response.body?.cancel();
    } catch { throw new DevelopmentWechatRelayUnavailable(); }
    return true;
  }
}

export class DevelopmentWechatRelayUnavailable extends Error {
  constructor() { super('Development WeChat relay is unavailable'); }
}
function secret(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value || value !== value.trim() || Buffer.byteLength(value) < 32) throw new Error(`${key} must contain at least 32 bytes`);
  return value;
}
function serviceUrl(value: string | undefined): string {
  if (!value) throw new Error('AUTH_WECHAT_DEVELOPMENT_CALLBACK_BASE_URL is required');
  const url = new URL(value);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) ||
      url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Development callback must be a fixed HTTPS service origin');
  return url.origin;
}
