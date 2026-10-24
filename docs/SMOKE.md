# Smoke test

Status: the in-process runner exists (`src/smoke.js`, `src/smoke/`, `okit smoke` / `npm run smoke`, merged in D19); the in-client runner of the section below is design (D20). Extends [ARCHITECTURE.md](ARCHITECTURE.md) and [DESIGN.md](DESIGN.md). One command proves the plugin is installed and every feature works end to end, on a scratch home, on Windows, macOS and Linux, and leaves a log a human can send for debugging (D17 was found by a Windows run of `node --test`).

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

## In-client smoke (real)

The runner above is the cheap layer: it starts no client, spends no quota and proves the code. This section is the other layer, and it runs **inside a real client session** — Claude Code first, Codex and opencode after. It spends the user's quota on purpose, and it buys the thing the in-process runner cannot buy: proof that the plugin is *installed and used* — the client loaded the plugin, its MCP server answers over a real stdio pipe, the skills are there, the hooks fire, the daemon ticks, and the inbox, the standing orders and the templates keep what the client wrote.

The synthetic tests already exist: `okit smoke` above covers the code. What is missing is a test of **real use**, so this layer has two purposes, and the checks are split accordingly:

1. **the installation** — the plugin, the skills, the hooks, the MCP server and the daemon of the installation the client actually loads;
2. **the logic in real use** — not that a tool answered, but that it answered *right* for a known input, judged from the disk or from the tool's own JSON.

| layer | the question it answers | cost | where it runs |
| :- | :- | :- | :- |
| `okit smoke` (above) | does the code work? | seconds, no quota | the plugin's own process |
| `okit client-smoke` (this section) | is the plugin installed, and does it work in real use? | minutes, real quota | a real client session |

Both layers write the same record format into the same artifact folder and answer the same three exit codes (0, 1, 2), so one reader reads both logs. What the in-client `0` *means* is stricter than the in-process one, and the "Refusal, skip and failure" section below says exactly how.

### The scenario

One ordered list of steps, written once, used by every driver. Every step is one of three kinds:

- a **call** the client makes, through the model, over the real MCP pipe;
- a **preparation** the runner makes before the calls — a known input, always tagged `okit-smoke`, so it can be found and removed afterwards;
- a **reading** the runner makes after the calls — the fact on disk that decides the step.

A step names a resource, the call that touches it and the **behaviour** it asserts. The list is data, not code, so the kit can load the same list (see the join point below).

**A. The installation (`C1`–`C5`)**

| id | resource | what it proves | judged from |
| :- | :- | :- | :- |
| `C1` | plugin | the client loaded the installed plugin | the `init` event's `plugins[]`: our plugin's name and the path it was loaded from |
| `C2` | skills | the installed skills are visible to the session | the `init` event's `skills[]`: `okit-director`, `okit-executor`, `okit-critic` and `okit-smoke` under the plugin's namespace |
| `C3` | MCP | the server answered over the real stdio pipe | the `init` event's `mcp_servers[]` holds our server with `status: "connected"`, and the server answered `initialize` and `tools/list` with the 12 names |
| `C4` | hooks | a hook of the plugin fired | the client's hook events; while the plugin ships no `hooks/hooks.json`, it is a `skip` with the reason `hook-evidence-unavailable` |
| `C5` | daemon | the daemon of the installation ticked | the runner runs the installed `okit` bin with `daemon run-once`, and the decision line lands in `logs/<date>.jsonl` |

**B. The logic, in real use (`C6`–`C21`)**

| id | resource | the behaviour it asserts | judged from |
| :- | :- | :- | :- |
| `C6` | caps | `limits_status` reports the caps the config declares | the tool's answer against `config.json` |
| `C7` | slot | `acquire_slot` under the cap answers `ok: true` and the slot is real | the answer, and `runs/<runId>.json` is `live` with the client we named |
| `C8` | slot | `acquire_slot` **at** the cap answers `ok: false` and names the cap that refused | the answer's `reason`, and no run file was written for that id |
| `C9` | slot | `release_slot` gives the slot back | the answer is `ok: true` and `runs/<runId>.json` reads `done` |
| `C10` | slot | `release_slot` of a run that never existed refuses | the answer is `ok: false` with `unknown run`, and nothing was written |
| `C11` | effort | `classify` gives `simple` for a known short demand | the answer's `effort` is `simple`, with the `short-body` reason |
| `C12` | effort | `classify` gives `normal` for a known mid demand | the answer's `effort` is `normal`, with the `mid-body` reason |
| `C13` | effort | `classify` gives `hard` for a known long demand | the answer's `effort` is `hard`, with the `long-body` reason |
| `C14` | profile | `profile_pick` resolves the profile the config declares for the class asked | the answer's `model` against `config.profiles.<client>.<class>` — and the lowered class when the quota is below the floor; with no `config.json` there is no profile to pick, so it is a `skip` with the reason `config-missing` and the report says the installation is incomplete |
| `C15` | inbox | `inbox_add` stores the demand it answered | the answer, and `inbox.json` holds the item with the title we sent |
| `C16` | inbox | `inbox_list` lists it | the answer's list holds that item |
| `C17` | inbox | `inbox_set_status` moves it and the move persists | the answer, and `inbox.json` reads `delegated` |
| `C18` | inbox | the invalid move is refused | `pending` → `consolidated` is refused, and `inbox.json` still reads `pending` |
| `C19` | order | `order_add` stores the order it answered | the answer, and `orders.json` holds the row as active |
| `C20` | order | `order_remove` revokes it and the revoked order stops being listed | `orders.json` keeps the row with `revokedReason`, and `order_list` no longer lists it |
| `C21` | template | a due template is opened by the daemon as a demand | `inbox.json` holds the child the template opened, and the daemon's decision line lists that id under `opened` |

**C. The report (`C22`–`C23`)**

| id | resource | what it proves | judged from |
| :- | :- | :- | :- |
| `C22` | status | the table matches the quota readings | the `status` answer's row for the client carries the same percentage as `quota/<client>.json`, and the status word that follows the floor |
| `C23` | report | the artifacts are where the run said | the two files at the printed path |

23 checks in the group `C`, beside the 31 of the groups `I`, `E` and `U` — different ids, so `--only` of one runner never picks a check of the other.

Two facts about today's repository belong here, because they decide what a run says before a single check runs: the plugin ships **no** `.mcp.json`, **no** `.claude-plugin/plugin.json` and **no** `hooks/hooks.json`. The client therefore loads the folder as an inline plugin named after it — `--plugin-dir` needs no manifest, and the skills show up namespaced under the plugin's name — but it starts **no** MCP server for us, so `C3` has nothing to see and `C4` has no hook to watch. A run today says exactly that: the installation is not complete yet. That is the first thing this test exists to say.

### The drivers

One scenario, four ways to run it.

| driver | how | what the user sees |
| :- | :- | :- |
| skill | the plugin ships the skill `okit-smoke`; the user types `/okit-smoke` in a session with the plugin installed | the narration of each step, then the report |
| headless | `okit client-smoke --client claude-code --headless` | the report only, no session left open |
| demo | `okit client-smoke --client claude-code --demo` | the narration of each step *while* it runs, then the same one-line-per-check report as the other modes |
| dry run | `okit client-smoke --client claude-code --dry-run` | what the scenario *would* call, step by step — no client, no model, no quota |

The skill is the driver of the scenario; the headless and demo modes are the same scenario without a human in the loop, so a run in CI is the same run as a run on a desk. The dry run walks the same list and reports what it would call, without calling the model and without spending quota: it is the cheap way to check the scenario itself, and the way to rehearse a change to the scenario before it costs anything. In headless mode the runner starts the client with

```
claude -p "<the scenario as a briefing>" \
  --output-format stream-json --include-hook-events --verbose \
  --max-budget-usd <n> --permission-mode <mode> --plugin-dir <checkout>
```

Every flag above was read from `claude --help` on Claude Code 2.1.304 (2026-10-23), and the runner refuses a flag the client does not have. Three of them carry their own rule, and the runner must honour them:

| flag | the client's own rule (from `--help`) | what the runner does with it |
| :- | :- | :- |
| `--output-format stream-json` | "requires `--verbose`" when used with `--print` | the runner always passes `--verbose` with it |
| `--include-hook-events` | "only works with `--output-format=stream-json`" | the runner pairs it with `stream-json`, never with `json` |
| `--max-budget-usd <amount>` | "only works with `--print`" | the runner passes it in headless mode and reads the money it spent back |

`--max-turns` does **not** exist in the client: `claude --help` has no such flag, and `docs/ARCHITECTURE.md` section 12.1 already says so for 2.1.303. The `--max-turns` of the runner below is the *runner's own* ceiling over the scenario's steps — it never reaches the command line.

The runner reads the client's **event stream**, not the model's prose: the `init` event carries `plugins[]`, `skills[]`, `tools[]` and `mcp_servers[]` (each with a `status`), which is the evidence for `C1`, `C2`, `C3` and for the twelve tools; the `hook_started` and `hook_response` events are the evidence for `C4`; the final `result` event carries `is_error`, `num_turns`, `total_cost_usd`, `permission_denials[]` and `terminal_reason`. The single-result `--output-format json` carries only the `result` event, so it cannot prove `C1`–`C4` and is not what the runner uses.

**The model is not the judge.** The scenario never asks the model "did it work?". The MCP tools are what the scenario *calls*; the files are the *verdict*. Every step is a call, and every verdict comes from a fact on disk or from the tool's own JSON answer: the state root, the run file, the log line, the client's own event stream. The model's own words are never part of a pass criterion — a run that passes is a run whose files say so. That is what makes the demo honest: the narration is free text, the verdict is not.

### Budget: the variables, the ceiling and the quota pre-check

A real run spends the user's money, so it has a price and a floor. Neither is written in the code: each one is a **variable of the configuration**, a key in `config.json` under the state root, that the smoke reads and that a flag can override for one run.

| variable (a key in `config.json`) | what it limits | the default value of the variable |
| :- | :- | :- |
| `smoke.quotaFloorPct` | the quota below which the run is refused before it starts | `20` |
| `smoke.maxUsd` | the money one run may spend; the client itself enforces it (`--max-budget-usd` for Claude Code, which `claude --help` confirms) | `1.00` |
| `smoke.maxTurns` | the steps the scenario may take; the runner enforces it and never passes it to the client (the client has no `--max-turns`) | the number of steps in the scenario |
| `smoke.maxMinutes` | the wall clock of one run | `15` |
| `smoke.checkTimeoutMs` | the deadline of one check | `60000` |

The flags are one-run overrides of those variables and nothing else: `--quota-floor` overrides `smoke.quotaFloorPct`, `--max-usd` overrides `smoke.maxUsd`, `--max-turns` overrides `smoke.maxTurns`, `--max-minutes` overrides `smoke.maxMinutes` and `--timeout` overrides `smoke.checkTimeoutMs`. A flag without a value takes the value of the variable, and a variable with no key in `config.json` takes its default value. The in-process runner of the section above keeps its own defaults, so the two layers never drift into each other.

The **quota pre-check** reads the client's own reading (`quota/<client>.json`, the file `readQuota` of the adapter already reads) *before* the first step. Below the floor — `smoke.quotaFloorPct`, the same threshold the order O5 of the kit uses — the run does not start: nothing is spent, no check runs, and the run answers `2`, because nothing was verified. The reason is written in the run header of the report, not as a check, since no check exists. A missing reading is not a zero: the run proceeds only with `--allow-unknown-quota`, which says out loud that nobody knows the quota.

The ceiling is *hard* in the sense that it is the client's own flag, not a promise in a prompt: `--max-budget-usd` makes the client stop spending, and the client's own `result` event says so — `terminal_reason: "budget_exhausted"` with `subtype: "error_max_budget_usd"`. The steps that did not run are `skip` with the reason `budget-exhausted`. A step that never ran is never a `pass`.

### Refusal, skip and failure

Three outcomes, and the difference between them is the point.

| outcome | when | in the report |
| :- | :- | :- |
| `pass` | the fact the step proves is there | `pass C15 inbox.added 120ms` |
| `fail` | the step ran and the fact is wrong or missing: the tool answered an error, the file was not written, the state does not have the record | `fail C17 inbox.moved` with `error` and the tail |
| `skip` | the step did not run because something refused it: the quota floor, the money ceiling, the permission prompt, the client refusing a tool, a rehearsal with no login, a missing config | `skip C14 profile.picked` with the reason |

A refusal by quota or by permission is a `skip` with its reason, never a `fail`: the plugin is not broken when the user's quota ran out or when the client asked the user for a permission the user did not give. A `fail` is reserved for what the plugin promised and did not deliver.

The exit code says whether the *installation* was proven, and a skipped check is never read as a green run:

| exit | when | what it means |
| :- | :- | :- |
| `2` | the run was refused **before it started**: the quota is below the floor, the quota is unknown without `--allow-unknown-quota`, the flag or the client is unknown | nothing was verified |
| `1` | the run started and the installation was **not** proven: some check is a `fail`, or one of `C1`–`C5` did not pass | the installation is broken or unproven |
| `0` | the run started, `C1`–`C5` all passed, nothing failed, and every other check either passed or was skipped (the cost ceiling, a rehearsal with no login, a missing config) | the installation is proven |

`C1`–`C5` are the installation itself (plugin, skills, MCP handshake, hooks, daemon), so one of them skipped is as bad as one of them failed: the point of the run is the installation, and an unproven installation is not a `0`. The checks from `C6` on are the logic in real use, and the ones the cost ceiling cut — or that a `--rehearsal` could not run, for want of a login — are reported as skipped, counted in the summary and followed by a `PARCIAL` line: the run is `0` but says out loud that it did not verify everything.

The reason is a fixed word, so a reader can count refusals without reading prose: `quota-below-floor`, `quota-unknown`, `budget-exhausted`, `permission-denied`, `client-refused`, `hook-evidence-unavailable`, `config-missing`, `no-login`, `timeout`.

A `config-missing` skip carries its own sentence in the human log: **the installation is incomplete**, because without a `config.json` there is no profile to pick. It is the one skip that names a thing the user has to fix, so the report says so in words and not only in a word.

### The log joins the D19 one

The in-client run writes **the same two artifacts, in the same place, in the same format**: `<state root>/logs/smoke/smoke-<runid>.jsonl` and `smoke-<runid>.log`, the run id in the same shape (`20261023T091530Z-4242`), one JSON object per line, the header first and one record per check after it. The record keeps the fields of the D19 record — `id`, `name`, `group`, `status`, `durationMs`, `timeoutMs`, `error`, `command`, `environment`, `logTail` — and the group of an in-client record is `C`.

The header gains three fields and nothing else: `kind: "smoke-in-client"`, `client` (`claude-code`) and `scenario` (the scenario version). A reader of the D19 log can read the in-client log without a new parser, and both are found by the same glob.

The `logTail` of an in-client record is the tail of the file that decided the step: the state file, the run file, the daemon log or the client's own JSON output. Nothing of the session is kept: a run leaves two files and a line of stdout.

### The real installation is the default

The default run verifies the **real installation**: the plugin the client itself loads, the skills and the hooks installed beside it, the real login and the real state. That is the point of the test — the synthetic tests are `okit smoke` above, and what is missing is a test of real use. The scratch home is the exception, and it is opt-in under `--rehearsal`.

The **login** is what decides how the run can be set up. The credentials live in `~/.claude/.credentials.json`, so a scratch config root has no login: `claude -p` then answers `Not logged in · Please run /login`, with `terminal_reason: "api_error"`, `is_error: true` and no cost — the client never reaches the model (verified on Claude Code 2.1.304, 2026-10-23). A scratch `HOME` breaks the login the same way, because the config root is resolved under it. So a run that calls the model needs the client's own config root, and the default is exactly that.

| | default | `--rehearsal` |
| :- | :- | :- |
| plugin root | the copy the client itself loads | the checkout, loaded by `--plugin-dir` for that session only |
| config root | the client's real one — the login, the installed skills and the installed hooks live there | a scratch one — **no login, the client cannot call the model** |
| state root | `OKWORK_HOME`, else the real `~/.okwork` | a scratch `OKWORK_HOME` |
| what it writes | the scenario's own records in the state root (each tagged `okit-smoke` and removable), plus the two artifacts | the same, in the scratch state root |
| what it reads | the installed plugin, the installed skills, the installed hooks and the real state | nothing of the user's installation |

**What the run writes is only two things**: the records of the scenario itself — a demand, an order, a template, every one of them tagged `okit-smoke` and removable — and the two artifacts. The run **never installs, never updates and never uninstalls** the plugin, never writes in the config root, and never touches a record it did not create.

`--rehearsal` is the opt-in exception: it isolates everything, so the client has no login and cannot call the model. What it still proves is the wiring — the client loads the plugin, the skills are there and the MCP server connects over stdio, because the `init` event arrives even without a login (verified) — and every step that needs the model is a `skip` with the reason `no-login`.

The `--real` flag of the in-process runner keeps its own meaning there: it is what makes *that* runner act on the real install. The in-client runner has the real installation as its default and names its exception `--rehearsal`.

### The join point with the kit (D272)

The kit asks for the same thing from its side: a real smoke in a Director session, with a `--package` variant. The two designs meet in exactly three places, and everything else stays on one side.

| what | owner | contract |
| :- | :- | :- |
| the scenario (the ordered steps, their ids and their behaviours) | the plugin | the list is data, exported as `SCENARIO`, versioned by `scenario` in the header |
| the record and the artifacts | the plugin | the D19 format, the D19 file names, the D19 run id shape |
| the budget floor and the ceiling | the plugin | the same `smoke.quotaFloorPct` and the same `smoke.maxUsd`, so a run in the kit and a run here cost the same |

The kit drives the *Director* side — the session, the panel, the `--package` variant — and calls the scenario the same way a driver here does. The plugin does not know about the Director session, the panel or the packaging; the kit does not know about the behaviours, the record or the artifacts. A kit-side run and a plugin-side run produce the same `smoke-<runid>.jsonl` and a reader cannot tell them apart.

### Decisions

Six, taken by the Producer on 2026-10-23. They are decisions, not questions: the section above already follows them.

1. **The quota floor is the order's.** The floor of the in-client run is the same threshold the order O5 of the kit uses — `smoke.quotaFloorPct`, whatever the configuration says it is — for the in-client run exactly as for the kit.
2. **A missing config is a `skip`, and the report says the installation is incomplete.** `profile_pick` needs `config.profiles.<client>.<class>`; with no `config.json` there is no profile to pick, so `C14` is a `skip` with the reason `config-missing`, and the human log says in words that the installation is incomplete, because that is the one skip the user has to fix.
3. **`C4` takes the client's own hook events.** The evidence is what the client reports with `--include-hook-events` (with `stream-json --verbose`); while the plugin ships no hook, the check is a `skip` with the reason `hook-evidence-unavailable`, so the run says the hooks are unproven instead of saying they are broken.
4. **The demo narrates and reports.** The demo mode narrates each step in the client's own words *and* prints the same one-line-per-check report as the other modes at the end: the narration is what a person watches, the report is what a person checks.
5. **`--dry-run` exists.** The runner walks the scenario and reports what it would call, without calling the model and without spending quota — the cheap way to check the scenario itself.
6. **The state is read from the files.** The MCP tools are what the scenario *calls*; the files are the *verdict*. The shared state root is exactly the assumption under test, so the runner reads the files directly, which is also the faster of the two ways.

### Implementation plan (this section)

Three steps, each merged on its own, each ending with a green `node --test`.

**Step 1 — the scenario as data.** New `src/smoke/scenario.js` with the ordered list of steps (id, name, resource, kind, call, behaviour) and the `SCENARIO` export. New `test/smoke-scenario.test.js` asserts the 23 ids, their order, that every id is unique, that every tool call names a tool of `TOOL_NAMES` and that every behaviour names the fact it is judged from. The known inputs are built from what the core itself exports — the classifier's thresholds from `CLASSIFIER_RULES`, the caps from `config.json` — so a change in the core is a change in the scenario and never a silent break.

The data table also carries `judgedFrom`. MCP calls use `{ tool, arguments }`,
with an optional `then` call; readings without an operation use `null`.
`{ "$ref": "path" }` denotes a value supplied by the future runner, not an MCP
argument to send literally: `client`, effective `config` (core defaults merged
with `config.json`), `quota`, prior `C*.answer` values and run-owned `fixtures`.
Fixtures supply unique slot/refused/absent run ids, inbox text, a fresh pending
item id, profile effort and quota variants at/below `config.lowQuotaPct`, and a
due template. Preparation descriptors (`action`, `tag`) and nested
`preparation`/`cleanup` describe setup and teardown; all use `okit-smoke`.
They may only create or remove run-owned records; insufficient real capacity
must never be made by altering another run or the installation's config.
The classifier corpus probes the exported rule predicates for word counts.
Step 1 exports only JSON-compatible data; resolving references and executing
these operations belongs to Step 2.

**Step 2 — the runner and the drivers (done).** `src/smoke/client.js` executes `SCENARIO`, with evidence and preparations in `client-checks.js`, `config.json` budget variables, quota pre-check, ceilings and CLI overrides. `okit client-smoke` defaults to the real installed target; `--headless` and `--demo` use Claude Code's JSON event stream. The installation gate, `PARCIAL`, disk verdicts and D19 artifacts are implemented. `test/smoke-client.test.js` uses an injected fake client and child streams; it never calls a real client. Step 3 adds the skill entry point.

Implementation notes for Step 2: the task's acceptance contract makes both
`--rehearsal` and `--dry-run` offline scenario walks: no client, quota read or
state write, exit 0, printing the effective maximum cost. This overrides the
earlier scratch-client rehearsal description for this implementation.
Defaults live only in `DEFAULT_CONFIG.smoke` (`src/profiles.js`); `maxTurns: null`
resolves to `SCENARIO.length`. Partial `smoke` objects retain the other defaults.
Each session gets the remaining dollar budget, with no session persistence;
runner turns count scenario steps, not model turns. A timeout fails the active
check and skips subsequent checks. `--only` does not waive the C1–C5 gate.
`--keep` retains tagged scenario records; otherwise only records owned by this
run are removed, and artifacts remain. Temporary cap fillers are always released.
The installed daemon runs with owned slots filling the caps to prevent unbudgeted
delegation; preparation skips with `client-refused` if foreign pending demands,
templates or orders due for purge could be affected by the tick. An unavailable client or a
missing required CLI flag refuses before the scenario, with exit 2.

**Step 3 — the skill (done).** `skills/okit-smoke/SKILL.md` drives `okit client-smoke --client claude-code --demo` without duplicating the scenario. It requests confirmation before spending quota, falls back to `--dry-run` without confirmation, and honors `--headless`, `--dry-run` or `--rehearsal` when requested. Limits come from `smoke.*` and the `--max-usd`, `--max-turns`, `--max-minutes` overrides. It narrates arriving output and finishes with one line per check, `PARCIAL` if present, artifact paths and the exit code. `C2` now requires all four skills, including `okit-smoke`.

## Implementation plan

Already merged (D19). The four steps below are what the in-process runner above turned out to be; the plan of the in-client runner is the one of its own section.

Four steps, three files each, each merged on its own and each ending with a green `node --test`. No new dependency: `node:test` and `node:fs` only.

**Step 1 — the record and the artifacts.** New `src/smoke/report.js` with `environmentOf`, `recordOf` and `writeArtifacts`. New `test/smoke-runner.test.js` asserts the field set of a record, one line per check in the jsonl and the environment block in the log.

**Step 2 — the check tables.** New `src/smoke/checks-install.js`, `src/smoke/checks-features.js` and `src/smoke/checks-uninstall.js`: the `I`, `E` and `U` tables above as `{ id, name, group, timeoutMs, run }`, with `deps` for root, env, clock and the injected `spawn`/`run`. New `test/smoke-checks.test.js` asserts unique ids, a positive timeout on each, the ids of this file, and every check passing on a scratch root (an injected failing body reporting `fail`).

**Step 3 — the runner and the CLI.** New `src/smoke.js`: the scratch home rule, the loop with the per-check timeout and the run cap, `--only`, `--keep`, the `smoke` lock, and `runSmoke(argv, io)` returning `{ code, records, artifacts }` with `io` in the shape `main()` of `src/cli.js` already takes. Edit `src/cli.js` for the `smoke` group, `USAGE` and the `--real` refusal. `test/smoke-runner.test.js` then covers the D18 cases: a passing smoke exits `0` and writes both artifacts; an injected failing check exits `1` with `id`, `error`, `command` and `environment` in its record.

**Step 4 — the script, the codes and the changelog.** Edit `package.json` for `"smoke": "node src/cli.js smoke"`. Edit `test/cli.test.js` for the codes of the new group (`0`, `1` on a failure, `2` on an unknown flag or `--only` id) and the `OKWORK_HOME`-without-`--real` refusal. Add the `CHANGELOG.md` line under `[Unreleased]`.

Portuguese version: [SMOKE.pt-BR.md](SMOKE.pt-BR.md).
