# Google access setup

Stills Library uses its own Google OAuth session. The `harold@filmkraft.tv` connection in ChatGPT plugins cannot be reused as an Electron token. No OAuth client ID or refresh token is included in this repository.

## Google Cloud project

1. Create or select a Google Cloud project for Stills Library. Enable **Google Sheets API**, **Google Drive API**, and **Google Picker API**.
2. Configure the OAuth consent screen. For a single-operator pilot, keep the app in testing and add `harold@filmkraft.tv` as a test user if the app is external. If it is an internal Workspace app, configure the organization's access policy accordingly.
3. Add `openid`, `email`, `https://www.googleapis.com/auth/drive.file`, and `https://www.googleapis.com/auth/drive.metadata.readonly` to the consent configuration. The metadata scope lets the app enumerate existing folders and names before creating files; a token without it is rejected to prevent missed collisions. This is a restricted Drive scope and may require Google verification or administrator approval for broader distribution.
4. Create an OAuth client of type **Desktop app**. Use a separate desktop client ID for macOS and Windows if deploying on both platforms. Download its JSON and choose **Import OAuth JSON** in Setup, or run `npm run cli -- import-google "C:\path\to\client.json"`. The app accepts only the `installed` Desktop format and stores the client configuration using the operating system's encrypted storage. The optional desktop client secret is included in token exchanges and refreshes, never in browser URLs or CLI output. You can also paste the `*.apps.googleusercontent.com` client ID into Setup or run `npm run cli -- configure-google CLIENT_ID`. Do not use a Web application client ID or service-account key.

Download credentials outside the repository. Never commit credentials or tokens. **Sign out** in Setup (or `npm run cli -- logout`) removes this computer's saved login; the client configuration remains available for signing in again.

Protocol references: [Google Desktop OAuth](https://developers.google.com/identity/protocols/oauth2/native-app) and [Desktop Google Picker](https://developers.google.com/workspace/drive/picker/guides/desktop-mobile-picker).

The app opens Google authorization in the system browser and receives the result on a temporary `127.0.0.1` loopback listener using PKCE. Sign in as `harold@filmkraft.tv`; another account is rejected. Refresh tokens are stored through Electron's OS-protected storage. Each Google Picker request uses `drive.file` alone, as Google requires for the desktop Picker flow.

## Grant existing Sheets and destinations

The app targets only the `Stills` tab, columns A (`Project`) and B (`Status`), in these Sheets:

| Studio | Sheet ID | Supplied library root folder ID |
| --- | --- | --- |
| Filmkraft | `11kk_s8r-_dk1W3K8uudB1YtpMYh4LTlcHcFcq4O7Z6w` | `1DQr_5OSdnZluCyACHdaSLoQsp2sOBp2S` |
| Screenbridge | `15sS9pdgUTTVZp8t298bCvBKy0gLNpTIULUNCHQM0364` | `1Pdz7dsMmzXGoF5Sx6-q8z1wEudvQDWCS` |

After sign-in, select the requested Sheets, library roots, `01_Stills`, and year folders in the system-browser Google Picker. The Picker grants this app access to pre-existing items under `drive.file`. The app checks Drive's `isAppAuthorized` field after Picker; a visible folder alone does not establish a write grant. Before a Sheet row changes to `In Process`, an existing exact project folder is also opened in Picker if needed. Delivery checks the selected year and project folder again. If a grant remains missing, repeat the grant for that item or correct its ID. ChatGPT plugin access to the same files does not grant this OAuth client access.

The supplied Drive IDs are **library roots**, not upload folders. Existing stills live in `01_Stills/<year>/<exact Sheet project name>/`, for example `01_Stills/2026/[148SB]LSPACE_Evergreen_PremiumAd/`. Stills Library looks for an exact project folder across the available year folders. If none exists, it creates a project folder only after the destination year is known. Airwaav and Net32 are 2026 pilots. Some other `To Do` rows are from 2025, so the app must not assume every row belongs in 2026. PNG names follow the reviewed `Project_Type_Still_01.png` pattern; existing examples include `LSpace_CreativeVariation_Still_01.png`.

## If verification fails

- `wrong_account`: sign out of the browser's other Google account and sign in as `harold@filmkraft.tv`.
- `missing_required_scope`: repeat sign-in and grant both Drive permissions. Folder listings are blocked without read-only metadata access.
- `not_found_or_not_granted`: open the item in Picker, or verify the Sheet/folder ID and account permission.
- A read-only Sheet or destination folder must be granted edit/add permission in Google Drive before the app can change a status or upload. A Google Picker grant does not expand the account's underlying permissions.

The app never reads the `Wrap up` tabs. It does not use the ChatGPT connector to write rows or files.
