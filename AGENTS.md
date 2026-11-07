# Agent Skills Configuration

This file documents the configuration for Matt Pocock's engineering skills.

## Agent skills

### Issue tracker

Issues live in GitHub at `yandw/learning-digest`. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context layout: one `GLOSSARY.md` at repo root, ADRs under `docs/adr/`. See `docs/agents/domain.md`.

## Project conventions

- **Every change bumps the patch version** (manifest.json + package.json + the pin in tests/release.test.js, kept in sync): 0.1.0 → 0.1.1 → … The owner verifies in chrome://extensions that newly loaded code is current, so the version must move on every push.
