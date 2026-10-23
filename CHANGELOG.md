# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Quota table (`src/status.js`): `statusTable` renders the Markdown table and the capacity line over the adapters' readings with a TTL cache, `shouldShowStatus` decides whether a task is big enough to show it, `okit status [--locale en|pt-BR]` prints it, the `status` MCP tool answers it, and the Director skill names it as the view to show before a big task and on request.
- `okit daemon status --table [--locale en|pt-BR]`: the same quota table and capacity line under the daemon status lines, built by `daemonStatus(root, { table })` only when asked for, so a daemon pass never reads a quota for it and the default output is unchanged.
- Claude Code adapter (`adapters/claude-code/index.js`): the five functions of `docs/ARCHITECTURE.md` section 4 — `spawn` returning the Agent tool call in `NATIVE` and reusing `makeSpawner` in `PROCESS`, `readQuota` without an invented number, `capabilities`, `installSkill` and `installHooks`.
- `PROCESS` spawn mode: `src/spawn-process.js` builds the headless command of `claude-code`, `codex` and `opencode` as a pure value and starts it without a shell, `src/autostart.js` generates the systemd, cron, launchd and schtasks plans, and the `okit` CLI (`daemon start|stop|status|pause|resume|run-once`, `autostart install|uninstall|show`) drives both.

- Inbox and standing-order stores on top of `src/state.js`: `inboxAdd`, `inboxList`, `inboxSetStatus`, `orderAdd`, `orderRemove`, `orderList`, `orderLint`, `orderRender`, plus the state paths in `src/store.js`.
- Effort classification (`classify`), actor-profile choice with the low-quota downgrade (`profilePick`) and the concurrency cap over live runs (`canSpawn`, `acquireSlot`, `releaseSlot`, `limitsStatus`).
- State layer: atomic JSON file writes and a stale-aware directory lock.
- Schedule engine: parse cron, friendly and event schedules, then decide when one is due with an injected clock.
- Recurring templates: `templateAdd`, `templateList`, `templateSet`, `templateRemove` with the standing order each one records, plus `due`, `plan` and `openDue` to open one inbox child per period.
- Daemon core: `tick`, `daemonRun`, `daemonStatus`, `daemonPause`, `daemonResume` and `rotateLogs` — one pass per interval that opens the due template children and hands the pending demands to an injected spawner inside the concurrency cap, with a kill switch, a pause file and one decision record per pass in `logs/<date>.jsonl`.
- Initial repository structure.
- `docs/ARCHITECTURE.md` and `docs/ARCHITECTURE.pt-BR.md`: the architecture note answering the open questions in `docs/DESIGN.md`, with per-client claims sourced and dated.
- Optional `appliesTo` on inbox demands, standing orders and templates (`src/applies.js`): one global inbox and one global set of orders serve many projects, a record without the field is shared, `inboxList` and `orderList` filter by project plus the global records, `orderRender` shows it, and every child a template opens inherits it.
- Derived status and retention for standing orders: `orderStatus` computes `active`, `revoked` or `expired` from the row without storing it, `orderList` adds that status (and the `purgeAfter` date) to a copy, `orderRender` says why an order is not active, a second revoke is refused, and `purgeAfter`/`orderPurge` remove an inactive order for good once `orders.retentionDays` (default 90) is over, logging `{ at, purged: [ids] }` to `logs/<date>.jsonl`; the daemon pass reports `purged` in its decision line.
- `docs/ARCHITECTURE.md` and `docs/ARCHITECTURE.pt-BR.md`: sections for what the core now does — schedules and recurrence, recurring templates, standing orders, the daemon pass order, spawn modes, maximum autonomy and the global state with `appliesTo`.
- Plugin skills: `skills/okit-director/SKILL.md`, `skills/okit-executor/SKILL.md` and `skills/okit-critic/SKILL.md` for the client to install, plus `installSkillFiles` in `src/skills.js`, which copies a skill folder without ever overwriting a file that already differs.
- MCP server over stdio (`src/mcp/server.js`, `src/mcp/tools.js`): JSON-RPC 2.0 hand-written with zero dependencies and the twelve tools (`acquire_slot`, `release_slot`, `limits_status`, `status`, `classify`, `profile_pick`, `inbox_add`, `inbox_list`, `inbox_set_status`, `order_add`, `order_list`, `order_remove`) that let a client's own subagents hold the concurrency cap and read and write the inbox and the standing orders.

### Changed

- Standing orders have one store again: the project layer is gone, so every order lives in `orders.json` under the state root with a `G` id and `appliesTo` is what selects the projects (`orderAdd` with a `layer` is refused with `layer is gone: use appliesTo`), `projectOrdersPath` left `src/store.js`, and `orderMigrateProjects(root, projectRoots)` copies each old `<projectRoot>/.okwork/orders.json` into the store once — lazily from `orderList`/`orderAdd` when a `projectRoot` is passed — with `appliesTo` set to that project, `origin` `migrated:project` and a fresh `G` id, renaming the old file to `orders.json.migrated` instead of deleting it.

### Fixed

- A stale lock takeover no longer acts on a verdict read before an earlier lock was replaced, so a lock that is fresh but has no `owner.json` yet is never moved aside, and an owner that loses its folder before the owner file lands takes the lock again instead of failing.
- The stale-lock takeover claims the folder in place, renaming the dead owner's `owner.json` out of it instead of moving the folder aside, so the window where the folder could not be given back — after which the displaced owner's release deleted the live lock of whoever had taken the path — no longer lets two children into the same section.
- `test/state.test.js` forks itself through `fileURLToPath(import.meta.url)`, since the path part of a URL is `/C:/...` on Windows and `fork` could not start the child from it, and a forked child keeps its stderr, so a rejection now carries the last 2 KB of what the child said instead of only "child exited with 1".
- `test/spawn-process.test.js`'s `until` keeps the last value and the last error a poll saw and names both in the timeout, so the two run-file tests that fail only on Windows report what the run file said or why it could not be read.
- `src/spawn-process.js` reports every failure of the run file it used to swallow: the first write, the read-back before the record on exit, a run file that is gone by then, and the write of the record, each one line `okit: run file <path>: <message>` on stderr; the first write still throws, as before.
- Three tests spelled an expected path as posix text while the code builds it with `node:path`, so they failed on Windows and nowhere else: `configRoot` is expected as `resolve('/tmp/somewhere')`, the systemd, cron and launchd plans in `test/autostart.test.js` compare against `join('/home/u', ...)` and the `rm -f`/`launchctl` lines built from it, and `test/cli.test.js` ends the written path with `join('systemd', 'user', 'okit-daemon.service')`.
- `test/adapter-claude-code.test.js` removes each temporary folder once: `root` pushed into both the roots and the temps list, so the cleanup ran two concurrent recursive removals over the same tree and Windows answered `EPERM` from `rmdir` on a folder the other one was still emptying. The list is deduplicated and the removal asks for retries, with a test that fails on every platform if a folder is listed twice.
- A forked child of `test/state.test.js` writes the code, the message and the stack of a failed bump with `writeSync` on stderr before it exits, and the parent names how many milliseconds the child lived, so the wider takeover race reports why it died instead of only "child exited with 1".

## [0.0.0] - Unreleased

Nothing yet.