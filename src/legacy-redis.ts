import { createHash } from 'crypto';
import net from 'net';
import tls from 'tls';
import type { RedisConfig } from './config';

const OPEN_ID_INDEX_KEY = 'open_id';
const REDIS_TIMEOUT_MS = 5000;

type RedisValue = string | number | null | RedisValue[];

interface ParsedRedisValue {
  value: RedisValue;
  offset: number;
}

export class LegacyRedisOpenIdStore {
  constructor(private readonly config: RedisConfig) {}

  async saveOpenId(token: string, openId: string): Promise<void> {
    const primaryKey = yiiRedisBuildKey(token);
    await executeRedisCommands(this.config, [
      ['RPUSH', OPEN_ID_INDEX_KEY, primaryKey],
      ['HMSET', yiiRedisOpenIdKey(token), 'token', token, 'openid', openId],
    ]);
  }

  async findOpenId(token: string): Promise<string | undefined> {
    const [openId] = await executeRedisCommands(this.config, [
      ['HGET', yiiRedisOpenIdKey(token), 'openid'],
    ]);
    return typeof openId === 'string' && openId ? openId : undefined;
  }
}

export function yiiRedisOpenIdKey(token: string): string {
  return `${OPEN_ID_INDEX_KEY}:a:${yiiRedisBuildKey(token)}`;
}

export function yiiRedisBuildKey(value: string): string {
  if (/^[A-Za-z0-9]+$/.test(value) && Buffer.byteLength(value) <= 32) return value;
  return createHash('md5').update(value).digest('hex');
}

async function executeRedisCommands(config: RedisConfig, commands: string[][]): Promise<RedisValue[]> {
  const setupCommands: string[][] = [];
  if (config.password) {
    setupCommands.push(config.username ? ['AUTH', config.username, config.password] : ['AUTH', config.password]);
  }
  setupCommands.push(['SELECT', String(config.database)]);

  const allCommands = [...setupCommands, ...commands];
  const responses = await runRedisCommands(config, allCommands);
  return responses.slice(setupCommands.length);
}

function runRedisCommands(config: RedisConfig, commands: string[][]): Promise<RedisValue[]> {
  return new Promise((resolve, reject) => {
    const socket = config.tls
      ? tls.connect({ host: config.host, port: config.port, servername: config.host })
      : net.createConnection({ host: config.host, port: config.port });
    const responses: RedisValue[] = [];
    let buffer = Buffer.alloc(0);
    let settled = false;

    const timeout = setTimeout(() => {
      finish(new Error('Redis command timed out'));
      socket.destroy();
    }, REDIS_TIMEOUT_MS);

    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) {
        socket.destroy();
        reject(error);
        return;
      }
      socket.end();
      resolve(responses);
    };

    socket.on(config.tls ? 'secureConnect' : 'connect', () => {
      for (const command of commands) socket.write(encodeRedisCommand(command));
    });

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      try {
        while (responses.length < commands.length) {
          const parsed = parseRedisValue(buffer);
          if (!parsed) break;
          responses.push(parsed.value);
          buffer = buffer.subarray(parsed.offset);
        }
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
        return;
      }

      if (responses.length === commands.length) finish();
    });

    socket.on('error', (error) => finish(error));
    socket.on('close', () => {
      if (!settled) finish(new Error('Redis connection closed before all responses were received'));
    });
  });
}

function encodeRedisCommand(args: string[]): Buffer {
  const chunks = [Buffer.from(`*${args.length}\r\n`)];
  for (const arg of args) {
    const value = Buffer.from(arg);
    chunks.push(Buffer.from(`$${value.length}\r\n`), value, Buffer.from('\r\n'));
  }
  return Buffer.concat(chunks);
}

function parseRedisValue(buffer: Buffer, offset = 0): ParsedRedisValue | undefined {
  if (offset >= buffer.length) return undefined;

  const marker = String.fromCharCode(buffer[offset]);
  const line = readLine(buffer, offset + 1);
  if (!line) return undefined;

  if (marker === '+') return { value: line.value, offset: line.offset };
  if (marker === '-') throw new Error(`Redis error: ${line.value}`);
  if (marker === ':') return { value: Number(line.value), offset: line.offset };

  if (marker === '$') {
    const length = Number(line.value);
    if (length === -1) return { value: null, offset: line.offset };
    const end = line.offset + length;
    if (buffer.length < end + 2) return undefined;
    return { value: buffer.subarray(line.offset, end).toString(), offset: end + 2 };
  }

  if (marker === '*') {
    const length = Number(line.value);
    if (length === -1) return { value: null, offset: line.offset };
    const values: RedisValue[] = [];
    let nextOffset = line.offset;
    for (let index = 0; index < length; index += 1) {
      const item = parseRedisValue(buffer, nextOffset);
      if (!item) return undefined;
      values.push(item.value);
      nextOffset = item.offset;
    }
    return { value: values, offset: nextOffset };
  }

  throw new Error(`Unsupported Redis response marker: ${marker}`);
}

function readLine(buffer: Buffer, offset: number): { value: string; offset: number } | undefined {
  const end = buffer.indexOf('\r\n', offset);
  if (end === -1) return undefined;
  return { value: buffer.subarray(offset, end).toString(), offset: end + 2 };
}
