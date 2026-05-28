import type {
  AuthUser,
  LegacyLoginToken,
  LegacyScanToken,
  LegacyWechatLoginResult,
  OAuthAuthorizationCode,
  OAuthRefreshToken,
  UpsertIdentityResult,
  WechatProfile,
} from './types';

export interface AuthStore {
  migrate(): Promise<void>;
  saveLegacyScanToken(token: LegacyScanToken): Promise<void>;
  findLegacyScanToken(token: string): Promise<LegacyScanToken | undefined>;
  upsertWechatIdentity(profile: WechatProfile): Promise<UpsertIdentityResult>;
  completeLegacyWechatLogin(profile: WechatProfile): Promise<LegacyWechatLoginResult>;
  createLegacyLoginToken(token: LegacyLoginToken): Promise<void>;
  createAuthorizationCode(code: OAuthAuthorizationCode): Promise<void>;
  consumeAuthorizationCode(codeHash: string): Promise<OAuthAuthorizationCode | undefined>;
  createRefreshToken(token: OAuthRefreshToken): Promise<void>;
  findRefreshToken(tokenHash: string): Promise<OAuthRefreshToken | undefined>;
  revokeRefreshToken(tokenHash: string): Promise<void>;
  findUserById(userId: string): Promise<AuthUser | undefined>;
}

export function addSeconds(date: Date, seconds: number): string {
  return new Date(date.getTime() + seconds * 1000).toISOString();
}

export function isFuture(isoDate: string | undefined): boolean {
  return Boolean(isoDate && new Date(isoDate).getTime() > Date.now());
}
