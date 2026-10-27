import { describe, expect, it } from 'vitest';
import { parseDesktopCredentials } from './desktop-credentials';

describe('desktop client import', () => {
  it('imports the installed client, including an optional secret and a Windows BOM', () => {
    expect(parseDesktopCredentials('\uFEFF' + JSON.stringify({ installed: {
      client_id: '123-example.apps.googleusercontent.com', client_secret: 'test-secret',
      auth_uri: 'https://untrusted.invalid/ignored',
    } }))).toEqual({ clientId: '123-example.apps.googleusercontent.com', clientSecret: 'test-secret' });
    expect(parseDesktopCredentials(JSON.stringify({ installed: { client_id: '123.apps.googleusercontent.com' } })))
      .toEqual({ clientId: '123.apps.googleusercontent.com', clientSecret: undefined });
  });

  it.each(['not json', '{}', '{"web":{"client_id":"123.apps.googleusercontent.com"}}',
    '{"type":"service_account","private_key":"example"}',
    '{"installed":{"client_id":"not-a-google-client"}}'])('rejects incorrect credential types without echoing content', value => {
    expect(() => parseDesktopCredentials(value)).toThrow(/Desktop app|Google client ID/);
  });
});
