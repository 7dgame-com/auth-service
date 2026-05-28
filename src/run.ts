import { createRuntime } from './server';
import logger from './logger';

async function main(): Promise<void> {
  const { app, config } = await createRuntime();
  app.listen(config.port, config.host, () => {
    logger.info(
      {
        host: config.host,
        port: config.port,
        publicBaseUrl: config.publicBaseUrl,
        database: config.databaseUrl ? 'mysql' : 'memory',
      },
      'Unified auth service started'
    );
  });
}

main().catch((error: unknown) => {
  logger.error({ error }, 'Unified auth service crashed');
  process.exitCode = 1;
});
