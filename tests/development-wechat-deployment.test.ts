import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
describe('development provider deployment assets', () => {
  it('ships the reviewed registry SQL and separate compiled entrypoint in the normal image', () => {
    const dockerfile = read('Dockerfile');
    expect(dockerfile).toContain('COPY --from=build /app/dist ./dist');
    expect(dockerfile).toContain('COPY deploy/mysql/development-wechat-registry.sql ./deploy/mysql/development-wechat-registry.sql');
    expect(read('deploy/development-wechat.compose.yml')).toContain('dist/development-provider-run.js');
    expect(read('deploy/development-wechat.compose.yml')).toContain('com.centurylinklabs.watchtower.enable: "false"');
  });
  it('keeps shared F disabled and does not provision legacy account stores or WeChat secrets to the adapter', () => {
    expect(read('.env.example')).toContain('AUTH_WECHAT_DEVELOPMENT_RELAY_ENABLED=false');
    const adapter = read('deploy/development-wechat.env.example');
    expect(adapter).not.toMatch(/^AUTH_DATABASE_URL=|^MYSQL_|^AUTH_REDIS_|^WECHAT_SECRET=|^AUTH_WECHAT_OFFICIAL_APP_SECRET=/m);
    expect(read('src/development-provider-run.ts')).not.toMatch(/createRuntime|createStore|WechatClient|MySqlAuthStore|Redis/);
    expect(read('deploy/mysql/development-wechat-registry.sql')).not.toMatch(/^\s*(ALTER|DROP|DELETE|TRUNCATE)\b/im);
  });
});
