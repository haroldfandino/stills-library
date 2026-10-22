# Stills Library

Stills Library is an Electron app and local CLI for supervised still extraction. It reads the `Stills` tabs in the Filmkraft and Screenbridge project sheets, proposes delivery videos, waits for video approval, proposes frames, waits for still and filename approval, then uploads verified PNGs to Google Drive. It changes the Sheet row to `Done` only after delivery. Source videos and existing Drive items are never renamed, moved, deleted, or overwritten.

## Setup

1. Install Node.js and dependencies with `npm ci`.
2. Set up a Google Cloud **Desktop app OAuth client ID** as described in [docs/GOOGLE_SETUP.md](docs/GOOGLE_SETUP.md). A ChatGPT Google Drive plugin connection cannot authenticate this separate app.
3. Prepare the native Extract Stills and Rename Stills tools and their models/FFmpeg. Run `python3.12 scripts/build-native.py --check` on the target computer, then `python3.12 scripts/build-native.py` to build verified sidecars. See [release and platform build instructions](docs/RELEASE.md).
4. Run `npm run dev`. In **Setup**, save the desktop OAuth client ID, sign in as `harold@filmkraft.tv`, grant the existing Sheets and folders in Google Picker, and choose the mounted Filmkraft and Screenbridge source roots.

Default source roots are `/Volumes/filmkraft/filespace/Filmkraft` and `/Volumes/filmkraft/filespace/Screenbridge` on this Mac. Set equivalent locations on Windows. The app keeps staging and its recovery state in the user's application data directory.

## Supervised run

Start with Screenbridge **203SB Airwaav Brager**, then Filmkraft **1289 Net32 Brand Refresh**. Prepare one project; review every discovered delivery video and adjust the checked suggestions. Approving videos starts local analysis. Review candidate stills and their proposed filenames; approve the final selection to export and upload PNGs. Choose the destination year explicitly for a new project folder when the project name has no year. A missing video, access error, or collision pauses the session for review. Use **Resume** after correcting the issue. Only a human should choose **Skip**.

CLI commands use the same local service as the GUI. They can prepare and inspect work but the two media approvals happen in the GUI:

```sh
npm run cli -- projects --json
npm run cli -- prepare screenbridge 203SB --json
npm run cli -- status --json
npm run cli -- status SESSION_ID --json
npm run cli -- resume SESSION_ID --json
```

The CLI starts the development app if it is not already running. `login`, `configure-google <desktop-client-id>`, `set-source <filmkraft|screenbridge> <folder>`, and `set-project-source <session-id> <folder>` are also available. For a Sheet row without a bracketed code, prepare it using its `row-N` ID from `projects --json`, then choose the exact project folder in the GUI or set it through the CLI. The folder must be inside the configured studio root. Video approval, still approval, and Skip remain GUI actions. Use `npm run typecheck` and `npm test` for source checks.

## Packaging status

The Apple Silicon **developer build** was packaged on October 22, 2026:

- Local Mac DMG (excluded from Git): `out/make/dmg/arm64/Stills Library-0.1.0-arm64.dmg` (405 MiB, SHA-256 `26295d8cc61206845a3bfbde11ac705eca285727c5a0d8f110c075c03c4a1d60`)
- Local Mac ZIP (excluded from Git): `out/make/zip/darwin/arm64/Stills Library-darwin-arm64-0.1.0.zip` (407 MiB, SHA-256 `a6ca51e133e58eba1e04d23b9c08bd648f9d0cf8c18abb3a85d03d8940400458`)

`npm run package` and `npm run make` passed. The bundled Extract Stills synthetic-media verifier and Rename Stills isolated PNG smoke test passed. The packaged CLI passed with a restricted system `PATH`, including `status --json` auto-launching a fresh GUI instance. The Electron app declares macOS 15.0, matching the highest declared minimum across the native bundle. The app is not signed or notarized, and it has not had a clean-machine macOS 15 test. See [release checks](docs/RELEASE.md) for the source-suite result and reproduction steps.

Build and verify the native sidecars on each target architecture before running `npm run make`; release packaging refuses an incomplete sidecar. The **Windows 11 x64 build and smoke test are pending** on the Windows machine, after the Mac pilot. A packaged app still needs its own Google OAuth client ID and account consent.

## Windows handoff

Clone the three source repositories as sibling folders on the Windows 11 x64 machine:

```powershell
git clone https://github.com/haroldfandino/stills-library.git
git clone https://github.com/haroldfandino/extract-stills.git
git clone https://github.com/haroldfandino/postproduction-tools.git
cd stills-library
```

Follow the [Windows 11 x64 instructions](docs/RELEASE.md#windows-11-x64) to build the native sidecars, run the tests, and package the app. Generated binaries, models, build logs, and the Mac DMG/ZIP are deliberately excluded from this source repository. The Mac Google sign-in and pilot projects are still pending; Windows validation should wait until the Mac pilot works, as requested.
