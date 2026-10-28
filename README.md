# Stills Library

Stills Library is an Electron app and local CLI for supervised still extraction. It reads the `Stills` tabs in the Filmkraft and Screenbridge project sheets, proposes delivery videos, waits for video approval, proposes frames, waits for still and filename approval, then uploads verified PNGs to Google Drive. It changes the Sheet row to `Done` only after delivery. Source videos are never changed. Approved revisions can rename or trash previously verified app-owned Drive PNGs; unrelated Drive items are preserved.

## Windows 11 quick start

The Windows x64 developer build includes Extract Stills, Rename Stills, FFmpeg/FFprobe, and all required analysis models. Running the packaged app does not require a separate Node or Python installation.

Local output from `npm run make`:

| Use | Path from this repository |
| --- | --- |
| Installer | `out\make\squirrel.windows\x64\Stills Library-0.1.0 Setup.exe` |
| Portable ZIP | `out\make\zip\win32\x64\Stills Library-win32-x64-0.1.0.zip` |
| Unpacked app | `out\Stills Library-win32-x64\Stills Library.exe` |
| Bundled CLI | `out\Stills Library-win32-x64\resources\bin\stills-library.cmd` |

Run the installer and open **Stills Library** from its shortcut, or extract the whole ZIP and run `Stills Library.exe`. Keep the adjacent `resources` folder and other packaged files together. To launch the unpacked build directly:

```powershell
Start-Process -FilePath '.\out\Stills Library-win32-x64\Stills Library.exe'
```

In **Setup**:

1. Follow [Google setup](docs/GOOGLE_SETUP.md), then choose **Import OAuth JSON** for the downloaded Google **Desktop app** credentials. Saving the desktop client ID directly is also supported.
2. Choose **Sign in with Google**, sign in as `harold@filmkraft.tv`, and approve full Google Drive access. Writes remain restricted to the configured stills folders and the two Stills spreadsheets; individual Picker grants are not needed. Existing per-file connections require signing in again once. This app needs its own authorization; the ChatGPT Google Drive connection does not sign it in.
3. Choose the mounted **Filmkraft** and **Screenbridge** source folders on this computer. Windows starts with empty source locations so no macOS mount is assumed.
4. Refresh the queue and prepare the first pilot project.

Recovery state and staging are kept under `%APPDATA%\Stills Library`. Login and imported client credentials use Windows-protected encrypted storage. **Sign out** removes the saved login while keeping client setup and project recovery state.

## Supervised run

Video suggestions automatically uncheck filenames that do not contain the project's client name (the first name segment after its bracketed code, before `_`). Matching ignores case and punctuation. For example, `[1278]Monarch_TVCampaign2025` matches `Monarch_30_Social.mp4`, but not `MMTBMYV130H.mov`. These videos remain visible with a reason and can be explicitly selected by a reviewer. The check happens before creative/format ranking, with no fallback to unrelated files.

Resuming a saved Picker-blocked discovery now verifies full Drive access and reuses its saved video list without waiting for another project's long scan/upload or repeating media probes. It returns to video review; it never approves analysis or delivery. `refresh-videos SESSION_ID` reapplies current suggestions before video approval; `recover-drive-access SESSION_ID` rechecks a cached blocked discovery while retaining its open/closed review state.

Start with Screenbridge **203SB Airwaav Brager**, then Filmkraft **1289 Net32 Brand Refresh**. Prepare one project; review every discovered delivery video and adjust the checked suggestions. Approving videos starts local analysis. Review candidate stills and their proposed filenames; approve the final selection to export and upload PNGs. The year is suggested from embedded video creation metadata, then file creation/modification dates; you can edit it before delivery. Each video’s actual last source frame is also preselected. A missing video, access error, or collision pauses the session for review. Use **Resume** after correcting the issue. In manual mode, choose **Skip** explicitly.

Both review screens support **Select all** and **Clear selection**. Enlarge a still to inspect it, navigate with the arrow buttons or keys, and include or exclude it before delivery. Folder actions open source/staging locations and Drive destinations; individual video actions reveal the file in Explorer. Restarting the app exposes interrupted work as resumable. After verified delivery or Skip, **Next project** selects the next `To Do` project in the pilot-prioritized queue and clears search/filters. It does not prepare or approve that project. When no `To Do` projects remain, the screen shows **Queue complete**.

Projects with multiple creative video versions deliver into separate subfolders inside the project folder. Meaningful numbered source folders are preserved, such as `01_SummerEssentials` and `02_GentleCleansingGel`. Otherwise, the app derives numbered labels from the version names. Encodes and aspect ratios of the same creative version share a folder; a single-version project keeps the existing flat layout. Stills review shows the folder labels and each PNG's destination before approval. PNG numbering remains continuous across the approved selection. Folder identities and filenames are rechecked during delivery and on resume.

**Review stills again** reopens a completed app delivery with saved previews and its previous selection. Adjust the selection, review the upload/removal counts and filenames, then choose **Apply revision**. Deselected app-owned PNGs move to Drive Trash; retained PNGs keep their Drive IDs and are renumbered; additions are exported and uploaded. The delivery year stays fixed. A saved revision journal recovers interrupted changes without re-uploading verified files. The previous manifest is archived locally, and the Sheet row returns to Done after verification. The CLI equivalent is `review-again <session-id>` followed by still approval.

## Authorized automatic queue

`run-queue --approve-all --json` explicitly authorizes one snapshot of all **To Do** rows in both studios. It searches Active and Archived projects in both source roots, approves suggested videos and stills (including the last frame), fills naming/year defaults, and verifies uploads before marking Done. Only missing source folders or delivery videos are marked Skip. Technical failures remain In Process (or To Do if access failed before processing), are recorded as failures, and do not prevent later projects from running. Existing Done/Skip/In Process rows are listed separately and remain untouched.

The app shows progress and **Open run report**. The HTML/JSON report records each outcome, year, counts and Drive destination. **Pause after this project** or `pause-queue` stops at a safe project boundary; **Resume automatic queue** or the same authorized CLI command continues it. Progress and authorization survive restarts. Closing the window keeps an active queue running, and the app prevents system sleep while processing. Source mount failures pause the queue. Account access failures are reported without waiting indefinitely for unattended interaction. `grant-queue-folders` now verifies access without opening Picker; `retry-queue --approve-all` or **Retry flagged projects** retries failures while keeping completed entries intact. Sheet requests are paced and quota rejections retried automatically.

## CLI

CLI commands use the same local service as the GUI. Manual commands prepare and inspect work; individual media approvals happen in the GUI. The separate automatic queue command requires the explicit `--approve-all` flag:

Run the packaged CLI without installing Node:

```powershell
& '.\out\Stills Library-win32-x64\resources\bin\stills-library.cmd' status --json
& '.\out\Stills Library-win32-x64\resources\bin\stills-library.cmd' projects --json
```

In a source checkout after `npm run build`:

```powershell
npm run cli -- import-google 'C:\path\to\desktop-client.json'
npm run cli -- login
npm run cli -- set-source screenbridge 'X:\filespace\Screenbridge'
npm run cli -- set-source filmkraft 'X:\filespace\Filmkraft'
npm run cli -- projects --json
npm run cli -- prepare screenbridge 203SB --json
npm run cli -- status --json
npm run cli -- status SESSION_ID --json
npm run cli -- resume SESSION_ID --json
```

The folder examples above are placeholders: use the actual mounted paths. The CLI starts the app if it is not running. `configure-google <desktop-client-id>`, `set-project-source <session-id> <folder>`, and `logout` are also available. A Sheet row with no bracketed code, or a repeated code within one studio, has a distinct `row-N` ID in `projects --json`; use that ID to prepare it. An ambiguous code is rejected before any Sheet write. Choose the exact source folder in the GUI or set it through the CLI when needed. The folder must be inside the configured studio root. Individual video approval, still approval, and Skip remain GUI actions outside an explicitly authorized automatic queue.

`STILLS_LIBRARY_APP_EXECUTABLE` can point a separately launched CLI at an installed executable. `STILLS_LIBRARY_DATA_DIR` selects a separate state directory and local service for isolated testing.

## Develop and build on Windows

Clone the three source repositories as sibling folders on the Windows 11 x64 machine:

```powershell
git clone https://github.com/haroldfandino/stills-library.git
git clone https://github.com/haroldfandino/extract-stills.git
git clone https://github.com/haroldfandino/postproduction-tools.git
cd stills-library
npm ci
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup-native-windows.ps1 -Build
npm run dev
```

The native setup helper requires Python 3.12 x64 and compatible FFmpeg binaries. It prepares the extraction environment, pinned models and compatibility patches, then builds and verifies the native tools. See [Windows build instructions](docs/RELEASE.md#windows-11-x64) for prerequisites and custom paths.

Development uses verified native sidecars when present, otherwise the sibling Extract Stills virtual environment, then the Windows Python launcher (`py -3.12`). Electron may download its runtime on first use. Run `npm run build` before using the development CLI on a fresh checkout.

```powershell
npm run typecheck
npm test
npm run make
npm run verify:package
```

`npm run make` creates the installer and ZIP and verifies the package. `node scripts/smoke-gui.mjs` exercises the approval screens with synthetic videos, real native tools, and local Google fixtures; reports and screenshots go to `build/gui-smoke/`. It does not perform a production Google delivery.

## Validation and remaining acceptance

Windows x64 native extraction, isolated renaming, Unicode source/output paths, package contents, and bundled CLI autolaunch have been exercised on this Windows host. Package verification checks model and executable hashes and runs the CLI with only system directories on `PATH`. The development GUI also supports enlarged still review and explicit year entry. See [release validation](docs/RELEASE.md#windows-native-validation-october-22-2026) for native checks and exact tool versions.

The final app suite has **114 passing tests** and passing TypeScript checks. The complete offline GUI workflow passed with real native tools, including separate version folders and reopening a completed project for fresh approval. Google sign-in and access were verified on this Windows computer, and all 155 project rows load. The real **203SB Airwaav Brager** pilot completed: the reviewer approved one of four delivery videos, native analysis produced **297 candidate previews and 15 suggested stills**, and the reviewer approved **17 PNGs** for delivery. All 17 uploads passed the final Drive verification and the app marked the Stills row **Done**. The reviewer explicitly skipped **1289 Net32 Brand Refresh** after reporting that its source appears to have been removed from LucidLink; its Stills row is **Skip**.

The installer also passed on this development computer. This development host redirects AppData into private storage, including the installer and its Start menu entry. The local **Stills Library** desktop shortcut instead uses `build\launch-stills-library.cmd` to open the portable package with the verified physical state location. `build\stills-library.cmd` is the matching local CLI wrapper. These computer-specific launchers are excluded from Git. Run the installer normally from Explorer for a conventional installation on another computer; the distributed app does not hardcode this development host's paths.

The Net32 pilot was waived by the reviewer, so it does not count as a completed production delivery. Continue the queue with available source projects and human video/still approvals. A clean-machine Windows installation/offline run has not yet been recorded, and the developer installer is unsigned.

The revised **1290 Mustela Paid Social** delivery also passed on the real Windows app: after fresh still approval, **73 PNGs** were exported and verified across eight numbered version folders, and the Stills row returned to **Done**.

Apple Silicon macOS packaging was previously verified on October 22, 2026. The macOS build declares macOS 15.0 to match its native dependencies; it remains unsigned and unnotarized, without a recorded clean-machine macOS 15 test. [Release instructions](docs/RELEASE.md) cover both platforms. Build native sidecars on each target architecture before packaging.

Generated installers, binaries, models, staging files, and build logs are excluded from Git. Credentials and tokens must also stay outside this repository.

When approved videos have multiple aspect ratios, delivery uses Horizontal, Square, Vertical, and 4x5 folders, with any creative-version folders inside. Single-ratio projects retain the existing layout. The explicit `organize-ratios <completed-session-id>` maintenance command relocates only this app's checksum-verified PNGs, journals each move, and preserves file IDs and content.

Google Drive source folders can be added through `add-drive-source <mounted-path> <Drive-folder-URL>` and appear in Setup. Google Drive for desktop must remain mounted; source files are read in place. The queue searches LucidLink first, then added Drive locations if delivery videos are missing. It recognizes both `11_FINAL_DELIVERY/01_VIDEOS` and `03_FINAL_DELIVERY/03_CLIENT_DELIVERY/04_VIDEOS`, excluding review exports. `retry-missing --approve-all` creates a new report for failed/missing entries from the completed batch, reopens only its guarded Skip rows, and leaves completed deliveries intact.


### Overlapping automatic preparation and uploads

Automatic runs use one preparation slot and one Drive upload slot. The next project can be discovered, analyzed and exported while the previous project uploads and verifies its PNGs. Only one project owns the upload slot, including destination setup and final verification. Preparation keeps moving through the entire list, saving finished exports in a FIFO queue while the uploader works. There is no one-project waiting limit. The queue banner shows the uploader, current preparation, and an expandable count of projects waiting to upload. Pause stops new preparation and finishes the current upload; waiting exports remain saved for resume. Saved export and upload plans remain resumable after restarting the app.

Large still reviews load only visible preview rows. The complete candidate set remains selectable and filename previews are paged. Routine interface updates carry session summaries rather than the full processing history. The app records bounded runtime diagnostics in `runtime.log` under its user-data folder and can reload a failed renderer while keeping the processing service alive.

### Multiple project reviews

The app supports up to three open human reviews on computers with at least 16 GiB of RAM (two with 8–16 GiB, one below 8 GiB). Use the Open reviews buttons to switch projects. Still selections, skipped videos, video choices, and naming edits are saved separately in local drafts, including across app restarts. Close review keeps its draft and frees an open-review slot. Local drafts do not change Drive; explicitly save a project to apply its delivery revision. Project saves are queued and only one project uploads to Drive at a time.

### Review workspace and shortcuts

The Projects panel can be hidden with B; / focuses project search. The queue report, project actions, bulk selection actions, and delivery settings are collapsible. Press ? for the shortcut guide. Ctrl+1/2/3 switches open reviews; F toggles Approved only; E opens an enlarged preview. In the viewer, G opens shot thumbnails, S browses selected stills, T toggles thumbnails/enlargement, and Space selects or unselects the focused enlarged still. Arrow keys navigate within the active mode. Ctrl+Z and Ctrl+Y undo/redo review changes. Ctrl+S reveals delivery settings for review and never uploads automatically. Text-entry controls preserve normal typing behavior.
