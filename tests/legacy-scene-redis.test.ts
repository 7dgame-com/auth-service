import net, { type AddressInfo } from 'net';
import { describe, expect, it } from 'vitest';
import { LegacyRedisOpenIdStore, legacySceneMetadataKey } from '../src/legacy-redis';
import { sceneDigest } from '../src/legacy-routes';

describe('legacy scene Redis wire contract', () => {
  it('sends immutable hashed metadata and the original absolute millisecond expiry atomically', async () => {
    const commands: string[][] = [];
    const server = net.createServer(socket => {
      let pending = Buffer.alloc(0);
      socket.on('data', data => {
        pending = Buffer.concat([pending, data]);
        for (;;) {
          const parsed = readCommand(pending); if (!parsed) break;
          pending = pending.subarray(parsed.offset); commands.push(parsed.args);
          socket.write(parsed.args[0] === 'EVAL' ? ':1\r\n' : '+OK\r\n');
        }
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const metadata = { sceneDigest: sceneDigest('raw-scene-not-exported'), providerAppId: 'wx-exact-app',
        issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString() };
      const store = new LegacyRedisOpenIdStore({ host: '127.0.0.1', port: (server.address() as AddressInfo).port, database: 2 });
      await store.saveSceneMetadata(metadata);
      expect(commands[0]).toEqual(['SELECT', '2']);
      const command = commands[1];
      expect(command[0]).toBe('EVAL'); expect(command[1]).toContain("redis.call('EXISTS',KEYS[1])");
      expect(command[1]).toContain("redis.call('PEXPIREAT',KEYS[1],ARGV[5])");
      expect(command.slice(2)).toEqual(['1', legacySceneMetadataKey(metadata.sceneDigest), metadata.sceneDigest, metadata.providerAppId,
        metadata.issuedAt, metadata.expiresAt, String(Date.parse(metadata.expiresAt))]);
      expect(JSON.stringify(commands)).not.toContain('raw-scene-not-exported');
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  });
});

function readCommand(buffer: Buffer): { args: string[]; offset: number } | undefined {
  const countEnd = buffer.indexOf('\r\n'); if (countEnd < 0) return undefined;
  const count = Number(buffer.subarray(1, countEnd).toString()); const args: string[] = []; let offset = countEnd + 2;
  for (let index = 0; index < count; index++) {
    const lengthEnd = buffer.indexOf('\r\n', offset); if (lengthEnd < 0) return undefined;
    const length = Number(buffer.subarray(offset + 1, lengthEnd).toString()); offset = lengthEnd + 2;
    if (buffer.length < offset + length + 2) return undefined;
    args.push(buffer.subarray(offset, offset + length).toString()); offset += length + 2;
  }
  return { args, offset };
}
