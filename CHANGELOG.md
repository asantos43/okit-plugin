# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Inbox and standing-order stores on top of `src/state.js`: `inboxAdd`, `inboxList`, `inboxSetStatus`, `orderAdd`, `orderRemove`, `orderList`, `orderLint`, `orderRender`, plus the state paths in `src/store.js`.
- Effort classification (`classify`), actor-profile choice with the low-quota downgrade (`profilePick`) and the concurrency cap over live runs (`canSpawn`, `acquireSlot`, `releaseSlot`, `limitsStatus`).
- State layer: atomic JSON file writes and a stale-aware directory lock.
- Schedule engine: parse cron, friendly and event schedules, then decide when one is due with an injected clock.
- Recurring templates: `templateAdd`, `templateList`, `templateSet`, `templateRemove` with the standing order each one records, plus `due`, `plan` and `openDue` to open one inbox child per period.
- Daemon core: `tick`, `daemonRun`, `daemonStatus`, `daemonPause`, `daemonResume` and `rotateLogs` — one pass per interval that opens the due template children and hands the pending demands to an injected spawner inside the concurrency cap, with a kill switch, a pause file and one decision record per pass in `logs/<date>.jsonl`.
- Initial repository structure.
- `docs/ARCHITECTURE.md` and `docs/ARCHITECTURE.pt-BR.md`: the architecture note answering the open questions in `docs/DESIGN.md`, with per-client claims sourced and dated.
- Optional `appliesTo` on inbox demands, standing orders and templates (`src/applies.js`): one global inbox and one global set of orders serve many projects, a record without the field is shared, `inboxList` and `orderList` filter by project plus the global records, `orderRender` shows it, and every child a template opens inherits it.
- `docs/ARCHITECTURE.md` and `docs/ARCHITECTURE.pt-BR.md`: sections for what the core now does — schedules and recurrence, recurring templates, standing orders, the daemon pass order, spawn modes, maximum autonomy and the global state with `appliesTo`.
- MCP server over stdio (`src/mcp/server.js`, `src/mcp/tools.js`): JSON-RPC 2.0 hand-written with zero dependencies and the eleven tools (`acquire_slot`, `release_slot`, `limits_status`, `classify`, `profile_pick`, `inbox_add`, `inbox_list`, `inbox_set_status`, `order_add`, `order_list`, `order_remove`) that let a client's own subagents hold the concurrency cap and read and write the inbox and the standing orders.

### Fixed

- A stale lock takeover no longer acts on a verdict read before an earlier lock was replaced, so a lock that is fresh but has no `owner.json` yet is never moved aside, and an owner that loses its folder before the owner file lands takes the lock again instead of failing.

## [0.0.0] - Unreleased

Nothing yet.