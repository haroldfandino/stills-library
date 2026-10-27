"""Build the native Extract Stills and Rename Stills sidecars on this host.

Use the Python 3.12 environment prepared for the sibling extract-stills project.
Native builds are never cross-compiled. The complete one-folder extraction bundle
and the frozen rename executable are copied under native/<platform>/<arch>/.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import tempfile


ROOT = Path(__file__).resolve().parent.parent
TOOLS = ROOT.parent


def host() -> tuple[str, str]:
    if sys.version_info[:2] != (3, 12):
        raise ValueError("Run this script with the Extract Stills Python 3.12 environment.")
    machine = platform.machine().lower()
    if sys.platform == "darwin" and machine in ("arm64", "aarch64"):
        return "darwin", "arm64"
    if sys.platform == "win32" and machine in ("amd64", "x86_64"):
        return "win32", "x64"
    raise ValueError(f"Native build requires Apple Silicon macOS or Windows x64; got {sys.platform}/{machine}.")


def run(args: list[str], **kwargs: object) -> None:
    print("+", subprocess.list2cmdline(args), flush=True)
    subprocess.run(args, check=True, **kwargs)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def freeze_rename(source: Path, temporary: Path, suffix: str) -> Path:
    run([
        sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean", "--onefile",
        "--console", "--name", "rename-stills", "--distpath", str(temporary / "rename-dist"),
        "--workpath", str(temporary / "rename-work"), "--specpath", str(temporary / "rename-spec"),
        str(source),
    ])
    executable = temporary / "rename-dist" / f"rename-stills{suffix}"
    if not executable.is_file():
        raise ValueError(f"PyInstaller did not create {executable}")
    return executable


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--extract-root", type=Path,
                        default=Path(os.environ.get("STILLS_EXTRACT_STILLS_ROOT", TOOLS / "extract-stills")))
    parser.add_argument("--rename-script", type=Path,
                        default=Path(os.environ.get("STILLS_RENAME_STILLS_SOURCE",
                                                    TOOLS / "postproduction-tools" / "Rename_stills" / "rename_stills.py")))
    parser.add_argument("--ffmpeg-dir", type=Path,
                        help="Directory containing native ffmpeg and ffprobe. Defaults to Extract Stills' ffmpeg/ then PATH.")
    parser.add_argument("--check", action="store_true", help="Validate prerequisites without creating a bundle.")
    args = parser.parse_args()
    try:
        platform_name, arch = host()
        extract_root = args.extract_root.resolve(strict=True)
        rename_source = args.rename_script.resolve(strict=True)
        if not (extract_root / "build_app.py").is_file():
            raise ValueError(f"Not an Extract Stills checkout: {extract_root}")
        core_source = extract_root / "stills_tool" / "core.py"
        if '"-filter_script:v"' in core_source.read_text(encoding="utf-8"):
            raise ValueError("Extract Stills still uses FFmpeg's removed -filter_script:v option. "
                             "Apply patches/extract-stills-ffmpeg9.patch to that checkout first.")
        if "cv2.imwrite(str(path), frame" in core_source.read_text(encoding="utf-8"):
            raise ValueError("Extract Stills still uses preview file APIs that fail for Unicode Windows paths. "
                             "Apply patches/extract-stills-unicode-paths.patch to that checkout first.")
        if 'str(directory).replace("%", "%%")' not in core_source.read_text(encoding="utf-8"):
            raise ValueError("Apply patches/extract-stills-percent-paths.patch before building.")
        if 'recognition_error=str(error)' not in (extract_root / 'stills_tool' / 'text_ocr.py').read_text(encoding='utf-8'):
            raise ValueError("Apply patches/extract-stills-degenerate-text.patch before building.")
        if not rename_source.is_file() or rename_source.name != "rename_stills.py":
            raise ValueError(f"Missing original Rename Stills script: {rename_source}")
        run([sys.executable, "-m", "PyInstaller", "--version"])
        preflight = [sys.executable, str(extract_root / "build_app.py"), "--target", "cli", "--dry-run"]
        if args.ffmpeg_dir:
            preflight.extend(["--ffmpeg-dir", str(args.ffmpeg_dir.resolve(strict=True))])
        run(preflight, cwd=extract_root)
        if args.check:
            print("Native prerequisites passed; no bundle was created.")
            return 0

        build_dir = ROOT / "build"
        build_dir.mkdir(exist_ok=True)
        suffix = ".exe" if platform_name == "win32" else ""
        destination = ROOT / "native" / platform_name / arch
        with tempfile.TemporaryDirectory(prefix="stills-native-", dir=build_dir) as name:
            temporary = Path(name)
            extraction_dist = temporary / "extract-dist"
            command = [sys.executable, str(extract_root / "build_app.py"), "--target", "cli",
                       "--dist-dir", str(extraction_dist)]
            if args.ffmpeg_dir:
                command.extend(["--ffmpeg-dir", str(args.ffmpeg_dir.resolve(strict=True))])
            run(command, cwd=extract_root)
            extraction_folder = extraction_dist / "cli" / "extract-stills"
            extraction_exe = extraction_folder / f"extract-stills{suffix}"
            if not extraction_exe.is_file():
                raise ValueError(f"Extract Stills build is incomplete: {extraction_exe}")
            ffprobe_exe = extraction_folder / "_internal" / "binaries" / f"ffprobe{suffix}"
            if not ffprobe_exe.is_file():
                raise ValueError(f"Extract Stills did not bundle ffprobe: {ffprobe_exe}")
            verification = temporary / "packaged-verification.json"
            run([sys.executable, str(extract_root / "scripts" / "verify_packaged.py"),
                 "--cli", str(extraction_exe), "--result-json", str(verification)], cwd=extract_root)

            rename_exe = freeze_rename(rename_source, temporary, suffix)
            # Verify the frozen rename script on isolated fixture copies.
            run([sys.executable, str(ROOT / "scripts" / "verify-native.py"),
                 "--extract", str(extraction_folder), "--rename", str(rename_exe),
                 "--extract-root", str(extract_root), "--skip-extract-smoke"])

            staged = temporary / "native-output"
            staged.mkdir()
            shutil.copytree(extraction_folder, staged / "extract-stills", symlinks=True)
            shutil.copy2(rename_exe, staged / rename_exe.name)
            shutil.copy2(verification, staged / "packaged-verification.json")
            notices = staged / "notices"
            notices.mkdir()
            shutil.copy2(rename_source, notices / "rename_stills.py")
            manifest = {
                "platform": platform_name,
                "arch": arch,
                "python": sys.version,
                "extract_stills_source": str(extract_root),
                "rename_stills_source": str(rename_source),
                "rename_stills_source_sha256": sha256(rename_source),
                "extract_executable_sha256": sha256(extraction_exe),
                "ffprobe_relative_path": f"extract-stills/_internal/binaries/ffprobe{suffix}",
                "ffprobe_sha256": sha256(ffprobe_exe),
                "rename_executable_sha256": sha256(rename_exe),
                "extraction_verification": "packaged-verification.json",
            }
            (staged / "BUILD-MANIFEST.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
            destination.parent.mkdir(parents=True, exist_ok=True)
            replacement = destination.with_name(destination.name + ".old")
            if replacement.exists():
                shutil.rmtree(replacement)
            if destination.exists():
                destination.replace(replacement)
            try:
                shutil.move(str(staged), str(destination))
            except BaseException:
                if replacement.exists():
                    replacement.replace(destination)
                raise
            if replacement.exists():
                shutil.rmtree(replacement)
        print(f"Verified native sidecars: {destination}")
        return 0
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        print(f"Native build failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
