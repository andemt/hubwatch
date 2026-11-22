#!/usr/bin/env bash
# Builds HubWatch.app: the macOS menu bar app (Swift, src/HubWatch.Mac) with the published server inside it
# (Contents/Resources/server). Runs on macOS with Xcode or the Xcode command line tools.
#
# Usage: packaging/macos/build-app.sh <osx-arm64|osx-x64> <published server folder> <version> <output folder>
#
# Without arguments it does everything for this Mac: builds the web UI, publishes the server and writes
# artifacts/macos/HubWatch.app. See CONTRIBUTING.md.
set -euo pipefail

root=$(cd "$(dirname "$0")/../.." && pwd)

if [ $# -eq 0 ]; then
  case "$(uname -m)" in arm64) rid=osx-arm64 ;; *) rid=osx-x64 ;; esac
  out="$root/artifacts/macos"
  server="$out/server"
  version=$(sed -n 's:.*<Version>\(.*\)</Version>.*:\1:p' "$root/src/HubWatch.Server/HubWatch.Server.csproj")
  (cd "$root/src/HubWatch.Web" && pnpm install --frozen-lockfile && pnpm build)
  rm -rf "$server"
  dotnet publish "$root/src/HubWatch.Server" -c Release -r "$rid" --self-contained true \
    -p:PublishSingleFile=true -p:DebugType=none -o "$server"
else
  rid=$1; server=$2; version=$3; out=$4
fi

case "$rid" in
  osx-arm64) arch=arm64 ;;
  osx-x64) arch=x86_64 ;;
  *) echo "Unknown runtime identifier: $rid" >&2; exit 1 ;;
esac

app="$out/HubWatch.app"
rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources/server"

echo "Compiling the menu bar app ($arch)"
xcrun swiftc -O -swift-version 5 -target "$arch-apple-macos13.0" \
  -o "$app/Contents/MacOS/HubWatch" "$root"/src/HubWatch.Mac/*.swift

cp -R "$server"/. "$app/Contents/Resources/server/"
sed "s/__VERSION__/$version/g" "$root/src/HubWatch.Mac/Info.plist" > "$app/Contents/Info.plist"

echo "Making the icon"
tmp=$(mktemp -d)
iconset="$tmp/AppIcon.iconset"
mkdir "$iconset"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "$root/src/HubWatch.Mac/AppIcon.png" --out "$iconset/icon_${size}x${size}.png" >/dev/null
  double=$((size * 2))
  sips -z "$double" "$double" "$root/src/HubWatch.Mac/AppIcon.png" --out "$iconset/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$iconset" -o "$app/Contents/Resources/AppIcon.icns"
rm -rf "$tmp"

# Ad-hoc signatures: no Apple developer account needed, but Apple Silicon only runs signed code.
# Inner code first, then the app itself (which seals everything inside it).
echo "Signing (ad-hoc)"
find "$app/Contents/Resources/server" -type f \( -name '*.dylib' -o -perm -u+x \) -print0 |
  while IFS= read -r -d '' file; do
    if file "$file" | grep -q 'Mach-O'; then codesign --force --sign - "$file"; fi
  done
codesign --force --sign - "$app"
codesign --verify --strict "$app"

echo "Built $app ($version)"
