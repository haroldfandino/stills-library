"""Verify a native sidecar bundle and exercise frozen Rename Stills safely."""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
from pathlib import Path
import platform
import subprocess
import sys
import tempfile


PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j"
    "RZkAAAAASUVORK5CYII="
)


def digest(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def resources(executable: Path) -> Path:
    for candidate in (executable.parent / "_internal", executable.parent):
        if (candidate / "models" / "manifest.json").is_file():
            return candidate
    raise ValueError(f"No bundled models beside {executable}")


def check_resources(executable: Path) -> None:
    root = resources(executable)
    manifest = json.loads((root / "models" / "manifest.json").read_text(encoding="utf-8"))
    ids = set()
    for item in manifest["models"]:
        ids.add(item["id"])
        asset = (root / "models" / item["filename"]).resolve()
        if not asset.is_relative_to((root / "models").resolve()):
            raise ValueError(f"Unsafe bundled model filename: {item['filename']}")
        if not asset.is_file() or asset.stat().st_size != item["size_bytes"] or digest(asset) != item["sha256"]:
            raise ValueError(f"Missing or modified bundled model: {asset}")
    if not {"face_landmarker", "text_detector", "text_recognizer", "text_dictionary"} <= ids:
        raise ValueError("The extraction bundle is missing a required model declaration.")
    for name in ("ffmpeg", "ffprobe"):
        suffix = ".exe" if sys.platform == "win32" else ""
        if not (root / "binaries" / f"{name}{suffix}").is_file():
            raise ValueError(f"No bundled {name} executable")
    for name in ("EXTRACT-STILLS-LICENSE.txt", "FFMPEG-BINARIES.json", "PYTHON-PACKAGES.json"):
        if not (root / "licenses" / name).is_file():
            raise ValueError(f"Missing bundled notice: {name}")
    ffmpeg_records = json.loads((root / "licenses" / "FFMPEG-BINARIES.json").read_text(encoding="utf-8"))
    for name in ("ffmpeg", "ffprobe"):
        binary = root / "binaries" / f"{name}{suffix}"
        if digest(binary) != ffmpeg_records[name]["sha256"]:
            raise ValueError(f"Bundled {name} differs from its recorded build: {binary}")


def check_rename(executable: Path) -> None:
    with tempfile.TemporaryDirectory(prefix="stills-rename-check-") as name:
        folder = Path(name)
        inputs = [folder / "001.png", folder / "002.png"]
        for item in inputs:
            item.write_bytes(PNG)
        (folder / "keep.txt").write_text("untouched", encoding="utf-8")
        completed = subprocess.run(
            [str(executable)], cwd=folder, input="Project\nType\n", text=True,
            capture_output=True, timeout=30, check=False,
        )
        if completed.returncode:
            raise ValueError(f"Frozen Rename Stills failed: {completed.stdout}\n{completed.stderr}")
        expected = [folder / "Project_Type_Still_01.png", folder / "Project_Type_Still_02.png"]
        if any(not item.is_file() or item.read_bytes() != PNG for item in expected):
            raise ValueError("Frozen Rename Stills did not preserve and name the two PNG copies.")
        if any(item.exists() for item in inputs) or (folder / "keep.txt").read_text(encoding="utf-8") != "untouched":
            raise ValueError("Frozen Rename Stills changed an unexpected fixture file.")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--native-dir", type=Path, help="native/<platform>/<arch> directory")
    parser.add_argument("--extract", type=Path, help="Extract Stills one-folder bundle")
    parser.add_argument("--rename", type=Path, help="Frozen Rename Stills executable")
    parser.add_argument("--extract-root", type=Path, help="Extract Stills checkout for its full synthetic verifier")
    parser.add_argument("--skip-extract-smoke", action="store_true",
                        help="Only check bundled extraction assets; build-native already ran the full verifier.")
    args = parser.parse_args()
    try:
        suffix = ".exe" if sys.platform == "win32" else ""
        if args.native_dir:
            directory = args.native_dir.resolve(strict=True)
            extract = directory / "extract-stills"
            rename = directory / f"rename-stills{suffix}"
            record = directory / "BUILD-MANIFEST.json"
            if not record.is_file():
                raise ValueError(f"Missing build manifest: {record}")
            metadata = json.loads(record.read_text(encoding="utf-8"))
            if metadata["platform"] != sys.platform or metadata["arch"] != (
                "arm64" if platform.machine().lower() in ("arm64", "aarch64") else "x64"
            ):
                raise ValueError("Sidecar bundle was built for a different operating system or architecture.")
        else:
            if not args.extract or not args.rename:
                parser.error("Provide --native-dir or both --extract and --rename.")
            extract = args.extract.resolve(strict=True)
            rename = args.rename.resolve(strict=True)
        cli = extract / f"extract-stills{suffix}"
        if not cli.is_file() or not rename.is_file():
            raise ValueError(f"Missing native executable: {cli} or {rename}")
        if args.native_dir:
            for binary, key in ((cli, "extract_executable_sha256"), (rename, "rename_executable_sha256")):
                if digest(binary) != metadata[key]:
                    raise ValueError(f"Native executable differs from its build manifest: {binary}")
            report = directory / "packaged-verification.json"
            verification = json.loads(report.read_text(encoding="utf-8"))
            if verification.get("status") != "passed" or verification.get("offline_assets_verified") is not True:
                raise ValueError("The bundle has no passing packaged extraction verification.")
        check_resources(cli)
        check_rename(rename)
        if not args.skip_extract_smoke:
            if not args.extract_root:
                raise ValueError("--extract-root is required for the full synthetic extraction check.")
            checker = args.extract_root.resolve(strict=True) / "scripts" / "verify_packaged.py"
            subprocess.run([sys.executable, str(checker), "--cli", str(cli)], check=True, timeout=600)
        print(f"Native sidecars verified: {extract.parent}")
        return 0
    except (OSError, ValueError, KeyError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
        print(f"Native verification failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
