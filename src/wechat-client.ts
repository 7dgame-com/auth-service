import type { AuthServiceConfig } from './config';
import type { WechatProfile } from './types';
import { randomToken } from './crypto';

interface WechatAccessToken {
  token: string;
  expiresAtMs: number;
}

interface WechatApiError {
  errcode?: number;
  errmsg?: string;
}

interface WechatQrCodeResponse extends WechatApiError {
  ticket?: string;
  expire_seconds?: number;
  url?: string;
}

interface WechatOfficialUserInfo extends WechatApiError {
  openid?: string;
  unionid?: string;
  nickname?: string;
  headimgurl?: string;
}

interface WechatOAuthTokenResponse extends WechatApiError {
  access_token?: string;
  expires_in?: number;
  openid?: string;
  scope?: string;
  unionid?: string;
}

interface WechatOAuthUserInfo extends WechatApiError {
  openid?: string;
  unionid?: string;
  nickname?: string;
  headimgurl?: string;
}

type WechatMenuResponse = WechatApiError & Record<string, unknown>;

export interface CreateQrCodeResult {
  ticket: string;
  expire_seconds: number;
  url: string;
}

export interface WebsiteOAuthWidgetConfig {
  appId: string;
  redirectUri: string;
  scope: 'snsapi_login';
  state: string;
}

export class WechatClient {
  private accessToken: WechatAccessToken | undefined;

  constructor(private readonly config: AuthServiceConfig) {}

  get officialAppId(): string {
    return this.config.wechat.officialAppId || 'mock-wechat-app-id';
  }

  hasOfficialQrCodeConfig(): boolean {
    return this.config.allowMockWechat || Boolean(this.config.wechat.officialAppId && this.config.wechat.officialAppSecret);
  }

  hasWebsiteOAuthConfig(): boolean {
    return Boolean(this.config.wechat.websiteAppId && this.config.wechat.websiteAppSecret);
  }

  buildOfficialOAuthAuthorizeUrl(state: string): string {
    const callbackUrl = `${this.config.publicBaseUrl}/login/wechat/offiaccount/callback`;
    const url = new URL('/connect/oauth2/authorize', this.config.wechat.oauthBaseUrl);
    url.searchParams.set('appid', this.requireOfficialAppId());
    url.searchParams.set('redirect_uri', callbackUrl);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'snsapi_userinfo');
    url.searchParams.set('state', state);
    return `${url.toString()}#wechat_redirect`;
  }

  buildWebsiteOAuthAuthorizeUrl(state: string): string {
    const widget = this.buildWebsiteOAuthWidgetConfig(state);
    const url = new URL('/connect/qrconnect', this.config.wechat.oauthBaseUrl);
    url.searchParams.set('appid', widget.appId);
    url.searchParams.set('redirect_uri', widget.redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', widget.scope);
    url.searchParams.set('state', widget.state);
    return `${url.toString()}#wechat_redirect`;
  }

  buildWebsiteOAuthWidgetConfig(state: string): WebsiteOAuthWidgetConfig {
    const callbackUrl = `${this.config.publicBaseUrl}/login/wechat/website/callback`;
    return {
      appId: this.requireWebsiteAppId(),
      redirectUri: callbackUrl,
      scope: 'snsapi_login',
      state,
    };
  }

  buildOfficialQrCodeImageUrl(ticket: string): string {
    const url = new URL('/cgi-bin/showqrcode', 'https://mp.weixin.qq.com');
    url.searchParams.set('ticket', ticket);
    return url.toString();
  }

  async createTemporaryQrCode(sceneToken: string, lifetimeSeconds: number): Promise<CreateQrCodeResult> {
    if (this.config.allowMockWechat) {
      return {
        ticket: `mock-ticket-${sceneToken}`,
        expire_seconds: lifetimeSeconds,
        url: `${this.config.publicBaseUrl}/mock/wechat/scan?token=${encodeURIComponent(sceneToken)}`,
      };
    }

    const accessToken = await this.getOfficialAccessToken();
    const url = new URL('/cgi-bin/qrcode/create', this.config.wechat.apiBaseUrl);
    url.searchParams.set('access_token', accessToken);
    const result = await postJson<WechatQrCodeResponse>(url, {
      expire_seconds: lifetimeSeconds,
      action_name: 'QR_STR_SCENE',
      action_info: { scene: { scene_str: sceneToken } },
    });
    assertWechatOk(result, 'create temporary QR code');
    if (!result.ticket || !result.url) throw new Error('WeChat QR code response is missing ticket or url.');
    return {
      ticket: result.ticket,
      expire_seconds: result.expire_seconds || lifetimeSeconds,
      url: result.url,
    };
  }

  async createDefaultMenu(): Promise<WechatMenuResponse> {
    if (this.config.allowMockWechat) {
      return { errcode: 0, errmsg: 'ok' };
    }

    const accessToken = await this.getOfficialAccessToken();
    const url = new URL('/cgi-bin/menu/create', this.config.wechat.apiBaseUrl);
    url.searchParams.set('access_token', accessToken);
    const result = await postJson<WechatMenuResponse>(url, {
      button: [
        {
          name: '不加班平台',
          sub_button: [
            {
              type: 'view',
              name: '访问平台',
              url: 'https://bujiaban.com',
            },
          ],
        },
      ],
    });
    assertWechatOk(result, 'create default menu');
    return result;
  }

  async getOfficialUserInfo(openId: string): Promise<WechatProfile> {
    if (this.config.allowMockWechat) {
      return {
        provider: 'wechat_official_account',
        providerAppId: this.officialAppId,
        openId,
        unionId: `mock-union-${openId}`,
        nickname: 'Mock WeChat User',
        raw: { openid: openId, unionid: `mock-union-${openId}` },
      };
    }

    const accessToken = await this.getOfficialAccessToken();
    const url = new URL('/cgi-bin/user/info', this.config.wechat.apiBaseUrl);
    url.searchParams.set('access_token', accessToken);
    url.searchParams.set('openid', openId);
    url.searchParams.set('lang', 'zh_CN');
    const result = await getJson<WechatOfficialUserInfo>(url);
    assertWechatOk(result, 'get official account user info');
    return {
      provider: 'wechat_official_account',
      providerAppId: this.requireOfficialAppId(),
      openId,
      unionId: result.unionid,
      nickname: result.nickname,
      avatarUrl: result.headimgurl,
      raw: result as Record<string, unknown>,
    };
  }

  async exchangeOfficialOAuthCode(code: string): Promise<WechatProfile> {
    if (this.config.allowMockWechat) {
      return this.getOfficialUserInfo(`mock-oauth-openid-${randomToken(6)}`);
    }

    const tokenUrl = new URL('/sns/oauth2/access_token', this.config.wechat.apiBaseUrl);
    tokenUrl.searchParams.set('appid', this.requireOfficialAppId());
    tokenUrl.searchParams.set('secret', this.requireOfficialSecret());
    tokenUrl.searchParams.set('code', code);
    tokenUrl.searchParams.set('grant_type', 'authorization_code');
    const token = await getJson<WechatOAuthTokenResponse>(tokenUrl);
    assertWechatOk(token, 'exchange official OAuth code');
    if (!token.access_token || !token.openid) throw new Error('WeChat OAuth response is missing access_token or openid.');

    const userInfoUrl = new URL('/sns/userinfo', this.config.wechat.apiBaseUrl);
    userInfoUrl.searchParams.set('access_token', token.access_token);
    userInfoUrl.searchParams.set('openid', token.openid);
    userInfoUrl.searchParams.set('lang', 'zh_CN');
    const profile = await getJson<WechatOAuthUserInfo>(userInfoUrl);
    assertWechatOk(profile, 'get official OAuth user info');
    return {
      provider: 'wechat_official_account',
      providerAppId: this.requireOfficialAppId(),
      openId: token.openid,
      unionId: profile.unionid || token.unionid,
      nickname: profile.nickname,
      avatarUrl: profile.headimgurl,
      raw: { token, profile },
    };
  }

  async exchangeWebsiteOAuthCode(code: string): Promise<WechatProfile> {
    if (this.config.allowMockWechat) {
      const openId = `mock-website-openid-${randomToken(6)}`;
      return {
        provider: 'wechat_website',
        providerAppId: this.config.wechat.websiteAppId || 'mock-wechat-website-app-id',
        openId,
        unionId: `mock-website-union-${openId}`,
        nickname: 'Mock Website WeChat User',
        raw: { openid: openId, unionid: `mock-website-union-${openId}` },
      };
    }

    const tokenUrl = new URL('/sns/oauth2/access_token', this.config.wechat.apiBaseUrl);
    tokenUrl.searchParams.set('appid', this.requireWebsiteAppId());
    tokenUrl.searchParams.set('secret', this.requireWebsiteSecret());
    tokenUrl.searchParams.set('code', code);
    tokenUrl.searchParams.set('grant_type', 'authorization_code');
    const token = await getJson<WechatOAuthTokenResponse>(tokenUrl);
    assertWechatOk(token, 'exchange website OAuth code');
    if (!token.access_token || !token.openid) throw new Error('WeChat website OAuth response is missing access_token or openid.');

    const userInfoUrl = new URL('/sns/userinfo', this.config.wechat.apiBaseUrl);
    userInfoUrl.searchParams.set('access_token', token.access_token);
    userInfoUrl.searchParams.set('openid', token.openid);
    userInfoUrl.searchParams.set('lang', 'zh_CN');
    const profile = await getJson<WechatOAuthUserInfo>(userInfoUrl);
    assertWechatOk(profile, 'get website OAuth user info');
    return {
      provider: 'wechat_website',
      providerAppId: this.requireWebsiteAppId(),
      openId: token.openid,
      unionId: profile.unionid || token.unionid,
      nickname: profile.nickname,
      avatarUrl: profile.headimgurl,
      raw: { token, profile },
    };
  }

  private async getOfficialAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.accessToken && this.accessToken.expiresAtMs > now + 60_000) return this.accessToken.token;

    const url = new URL('/cgi-bin/token', this.config.wechat.apiBaseUrl);
    url.searchParams.set('grant_type', 'client_credential');
    url.searchParams.set('appid', this.requireOfficialAppId());
    url.searchParams.set('secret', this.requireOfficialSecret());
    const result = await getJson<WechatOAuthTokenResponse>(url);
    assertWechatOk(result, 'get official account access token');
    if (!result.access_token) throw new Error('WeChat access token response is missing access_token.');
    this.accessToken = {
      token: result.access_token,
      expiresAtMs: now + (result.expires_in || 7200) * 1000,
    };
    return this.accessToken.token;
  }

  private requireOfficialAppId(): string {
    if (!this.config.wechat.officialAppId) throw new Error('AUTH_WECHAT_OFFICIAL_APP_ID or WECHAT_APP_ID is required.');
    return this.config.wechat.officialAppId;
  }

  private requireOfficialSecret(): string {
    if (!this.config.wechat.officialAppSecret) throw new Error('AUTH_WECHAT_OFFICIAL_APP_SECRET or WECHAT_SECRET is required.');
    return this.config.wechat.officialAppSecret;
  }

  private requireWebsiteAppId(): string {
    if (!this.config.wechat.websiteAppId) throw new Error('AUTH_WECHAT_WEBSITE_APP_ID or WECHAT_WEBSITE_APP_ID is required.');
    return this.config.wechat.websiteAppId;
  }

  private requireWebsiteSecret(): string {
    if (!this.config.wechat.websiteAppSecret) {
      throw new Error('AUTH_WECHAT_WEBSITE_APP_SECRET or WECHAT_WEBSITE_APP_SECRET is required.');
    }
    return this.config.wechat.websiteAppSecret;
  }
}

async function getJson<T>(url: URL): Promise<T> {
  const response = await fetch(url);
  return parseWechatResponse<T>(response);
}

async function postJson<T>(url: URL, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return parseWechatResponse<T>(response);
}

async function parseWechatResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!response.ok) throw new Error(`WeChat HTTP ${response.status}: ${text}`);
  return JSON.parse(text) as T;
}

function assertWechatOk(result: WechatApiError, action: string): void {
  if (result.errcode && result.errcode !== 0) {
    throw new Error(`WeChat failed to ${action}: ${result.errcode} ${result.errmsg || ''}`.trim());
  }
}
