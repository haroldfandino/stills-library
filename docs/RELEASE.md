# Native builds and release checks

Build each release on its target architecture. The Electron package includes an
Extract Stills console bundle, the original Rename Stills script frozen as a
console executable, FFmpeg, FFprobe, all four pinned model assets, and notices.
The release build refuses to run if those sidecars are missing.

## Apple Silicon macOS

Prepare the sibling `extract-stills` checkout with Python 3.12, its
`requirements-dev.txt`, and `python scripts/setup_models.py`. The model setup
downloads exact files from the pinned manifest and checks their SHA-256 values.
Use an arm64 Python interpreter. If a Python symlink creates a broken virtual
environment, create the environment from the interpreter's resolved binary.
If the Extract Stills checkout still uses `-filter_script:v`, apply
`patches/extract-stills-ffmpeg9.patch` to it before building. FFmpeg 9 uses
`-/filter:v` to read a filtergraph file; `build-native.py` checks for this.
Run `git -C ../extract-stills apply ../stills-library/patches/extract-stills-ffmpeg9.patch`
once on an unpatched checkout.
Also apply `patches/extract-stills-unicode-paths.patch` after that patch. It
routes preview filesystem access through Python so accented and other Unicode
paths work on Windows, and adds a source regression test and an accented
temporary path to the frozen verifier:

```sh
git -C ../extract-stills apply ../stills-library/patches/extract-stills-unicode-paths.patch
```

The local Homebrew FFmpeg may lack the required color filters. From this
project's root, build the pinned FFmpeg 9.0.2 source with static zimg and
LittleCMS libraries. The helper targets macOS 15.0 because the installed
Homebrew static libraries declare that minimum:

```sh
./scripts/build-ffmpeg-macos.sh
mkdir -p ../extract-stills/ffmpeg
cp build/ffmpeg-macos/prefix/bin/ffmpeg build/ffmpeg-macos/prefix/bin/ffprobe ../extract-stills/ffmpeg/
cp build/ffmpeg-macos/notices/* ../extract-stills/ffmpeg/
../extract-stills/.venv/bin/python scripts/build-native.py --ffmpeg-dir ../extract-stills/ffmpeg
npm ci
npm run typecheck
npm test
npm run package
```

`build-native.py` runs Extract Stills' preflight and frozen synthetic-media
verifier before copying the complete CLI folder to `native/darwin/arm64/`.
It also runs the original Rename Stills script as a frozen executable against
isolated test PNG copies. A failure leaves an existing native bundle intact.
On this Mac, the frozen synthetic-media verifier passed. The Extract Stills
source suite had 231 passes, 9 skips, and one fixture failure: that test
generates its input with `libx264rgb`, an optional encoder omitted from the
lean redistributable FFmpeg. The bundled FFmpeg retains H.264 and HEVC
decoders, and the frozen verifier exercised the actual extraction path.
`npm run package` verifies the resulting Electron bundle and executes its CLI
launcher with a restricted `PATH`, proving that the CLI uses bundled Electron
instead of a system Node or Python installation. `npm run make` creates the
developer DMG/ZIP and repeats this check. The PyInstaller verifier records
every bundled Mach-O minimum OS in `packaged-verification.json`. The audit's
highest declared minimum on this Mac is 15.0; the Electron app's
`LSMinimumSystemVersion` is also set to 15.0. This is a declared minimum, not
a clean-machine test on macOS 15.

Inside the packaged app, the sidecars are at:

```text
Stills Library.app/Contents/Resources/arm64/extract-stills/extract-stills
Stills Library.app/Contents/Resources/arm64/extract-stills/_internal/binaries/ffprobe
Stills Library.app/Contents/Resources/arm64/rename-stills
Stills Library.app/Contents/Resources/bin/stills-library
```

Run the bundled CLI with `.../Contents/Resources/bin/stills-library status --json`.
It can launch the GUI if the app is not already running.

## Windows 11 x64

Clone `stills-library`, `extract-stills`, and `postproduction-tools` as sibling
folders on the Windows machine. Install native x64 Python 3.12 and Node. Put
x64 `ffmpeg.exe` and `ffprobe.exe` in `extract-stills\ffmpeg\`, or have a compatible
installation on `PATH`; the FFmpeg build must expose `zscale`, `tonemap`, and
`iccgen` and must not use `--enable-nonfree`. Scoop shims are resolved to the
actual executables before bundling, so the app does not need Scoop at runtime.

The Windows helper creates the sibling Extract Stills `.venv` if needed,
installs its pinned dependencies, downloads and verifies the four models,
applies the filter-file and Unicode-path compatibility patches when needed,
and runs preflight.
`-Build` also builds and verifies both native tools. It reuses an existing
Python 3.12 x64 environment and does not replace a virtual environment using
a different Python version. It detects launcher-registered Python runtimes,
including uv installations that `py -3.12` may not select.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup-native-windows.ps1 -Build
npm ci
npm run typecheck
npm test
npm run package
npm run make
```

Pass `-Python C:\path\to\python.exe` to choose an interpreter for a new
environment, `-ExtractRoot` and `-RenameScript` for non-sibling checkouts, or
`-FfmpegDir C:\path\to\ffmpeg\bin` for specific FFmpeg binaries. Omitting
`-Build` prepares and checks prerequisites only. The underlying build can be
repeated without reinstalling dependencies:

```powershell
..\extract-stills\.venv\Scripts\python.exe scripts\build-native.py
..\extract-stills\.venv\Scripts\python.exe scripts\verify-native.py --native-dir native\win32\x64 --extract-root ..\extract-stills
```

`verify-native.py` checks model and FFmpeg hashes, native executable hashes,
the saved synthetic extraction result, and isolated PNG renaming before
running the full synthetic extraction check again. No source media is needed.

The frozen verifier tests original-resolution PNG, 16-bit TIFF, ICC profile,
shot selection, repeated imagery, text changes, and unchanged source video on
synthetic clips. Then exercise both approval screens, interrupted upload
recovery, and the bundled CLI on the Windows machine. The CLI launcher is
`resources\bin\stills-library.cmd`; its packaged FFprobe is
`resources\x64\extract-stills\_internal\binaries\ffprobe.exe`.
Do not mark Windows validated until these checks run on that machine.

### Windows native validation, October 22, 2026

The Windows 11 x64 native bundle was built locally with Python 3.12.9 and
PyInstaller 6.22.3. Extract Stills commit
`5f19a7bc2708765cb7ba7e7fe59208edbb8d9558` plus the included filter-file and
Unicode-path patches
and Rename Stills commit `80edc8f53bff060b2a0d04208f2f5a4b19dcbb30` were used.
The bundled FFmpeg is the installed Gyan 7.1.1 full build, with `zscale`,
`tonemap`, `iccgen`, and `libx264rgb`; exact binary hashes, configuration and
license records are in `extract-stills/_internal/licenses/FFMPEG-BINARIES.json`.

- Extract Stills source checks: **233 passed, 9 skipped**, including analysis,
  readable previews, PNG export and source preservation under accented and
  Japanese source/output paths.
- Frozen synthetic extraction: **passed** from an accented Windows temporary
  path with a restricted system `PATH`,
  original-resolution PNG with ICC, 16-bit RGB TIFF with ICC, three-shot
  selection, all four caption states, repeated imagery and unchanged input.
- Frozen Rename Stills: **passed**, preserving both isolated PNG fixture files
  and leaving the unrelated text fixture untouched.
- Final local sidecars: `native\win32\x64\`, with `BUILD-MANIFEST.json` and
  `packaged-verification.json`. Generated binaries and logs remain outside Git.

These results cover the native extraction tools on this Windows host. The
Electron package, Google sign-in, supervised real-project approval screens,
upload recovery and a clean-machine offline run are separate checks. No
production videos or Drive folders were changed during native validation.

Run `node scripts/smoke-gui.mjs` for a disposable Electron workflow check with
real native tools and synthetic source videos under Unicode Windows paths.
Google responses are local fixtures. It exercises video approval, preview
rendering, still approval and delivery, and saves its report and screenshots
under `build/gui-smoke/`. This check is separate from a real Google sign-in
and supervised project delivery.

### Windows app and Google validation, October 22, 2026

- App source checks: **114 passed**; TypeScript checks passed.
- The complete offline Electron workflow passed with the real native tools:
  video approval, 30 readable previews, enlarged still review, folder/naming
  review, two approved PNGs exported/renamed/delivered into separate creative
  version folders, and a verified Done manifest. Reopening the completed
  project archived its old manifest and required fresh still approval, with
  no new export or upload before that approval.
  Source hashes and an existing destination fixture were preserved. Google
  was replaced with local fixtures for this test; its evidence is in
  `build/gui-smoke/` (excluded from Git).
- The Windows installer and portable ZIP were built. Package checks verified
  bundled native/model hashes and the CLI with only Windows system directories
  on `PATH`, including automatic GUI startup in an isolated state directory.
- The installer completed successfully on this development computer and
  created the Filmkraft / Stills Library Start menu shortcut. The installed
  bundled CLI launched the installed GUI, restored the encrypted Google
  login, and returned all 155 projects with Airwaav awaiting video approval.
  This is a same-machine installation check, not a clean-machine test.
- This host's MSIX AppData redirection also redirected that installation and
  its Start menu entry. The local desktop shortcut now uses the portable
  package with the verified physical state directory, through the ignored
  `build/launch-stills-library.cmd`. `build/stills-library.cmd` is its matching
  local CLI. Windows data-directory aliases now share a canonical service
  identity; native output containment checks canonicalize paths while still
  rejecting junction escapes. The distributed app retains ordinary Windows
  AppData defaults and contains no hardcoded host/package path.
- Real Desktop OAuth sign-in as `harold@filmkraft.tv`, both Sheets, both library
  roots, and their existing still/year folder grants were verified. The live
  queue loads all **155 rows**. Repeated project codes use separate `row-N`
  identifiers; an ambiguous code cannot select a Sheet row for writing.
- The real Airwaav pilot completed after the human approved the 30-second
  4K Social H.264 file and then selected **17 stills** from 297 candidate
  previews (15 were suggested). The app exported, renamed, and uploaded all
  **17 PNGs**, completed final Drive verification, and marked its Stills row
  **Done**. The delivery is in the existing project destination:
  https://drive.google.com/drive/folders/1y7t9QMgg7zT2bTv4z5ZyewtTw4KecQcy.
- The reviewer explicitly requested **Skip** for Net32, reporting that its
  source appears to have been removed from LucidLink that day. The app's
  Skip action completed and its Stills row is **Skip**. A preceding read-only
  search of 288 directory names through depth four under the configured
  Filmkraft mount found no 1289 or Net32 folder and reported no access errors.
  This is a waived pilot, not a completed delivery.
- Mustela Paid Social initially delivered 73 approved PNGs successfully.
  The reviewer subsequently removed those Drive PNGs and requested a rerun
  into separate version folders. The eight-folder plan matches the existing
  numbered source folders, from `01_SummerEssentials` to `08_HydraBaby`.
  The updated Windows app reopened the saved 1,344 previews with the prior
  73 selections as suggestions. The original completed manifest was archived
  locally, and a fresh still approval was required. After the reviewer approved,
  **73 PNGs** were exported and delivered into the eight version folders, all
  passed final file/folder verification, and the Stills row returned to **Done**.
  Folder counts in source order are **7, 7, 17, 9, 9, 10, 8, 6**. Verified
  production destination:
  https://drive.google.com/drive/folders/1YuWW7ABWTKlY22050cZamZ12JMRTlSH3.

The installer is unsigned. A clean-machine installation remains an acceptance
check; Net32's production pilot was waived by the reviewer. Encrypted Google
credentials and tokens live in the user's application data, outside Git.

Final local Windows artifacts (excluded from Git):

| Artifact | Size | SHA-256 |
| --- | --- | --- |
| `out/make/squirrel.windows/x64/Stills Library-0.1.0 Setup.exe` | 580,305,920 bytes | `86b3fc03266320a595df9a7c07d54f2f6c989c5a2007ce04aec5be0ba7711a9a` |
| `out/make/zip/win32/x64/Stills Library-win32-x64-0.1.0.zip` | 595,784,502 bytes | `e108582720cc0c6fdfcafc303bc4d4cf8a7f3198649b66f38cf6c37d5a1126b5` |

## Runtime paths and release materials

The Electron main process resolves the native extraction executable at
`process.resourcesPath/<arch>/extract-stills/extract-stills[.exe]`, Rename Stills
at `process.resourcesPath/<arch>/rename-stills[.exe]`, and FFprobe at
`process.resourcesPath/<arch>/extract-stills/_internal/binaries/ffprobe[.exe]`.
The complete Extract Stills folder must remain together. The bundled CLI is a
small shell or CMD launcher under `process.resourcesPath/bin/` that executes
the installed Electron binary in Node mode; it does not require system Node.

For distribution, inspect `BUILD-MANIFEST.json`,
`packaged-verification.json`, and the Extract Stills `licenses/` directory in
each native bundle. Keep the exact FFmpeg source tarball, this build script,
the zimg and LittleCMS sources and notices, and any corresponding FFmpeg
dependency sources or patches with release materials. See
`extract-stills/docs/PACKAGING.md` for code signing, notarization, license,
macOS 13 dependency audit, and clean-machine offline tests. A local developer
package is not a signed or notarized public release.

## Automatic queue update — October 22, 2026

The user authorized automatic approvals and delivery for all pending projects. The Windows app now searches both studios’ Active and Archived folders, suggests editable years from video creation metadata/file dates, and adds the actual final decoded source frame to each new analysis. It persists automatic queue progress and HTML/JSON reports, pauses at project boundaries, retries flagged projects, paces Google Sheets requests, and preserves existing Drive contents. Reused project codes require an unambiguous source match.

Validation: 124 tests, TypeScript checks, and the offline Windows GUI/native smoke passed. The native smoke selected and exported final frame 35 of two 36-frame videos into separate version folders. Live batch results are recorded in the app’s run report.

The queue recovery update preserves exact native nanosecond source timestamps when adding the last frame and escapes literal percent signs in FFmpeg export paths. Native core tests: 27 passed. The frozen Windows exporter also passed a three-frame export (including the last frame) with percent signs in source and destination paths.

Aspect-ratio organization: multi-ratio projects use aspect folders above creative versions. Completed app-owned deliveries can be reorganized through the explicit maintenance command, with checksum checks and per-file persistence. Validation: 130 tests, typecheck and Windows package verification passed.

October 23 Drive sources update: mounted Drive collections are additional persistent sources, including the older client-delivery layout. Missing-source retry creates a separate batch/report and preserves completed deliveries. Explicit concept matching disambiguates shared codes. Validation: 133 tests, typecheck, and Windows package verification passed.


## Retry display and OCR correction — October 23, 2026

The project view now selects the current retry instead of an older skipped attempt. The automatic queue identifies the active project, provides a View current project button, and reflects pending retries in its counters. Collapsed text-detector regions are retained as unreadable, zero-confidence evidence instead of aborting an entire video; invalid nonfinite geometry still fails validation.

Validation: 136 app tests and TypeScript checks, renderer smoke against the live retry state, and 29 text-recognition tests passed (3 skipped). The rebuilt native extraction and rename tools passed packaged verification. The running Windows package is updated separately from the previously built distributable installers; rebuild installers before sharing this correction.


## Overlapping preparation and delivery — October 23, 2026

The automatic queue now prepares one project while one other project delivers to Drive. A shared upload lock covers destination setup, upload and final verification; a one-project preparation buffer bounds native work and staging. Pause drains active projects, reports serialize concurrent updates, and restart recovery preserves upload identities. Both active projects appear in the queue banner.

Validation: 140 tests and typecheck pass, including overlap, single upload ownership, bounded staging, pause/resume, upload failure, and committed-upload recovery without duplicate delivery. Packaged verification and a two-project renderer smoke passed. The installed pipeline was observed uploading Keepsake Stories while analyzing Keynes Connected. A follow-up renderer-only correction for the brief source-discovery state is built in dist and will be included in the next package refresh; current installer artifacts still require rebuilding.


## Growing upload backlog — October 23, 2026

At the user's request, preparation now continues through all remaining projects instead of stopping after one prepared project. Prepared exports persist in a FIFO queue, with exactly one uploader. Pause finishes the current upload and saves waiting projects for resume without another analysis/export. The banner separates active work from an expandable waiting list. This update also includes the earlier source-discovery display correction.

Validation: 140 tests and typecheck passed; tests now hold the first upload open while all three projects finish preparing, then verify single-upload ownership, pause/resume without repeat exports, and continued delivery after a failed upload. Renderer backlog smoke and Windows package verification passed. Deployment preserved 1,214 verified upload records and both active projects' prepared exports. Distributable installer/zip rebuilding remains due after the automatic run.

## Final Windows refresh — October 24, 2026

This refresh incorporates the retry display, OCR collapsed-region handling, growing preparation backlog with one uploader, Windows trailing-period staging recovery, and a 128 MiB CLI response limit for retained review histories. Validation: 143 tests and typecheck passed. The Drive retry delivered 30 projects and 3,311 verified PNGs; 21 entries lacked delivery sources and 14 require access or source/destination clarification. No partial deliveries remain. See build/reports/drive-retry-report.html and build/final-retry-reconciliation.json.


Final installer and ZIP rebuilt successfully; packaged verification passed after the refresh.


## Completed delivery revisions — 2026-10-26

Completed app deliveries can be reopened and revised with an explicit Apply revision action. Removed app-owned PNGs move to Drive Trash; retained files keep their IDs; additions upload and the selection is renumbered without gaps. A persistent two-phase rename journal supports interruption recovery. Older open reviews recover their ownership records from the archived delivery manifest.

Validation: 150 tests, TypeScript checks, isolated renderer revision smoke, packaged GUI/CLI verification. Live installation preserved selections, exports and upload records across all 139 sessions; no Drive revision was applied during deployment.

## Review reliability — 2026-10-26

Windows recorded an AppHangB1 failure. Large reviews previously mounted every candidate and eagerly loaded every preview; routine GUI snapshots also cloned and sent all saved analysis and delivery history (51 MB). The Flowers review contains 18,588 candidates.

The grid now mounts visible rows plus a small buffer, filename previews are paged, and the GUI receives a 229,739-byte summary and fetches only the opened session. Full CLI status and saved processing/delivery records remain available. Unsent still-selection drafts survive display reloads. Renderer failures have bounded automatic recovery; lifecycle and memory diagnostics rotate in the app data directory's runtime.log.

Validation: 155 tests, typecheck/build, actual-main renderer crash injection/recovery, and packaged GUI/CLI checks. Stress tests exercised all 18,588 Flowers candidates, Select all, final-candidate reachability, window resizing, 96 project switches, and reload draft restoration. A follow-up collection check released temporary review allocations: renderer live JS heap 16.4 MB, working set 154 MB. No live Drive delivery or saved selection was changed. Both Windows artifacts include the preview-path, scrolling and reliability corrections.
