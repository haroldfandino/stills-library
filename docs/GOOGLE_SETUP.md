# Google access setup

Stills Library uses its own Google OAuth session. The `harold@filmkraft.tv` connection in ChatGPT plugins cannot be reused as an Electron token. No OAuth client ID or refresh token is included in this repository.

## Google Cloud project

1. Create or select a Google Cloud project for Stills Library. Enable **Google Sheets API** and **Google Drive API**.
2. Configure the OAuth consent screen. For a single-operator pilot, keep the app in testing and add `harold@filmkraft.tv` as a test user if the app is external. If it is an internal Workspace app, configure the organization's access policy accordingly.
3. In **Google Auth Platform > Data Access**, add `openid`, `email`, and `https://www.googleapis.com/auth/drive`. Full Drive access covers existing files without per-file Picker grants. It is a restricted scope; external distribution can require Google verification or administrator approval. The signed-in account still needs normal edit permission on the configured destinations.
4. Create an OAuth client of type **Desktop app**. Use a separate desktop client ID for macOS and Windows if deploying on both platforms. Download its JSON and choose **Import OAuth JSON** in Setup, or run `npm run cli -- import-google "C:\path\to\client.json"`. The app accepts only the `installed` Desktop format and stores the client configuration using the operating system's encrypted storage. The optional desktop client secret is included in token exchanges and refreshes, never in browser URLs or CLI output. You can also paste the `*.apps.googleusercontent.com` client ID into Setup or run `npm run cli -- configure-google CLIENT_ID`. Do not use a Web application client ID or service-account key.

Download credentials outside the repository. Never commit credentials or tokens. **Sign out** in Setup (or `npm run cli -- logout`) removes this computer's saved login; the client configuration remains available for signing in again.

Protocol references: [Google Desktop OAuth](https://developers.google.com/identity/protocols/oauth2/native-app).

The app opens Google authorization in the system browser and receives the result on a temporary `127.0.0.1` loopback listener using PKCE. Sign in as `harold@filmkraft.tv`; another account is rejected. Refresh tokens are stored through Electron's OS-protected storage. The app requests full Drive access and does not launch Google Picker.

## Sign in and verify configured destinations

The app targets only the `Stills` tab, columns A (`Project`) and B (`Status`), in these Sheets:

| Studio | Sheet ID | Supplied library root folder ID |
| --- | --- | --- |
| Filmkraft | `11kk_s8r-_dk1W3K8uudB1YtpMYh4LTlcHcFcq4O7Z6w` | `1DQr_5OSdnZluCyACHdaSLoQsp2sOBp2S` |
| Screenbridge | `15sS9pdgUTTVZp8t298bCvBKy0gLNpTIULUNCHQM0364` | `1Pdz7dsMmzXGoF5Sx6-q8z1wEudvQDWCS` |

After updating the Cloud consent configuration, sign in again in Setup and approve full Drive access. Old per-file tokens are preserved but cannot perform operations until upgraded; project history, review drafts, exports, and delivery records remain intact. The app verifies existing Sheets and destinations directly without Picker. ChatGPT plugin access does not grant this OAuth client access.

Full Drive access is an OAuth capability, not permission to change arbitrary files through Stills Library. Every outgoing Drive mutation verifies fresh folder ancestry against configured destination IDs. If a configured destination is a broader library root, only its unique `01_Stills` child and descendants are writable. An explicitly configured `01_Stills` or year folder is its own boundary. Renames, trashing, and moves verify the file's current parent; moves also check the destination. Upload initiation, chunks, recovery requests, and authorization retries recheck ancestry. Cycles, shortcuts, trashed folders, missing parents, and ambiguous parents fail closed. There is no persistent ancestry cache. Existing app ownership, checksum, name-collision, and empty-folder checks remain in force. Sheets writes stay limited to the two configured Stills spreadsheets and the existing status/dropdown operations.

The supplied Drive IDs are **library roots**, not upload folders. Existing stills live in `01_Stills/<year>/<exact Sheet project name>/`, for example `01_Stills/2026/[148SB]LSPACE_Evergreen_PremiumAd/`. Stills Library looks for an exact project folder across the available year folders. If none exists, it creates a project folder only after the destination year is known. Airwaav and Net32 are 2026 pilots. Some other `To Do` rows are from 2025, so the app must not assume every row belongs in 2026. PNG names follow the reviewed `Project_Type_Still_01.png` pattern; existing examples include `LSpace_CreativeVariation_Still_01.png`.

## If verification fails

- `wrong_account`: sign out of the browser's other Google account and sign in as `harold@filmkraft.tv`.
- `missing_required_scope`: update the Cloud Data Access scope, then sign in again and grant full Drive access. Existing per-file logins cannot upgrade themselves through token refresh.
- `not_found_or_not_granted`: verify the Sheet/folder ID and account permission.
- `outside_library`: the destination is outside the configured stills tree or its ancestry changed. Restore its location or correct the configured destination; no write was sent.
- A read-only Sheet or destination folder must be granted edit/add permission in Google Drive before the app can change a status or upload. Full Drive consent does not expand the account's underlying permissions.

The app never reads the `Wrap up` tabs. It does not use the ChatGPT connector to write rows or files.
