# Agent Skills Configuration

This file documents the configuration for Matt Pocock's engineering skills.

## Agent skills

### Issue tracker

Issues live in GitHub at `yandw/learning-digest`. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context layout: one `GLOSSARY.md` at repo root, ADRs under `docs/adr/`. See `docs/agents/domain.md`.

## Project conventions

- **All four units live under `apps/` (extension, web, api, worker); the repo root carries no plugin files.** The Chrome extension loads unpacked from `apps/extension`; its release checks and packaging scripts live in `apps/extension/scripts/`. The root `package.json` is only the suite-running entry (`npm test`, `npm run check`, `npm run package`); it carries no release version.
- **Version the four release units independently.** The Chrome extension, Web library, backend API, and recording Worker each own their release version. Bump the patch version of each affected unit for runtime changes by default. Shared changes bump each unit whose shipped behavior changes. Planning-only changes do not require a release bump.
- **The Chrome extension version authority is `apps/extension`, kept in sync in exactly three places: `apps/extension/manifest.json`, `apps/extension/package.json`, and the pin in `apps/extension/tests/release.test.js`.** The productization branch starts at `0.2.0`. The `0.1.x` series belongs to the legacy PoC. Bump all three when a change affects the extension release so the owner can verify the loaded version in `chrome://extensions`.
- **The Web library, API, and Worker each start at `0.1.0` when their first runnable build exists.** Store each version in that unit's own release metadata when introducing the unit. The API contract path `/v1` is versioned separately from the API build.
