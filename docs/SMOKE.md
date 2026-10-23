# Smoke test

Status: design. Extends [ARCHITECTURE.md](ARCHITECTURE.md) and [DESIGN.md](DESIGN.md). One command proves the plugin is installed and every feature works end to end, on a scratch home, on Windows, macOS and Linux, and leaves a log a human can send for debugging (D17 was found by a Windows run of `node --test`).

## Commands

`npm run smoke` runs the runner of this checkout and `okit smoke` the same runner through the installed bin; both use a scratch home and answer `0` when every selected check passed, `1` when one failed or timed out and `2` when the run was refused.

| Flag | Meaning |
| :- | :- |
| `--real` | act on the real install: the plugin root the client loads, the real `~/.okwork`, the real `~/.claude` |
| `--keep` | leave the scratch home on disk and print its path |
| `--only <id>` | run only these check ids; comma separated, repeatable, an unknown id is refused |
| `--timeout <ms>` | default timeout per check, `60000`; a check with its own smaller timeout keeps it |

Exit code, the three `src/cli.js` already uses: `0` every selected check passed, `1` one failed or timed out, `2` unknown flag, unknown `--only` id, or an `OKWORK_HOME` in the environment without `--real`.

## Scratch home rule

Each run builds `<scratch>/home`, `<scratch>/project` and `<scratch>/tmp` under `os.tmpdir()` and runs every child with `HOME`/`USERPROFILE`, `OKWORK_HOME=<scratch>/home/.okwork`, `CLAUDE_CONFIG_DIR=<scratch>/home/.claude`, `XDG_CONFIG_HOME` and `TMPDIR`/`TEMP`/`TMP` inside it. The real home is read only under `--real`. The runner takes the scratch root, the environment and the clock as parameters, so `test/smoke-runner.test.js` drives it with `mkdtemp(join(tmpdir(), 'smoke-'))` exactly as `test/cli.test.js` does today.

## What the runner reuses

`src/cli.js` (`main(argv, io)` and the injected `out`/`err`/`root`/`env`/`spawn`/`run`/`platform`/`now`), `src/store.js` (`stateRoot`, `paths`), `src/state.js` (`writeJsonAtomic`, `readJson`, `withLock`), `src/daemon.js`, `src/autostart.js`, `src/skills.js`, `src/spawn-process.js`, `src/limits.js`, `src/orders.js`, `src/inbox.js`, `src/templates.js`, `src/status.js`, `src/mcp/server.js` (`createServer`, `handleLine`, `serverVersion`), `src/mcp/tools.js` (`TOOL_NAMES`), `adapters/claude-code/index.js` (`installSkill`, `installHooks`, `configRoot`, `capabilities`). The existing `test/smoke.test.js` keeps its two packaging assertions (the `okit-plugin` name and the MIT `LICENSE`); the runner tests are new and borrow its `read()` helper.

## Checks

Every check has an id, a name, a timeout and a body. `status` is `pass`, `fail`, `timeout`
or `skip`, and only `pass` counts as a success.

**A. Install (`I`)** — id, name, what it does, timeout.

| id | name | what it does | timeout |
| :- | :- | :- | :- |
| `I1` | `files.placed` | `src/cli.js` (the `okit` bin), `src/mcp/server.js`, `adapters/claude-code/index.js` and `skills/okit-{director,executor,critic}/SKILL.md` are readable | 5 s |
| `I2` | `commands.registered` | `main()` accepts `daemon`, `autostart`, `status`; each exits `0`, an unknown group exits `2` | 15 s |
| `I3` | `mcp.registered` | `initialize` and `tools/list` over `handleLine` name the 12 tools of `TOOL_NAMES` | 15 s |
| `I4` | `skills.installed` | `installSkill('okit-director')` writes `skills/okit-director/SKILL.md` under the scratch config root; a second call reports `identical` | 10 s |
| `I5` | `hooks.merged` | `installHooks` writes `hooks/hooks.json`; over a user-edited file it keeps the user's entry and reports `written: false` | 10 s |
| `I6` | `permissions.readable` | the `bin` entry and every `SKILL.md` are readable files; the mode is asserted off Windows only | 5 s |
| `I7` | `version.matches` | `serverVersion()` equals the `version` of `package.json`, and `okit status` prints the table | 10 s |

**B. Every feature, end to end (`E`)**

| id | name | what it does | timeout |
| :- | :- | :- | :- |
| `E1` | `daemon.run-once` | one `tick` appends one decision line to `logs/<date>.jsonl` with `opened`, `spawned`, `skipped` | 20 s |
| `E2` | `daemon.pause` | `daemonPause` then a pass records `paused` and opens nothing; `daemonResume` clears it | 15 s |
| `E3` | `daemon.killswitch` | `daemon stop` writes `daemon.stop`; `daemon start` clears it before the loop | 15 s |
| `E4` | `daemon.lifecycle` | `daemonRun` with an injected `sleep` and an `AbortSignal` writes `daemon.pid.json` and removes it on exit; a second run is refused by the `daemon` lock | 25 s |
| `E5` | `daemon.status` | `daemonStatus` reads `running: false` from a dead pid and `running: true` while the injected loop lives | 15 s |
| `E6` | `state.atomic` | `inboxAdd` writes `inbox.json` through `writeJsonAtomic`, leaves no `.tmp` behind and reads back | 10 s |
| `E7` | `state.locks` | `withLock` refuses a second holder, releases, and takes over a stale lock whose pid is dead | 20 s |
| `E8` | `spawn.command` | `buildCommand` returns the documented argument array for `claude-code`, `codex` and `opencode`, briefing last, no shell | 10 s |
| `E9` | `spawn.process` | `makeSpawner` with an injected `spawn` writes `runs/<runId>.json` as `live` and `runs/<runId>.out`, and `maxMinutes` kills the child | 15 s |
| `E10` | `limits.slots` | `acquireSlot` takes `limits.perClient` slots, then answers `ok: false` with the cap; `releaseSlot` frees one | 15 s |
| `E11` | `autostart.plan` | `detectAutostart` per platform and `autostartPlan` for `systemd`, `cron`, `launchd`, `schtasks`; `win32` paths keep forward slashes | 10 s |
| `E12` | `autostart.apply` | `applyAutostart` with an injected `run`/`write` installs, uninstalls and reports what it wrote; a second install writes nothing new | 15 s |
| `E13` | `skills.packaged` | each `skills/*/SKILL.md` has `name` and `description` frontmatter, and `installSkillFiles` never overwrites a file that differs | 10 s |
| `E14` | `mcp.tools` | all 12 tools answer `tools/call`; an unknown tool is `-32602` and a bad line is `-32700`, and the loop keeps reading | 30 s |
| `E15` | `inbox.flow` | add, list, `inboxSetStatus` along the sequence, all persisted | 15 s |
| `E16` | `orders.flow` | add, list, revoke; the row survives with `revokedReason` and a second revoke is refused | 15 s |
| `E17` | `templates.flow` | add, list, pause and resume, remove; `openDue` twice in one period opens one child | 20 s |
| `E18` | `status.table` | `statusTable` has its six columns, a capacity line, no ANSI, and another word per locale | 15 s |
| `E19` | `commands.every` | each CLI action (`daemon start|stop|status|pause|resume|run-once`, `autostart show|install|uninstall`, `status`) exits `0` with an injected `run`/`spawn` | 30 s |

**C. Uninstall and idempotence (`U`)**

| id | name | what it does | timeout |
| :- | :- | :- | :- |
| `U1` | `uninstall.skills` | the folder `I4` wrote is gone; a second uninstall of a missing folder reports absent, not an error | 10 s |
| `U2` | `uninstall.autostart` | `applyAutostart` with `action: 'uninstall'` runs the plan's commands, writes no file, and says the same thing twice | 15 s |
| `U3` | `uninstall.state` | removing the scratch root takes `inbox.json`, `orders.json`, `logs/` and `locks/` with it; a rebuilt root starts empty | 15 s |
| `U4` | `idempotence.install` | the `I` group run twice leaves the same tree and the same bytes; the second run reports `skipped: identical` | 30 s |
| `U5` | `idempotence.run` | two runs on fresh scratch roots report the same ids in the same order; only the run id in the artifact names differs | 30 s |

31 checks. `--only` takes ids (`--only I,E7`) and a group letter. `--timeout <ms>` raises the per-check ceiling for a slow Windows host and never lowers a check that has a smaller one; the run itself is capped at 10 minutes.

## Checkout against installed plugin

| | default | `--real` |
| :- | :- | :- |
| plugin root | the checkout (`process.cwd()`, `skills/` and `adapters/` beside it) | what the client loads, from `CLAUDE_PLUGIN_ROOT` or the real path of the `okit` bin |
| state root | `<scratch>/home/.okwork` | `OKWORK_HOME`, else the real `~/.okwork` |
| config root | `<scratch>/home/.claude` | `CLAUDE_CONFIG_DIR`, else the real `~/.claude` |

`--real` is the only mode that touches the user's own files, and it still writes its artifacts to `<state root>/logs/smoke/`, never to the repo.

## Result record

One object per check, and the same fields in the human log: `id`, `name`, `group` (`E7`, `state.locks`, `E`); `status`, one of `pass`, `fail`, `timeout`, `skip`, where only `pass` counts; `durationMs` and the `timeoutMs` it ran under; `error`, the message plus the first stack frame when the body threw; `command`, the argv that ran as a child or `''` when the check stayed in process; `environment`, with `os` (platform, release, arch), `node`, `cwd`, `pluginRoot`, `stateRoot`, `configRoot`, `okitHome` and `pid`; and `logTail`, the last 20 lines of the file that decided the check (`logs/<date>.jsonl`, `runs/<runId>.out`, or the child's stderr).

## Output

Stdout is one fact per line, the shape `report()` of `src/cli.js` already prints: `okit smoke`, `run: <runid>`, one `pass E7 state.locks 120ms` per check, then `passed: 31 failed: 0 skipped: 0`, the artifact paths and, under `--keep`, the scratch path.

Two files land in `<state root>/logs/smoke/`: `smoke-<runid>.jsonl`, one JSON object per line (the run header, then one record per check in execution order), and `smoke-<runid>.log`, the human text with the whole environment block at the top and each tail inline. Both are UTF-8 with `\n` only, so the Windows file pastes into an issue unchanged. The run id is the UTC instant and the pid (`20261023T091530Z-4242`), which keeps two runs apart and orders them.

## Safety

- **Bounded time**: every check has a timeout and the run a 10 minute cap, so a check that hangs is a `timeout` record and the run still ends.
- **No network**: nothing in the runner opens a socket and no client CLI (`claude`, `codex`, `opencode`) is started, since every spawn is injected.
- **Repeatable**: a fresh scratch home per run, a fixed check order, no randomness in a result but the run id.
- **Contained**: the runner writes only under its own state root and the `--keep` folder, takes the `smoke` lock of that root, and never touches the repo working tree.
- **Safe to interrupt**: `Ctrl-C` writes what it has, removes the lock and exits `1`.

## Implementation plan

Four steps, three files each, each merged on its own and each ending with a green `node --test`. No new dependency: `node:test` and `node:fs` only.

**Step 1 — the record and the artifacts.** New `src/smoke/report.js` with `environmentOf`, `recordOf` and `writeArtifacts`. New `test/smoke-runner.test.js` asserts the field set of a record, one line per check in the jsonl and the environment block in the log.

**Step 2 — the check tables.** New `src/smoke/checks-install.js`, `src/smoke/checks-features.js` and `src/smoke/checks-uninstall.js`: the `I`, `E` and `U` tables above as `{ id, name, group, timeoutMs, run }`, with `deps` for root, env, clock and the injected `spawn`/`run`. New `test/smoke-checks.test.js` asserts unique ids, a positive timeout on each, the ids of this file, and every check passing on a scratch root (an injected failing body reporting `fail`).

**Step 3 — the runner and the CLI.** New `src/smoke.js`: the scratch home rule, the loop with the per-check timeout and the run cap, `--only`, `--keep`, the `smoke` lock, and `runSmoke(argv, io)` returning `{ code, records, artifacts }` with `io` in the shape `main()` of `src/cli.js` already takes. Edit `src/cli.js` for the `smoke` group, `USAGE` and the `--real` refusal. `test/smoke-runner.test.js` then covers the D18 cases: a passing smoke exits `0` and writes both artifacts; an injected failing check exits `1` with `id`, `error`, `command` and `environment` in its record.

**Step 4 — the script, the codes and the changelog.** Edit `package.json` for `"smoke": "node src/cli.js smoke"`. Edit `test/cli.test.js` for the codes of the new group (`0`, `1` on a failure, `2` on an unknown flag or `--only` id) and the `OKWORK_HOME`-without-`--real` refusal. Add the `CHANGELOG.md` line under `[Unreleased]`.

Portuguese version: [SMOKE.pt-BR.md](SMOKE.pt-BR.md).