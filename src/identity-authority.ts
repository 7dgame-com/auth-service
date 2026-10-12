import type { AuthServiceConfig } from './config';
import type { AuthStore } from './store';
import type { AuthUser, LegacyLoginToken, LegacyScanToken, LegacySceneMetadata, LegacyWechatLoginResult, OAuthAuthorizationCode, OAuthRefreshToken, UpsertIdentityResult, WechatProfile } from './types';

export class IdentityAuthorityError extends Error {
  constructor(readonly status: number, readonly body: unknown) { super('Identity authority request failed'); }
}

/** The provider holds neither account records nor refresh credentials in identity mode. */
export class IdentityAuthority {
  constructor(private readonly settings: NonNullable<AuthServiceConfig['identityApi']>) {}

  async request<T = unknown>(path: string, body?: unknown, authorization?: string): Promise<T> {
    try {
      const response = await fetch(`${this.settings.baseUrl}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'x-identity-internal-token': this.settings.internalToken, 'content-type': 'application/json',
          ...(authorization ? { authorization } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.settings.timeoutMs),
        redirect: 'error',
      });
      const data: unknown = await response.json();
      if (!response.ok) throw new IdentityAuthorityError(response.status, data);
      return data as T;
    } catch (error) {
      if (error instanceof IdentityAuthorityError) throw error;
      throw new IdentityAuthorityError(503, { error: 'temporarily_unavailable' });
    }
  }

  token(body: unknown) { return this.request('/internal/wechat-oauth/token', body); }
  revoke(token: string) { return this.request('/internal/wechat-oauth/revoke', { token }); }
  userinfo(authorization?: string) { return this.request('/internal/wechat-oauth/userinfo', {}, authorization); }
  metadata() { return this.request<{ issuer: string; keys: Record<string, unknown>[] }>('/internal/wechat-oauth/metadata'); }
}

export class IdentityAuthStore implements AuthStore {
  readonly identityAuthority: IdentityAuthority;
  constructor(settings: NonNullable<AuthServiceConfig['identityApi']>) { this.identityAuthority = new IdentityAuthority(settings); }
  async migrate() { /* The authority owns its schema. */ }
  async saveLegacySceneMetadata(_metadata: LegacySceneMetadata): Promise<void> { return this.unsupported(); }
  async findLegacySceneMetadata(_sceneDigest: string): Promise<LegacySceneMetadata | undefined> { return this.unsupported(); }
  async saveLegacyScanToken(token: LegacyScanToken) {
    await this.identityAuthority.request('/internal/wechat-provider/confirm-scan', {
      scene: token.scene || token.token, openId: token.openId, providerAppId: token.providerAppId,
    });
  }
  async upsertWechatIdentity(profile: WechatProfile): Promise<UpsertIdentityResult> {
    return this.identityAuthority.request('/internal/wechat-oauth/resolve', { profile });
  }
  async createAuthorizationCode(code: OAuthAuthorizationCode) {
    await this.identityAuthority.request('/internal/wechat-oauth/code', code);
  }
  async findUserById(userId: string): Promise<AuthUser | undefined> {
    return this.identityAuthority.request('/internal/wechat-oauth/user', { userId });
  }
  async findLegacyScanToken(_token: string): Promise<LegacyScanToken | undefined> { return this.unsupported(); }
  async completeLegacyWechatLogin(_profile: WechatProfile): Promise<LegacyWechatLoginResult> { return this.unsupported(); }
  async createLegacyLoginToken(_token: LegacyLoginToken): Promise<void> { return this.unsupported(); }
  async consumeAuthorizationCode(_codeHash: string): Promise<OAuthAuthorizationCode | undefined> { return this.unsupported(); }
  async createRefreshToken(_token: OAuthRefreshToken): Promise<void> { return this.unsupported(); }
  async findRefreshToken(_tokenHash: string): Promise<OAuthRefreshToken | undefined> { return this.unsupported(); }
  async revokeRefreshToken(_tokenHash: string): Promise<void> { return this.unsupported(); }
  private unsupported(): never { throw new Error('This operation must be performed atomically by Identity authority'); }
}
