import crypto from 'crypto';

export interface SignedTokenPayload {
  iss: string;
  sub: string;
  aud: string;
  scope?: string;
  unionid?: string;
  iat: number;
  exp: number;
  jti: string;
  typ?: 'access' | 'id';
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function sha256Base64Url(value: string): string {
  return crypto.createHash('sha256').update(value).digest('base64url');
}

export function createSignedToken(payload: SignedTokenPayload, secret: string): string {
  const encodedHeader = encodeJson({ alg: 'HS256', typ: 'JWT' });
  const encodedPayload = encodeJson(payload);
  const signature = hmac(`${encodedHeader}.${encodedPayload}`, secret);
  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

export function verifySignedToken(token: string, secret: string): SignedTokenPayload | undefined {
  const [encodedHeader, encodedPayload, signature] = token.split('.');
  if (!encodedHeader || !encodedPayload || !signature) return undefined;
  if (!timingSafeEqual(signature, hmac(`${encodedHeader}.${encodedPayload}`, secret))) return undefined;

  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as SignedTokenPayload;
    if (!payload.sub || !payload.exp || payload.exp <= Math.floor(Date.now() / 1000)) return undefined;
    return payload;
  } catch {
    return undefined;
  }
}

export function createSignedState(payload: Record<string, unknown>, secret: string, ttlSeconds: number): string {
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now, exp: now + ttlSeconds, nonce: randomToken(16) };
  const encodedPayload = encodeJson(body);
  return `${encodedPayload}.${hmac(encodedPayload, secret)}`;
}

export function verifySignedState<T extends Record<string, unknown>>(state: string, secret: string): T | undefined {
  const [encodedPayload, signature] = state.split('.');
  if (!encodedPayload || !signature) return undefined;
  if (!timingSafeEqual(signature, hmac(encodedPayload, secret))) return undefined;

  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as T & { exp?: number };
    if (!payload.exp || payload.exp <= Math.floor(Date.now() / 1000)) return undefined;
    return payload;
  } catch {
    return undefined;
  }
}

export function verifyWechatSignature(token: string, signature: string, timestamp: string, nonce: string): boolean {
  return timingSafeEqual(createSha1Signature([token, timestamp, nonce]), signature);
}

export function createWechatMessageSignature(token: string, timestamp: string, nonce: string, encrypted: string): string {
  return createSha1Signature([token, timestamp, nonce, encrypted]);
}

export function verifyWechatMessageSignature(
  token: string,
  signature: string,
  timestamp: string,
  nonce: string,
  encrypted: string
): boolean {
  return timingSafeEqual(createWechatMessageSignature(token, timestamp, nonce, encrypted), signature);
}

export function decryptWechatMessage(encrypted: string, encodingAesKey: string, expectedAppId?: string): string {
  const key = readWechatAesKey(encodingAesKey);
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, key.subarray(0, 16));
  decipher.setAutoPadding(false);
  const decrypted = removePkcs7Padding(Buffer.concat([
    decipher.update(Buffer.from(encrypted, 'base64')),
    decipher.final(),
  ]));

  const messageLength = decrypted.readUInt32BE(16);
  const messageStart = 20;
  const messageEnd = messageStart + messageLength;
  const message = decrypted.subarray(messageStart, messageEnd).toString('utf8');
  const appId = decrypted.subarray(messageEnd).toString('utf8');

  if (expectedAppId && appId && appId !== expectedAppId) {
    throw new Error('WeChat encrypted message app_id does not match configured app id.');
  }
  return message;
}

export function encryptWechatMessage(message: string, encodingAesKey: string, appId: string): string {
  const key = readWechatAesKey(encodingAesKey);
  const messageBuffer = Buffer.from(message, 'utf8');
  const lengthBuffer = Buffer.alloc(4);
  lengthBuffer.writeUInt32BE(messageBuffer.length, 0);
  const plaintext = addPkcs7Padding(Buffer.concat([
    crypto.randomBytes(16),
    lengthBuffer,
    messageBuffer,
    Buffer.from(appId, 'utf8'),
  ]));

  const cipher = crypto.createCipheriv('aes-256-cbc', key, key.subarray(0, 16));
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]).toString('base64');
}

export function verifyPkceChallenge(verifier: string, challenge: string, method: 'plain' | 'S256' | undefined): boolean {
  const actual = method === 'S256' ? sha256Base64Url(verifier) : verifier;
  return timingSafeEqual(actual, challenge);
}

export function constantTimeSecretEqual(left: string | undefined, right: string | undefined): boolean {
  return Boolean(left && right && timingSafeEqual(left, right));
}

function encodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function hmac(value: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

function createSha1Signature(parts: string[]): string {
  return crypto.createHash('sha1').update(parts.sort().join('')).digest('hex');
}

function readWechatAesKey(encodingAesKey: string): Buffer {
  const key = Buffer.from(`${encodingAesKey.trim()}=`, 'base64');
  if (key.length !== 32) throw new Error('WECHAT_AES_KEY must decode to a 32-byte AES key.');
  return key;
}

function addPkcs7Padding(value: Buffer): Buffer {
  const blockSize = 32;
  const paddingSize = blockSize - (value.length % blockSize) || blockSize;
  return Buffer.concat([value, Buffer.alloc(paddingSize, paddingSize)]);
}

function removePkcs7Padding(value: Buffer): Buffer {
  const paddingSize = value[value.length - 1] || 0;
  if (paddingSize < 1 || paddingSize > 32) throw new Error('Invalid WeChat message padding.');
  for (let index = value.length - paddingSize; index < value.length; index += 1) {
    if (value[index] !== paddingSize) throw new Error('Invalid WeChat message padding.');
  }
  return value.subarray(0, value.length - paddingSize);
}

function timingSafeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}
