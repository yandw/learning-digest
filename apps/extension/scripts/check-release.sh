#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# The extension unit root (allowlisted plugin files resolve from here).
extension_root="$(cd "$script_dir/.." && pwd)"
# The repository root (shared docs shipped in the ZIP resolve from here).
repo_root="$(cd "$extension_root/../.." && pwd)"
cd "$extension_root"

mode="${1:-}"
if [[ -n "$mode" && "$mode" != "--print-files" && "$mode" != "--print-repo-files" ]]; then
  printf 'Usage: %s [--print-files|--print-repo-files]\n' "$0" >&2
  exit 2
fi

log() {
  printf '%s\n' "$*" >&2
}

fail() {
  printf 'Release check failed: %s\n' "$*" >&2
  exit 1
}

# This is the only set of files eligible for the public extension ZIP.
# Optional entries are included only when present; manifest references are
# validated separately, so a referenced-but-missing file still fails.
public_allowlist=(
  "manifest.json"
  "background.js"
  "settings.js"
  "auth-gate.js"
  "collect.js"
  "learning-start.js"
  "notes.js"
  "api-client.js"
  "transcript-shapes.js"
  "session-archive.js"
  "bilibili-captions.js"
  "youtube-captions.js"
  "contracts/platform-video-id.js"
  "transcript-pipeline.js"
  "speech-transcription.js"
  "session-pipeline.js"
  "session-timeline.js"
  "session-persistence.js"
  "source-platforms.js"
  "session-segmenter.js"
  "session-summary.js"
  "page-bridge.js"
  "offscreen.html"
  "offscreen.js"
  "report-render.js"
  "report.html"
  "report.js"
  "sidepanel.html"
  "sidepanel.css"
  "sidepanel.js"
  "options.html"
  "options-diagnostics.js"
  "options.css"
  "options.js"
  "icons/icon16.png"
  "icons/icon48.png"
  "icons/icon128.png"
  "prompts/explain.md"
  "prompts/topic-tick.md"
  "prompts/session-report.md"
)

# Repo-root files that ride along in the public ZIP (project docs + license).
# They resolve from the repository root, not from the extension unit root.
repo_public_files=(
  "README.md"
  "README.zh-CN.md"
  "PRIVACY.md"
  "SECURITY.md"
  "LICENSE"
)

required_public_files=(
  "manifest.json"
  "background.js"
  "settings.js"
  "auth-gate.js"
  "collect.js"
  "learning-start.js"
  "notes.js"
  "api-client.js"
  "transcript-shapes.js"
  "session-archive.js"
  "bilibili-captions.js"
  "youtube-captions.js"
  "contracts/platform-video-id.js"
  "transcript-pipeline.js"
  "speech-transcription.js"
  "session-pipeline.js"
  "session-timeline.js"
  "session-persistence.js"
  "source-platforms.js"
  "session-segmenter.js"
  "session-summary.js"
  "page-bridge.js"
  "offscreen.html"
  "offscreen.js"
  "report-render.js"
  "report.html"
  "report.js"
  "sidepanel.html"
  "sidepanel.css"
  "sidepanel.js"
  "icons/icon16.png"
  "icons/icon48.png"
  "icons/icon128.png"
)

# The extension's copy of the shared four-station identity extractor: the
# service worker can only importScripts() from inside the extension root, so
# this unit carries a verbatim copy of contracts/platform-video-id.js. Guard
# against drift whenever the shared original changes.
shared_platform_video_id="$repo_root/contracts/platform-video-id.js"
extension_platform_video_id="$extension_root/contracts/platform-video-id.js"
if [[ -f "$shared_platform_video_id" ]]; then
  cmp -s "$shared_platform_video_id" "$extension_platform_video_id" || fail \
    "apps/extension/contracts/platform-video-id.js has drifted from contracts/platform-video-id.js; re-sync the extension copy"
fi

for file in "${required_public_files[@]}"; do
  [[ -f "$file" ]] || fail "required public file is missing: $file"
done

for file in "${repo_public_files[@]}"; do
  [[ -f "$repo_root/$file" ]] || fail "required public file is missing: $file"
done

release_files=()
for file in "${public_allowlist[@]}"; do
  if [[ -e "$file" ]]; then
    [[ -f "$file" ]] || fail "allowlisted path is not a regular file: $file"
    [[ ! -L "$file" ]] || fail "allowlisted path must not be a symbolic link: $file"
    release_files+=("$file")
  fi
done

for forbidden in "config.js" ".DS_Store" ".git"; do
  for file in "${release_files[@]}" "${repo_public_files[@]}"; do
    if [[ "$file" == "$forbidden" || "$file" == "$forbidden/"* || "$file" == */"$forbidden" ]]; then
      fail "private path entered the release list: $file"
    fi
  done
done

command -v node >/dev/null 2>&1 || fail "Node.js is required"

# Repo-root ZIP entries are scanned from their real location; every other
# release file resolves from the extension unit root (the cwd).
credential_scan_files=()
for file in "${release_files[@]}"; do
  credential_scan_files+=("$file")
done
for file in "${repo_public_files[@]}"; do
  credential_scan_files+=("$repo_root/$file")
done
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  while IFS= read -r -d '' file; do
    [[ -f "$repo_root/$file" && ! -L "$repo_root/$file" ]] || continue
    credential_scan_files+=("$repo_root/$file")
  done < <(git ls-files -z --cached --others --exclude-standard --full-name)
fi

REPO_PUBLIC_ROOT="$repo_root" node - "${release_files[@]}" -- "${repo_public_files[@]}" <<'NODE'
const fs = require("fs");
const path = require("path");

const separator = process.argv.indexOf("--");
const releaseFiles = process.argv.slice(2, separator === -1 ? undefined : separator);
// Repo-root entries ship in the ZIP under their own names but live at the
// repository root on disk (the shared README/PRIVACY/SECURITY docs, LICENSE).
const repoPublicFiles = process.argv.slice(separator + 1);
const repoRoot = process.env.REPO_PUBLIC_ROOT || "";
const allowlisted = new Set([...releaseFiles, ...repoPublicFiles]);
const resolvePublicFile = (file) =>
  repoPublicFiles.includes(file) ? path.join(repoRoot, file) : file;
let manifest;

try {
  manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
} catch (error) {
  console.error(`manifest.json is not valid JSON: ${error.message}`);
  process.exit(1);
}

if (manifest.manifest_version !== 3) {
  console.error("manifest.json must declare manifest_version 3");
  process.exit(1);
}

for (const field of ["name", "version", "description"]) {
  if (typeof manifest[field] !== "string" || !manifest[field].trim()) {
    console.error(`manifest.json must include a non-empty ${field}`);
    process.exit(1);
  }
}

if (!/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(manifest.version)) {
  console.error("manifest.json version must contain three or four numeric components");
  process.exit(1);
}

const referenced = new Set();
const add = (value) => {
  if (typeof value === "string" && value) referenced.add(value);
};
const addIconMap = (icons) => {
  if (icons && typeof icons === "object") Object.values(icons).forEach(add);
};

add(manifest.background?.service_worker);
add(manifest.side_panel?.default_path);
add(manifest.options_page);
add(manifest.options_ui?.page);
add(manifest.action?.default_popup);
addIconMap(manifest.icons);
addIconMap(manifest.action?.default_icon);

for (const script of manifest.content_scripts || []) {
  (script.js || []).forEach(add);
  (script.css || []).forEach(add);
}

for (const item of manifest.web_accessible_resources || []) {
  (item.resources || []).forEach((resource) => {
    if (!resource.includes("*")) add(resource);
  });
}

// Manifest V3 does not list importScripts() dependencies or assets referenced
// by extension HTML, so validate those local references too.
for (const file of releaseFiles) {
  if (file.endsWith(".js")) {
    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(
      /\bimportScripts\s*\(\s*["']([^"']+)["']\s*\)/g,
    )) {
      if (!/^[a-z]+:/i.test(match[1])) {
        referenced.add(path.posix.join(path.posix.dirname(file), match[1]));
      }
    }
    for (const match of source.matchAll(
      /\bloadPromptSection\s*\(\s*["']([^"']+)["']/g,
    )) {
      referenced.add(path.posix.join("prompts", match[1]));
    }
  }

  if (file.endsWith(".html")) {
    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(
      /\b(?:src|href)\s*=\s*["']([^"']+)["']/gi,
    )) {
      const value = match[1];
      if (
        value.startsWith("#") ||
        value.startsWith("//") ||
        /^[a-z]+:/i.test(value)
      ) {
        continue;
      }
      referenced.add(path.posix.join(path.posix.dirname(file), value));
    }
  }
}

for (const file of referenced) {
  const normalized = path.posix.normalize(file.replaceAll("\\", "/"));
  if (
    path.isAbsolute(file) ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    console.error(`manifest references an unsafe path: ${file}`);
    process.exit(1);
  }
  const resolved = resolvePublicFile(file);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    console.error(`manifest references a missing file: ${file}`);
    process.exit(1);
  }
  if (!allowlisted.has(file)) {
    console.error(`manifest references a file outside the public allowlist: ${file}`);
    process.exit(1);
  }
}
NODE

javascript_files=()
for file in "${release_files[@]}"; do
  if [[ "$file" == *.js ]]; then
    javascript_files+=("$file")
  fi
done

for file in "${javascript_files[@]}"; do
  node --check "$file"
done

if compgen -G "tests/*.test.js" >/dev/null; then
  # In print modes the caller consumes this script's stdout as the release
  # file list, so the test reporter's stream is parked on stderr there.
  if [[ -n "$mode" ]]; then
    node --test tests/*.test.js >&2
  else
    node --test tests/*.test.js
  fi
fi

if ((${#javascript_files[@]} > 0)); then
  if grep -En \
    'importScripts[[:space:]]*\([[:space:]]*["'\'']config\.js|(^|[^[:alnum:]_])CONFIG\.' \
    "${javascript_files[@]}" >&2; then
    fail "public JavaScript still depends on config.js/CONFIG; use Options-page storage"
  fi
fi

node - "${credential_scan_files[@]}" <<'NODE'
const fs = require("fs");

const patterns = [
  ["private key block", /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g],
  ["OpenAI-style key", /\bsk-[A-Za-z0-9_-]{20,}\b/g],
  ["Supadata-style key", /\bsd_[A-Za-z0-9_-]{16,}\b/g],
  ["GitHub token", /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g],
  ["GitHub fine-grained token", /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{30,}\b/g],
  ["Slack token", /\bxox[baprs]-[0-9A-Za-z-]{20,}\b/g],
  ["AWS access key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  [
    "credential assignment",
    /\b(?:api[_-]?key|secret|access[_-]?token|auth[_-]?token)\b\s*[:=]\s*["'][^"'\s]{16,}["']/gi,
  ],
];

let found = false;
for (const file of process.argv.slice(2)) {
  if (!/\.(?:js|json|html|css|md|txt|yml|yaml|sh)$/i.test(file) && file !== "LICENSE") {
    continue;
  }
  const text = fs.readFileSync(file, "utf8");
  for (const [label, pattern] of patterns) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) {
      console.error(`possible ${label} found in publishable repository file: ${file}`);
      found = true;
    }
  }
}

if (found) process.exit(1);
NODE

log "Release checks passed ((${#release_files[@]} + ${#repo_public_files[@]}) allowlisted files)."

if [[ "$mode" == "--print-files" ]]; then
  printf '%s\n' "${release_files[@]}" "${repo_public_files[@]}"
fi

if [[ "$mode" == "--print-repo-files" ]]; then
  printf '%s\n' "${repo_public_files[@]}"
fi
