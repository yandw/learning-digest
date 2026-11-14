#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Extension unit root: the ZIP's root namespace (manifest.json lives here).
extension_root="$(cd "$script_dir/.." && pwd)"
# Repository root: shared docs shipped in the ZIP (README/PRIVACY/...) live here.
repo_root="$(cd "$extension_root/../.." && pwd)"
check_script="$script_dir/check-release.sh"
dist_dir="$extension_root/dist"

command -v zip >/dev/null 2>&1 || {
  printf 'Packaging failed: zip is required\n' >&2
  exit 1
}

release_files=()
while IFS= read -r file; do
  [[ -n "$file" ]] && release_files+=("$file")
done < <("$check_script" --print-files)

if ((${#release_files[@]} == 0)); then
  printf 'Packaging failed: release allowlist is empty\n' >&2
  exit 1
fi

# Entries sourced from the repository root instead of the extension unit root.
repo_files=()
while IFS= read -r file; do
  [[ -n "$file" ]] && repo_files+=("$file")
done < <("$check_script" --print-repo-files)

extension_files=()
for file in "${release_files[@]}"; do
  is_repo_file=false
  for repo_file in "${repo_files[@]}"; do
    if [[ "$file" == "$repo_file" ]]; then
      is_repo_file=true
      break
    fi
  done
  if [[ "$is_repo_file" == false ]]; then
    extension_files+=("$file")
  fi
done

if ((${#extension_files[@]} == 0)); then
  printf 'Packaging failed: extension allowlist is empty\n' >&2
  exit 1
fi

version="$(node -e 'const m=require(process.argv[1]); process.stdout.write(m.version)' "$extension_root/manifest.json")"
if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(\.[0-9]+)?$ ]]; then
  printf 'Packaging failed: unsafe manifest version: %s\n' "$version"
  exit 1
fi

mkdir -p "$dist_dir"
temporary_dir="$(mktemp -d "$dist_dir/.learning-digest-package.XXXXXX")"
temporary_zip="$temporary_dir/learning-digest.zip"
output_zip="$dist_dir/learning-digest-v$version.zip"

cleanup() {
  if [[ -f "$temporary_zip" ]]; then
    rm -f "$temporary_zip"
  fi
  if [[ -d "$temporary_dir" ]]; then
    rmdir "$temporary_dir" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# Two zip passes keep every entry name relative to the ZIP root (the
# extension unit namespace) while the sources live in two roots.
(
  cd "$extension_root"
  # Exclude platform-specific extra attributes so identical source files
  # produce the same archive checksum across repeated local builds.
  zip -X -q "$temporary_zip" "${extension_files[@]}"
)
(
  cd "$repo_root"
  zip -X -q "$temporary_zip" "${repo_files[@]}"
)

if unzip -Z1 "$temporary_zip" | grep -En '(^|/)(config\.js|\.DS_Store|\.git)(/|$)' >&2; then
  printf 'Packaging failed: a forbidden private path entered the ZIP\n' >&2
  exit 1
fi

mv -f "$temporary_zip" "$output_zip"
rmdir "$temporary_dir"
trap - EXIT

checksum="$(shasum -a 256 "$output_zip" | awk '{print $1}')"
printf 'Created %s\n' "$output_zip"
printf 'SHA-256: %s\n' "$checksum"
