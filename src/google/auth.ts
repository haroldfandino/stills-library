import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { GoogleApiError } from './types.js';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
export const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const DRIVE_METADATA_SCOPE = 'https://www.googleapis.com/auth/drive.metadata.readonly';
export const DEFAULT_GOOGLE_SCOPES = ['openid', 'email', DRIVE_FILE_SCOPE, DRIVE_METADATA_SCOPE] as const;

export interface StoredGoogleTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  email: string;
  scope: string;
}

/** Implement with an OS-protected credential vault; the module never writes tokens to disk. */
export interface GoogleTokenStore {
  load(): Promise<StoredGoogleTokens | null>;
  save(tokens: StoredGoogleTokens): Promise<void>;
  clear(): Promise<void>;
}

export class MemoryGoogleTokenStore implements GoogleTokenStore {
  private tokens: StoredGoogleTokens | null = null;
  async load(): Promise<StoredGoogleTokens | null> { return this.tokens; }
  async save(tokens: StoredGoogleTokens): Promise<void> { this.tokens = tokens; }
  async clear(): Promise<void> { this.tokens = null; }
}

export interface GoogleAuthOptions {
  clientId: string;
  clientSecret?: string;
  tokenStore: GoogleTokenStore;
  /** In Electron, inject shell.openExternal. Must launch the system browser. */
  openBrowser(url: string): Promise<unknown> | unknown;
  expectedEmail?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface PickerOptions {
  fileIds?: string[];
  allowFolders?: boolean;
  allowMultiple?: boolean;
  mimeTypes?: string[];
}

interface OAuthCode {
  code: string;
  redirectUri: string;
  verifier: string;
  pickedFileIds: string[];
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

function base64url(bytes: Buffer): string {
  return bytes.toString('base64url');
}

function safeError(body: unknown, status: number, endpoint: string): GoogleApiError {
  const record = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  const detail = record.error_description && typeof record.error_description === 'string'
    ? record.error_description
    : typeof record.error === 'string' ? record.error : `Google returned HTTP ${status}`;
  return new GoogleApiError(detail, status, typeof record.error === 'string' ? record.error : 'oauth_error', endpoint);
}

function hasDriveScopes(scope: string | undefined): boolean {
  const values = new Set((scope ?? '').split(/\s+/).filter(Boolean));
  return values.has(DRIVE_FILE_SCOPE) && values.has(DRIVE_METADATA_SCOPE);
}

export class GoogleAuth {
  private readonly clientId: string;
  private readonly clientSecret?: string;
  private readonly tokenStore: GoogleTokenStore;
  private readonly openBrowser: GoogleAuthOptions['openBrowser'];
  private readonly expectedEmail: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private refreshInFlight: Promise<string> | null = null;

  constructor(options: GoogleAuthOptions) {
    if (!options.clientId.trim()) throw new Error('Google desktop OAuth client ID is required.');
    this.clientId = options.clientId.trim();
    this.clientSecret = options.clientSecret;
    this.tokenStore = options.tokenStore;
    this.openBrowser = options.openBrowser;
    this.expectedEmail = (options.expectedEmail ?? 'harold@filmkraft.tv').trim().toLowerCase();
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 180_000;
  }

  get requiredEmail(): string { return this.expectedEmail; }

  async currentEmail(): Promise<string | null> {
    const tokens = await this.tokenStore.load();
    return tokens?.email.toLowerCase() === this.expectedEmail ? tokens.email : null;
  }

  async signIn(): Promise<string> {
    const code = await this.authorize([...DEFAULT_GOOGLE_SCOPES]);
    const response = await this.exchangeCode(code);
    if (!response.access_token) throw new GoogleApiError('Google did not return an access token.', 502, 'missing_token');
    if (!hasDriveScopes(response.scope)) {
      throw new GoogleApiError('Grant both Drive file access and read-only Drive metadata access to check existing names safely.', 403, 'missing_required_scope');
    }
    const email = await this.fetchEmail(response.access_token);
    if (email.toLowerCase() !== this.expectedEmail) {
      await this.tokenStore.clear();
      throw new GoogleApiError(`Sign in with ${this.expectedEmail}; Google returned ${email}.`, 403, 'wrong_account');
    }
    const previous = await this.tokenStore.load();
    const refreshToken = response.refresh_token ?? (previous?.email.toLowerCase() === email.toLowerCase() ? previous.refreshToken : undefined);
    await this.tokenStore.save({
      accessToken: response.access_token,
      refreshToken,
      expiresAt: Date.now() + Math.max(0, response.expires_in ?? 3600) * 1000,
      email,
      scope: response.scope!, // hasDriveScopes above rejects missing scope responses
    });
    return email;
  }

  /**
   * Grants this OAuth client access to pre-existing files selected by the user.
   * Google requires the Picker request itself to use ONLY drive.file. It does not
   * replace the normal session token, which also carries read-only metadata scope.
   */
  async pickFiles(options: PickerOptions = {}): Promise<string[]> {
    await this.getAccessToken();
    const extra: Record<string, string> = {
      prompt: 'consent', trigger_onepick: 'true', include_granted_scopes: 'false',
    };
    if (options.fileIds?.length) extra.file_ids = options.fileIds.join(',');
    if (options.allowFolders) extra.allow_folder_selection = 'true';
    if (options.allowMultiple) extra.allow_multiple = 'true';
    if (options.mimeTypes?.length) extra.mimetypes = options.mimeTypes.join(',');
    const code = await this.authorize([DRIVE_FILE_SCOPE], extra);
    await this.exchangeCode(code); // Google requires exchanging Picker's authorization code.
    return code.pickedFileIds;
  }

  async getAccessToken(forceRefresh = false): Promise<string> {
    const tokens = await this.tokenStore.load();
    if (!tokens || tokens.email.toLowerCase() !== this.expectedEmail) {
      throw new GoogleApiError(`Sign in with ${this.expectedEmail} in Stills Library.`, 401, 'auth_required');
    }
    if (!hasDriveScopes(tokens.scope)) {
      throw new GoogleApiError('Google session lacks required Drive access; sign in again and grant all requested permissions.', 403, 'missing_required_scope');
    }
    if (!forceRefresh && tokens.accessToken && tokens.expiresAt > Date.now() + 60_000) return tokens.accessToken;
    if (!tokens.refreshToken) throw new GoogleApiError('Google session expired; sign in again.', 401, 'auth_required');
    if (this.refreshInFlight) return this.refreshInFlight;
    this.refreshInFlight = this.refresh(tokens);
    try { return await this.refreshInFlight; }
    finally { this.refreshInFlight = null; }
  }

  async signOut(): Promise<void> { await this.tokenStore.clear(); }

  private async refresh(tokens: StoredGoogleTokens): Promise<string> {
    const body = new URLSearchParams({
      client_id: this.clientId,
      refresh_token: tokens.refreshToken!,
      grant_type: 'refresh_token',
    });
    let response: TokenResponse;
    try { response = await this.postToken(body); }
    catch (error) {
      if (error instanceof GoogleApiError && error.code === 'invalid_grant') await this.tokenStore.clear();
      throw error;
    }
    if (!response.access_token) throw new GoogleApiError('Google did not refresh the access token.', 502, 'missing_token');
    if (response.scope && !hasDriveScopes(response.scope)) {
      throw new GoogleApiError('Refreshed Google token lacks required Drive access; sign in again.', 403, 'missing_required_scope');
    }
    await this.tokenStore.save({
      ...tokens,
      accessToken: response.access_token,
      refreshToken: response.refresh_token ?? tokens.refreshToken,
      expiresAt: Date.now() + Math.max(0, response.expires_in ?? 3600) * 1000,
      scope: response.scope ?? tokens.scope,
    });
    return response.access_token;
  }

  private async fetchEmail(accessToken: string): Promise<string> {
    const response = await this.fetchImpl(USERINFO_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
    const data = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) throw safeError(data, response.status, USERINFO_URL);
    if (typeof data.email !== 'string' || !data.email) throw new GoogleApiError('Google did not return an account email.', 502, 'missing_email');
    if (data.email_verified === false) throw new GoogleApiError('The Google account email is unverified.', 403, 'unverified_email');
    return data.email;
  }

  private async exchangeCode(code: OAuthCode): Promise<TokenResponse> {
    return this.postToken(new URLSearchParams({
      client_id: this.clientId,
      code: code.code,
      code_verifier: code.verifier,
      redirect_uri: code.redirectUri,
      grant_type: 'authorization_code',
    }));
  }

  private async postToken(body: URLSearchParams): Promise<TokenResponse> {
    if (this.clientSecret) body.set('client_secret', this.clientSecret);
    const response = await this.fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(30_000),
    });
    const data = await response.json().catch(() => ({})) as TokenResponse;
    if (!response.ok) throw safeError(data, response.status, TOKEN_URL);
    return data;
  }

  private async authorize(scopes: string[], extra: Record<string, string> = {}): Promise<OAuthCode> {
    const state = base64url(randomBytes(24));
    const verifier = base64url(randomBytes(48));
    const challenge = base64url(createHash('sha256').update(verifier).digest());
    let server!: Server;
    let resolveCallback!: (value: URLSearchParams) => void;
    let rejectCallback!: (error: Error) => void;
    const callback = new Promise<URLSearchParams>((resolve, reject) => {
      resolveCallback = resolve;
      rejectCallback = reject;
    });
    server = createServer((request, response) => {
      if (request.method !== 'GET') { response.writeHead(405).end(); return; }
      const address = server.address();
      if (!address || typeof address === 'string' || request.headers.host !== `127.0.0.1:${address.port}`) {
        response.writeHead(400).end('Invalid callback host.');
        return;
      }
      const url = new URL(request.url ?? '/', `http://127.0.0.1:${address.port}`);
      if (url.pathname !== '/oauth2/callback') { response.writeHead(404).end(); return; }
      if (url.searchParams.get('state') !== state) {
        response.writeHead(400).end('Invalid OAuth state.');
        return;
      }
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
        .end('<!doctype html><title>Stills Library</title><p>You can return to Stills Library.</p>');
      if (url.searchParams.has('error')) {
        rejectCallback(new GoogleApiError(`Google authorization: ${url.searchParams.get('error')}`, 403, 'oauth_denied'));
      } else {
        resolveCallback(url.searchParams);
      }
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Could not create OAuth loopback listener.');
    const redirectUri = `http://127.0.0.1:${address.port}/oauth2/callback`;
    const authUrl = new URL(AUTH_URL);
    const params: Record<string, string> = {
      client_id: this.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: scopes.join(' '),
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
      access_type: 'offline',
      login_hint: this.expectedEmail,
      prompt: 'consent',
      ...extra,
    };
    Object.entries(params).forEach(([key, value]) => authUrl.searchParams.set(key, value));
    const timeout = setTimeout(() => rejectCallback(new GoogleApiError('Google sign-in timed out.', 408, 'oauth_timeout')), this.timeoutMs);
    try {
      Promise.resolve().then(() => this.openBrowser(authUrl.toString())).catch(error => rejectCallback(error instanceof Error ? error : new Error(String(error))));
      const query = await callback;
      const code = query.get('code');
      if (!code) throw new GoogleApiError('Google did not return an authorization code.', 502, 'missing_code');
      return {
        code,
        redirectUri,
        verifier,
        pickedFileIds: (query.get('picked_file_ids') ?? '').split(',').map(id => id.trim()).filter(Boolean),
      };
    } finally {
      clearTimeout(timeout);
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }
}
