import { randomUUID } from 'crypto';
import type {
  AuthIdentity,
  AuthIdentityProvider,
  AuthUser,
  LegacyLoginToken,
  LegacyScanToken,
  LegacyWechatLoginResult,
  OAuthAuthorizationCode,
  OAuthRefreshToken,
  UpsertIdentityResult,
  WechatProfile,
} from './types';
import { AuthStore, isFuture } from './store';
import { randomToken } from './crypto';

interface LegacyWechatRow {
  openId: string;
  unionId?: string;
  userId?: string;
  token?: string;
}

export class MemoryAuthStore implements AuthStore {
  private readonly users = new Map<string, AuthUser>();
  private readonly identities = new Map<string, AuthIdentity>();
  private readonly scanTokens = new Map<string, LegacyScanToken>();
  private readonly legacyWechatRows = new Map<string, LegacyWechatRow>();
  private readonly legacyLoginTokens = new Map<string, LegacyLoginToken>();
  private readonly authorizationCodes = new Map<string, OAuthAuthorizationCode>();
  private readonly refreshTokens = new Map<string, OAuthRefreshToken>();

  async migrate(): Promise<void> {
    return undefined;
  }

  async saveLegacyScanToken(token: LegacyScanToken): Promise<void> {
    this.scanTokens.set(token.token, token);
  }

  async findLegacyScanToken(token: string): Promise<LegacyScanToken | undefined> {
    const scanToken = this.scanTokens.get(token);
    if (!scanToken || !isFuture(scanToken.expiresAt)) return undefined;
    return scanToken;
  }

  async upsertWechatIdentity(profile: WechatProfile): Promise<UpsertIdentityResult> {
    const identityKey = createIdentityKey(profile.provider, profile.providerAppId, profile.openId);
    const existingIdentity = this.identities.get(identityKey);
    const now = new Date().toISOString();

    if (existingIdentity) {
      const existingUser = this.users.get(existingIdentity.userId);
      if (!existingUser) throw new Error(`Auth user ${existingIdentity.userId} is missing`);
      const user = mergeUserProfile(existingUser, profile, now);
      const identity: AuthIdentity = {
        ...existingIdentity,
        unionId: profile.unionId || existingIdentity.unionId,
        profile: profile.raw || existingIdentity.profile,
        updatedAt: now,
      };
      this.users.set(user.id, user);
      this.identities.set(identityKey, identity);
      return { user, identity, isNewIdentity: false };
    }

    const matchedUser = this.findUserByUnionId(profile.unionId);
    const user = mergeUserProfile(matchedUser || createUser(profile, now), profile, now);
    this.users.set(user.id, user);
    const identity: AuthIdentity = {
      id: randomUUID(),
      userId: user.id,
      provider: profile.provider,
      providerAppId: profile.providerAppId,
      openId: profile.openId,
      unionId: profile.unionId,
      profile: profile.raw,
      createdAt: now,
      updatedAt: now,
    };
    this.identities.set(identityKey, identity);
    return { user, identity, isNewIdentity: true };
  }

  async completeLegacyWechatLogin(profile: WechatProfile): Promise<LegacyWechatLoginResult> {
    const existing = this.legacyWechatRows.get(profile.openId);
    const token = randomToken(32);
    const row: LegacyWechatRow = {
      openId: profile.openId,
      unionId: existing?.unionId || profile.unionId,
      userId: existing?.userId,
      token,
    };
    this.legacyWechatRows.set(profile.openId, row);
    return {
      openId: row.openId,
      unionId: row.unionId,
      userId: row.userId,
      token,
      isRegistered: Boolean(row.userId),
    };
  }

  seedLegacyWechatUser(openId: string, userId = '1', unionId?: string): void {
    this.legacyWechatRows.set(openId, { openId, userId, unionId });
  }

  async createLegacyLoginToken(token: LegacyLoginToken): Promise<void> {
    this.legacyLoginTokens.set(token.tokenHash, token);
  }

  async createAuthorizationCode(code: OAuthAuthorizationCode): Promise<void> {
    this.authorizationCodes.set(code.codeHash, code);
  }

  async consumeAuthorizationCode(codeHash: string): Promise<OAuthAuthorizationCode | undefined> {
    const code = this.authorizationCodes.get(codeHash);
    if (!code || code.consumedAt || !isFuture(code.expiresAt)) return undefined;
    this.authorizationCodes.set(codeHash, { ...code, consumedAt: new Date().toISOString() });
    return code;
  }

  async createRefreshToken(token: OAuthRefreshToken): Promise<void> {
    this.refreshTokens.set(token.tokenHash, token);
  }

  async findRefreshToken(tokenHash: string): Promise<OAuthRefreshToken | undefined> {
    const token = this.refreshTokens.get(tokenHash);
    if (!token || token.revokedAt || !isFuture(token.expiresAt)) return undefined;
    return token;
  }

  async revokeRefreshToken(tokenHash: string): Promise<void> {
    const token = this.refreshTokens.get(tokenHash);
    if (token) this.refreshTokens.set(tokenHash, { ...token, revokedAt: new Date().toISOString() });
  }

  async findUserById(userId: string): Promise<AuthUser | undefined> {
    return this.users.get(userId);
  }

  async findPrimaryWechatIdentity(userId: string): Promise<AuthIdentity | undefined> {
    return Array.from(this.identities.values()).find((identity) => identity.userId === userId);
  }

  private findUserByUnionId(unionId: string | undefined): AuthUser | undefined {
    if (!unionId) return undefined;
    return Array.from(this.users.values()).find((user) => user.primaryUnionId === unionId);
  }
}

function createIdentityKey(provider: AuthIdentityProvider, providerAppId: string, openId: string): string {
  return `${provider}:${providerAppId}:${openId}`;
}

function createUser(profile: WechatProfile, now: string): AuthUser {
  return {
    id: randomUUID(),
    primaryUnionId: profile.unionId,
    displayName: profile.nickname,
    avatarUrl: profile.avatarUrl,
    status: 'active',
    createdAt: now,
    updatedAt: now,
  };
}

function mergeUserProfile(user: AuthUser, profile: WechatProfile, now: string): AuthUser {
  return {
    ...user,
    primaryUnionId: user.primaryUnionId || profile.unionId,
    displayName: profile.nickname || user.displayName,
    avatarUrl: profile.avatarUrl || user.avatarUrl,
    updatedAt: now,
  };
}
