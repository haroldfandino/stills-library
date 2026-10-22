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
folders on the Windows machine, or pass `--extract-root` and `--rename-script`
to `scripts/build-native.py`. Install native x64 Python 3.12, Node, and the
Extract Stills pinned requirements. Put x64 `ffmpeg.exe` and `ffprobe.exe` in
`extract-stills\ffmpeg\`; the FFmpeg build must expose `zscale`, `tonemap`, and
`iccgen` and must not use `--enable-nonfree`.
Apply the same patch once if that checkout still uses `-filter_script:v`:
`git -C ..\extract-stills apply ..\stills-library\patches\extract-stills-ffmpeg9.patch`.

```powershell
cd ..\extract-stills
py -3.12 -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements-dev.txt
.venv\Scripts\python.exe scripts\setup_models.py
cd ..\stills-library
..\extract-stills\.venv\Scripts\python.exe scripts\build-native.py --ffmpeg-dir ..\extract-stills\ffmpeg
npm ci
npm run typecheck
npm test
npm run package
npm run make
```

The frozen verifier tests original-resolution PNG, 16-bit TIFF, ICC profile,
shot selection, repeated imagery, text changes, and unchanged source video on
synthetic clips. Then exercise both approval screens, interrupted upload
recovery, and the bundled CLI on the Windows machine. The CLI launcher is
`resources\bin\stills-library.cmd`; its packaged FFprobe is
`resources\x64\extract-stills\_internal\binaries\ffprobe.exe`.
Do not mark Windows validated until these checks run on that machine.

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
