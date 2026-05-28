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
      database: config.databaseUrl ? 'mysql' : 'memory',
      wechatOfficialAppIdConfigured: Boolean(config.wechat.officialAppId),
      wechatOfficialSecretConfigured: Boolean(config.wechat.officialAppSecret),
    });
  });

  app.use('/v1', createLegacyWechatRouter(config, store, wechat));
  app.use(createOAuthRouter(config, store, wechat));

  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
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
  return config.databaseUrl
    ? new MySqlAuthStore(config.databaseUrl, { autoMigrate: config.databaseAutoMigrate })
    : new MemoryAuthStore();
}
