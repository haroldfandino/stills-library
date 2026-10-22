import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_GOOGLE_SCOPES, DRIVE_FILE_SCOPE, DRIVE_METADATA_SCOPE, GoogleAuth, MemoryGoogleTokenStore,
} from './auth.js';

const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });

describe('Google desktop OAuth', () => {
  it('uses a loopback PKCE login and a separate drive.file-only Picker request', async () => {
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
      if (String(input).includes('/token')) return json({ access_token: 'token', refresh_token: 'refresh', expires_in: 3600, scope: `${DRIVE_FILE_SCOPE} ${DRIVE_METADATA_SCOPE}` });
      return json({ email: 'harold@filmkraft.tv', email_verified: true });
    }) as unknown as typeof fetch;
    const auth = new GoogleAuth({ clientId: 'desktop-client-id', tokenStore, openBrowser, fetchImpl });
    expect(await auth.signIn()).toBe('harold@filmkraft.tv');
    expect(await auth.pickFiles({ fileIds: ['sheet-id', 'folder-id'], allowFolders: true, allowMultiple: true })).toEqual(['sheet-id', 'folder-id']);
    expect(seenScopes).toEqual([[...DEFAULT_GOOGLE_SCOPES], [DRIVE_FILE_SCOPE]]);
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
      String(input).includes('/token') ? json({ access_token: 'token', refresh_token: 'refresh', expires_in: 3600, scope: `${DRIVE_FILE_SCOPE} ${DRIVE_METADATA_SCOPE}` })
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
