export type AuthIdentityProvider = 'wechat_official_account' | 'wechat_website' | 'wechat_mini_program';

export interface AuthUser {
  id: string;
  primaryUnionId?: string;
  displayName?: string;
  avatarUrl?: string;
  status: 'active' | 'disabled';
  createdAt: string;
  updatedAt: string;
}

export interface AuthIdentity {
  id: string;
  userId: string;
  provider: AuthIdentityProvider;
  providerAppId: string;
  openId: string;
  unionId?: string;
  profile?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface LegacyScanToken {
  token: string;
  providerAppId: string;
  openId: string;
  scene?: string;
  expiresAt: string;
  consumedAt?: string;
  createdAt: string;
}

export interface LegacyLoginToken {
  tokenHash: string;
  userId: string;
  providerAppId: string;
  openId: string;
  unionId?: string;
  expiresAt: string;
  revokedAt?: string;
  createdAt: string;
}

export interface OAuthClient {
  clientId: string;
  clientSecret?: string;
  name: string;
  redirectUris: string[];
  allowedOrigins: string[];
  scopes: string[];
  publicClient: boolean;
}

export interface OAuthAuthorizationCode {
  codeHash: string;
  clientId: string;
  userId: string;
  redirectUri: string;
  codeChallenge?: string;
  codeChallengeMethod?: 'plain' | 'S256';
  scopes: string[];
  expiresAt: string;
  consumedAt?: string;
  createdAt: string;
}

export interface OAuthRefreshToken {
  tokenHash: string;
  clientId: string;
  userId: string;
  scopes: string[];
  expiresAt: string;
  revokedAt?: string;
  createdAt: string;
}

export interface WechatProfile {
  provider: AuthIdentityProvider;
  providerAppId: string;
  openId: string;
  unionId?: string;
  nickname?: string;
  avatarUrl?: string;
  raw?: Record<string, unknown>;
}

export interface UpsertIdentityResult {
  user: AuthUser;
  identity: AuthIdentity;
  isNewIdentity: boolean;
}
