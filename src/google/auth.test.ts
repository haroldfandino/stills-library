import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_GOOGLE_SCOPES, DRIVE_SCOPE, DRIVE_FILE_SCOPE, DRIVE_METADATA_SCOPE, GoogleAuth, MemoryGoogleTokenStore,
} from './auth.js';

const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });

describe('Google desktop OAuth', () => {
  it('requires a new consent for legacy file-only tokens without deleting them or silently refreshing', async () => {
    const tokenStore = new MemoryGoogleTokenStore();
    const old = { accessToken: 'legacy', refreshToken: 'legacy-refresh', email: 'harold@filmkraft.tv', expiresAt: Date.now() + 3600000, scope: `${DRIVE_FILE_SCOPE} ${DRIVE_METADATA_SCOPE}` };
    await tokenStore.save(old);
    const fetchImpl = vi.fn();
    const openBrowser = vi.fn();
    const auth = new GoogleAuth({ clientId: 'desktop-client-id', tokenStore, fetchImpl, openBrowser });
    expect(await auth.currentEmail()).toBeNull();
    await expect(auth.getAccessToken()).rejects.toMatchObject({ code: 'missing_required_scope' });
    expect(await tokenStore.load()).toEqual(old);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(openBrowser).not.toHaveBeenCalled();
  });
  it('uses imported client configuration for both code exchange and refresh without placing its secret in the browser URL', async () => {
    const tokenStore = new MemoryGoogleTokenStore();
    const requests: URLSearchParams[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!String(input).includes('/token')) return json({ email: 'harold@filmkraft.tv', email_verified: true });
      requests.push(new URLSearchParams(String(init?.body)));
      return json({ access_token: `token-${requests.length}`, refresh_token: 'refresh', expires_in: 3600,
        scope: DRIVE_SCOPE });
    }) as unknown as typeof fetch;
    const auth = new GoogleAuth({ clientId: 'desktop-client-id', clientSecret: 'test-secret', tokenStore, fetchImpl,
      openBrowser: async value => {
        const url = new URL(value);
        expect(url.searchParams.has('client_secret')).toBe(false);
        const callback = new URL(url.searchParams.get('redirect_uri')!);
        callback.searchParams.set('state', url.searchParams.get('state')!);
        callback.searchParams.set('code', 'test-code');
        await fetch(callback);
      } });
    await auth.signIn();
    expect(await auth.getAccessToken(true)).toBe('token-2');
    expect(requests.map(body => body.get('grant_type'))).toEqual(['authorization_code', 'refresh_token']);
    expect(requests.every(body => body.get('client_secret') === 'test-secret')).toBe(true);
  });

  it('ignores forged callback state and wrong methods, then accepts the real callback', async () => {
    const tokenStore = new MemoryGoogleTokenStore();
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => String(input).includes('/token')
      ? json({ access_token: 'token', scope: DRIVE_SCOPE })
      : json({ email: 'harold@filmkraft.tv', email_verified: true })) as unknown as typeof fetch;
    const auth = new GoogleAuth({ clientId: 'desktop-client-id', tokenStore, fetchImpl,
      openBrowser: async value => {
        const url = new URL(value);
        const callback = new URL(url.searchParams.get('redirect_uri')!);
        callback.searchParams.set('code', 'test-code');
        callback.searchParams.set('state', 'forged');
        expect((await fetch(callback)).status).toBe(400);
        callback.searchParams.set('state', url.searchParams.get('state')!);
        expect((await fetch(callback, { method: 'POST' })).status).toBe(405);
        expect((await fetch(callback)).status).toBe(200);
      } });
    expect(await auth.signIn()).toBe('harold@filmkraft.tv');
  });

  it('closes the callback listener when opening the browser fails', async () => {
    let redirect = '';
    const auth = new GoogleAuth({ clientId: 'desktop-client-id', tokenStore: new MemoryGoogleTokenStore(),
      openBrowser: value => { redirect = new URL(value).searchParams.get('redirect_uri')!; throw new Error('No default browser'); } });
    await expect(auth.signIn()).rejects.toThrow('No default browser');
    await expect(fetch(redirect)).rejects.toThrow();
  });

  it('requests full Drive access through loopback PKCE without opening a picker', async () => {
    const seenScopes: string[][] = [];
    const tokenStore = new MemoryGoogleTokenStore();
    const openBrowser = vi.fn(async (value: string) => {
      const authUrl = new URL(value);
      const scope = authUrl.searchParams.get('scope')?.split(' ') ?? [];
      seenScopes.push(scope);
      expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256');
      expect(authUrl.searchParams.get('code_challenge')).toBeTruthy();
      if (authUrl.searchParams.has('trigger_onepick')) {
        expect(authUrl.searchParams.get('include_granted_scopes')).toBe('false');
      }
      const callback = new URL(authUrl.searchParams.get('redirect_uri')!);
      callback.searchParams.set('state', authUrl.searchParams.get('state')!);
      callback.searchParams.set('code', `code-${seenScopes.length}`);
      if (authUrl.searchParams.has('trigger_onepick')) callback.searchParams.set('picked_file_ids', 'sheet-id,folder-id');
      await fetch(callback);
    });
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/token')) return json({ access_token: 'token', refresh_token: 'refresh', expires_in: 3600, scope: DRIVE_SCOPE });
      return json({ email: 'harold@filmkraft.tv', email_verified: true });
    }) as unknown as typeof fetch;
    const auth = new GoogleAuth({ clientId: 'desktop-client-id', tokenStore, openBrowser, fetchImpl });
    expect(await auth.signIn()).toBe('harold@filmkraft.tv');
    expect(seenScopes).toEqual([[...DEFAULT_GOOGLE_SCOPES]]);
    expect(seenScopes[0]).toContain(DRIVE_SCOPE);
    expect(openBrowser).toHaveBeenCalledTimes(1);
    expect(await auth.currentEmail()).toBe('harold@filmkraft.tv');
    expect(await auth.getAccessToken()).toBe('token');
  });

  it('rejects a different account before saving credentials', async () => {
    const tokenStore = new MemoryGoogleTokenStore();
    const openBrowser = async (value: string) => {
      const authUrl = new URL(value);
      const callback = new URL(authUrl.searchParams.get('redirect_uri')!);
      callback.searchParams.set('state', authUrl.searchParams.get('state')!);
      callback.searchParams.set('code', 'code');
      await fetch(callback);
    };
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes('/token') ? json({ access_token: 'token', refresh_token: 'refresh', expires_in: 3600, scope: DRIVE_SCOPE })
        : json({ email: 'someone@example.com', email_verified: true })) as unknown as typeof fetch;
    const auth = new GoogleAuth({ clientId: 'desktop-client-id', tokenStore, openBrowser, fetchImpl });
    await expect(auth.signIn()).rejects.toMatchObject({ code: 'wrong_account' });
    expect(await tokenStore.load()).toBeNull();
  });

  it('refuses partial consent that would hide existing Drive filenames', async () => {
    const tokenStore = new MemoryGoogleTokenStore();
    const openBrowser = async (value: string) => {
      const authUrl = new URL(value);
      const callback = new URL(authUrl.searchParams.get('redirect_uri')!);
      callback.searchParams.set('state', authUrl.searchParams.get('state')!);
      callback.searchParams.set('code', 'code');
      await fetch(callback);
    };
    const fetchImpl = vi.fn(async () => json({ access_token: 'token', refresh_token: 'refresh', expires_in: 3600, scope: DRIVE_FILE_SCOPE })) as unknown as typeof fetch;
    const auth = new GoogleAuth({ clientId: 'desktop-client-id', tokenStore, openBrowser, fetchImpl });
    await expect(auth.signIn()).rejects.toMatchObject({ code: 'missing_required_scope' });
    expect(await tokenStore.load()).toBeNull();
  });
});
