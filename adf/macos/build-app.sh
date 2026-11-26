#!/bin/bash
set -euo pipefail

if [[ $# -ne 2 || "$1" != *.app || "$2" != /* ]]; then
    printf '%s\n' 'usage: build-app.sh /path/to/ADF.app /absolute/path/to/python3' >&2
    exit 2
fi

destination=$1
interpreter=$2
source_dir=$(cd "$(dirname "$0")/../.." && pwd)
"$interpreter" -I -c 'import sys; assert sys.version_info >= (3, 12), "Python 3.12 or later is required"'
if [[ -e "$destination" || -L "$destination" ]]; then
    printf '%s\n' '出力先は既に存在します。新しいパスを指定してください。' >&2
    exit 1
fi
parent=$(dirname "$destination")
mkdir -p "$parent"
stage=$(mktemp -d "$parent/.adf-app.XXXXXX")
trap 'rm -rf "$stage"' EXIT
mkdir -p "$stage/Contents/MacOS" "$stage/Contents/Resources/adf"
cp "$source_dir"/adf/*.py "$stage/Contents/Resources/adf/"
cp "$source_dir/adf/macos/Info.plist" "$stage/Contents/"
cp "$source_dir/adf/macos/adf" "$stage/Contents/MacOS/"
chmod +x "$stage/Contents/MacOS/adf"
mkdir -p "$stage/cache"
xcrun swiftc -module-cache-path "$stage/cache" -O -o "$stage/Contents/MacOS/ADFDesktop" \
    "$source_dir"/adf/macos/*.swift
rm -rf "$stage/cache"
printf '%s\n' "$interpreter" > "$stage/Contents/Resources/python-path"
# Seal the completed local bundle, including its interpreter launcher.
codesign --force --sign - "$stage/Contents/MacOS/adf"
codesign --force --sign - "$stage"
codesign --verify --strict "$stage"
# BSD mv -h refuses to follow a destination symlink.
mv -h -n "$stage" "$destination"
[[ ! -d "$stage" ]]
