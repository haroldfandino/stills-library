export interface GoogleDesktopCredentials {
  clientId: string;
  clientSecret?: string;
}

/** Accept Google's downloaded Desktop app JSON, never web or service-account keys. */
export function parseDesktopCredentials(text: string): GoogleDesktopCredentials {
  let data: unknown;
  try { data = JSON.parse(text.replace(/^\uFEFF/, '')); }
  catch { throw new Error('Choose the Desktop app JSON downloaded from Google Cloud.'); }
  const installed = data && typeof data === 'object'
    ? (data as Record<string, unknown>).installed : undefined;
  if (!installed || typeof installed !== 'object' || Array.isArray(installed)) {
    throw new Error('This is not a Google Desktop app credential file. Create a Desktop app OAuth client in Google Cloud.');
  }
  const values = installed as Record<string, unknown>;
  if (typeof values.client_id !== 'string' || !/^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(values.client_id)) {
    throw new Error('The Desktop app JSON does not contain a valid Google client ID.');
  }
  if (values.client_secret !== undefined && (typeof values.client_secret !== 'string' || !values.client_secret.trim())) {
    throw new Error('The Desktop app JSON contains an invalid client secret.');
  }
  return { clientId: values.client_id, clientSecret: values.client_secret as string | undefined };
}
