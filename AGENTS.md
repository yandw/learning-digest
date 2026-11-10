# Agent Skills Configuration

This file documents the configuration for Matt Pocock's engineering skills.

## Agent skills

### Issue tracker

Issues live in GitHub at `yandw/learning-digest`. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context layout: one `GLOSSARY.md` at repo root, ADRs under `docs/adr/`. See `docs/agents/domain.md`.

## Project conventions

- **Version the four release units independently.** The Chrome extension, Web library, backend API, and recording Worker each own their release version. Bump the patch version of each affected unit for runtime changes by default. Shared changes bump each unit whose shipped behavior changes. Planning-only changes do not require a release bump.
- **The root version is the Chrome extension version.** The productization branch starts at `0.2.0`. The `0.1.x` series belongs to the legacy PoC. Keep `manifest.json`, root `package.json`, and the pin in `tests/release.test.js` in sync. Bump them when a change affects the extension release so the owner can verify the loaded version in `chrome://extensions`.
- **The Web library, API, and Worker each start at `0.1.0` when their first runnable build exists.** Store each version in that unit's own release metadata when introducing the unit. The API contract path `/v1` is versioned separately from the API build.
