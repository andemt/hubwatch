#!/usr/bin/env bash
# Tests the Homebrew formula on this Mac before anything is published: zips artifacts/macos/HubWatch.app like the
# release does, generates the formula with a file:// URL, puts it in a local tap (andemt/local) and installs it.
# Output is also written to logs/brew-test.log.
#
# Usage: packaging/homebrew/test-local.sh        (run packaging/macos/build-app.sh first)
# Clean up afterwards: brew uninstall hubwatch && brew untap andemt/local
set -euo pipefail

root=$(cd "$(dirname "$0")/../.." && pwd)
mkdir -p "$root/logs"
exec > >(tee "$root/logs/brew-test.log") 2>&1

app="$root/artifacts/macos/HubWatch.app"
[ -d "$app" ] || { echo "No $app. Run packaging/macos/build-app.sh first."; exit 1; }

if curl -s -m 1 -o /dev/null http://localhost:5080/api/status; then
  echo "Something answers on port 5080 (dotnet watch, or the app). Stop it first, so the test uses the installed server."
  exit 1
fi

version=$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$app/Contents/Info.plist")
tag="v$version"
dist="$root/artifacts/macos/dist"
rm -rf "$dist"; mkdir -p "$dist"

echo "== Zipping HubWatch.app ($tag)"
ditto -c -k --keepParent "$app" "$dist/HubWatch-$tag-osx-arm64.zip"
# The formula lists both architectures; only this Mac's is used, so the same zip stands in for the other.
cp "$dist/HubWatch-$tag-osx-arm64.zip" "$dist/HubWatch-$tag-osx-x64.zip"

echo "== Local tap andemt/local"
brew tap andemt/local >/dev/null 2>&1 || brew tap-new andemt/local --no-git
tap_dir="$(brew --repository andemt/local)"
mkdir -p "$tap_dir/Formula"
bash "$root/packaging/homebrew/formula.sh" "$tag" andemt/hubwatch "$dist" "file://$dist" > "$tap_dir/Formula/hubwatch.rb"
echo "Formula: $tap_dir/Formula/hubwatch.rb"

echo "== Installing"
brew uninstall --force hubwatch >/dev/null 2>&1 || true
brew install andemt/local/hubwatch

echo "== brew test"
brew test andemt/local/hubwatch

prefix="$(brew --prefix)/opt/hubwatch"
echo "== Quarantine attribute (should be empty)"
xattr -r "$prefix/HubWatch.app" | grep -i quarantine || echo "none"

echo "== Signatures after install"
codesign --verify --strict --verbose=1 "$prefix/HubWatch.app" 2>&1 || true
codesign --verify --verbose=1 "$prefix/HubWatch.app/Contents/Resources/server/HubWatch" 2>&1 || true

echo "== hubwatch command"
ls -la "$(brew --prefix)/bin/hubwatch" 2>&1 || true
command -v hubwatch || echo "hubwatch is not on PATH ($PATH)"

echo "== Starting the server with the hubwatch command"
"$prefix/bin/hubwatch" --no-browser > "$root/logs/brew-test-server.log" 2>&1 &
pid=$!
ok=no
for _ in $(seq 1 40); do
  if curl -s -m 1 http://localhost:5080/api/status >/dev/null; then ok=yes; break; fi
  sleep 0.5
done
echo "API answers: $ok"
curl -s -m 2 http://localhost:5080/ | grep -q 'id="root"' && echo "Web UI served: yes" || echo "Web UI served: NO"
kill "$pid" 2>/dev/null || true
wait "$pid" 2>/dev/null || true

echo
echo "== Done. Next, by hand:"
echo "  ln -sfn \"$prefix/HubWatch.app\" /Applications/HubWatch.app"
echo "  open /Applications/HubWatch.app"
