import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import compression from 'compression';
import cors from 'cors';
import helmet from 'helmet';
import type { AuthServiceConfig } from './config';
import { createConfig } from './config';
import { createLegacyWechatRouter } from './legacy-routes';
import { MemoryAuthStore } from './memory-store';
import { MySqlAuthStore } from './mysql-store';
import { createOAuthRouter } from './oauth-routes';
import type { AuthStore } from './store';
import { WechatClient } from './wechat-client';
import logger from './logger';
import { IdentityAuthStore, IdentityAuthorityError } from './identity-authority';
import { constantTimeSecretEqual } from './crypto';

export interface AuthServiceRuntime {
  app: Express;
  config: AuthServiceConfig;
  store: AuthStore;
}

export async function createRuntime(config = createConfig()): Promise<AuthServiceRuntime> {
  const store = createStore(config);
  if (config.databaseAutoMigrate || !config.databaseUrl) await store.migrate();
  const wechat = new WechatClient(config);
  const app = createApp(config, store, wechat);
  return { app, config, store };
}

export function createApp(config: AuthServiceConfig, store: AuthStore, wechat: WechatClient): Express {
  const app = express();

  app.set('trust proxy', true);
  app.use(cors({
    origin: config.corsOrigins,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  }));
  app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
  app.use(compression());
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      service: 'unified-auth-service',
      timestamp: new Date().toISOString(),
      database: config.dataSource === 'identity' ? 'identity-api' : config.databaseUrl ? 'mysql' : 'memory',
      redis: config.redis ? 'configured' : 'disabled',
      wechatOfficialAppIdConfigured: Boolean(config.wechat.officialAppId),
      wechatOfficialSecretConfigured: Boolean(config.wechat.officialAppSecret),
    });
  });

  const internalProvider: express.RequestHandler = (req, res, next) => {
    if (config.dataSource !== 'identity' || !constantTimeSecretEqual(config.identityApi?.internalToken, req.header('x-identity-internal-token'))) {
      res.status(401).json({ error: 'unauthorized' }); return;
    }
    next();
  };
  app.post('/internal/wechat-provider/qrcode', internalProvider, (req, res, next) => {
    const scene = req.body?.scene; const ttl = req.body?.lifetimeSeconds;
    if (typeof scene !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(scene) || !Number.isSafeInteger(ttl) || ttl < 1 || ttl > 2592000) {
      res.status(400).json({ error: 'invalid_request' }); return;
    }
    wechat.createTemporaryQrCode(scene, ttl).then((qrcode) => res.json(qrcode)).catch(next);
  });
  app.post('/internal/wechat-provider/profile', internalProvider, (req, res, next) => {
    const openId = req.body?.openId;
    if (typeof openId !== 'string' || openId.length < 1 || openId.length > 191) {
      res.status(400).json({ error: 'invalid_request' }); return;
    }
    wechat.getOfficialUserInfo(openId).then((profile) => res.json(profile)).catch(next);
  });

  app.use('/v1', createLegacyWechatRouter(config, store, wechat));
  app.use(createOAuthRouter(config, store, wechat));

  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof IdentityAuthorityError) {
      if (!res.headersSent) res.status(error.status).json(error.body);
      return;
    }
    logger.error({ error }, 'Auth service request failed');
    if (res.headersSent) return;
    res.status(500).json({
      error: 'internal_server_error',
      error_description: error instanceof Error ? error.message : 'unexpected error',
    });
  });

  return app;
}

function createStore(config: AuthServiceConfig): AuthStore {
  if (config.dataSource === 'identity') {
    if (!config.identityApi) throw new Error('Identity API is required in identity mode');
    return new IdentityAuthStore(config.identityApi);
  }
  return config.databaseUrl
    ? new MySqlAuthStore(config.databaseUrl, { autoMigrate: config.databaseAutoMigrate, legacyRedis: config.redis })
    : new MemoryAuthStore();
}
