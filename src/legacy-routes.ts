import express, { Router, type Request, type Response } from 'express';
import type { AuthServiceConfig } from './config';
import {
  createWechatMessageSignature,
  decryptWechatMessage,
  encryptWechatMessage,
  randomToken,
  verifyWechatMessageSignature,
  verifyWechatSignature,
} from './crypto';
import type { AuthStore } from './store';
import { addSeconds } from './store';
import type { WechatClient } from './wechat-client';

interface WechatEventMessage {
  ToUserName?: string;
  FromUserName?: string;
  MsgType?: string;
  Event?: string;
  EventKey?: string;
}

export function createLegacyWechatRouter(config: AuthServiceConfig, store: AuthStore, wechat: WechatClient): Router {
  const router = Router();
  const xmlParser = express.text({ type: ['application/xml', 'text/xml', '*/xml', 'text/plain', '*/*'], limit: '1mb' });

  router.get('/wechat', (req, res) => handleWechatCheck(config, req, res));
  router.get('/wechat/check', (req, res) => handleWechatCheck(config, req, res));

  router.post('/wechat', xmlParser, asyncHandler(async (req, res) => {
    const incoming = readWechatMessage(config, req, String(req.body || ''));
    if (!incoming.ok) {
      res.status(incoming.status).send(incoming.message);
      return;
    }
    const message = parseWechatXml(incoming.xml);
    const reply = await handleWechatEvent(config, store, message);
    const replyXml = createWechatTextReply(message, reply);
    res.type('application/xml').send(incoming.encrypted ? createEncryptedWechatReply(config, req, replyXml) : replyXml);
  }));

  router.get('/wechat/qrcode', asyncHandler(async (_req, res) => {
    const token = randomToken(24);
    const qrcode = await wechat.createTemporaryQrCode(token, config.legacyScanTokenTtlSeconds);
    res.json({ success: true, message: 'create qrcode', qrcode, token });
  }));

  router.get('/wechat/refresh', asyncHandler(async (req, res) => {
    const token = typeof req.query.token === 'string' ? req.query.token : '';
    if (!token) {
      res.status(400).json({ success: false, message: 'token required' });
      return;
    }

    const scanToken = await store.findLegacyScanToken(token);
    if (!scanToken) {
      res.json({ success: false, message: 'token not found' });
      return;
    }

    const profile = await wechat.getOfficialUserInfo(scanToken.openId);
    const result = await store.completeLegacyWechatLogin(profile);

    res.json({
      success: true,
      message: result.isRegistered ? 'signin' : 'signup',
      token: result.token,
    });
  }));

  router.get('/wechat/menu', asyncHandler(async (_req, res) => {
    res.json(await wechat.createDefaultMenu());
  }));

  router.get('/wechat/test', (_req, res) => {
    if (!config.enableLegacyDebugEndpoints) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json({ success: true, message: 'legacy test endpoint' });
  });

  router.get('/wechat/the', asyncHandler(async (_req, res) => {
    if (!config.enableLegacyDebugEndpoints) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const now = new Date();
    await store.saveLegacyScanToken({
      token: 'token',
      providerAppId: config.wechat.officialAppId || 'unknown',
      openId: 'the id',
      scene: 'token',
      expiresAt: addSeconds(now, config.legacyScanTokenTtlSeconds),
      createdAt: now.toISOString(),
    });
    res.json({ token: 'token', openid: 'the id' });
  }));

  return router;
}

async function handleWechatEvent(config: AuthServiceConfig, store: AuthStore, message: WechatEventMessage): Promise<string> {
  if (!message.FromUserName) return '默认消息';
  if (message.MsgType === 'event' && (message.Event === 'SCAN' || message.Event === 'subscribe')) {
    const token = normalizeSceneToken(message.EventKey || '');
    if (token) {
      const now = new Date();
      await store.saveLegacyScanToken({
        token,
        providerAppId: config.wechat.officialAppId || 'unknown',
        openId: message.FromUserName,
        scene: token,
        expiresAt: addSeconds(now, config.legacyScanTokenTtlSeconds),
        createdAt: now.toISOString(),
      });
    }
    return '欢迎登陆平台，祝你永不加班～';
  }
  return message.MsgType === 'text' ? '感谢您的关注' : '扫描二维码';
}

function handleWechatCheck(config: AuthServiceConfig, req: Request, res: Response): void {
  const signature = queryString(req, 'signature');
  const messageSignature = queryString(req, 'msg_signature');
  const timestamp = queryString(req, 'timestamp');
  const nonce = queryString(req, 'nonce');
  const echo = queryString(req, 'echostr');

  if ((!signature && !messageSignature) || !timestamp || !nonce || !echo) {
    res.status(400).send('missing signature parameters');
    return;
  }
  if (messageSignature && config.wechat.officialEncodingAesKey) {
    if (!config.wechat.officialToken || !verifyWechatMessageSignature(config.wechat.officialToken, messageSignature, timestamp, nonce, echo)) {
      res.status(403).send('false');
      return;
    }
    try {
      res.type('text/plain').send(decryptWechatMessage(echo, config.wechat.officialEncodingAesKey, config.wechat.officialAppId));
    } catch {
      res.status(403).send('false');
    }
    return;
  }

  if (!signature || !isValidWechatSignature(config, signature, timestamp, nonce)) {
    res.status(403).send('false');
    return;
  }
  res.type('text/plain').send(echo);
}

type IncomingWechatMessage =
  | { ok: true; encrypted: boolean; xml: string }
  | { ok: false; status: number; message: string };

function readWechatMessage(config: AuthServiceConfig, req: Request, rawXml: string): IncomingWechatMessage {
  const encrypted = extractXml(rawXml, 'Encrypt');
  const encryptType = queryString(req, 'encrypt_type');
  if (encrypted || encryptType === 'aes') {
    if (!encrypted) return { ok: false, status: 400, message: 'encrypted message required' };
    const timestamp = queryString(req, 'timestamp');
    const nonce = queryString(req, 'nonce');
    const messageSignature = queryString(req, 'msg_signature');
    if (!config.wechat.officialToken || !config.wechat.officialEncodingAesKey || !timestamp || !nonce || !messageSignature) {
      return { ok: false, status: 403, message: 'invalid signature' };
    }
    if (!verifyWechatMessageSignature(config.wechat.officialToken, messageSignature, timestamp, nonce, encrypted)) {
      return { ok: false, status: 403, message: 'invalid signature' };
    }
    try {
      return {
        ok: true,
        encrypted: true,
        xml: decryptWechatMessage(encrypted, config.wechat.officialEncodingAesKey, config.wechat.officialAppId),
      };
    } catch (error) {
      return {
        ok: false,
        status: 400,
        message: error instanceof Error ? error.message : 'invalid encrypted message',
      };
    }
  }

  if (!isValidWechatRequest(config, req)) return { ok: false, status: 403, message: 'invalid signature' };
  return { ok: true, encrypted: false, xml: rawXml };
}

function isValidWechatRequest(config: AuthServiceConfig, req: Request): boolean {
  if (!config.wechat.signatureRequired) return true;
  const signature = queryString(req, 'signature');
  const timestamp = queryString(req, 'timestamp');
  const nonce = queryString(req, 'nonce');
  return Boolean(signature && timestamp && nonce && isValidWechatSignature(config, signature, timestamp, nonce));
}

function isValidWechatSignature(config: AuthServiceConfig, signature: string, timestamp: string, nonce: string): boolean {
  if (!config.wechat.officialToken) return !config.wechat.signatureRequired;
  return verifyWechatSignature(config.wechat.officialToken, signature, timestamp, nonce);
}

function parseWechatXml(xml: string): WechatEventMessage {
  return {
    ToUserName: extractXml(xml, 'ToUserName'),
    FromUserName: extractXml(xml, 'FromUserName'),
    MsgType: extractXml(xml, 'MsgType'),
    Event: extractXml(xml, 'Event'),
    EventKey: extractXml(xml, 'EventKey'),
  };
}

function createWechatTextReply(message: WechatEventMessage, content: string): string {
  const toUser = escapeXml(message.FromUserName || '');
  const fromUser = escapeXml(message.ToUserName || '');
  return [
    '<xml>',
    `<ToUserName><![CDATA[${toUser}]]></ToUserName>`,
    `<FromUserName><![CDATA[${fromUser}]]></FromUserName>`,
    `<CreateTime>${Math.floor(Date.now() / 1000)}</CreateTime>`,
    '<MsgType><![CDATA[text]]></MsgType>',
    `<Content><![CDATA[${escapeCdata(content)}]]></Content>`,
    '</xml>',
  ].join('');
}

function createEncryptedWechatReply(config: AuthServiceConfig, req: Request, replyXml: string): string {
  if (!config.wechat.officialToken || !config.wechat.officialEncodingAesKey || !config.wechat.officialAppId) {
    throw new Error('WECHAT_TOKEN, WECHAT_AES_KEY, and WECHAT_APP_ID are required for encrypted WeChat replies.');
  }

  const timestamp = queryString(req, 'timestamp') || `${Math.floor(Date.now() / 1000)}`;
  const nonce = queryString(req, 'nonce') || randomToken(8);
  const encrypted = encryptWechatMessage(replyXml, config.wechat.officialEncodingAesKey, config.wechat.officialAppId);
  const signature = createWechatMessageSignature(config.wechat.officialToken, timestamp, nonce, encrypted);
  return [
    '<xml>',
    `<Encrypt><![CDATA[${encrypted}]]></Encrypt>`,
    `<MsgSignature><![CDATA[${signature}]]></MsgSignature>`,
    `<TimeStamp>${timestamp}</TimeStamp>`,
    `<Nonce><![CDATA[${escapeCdata(nonce)}]]></Nonce>`,
    '</xml>',
  ].join('');
}

function normalizeSceneToken(eventKey: string): string {
  return eventKey.replace(/^qrscene_/, '').trim();
}

function extractXml(xml: string, tag: string): string | undefined {
  const match = xml.match(new RegExp(`<${tag}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>|<${tag}>([\\s\\S]*?)</${tag}>`));
  return (match?.[1] || match?.[2])?.trim();
}

function escapeXml(value: string): string {
  return value.replace(/[<>&'"]/g, (char) => {
    switch (char) {
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '&':
        return '&amp;';
      case "'":
        return '&apos;';
      case '"':
        return '&quot;';
      default:
        return char;
    }
  });
}

function escapeCdata(value: string): string {
  return value.replaceAll(']]>', ']]]]><![CDATA[>');
}

function queryString(req: Request, key: string): string | undefined {
  const value = req.query[key];
  return typeof value === 'string' ? value : undefined;
}

function asyncHandler(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: express.NextFunction): void => {
    handler(req, res).catch(next);
  };
}
