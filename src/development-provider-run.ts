import { createDevelopmentProviderApp, createDevelopmentProviderConfig } from './development-provider-adapter';
import { MySqlDevelopmentWechatRegistry } from './development-wechat-registry';

async function main(): Promise<void> {
  const config = createDevelopmentProviderConfig();
  const registry = new MySqlDevelopmentWechatRegistry(config.registryDatabaseUrl);
  try {
    await registry.ensureReady();
    const server = createDevelopmentProviderApp(config, registry).listen(config.port, config.host);
    const close = (): void => { server.close(() => { registry.close().then(() => process.exit(0)).catch(() => process.exit(1)); }); };
    process.once('SIGTERM', close); process.once('SIGINT', close);
    server.once('error', () => { registry.close().finally(() => { process.exitCode = 1; }); });
  } catch {
    await registry.close();
    // Never print connection strings, keys, scenes, openids, or upstream bodies.
    process.stderr.write('Development WeChat provider could not start\n'); process.exitCode = 1;
  }
}
main().catch(() => { process.stderr.write('Development WeChat provider could not start\n'); process.exitCode = 1; });
