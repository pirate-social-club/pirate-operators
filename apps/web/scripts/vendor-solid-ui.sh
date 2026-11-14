#!/usr/bin/env bash
# Rebuild the vendored design-system tarballs from a pirate-web-solid commit.
#
# Usage: scripts/vendor-solid-ui.sh <pirate-web-solid checkout> <commit>
#
# The script reads the commit with `git archive`, so it never edits or checks
# out the source repository. It applies exactly the transformations recorded in
# vendor/PROVENANCE.json and writes deterministic tarballs (sorted entries,
# fixed mtime, numeric owner, gzip without a name or timestamp).
set -euo pipefail

source_repo=${1:?pirate-web-solid checkout}
commit=${2:?commit}
here=$(cd "$(dirname "$0")/.." && pwd)
vendor="$here/vendor"
short=$(git -C "$source_repo" rev-parse --short=8 "$commit^{commit}")
full=$(git -C "$source_repo" rev-parse "$commit^{commit}")
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

kobalte=vendor/kobalte-core-2.0.0-alpha.0-a892187065cf7e0d07e91db02310bd28a5619236-patched.tgz
git -C "$source_repo" archive "$full" packages/solid-ui "$kobalte" vendor/kobalte-core-provenance.json \
  | tar -x -C "$work"

# Apply the consumer-owned, type-only Solid rc.21 update. Keep the original
# imported source and Kobalte patch series independently reproducible.
patch --batch --forward --fuzz=0 --strip=1 --directory="$work/packages/solid-ui" \
  --input="$vendor/patches/solid-ui-solid2-rc21.patch"

# Add the npm package version and declare the consumer's pinned runtime.
# Kobalte keeps its source file: specifier; the consumer override redirects it.
node -e '
  const fs = require("node:fs");
  const [file, version] = process.argv.slice(1);
  const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  if ("version" in manifest) throw new Error("upstream manifest now has a version; review the transformation");
  manifest.peerDependencies = { ...manifest.peerDependencies, "solid-js": "2.0.0-rc.21", "@solidjs/web": "2.0.0-rc.21" };
  const ordered = { name: manifest.name, version, ...manifest };
  fs.writeFileSync(file, JSON.stringify(ordered, null, 2) + "\n");
' "$work/packages/solid-ui/package.json" "0.0.0-git.$short.solid2-rc21.1"

mkdir -p "$work/stage"
mv "$work/packages/solid-ui" "$work/stage/package"
out="$vendor/pirate-web-solid-ui-0.0.0-git.$short.solid2-rc21.1.tgz"
mkdir -p "$vendor"
tar --sort=name --mtime='1985-10-26 08:15:00Z' --owner=0 --group=0 --numeric-owner \
  -C "$work/stage" -cf - package | gzip -n -9 > "$out"
cp "$work/$kobalte" "$vendor/"
cp "$work/vendor/kobalte-core-provenance.json" "$vendor/"

# Register dialog layers after their DOM ref arrives. Preserve the original
# patched archive and derive a separately identified consumer successor.
mkdir -p "$work/kobalte"
tar -xzf "$work/$kobalte" -C "$work/kobalte"
patch --batch --forward --fuzz=0 --strip=1 --directory="$work/kobalte/package" \
  --input="$vendor/patches/kobalte-solid2-rc21.patch"
kobalte_out="$vendor/kobalte-core-2.0.0-alpha.0-a892187065cf7e0d07e91db02310bd28a5619236-patched-rc21.1.tgz"
tar --sort=name --mtime='1985-10-26 08:15:00Z' --owner=0 --group=0 --numeric-owner \
  -C "$work/kobalte" -cf - package | gzip -n -9 > "$kobalte_out"

sha512() { openssl dgst -sha512 -binary "$1" | base64 -w0; }
printf 'solid-ui %s sha512-%s\n' "$(basename "$out")" "$(sha512 "$out")"
printf 'kobalte  %s sha512-%s\n' "$(basename "$kobalte")" "$(sha512 "$vendor/$(basename "$kobalte")")"
printf 'kobalte consumer %s sha512-%s\n' "$(basename "$kobalte_out")" "$(sha512 "$kobalte_out")"
printf 'source   %s\n' "$full"
