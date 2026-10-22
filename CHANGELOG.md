# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Inbox and standing-order stores on top of `src/state.js`: `inboxAdd`, `inboxList`, `inboxSetStatus`, `orderAdd`, `orderRemove`, `orderList`, `orderLint`, `orderRender`, plus the state paths in `src/store.js`.
- Effort classification (`classify`), actor-profile choice with the low-quota downgrade (`profilePick`) and the concurrency cap over live runs (`canSpawn`, `acquireSlot`, `releaseSlot`, `limitsStatus`).
- State layer: atomic JSON file writes and a stale-aware directory lock.
- Initial repository structure.
- `docs/ARCHITECTURE.md` and `docs/ARCHITECTURE.pt-BR.md`: the architecture note answering the open questions in `docs/DESIGN.md`, with per-client claims sourced and dated.

## [0.0.0] - Unreleased

Nothing yet.