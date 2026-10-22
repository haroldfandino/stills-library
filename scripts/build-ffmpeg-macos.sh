#!/bin/sh
# Build the two native FFmpeg tools needed by Extract Stills on Apple Silicon.
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
project_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
build_dir="$project_dir/build/ffmpeg-macos"
version=9.0.2
archive="$build_dir/ffmpeg-$version.tar.xz"
source_dir="$build_dir/ffmpeg-$version"
expected_sha256=8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e

if [ "$(uname -s)" != Darwin ] || [ "$(uname -m)" != arm64 ]; then
  echo 'This helper builds FFmpeg only on Apple Silicon macOS.' >&2
  exit 1
fi
for command in curl tar shasum make pkg-config brew clang vtool; do
  command -v "$command" >/dev/null 2>&1 || { echo "Missing $command" >&2; exit 1; }
done
zimg_prefix=$(brew --prefix zimg)
lcms_prefix=$(brew --prefix little-cms2)
zimg_version=$(pkg-config --modversion zimg)
lcms_version=$(pkg-config --modversion lcms2)
mkdir -p "$build_dir" "$build_dir/pkgconfig"
if [ ! -f "$archive" ]; then
  curl --fail --location --retry 3 --output "$archive" "https://ffmpeg.org/releases/ffmpeg-$version.tar.xz"
fi
actual_sha256=$(shasum -a 256 "$archive" | cut -d ' ' -f 1)
if [ "$actual_sha256" != "$expected_sha256" ]; then
  echo "FFmpeg source checksum mismatch: $actual_sha256" >&2
  exit 1
fi
if [ ! -d "$source_dir" ]; then
  tar -xf "$archive" -C "$build_dir"
fi

# Use the installed static archives, preventing references to Homebrew dylib
# paths in the shipped ffmpeg and ffprobe programs.
cat > "$build_dir/pkgconfig/zimg.pc" <<EOF
prefix=$zimg_prefix
Name: zimg
Description: static zimg for the Stills Library FFmpeg build
Version: $zimg_version
Libs: $zimg_prefix/lib/libzimg.a -lc++
Cflags: -I$zimg_prefix/include
EOF
cat > "$build_dir/pkgconfig/lcms2.pc" <<EOF
prefix=$lcms_prefix
Name: lcms2
Description: static LittleCMS 2 for the Stills Library FFmpeg build
Version: $lcms_version
Libs: $lcms_prefix/lib/liblcms2.a
Cflags: -I$lcms_prefix/include
EOF
export PKG_CONFIG_PATH="$build_dir/pkgconfig"
export PKG_CONFIG_LIBDIR="$build_dir/pkgconfig"
export MACOSX_DEPLOYMENT_TARGET=15.0

mkdir -p "$build_dir/objects" "$build_dir/prefix"
cd "$build_dir/objects"
if [ -f Makefile ]; then
  make clean
fi
"$source_dir/configure" \
  --prefix="$build_dir/prefix" \
  --arch=arm64 \
  --target-os=darwin \
  --cc=clang \
  --disable-autodetect \
  --disable-shared \
  --enable-static \
  --disable-doc \
  --disable-ffplay \
  --enable-avdevice \
  --enable-lcms2 \
  --enable-libzimg \
  --enable-zlib \
  --enable-videotoolbox \
  --enable-audiotoolbox \
  --extra-cflags=-mmacosx-version-min=15.0 \
  --extra-ldflags=-mmacosx-version-min=15.0 \
  --pkg-config-flags=--static
make -j 4
make install

bin_dir="$build_dir/prefix/bin"
for filter in zscale tonemap iccgen; do
  if ! "$bin_dir/ffmpeg" -hide_banner -filters 2>/dev/null | awk '{print $2}' | grep -qx "$filter"; then
    echo "FFmpeg build lacks $filter" >&2
    exit 1
  fi
done
if otool -L "$bin_dir/ffmpeg" | grep -q '/opt/homebrew'; then
  echo 'FFmpeg still depends on a Homebrew library and is not redistributable as built.' >&2
  exit 1
fi
for binary in ffmpeg ffprobe; do
  if ! vtool -show-build "$bin_dir/$binary" | grep -q 'minos 15.0'; then
    echo "$binary does not declare a macOS 15.0 minimum." >&2
    exit 1
  fi
done

notices="$build_dir/notices"
mkdir -p "$notices"
cp "$source_dir/COPYING.LGPLv2.1" "$source_dir/LICENSE.md" "$notices/"
cp "$script_dir/build-ffmpeg-macos.sh" "$notices/SOURCE-BUILD-FFMPEG.sh"
curl --fail --location --retry 3 --output "$notices/LICENSE-zimg.txt" \
  "https://raw.githubusercontent.com/sekrit-twc/zimg/release-$zimg_version/COPYING"
curl --fail --location --retry 3 --output "$notices/LICENSE-lcms2.txt" \
  "https://raw.githubusercontent.com/mm2/Little-CMS/lcms$lcms_version/LICENSE"
cat > "$notices/README-SOURCE.txt" <<EOF
FFmpeg $version: https://ffmpeg.org/releases/ffmpeg-$version.tar.xz
FFmpeg source SHA-256: $expected_sha256
zimg $zimg_version: https://github.com/sekrit-twc/zimg/tree/release-$zimg_version
LittleCMS $lcms_version: https://github.com/mm2/Little-CMS/tree/lcms$lcms_version
Build script: SOURCE-BUILD-FFMPEG.sh
Linked zimg and LittleCMS static archives came from the Homebrew installations
listed above. Save their exact source archives and any Homebrew patches beside
public release files. FFmpeg -buildconf and -L are also recorded by Extract
Stills under its bundled licenses directory.
EOF

echo "FFmpeg and FFprobe built in $bin_dir"
echo "Copy them into the Extract Stills ffmpeg/ directory, then run build-native.py."
echo "Keep the source tarball, this build script, and exact dependency sources with release materials."
