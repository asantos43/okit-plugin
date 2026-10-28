# Smoke test

![okit-plugin: Maintainers](../images/banners/maintainers.svg)

Verification contracts and evidence for isolated checks and real-client smoke runs.

<a id="contents"></a>
## Contents

- [Commands](#section-1)
- [Scratch home rule](#section-2)
- [What the runner reuses](#section-3)
- [Checks](#section-4)
- [Checkout against installed plugin](#section-5)
- [Result record](#section-6)
- [Output](#section-7)
- [Safety](#section-8)
- [In-client smoke (real)](#section-9)
- [In-process implementation](#section-10)

For preview instructions, see the [guide](../guide/smoke-demo.md); engine and report contracts are in [DEMO](DEMO.md).

`okit-plugin smoke-demo --confirm <planHash>` and MCP `smoke_demo` with `confirm` execute the five practice tasks with the selected real client and spend its allowance. Preview first with `--dry-run`; its text and hash contract are unchanged. Confirmation requires the same plan, fresh quota evidence and `smoke.demoRequireQuotaConfirmation: true`. Exit codes are 0 for pass, 2 for refusal before launch and 1 for fail/partial. Paid proof belongs to the owner; offline tests use fake child processes and spend nothing. The real demonstration runs its tasks one at a time. The demonstration through MCP cannot be cancelled midway; it ends by its limits (`smoke.maxMinutes` and the cost ceilings).

Each launch reserves `min(driver.maxCostUsd, remaining total, remaining demand)` and receives that money ceiling. The shared ledger covers executors, reviews and corrections; exhausted money, tokens, turns or time stop new work. A failure with measured usage retains its money and tokens; unmeasured usage stops further work. Clients without money reports require positive integer `smoke.maxTokens` before any launch and report money as unavailable. Token ceilings are checked after replies; calls already in flight can exceed them.

The real practice environment retains scratch home/state/configuration paths and takes only `PATH` plus an explicit credential list from `deps.env` (the CLI and MCP supply the process environment at the boundary; `src/smoke/demo` never reads `process.env`): Claude Code gets `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_BASE_URL`; Codex gets `OPENAI_API_KEY`, `OPENAI_BASE_URL`; OpenCode gets no authentication variables because none are established by the repository client contract. `OPENCODE_CONFIG` and the host configuration directory are not forwarded. These credential lists follow the D84 requirement; all other host variables are excluded. A missing or empty `PATH` refuses before the drivers are built (exit 2, nothing paid, no launch, practice folder removed). The practice folder is isolated and does **not** inherit the client's login session: export the client's key or token first (Claude Code: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` or `CLAUDE_CODE_OAUTH_TOKEN`; Codex: `OPENAI_API_KEY`; OpenCode: no accepted variable yet, so the real demonstration does not authenticate); otherwise the call fails without spending anything.

The demo ledger keeps `smoke.maxTokens` as `null` or a positive safe integer and adds each launched attempt's non-negative safe integer `usage.tokens`. At or above the ceiling, no new reservation starts. Missing or invalid token usage with a ceiling makes usage unresolved and blocks new reservations. Reservations and settlements remain synchronous: parallel work shares the total, but already reserved attempts may finish above the ceiling. An attempt that never launched consumes no tokens.

A configured token ceiling applies to every client, including money-reporting clients with `reportsCost` true or absent: their drivers must also supply `usage.tokens`. With `maxTokens: null`, missing token usage does not make the ledger unknown. Reservations do not reserve tokens: the worst-case overshoot above the configured ceiling is parallelism × tokens consumed by one attempt (using the largest attempt in flight). Without a per-attempt token limit, there is no fixed bound on that overshoot.

`src/smoke/demo/index.js` passes `clientRequest(client, config).reportsCost` into the real ledger limits. Its snapshot supplies final `reportsCost`, `tokens` and `costUsd` for the result/summary. With `reportsCost: false`, money is not accounted, `costUsd` is `null` for both the total and settled demands, and those demands have `costKnown: false`. The text report says money is not reported in the selected language and shows tokens used and the ceiling. Money-reporting clients show their measured total. Injected test mode retains its simulated money accounting.

`src/smoke/demo/driver.js` exports `realDrivers({ client, config, spawn })` for the demo's executor and reviewer. Constructing the drivers starts nothing. Both roles reuse `clientRequest` and `invokeClient`, including shared client event conversion. After confirmation, entry/index supplies an injected launcher or Node's `spawn`; construction errors refuse before paid work starts.

The executor combines the briefing text, checks to fix, acceptance checks and allowed output paths. It launches in the supplied working folder and environment, forwards cancellation, and uses the shorter of `briefing.limits.timeoutMs` and `smoke.checkTimeoutMs`. The caller supplies the client environment, including `PATH` and credentials, through `briefing.env`; the driver passes it through as received. Only listed files under `briefing.root` become artifacts. Artifacts must be regular files of at most 128 KiB; missing files are absent, and unsafe paths or symbolic links fail. Model text cannot supply artifact content.

The driver compares names, sizes and modification times in the practice root before and after the call. Changes outside the allowed files fail with "The helper wrote outside the allowed files. / O ajudante escreveu fora dos arquivos permitidos." The comparison excludes `home/`, the client's configuration folders and the demand's working folder (`briefing.cwd`). Extra working files are ignored inside `briefing.cwd`; they never become artifacts. An entry that disappears during the second scan counts as a change. Other scan failures report "Could not check the files. / Não foi possível conferir os arquivos." and retain measured usage.

The reviewer receives the execution, artifacts and checks and requests one JSON object. The whole final text must parse as an object with an exact `approved` or `rejected` verdict, an array of `criteria`, and string `feedback`. Unreadable or invalid answers are rejected with an English/Portuguese explanation. A client error result cannot approve work.

Both roles expose `maxCostUsd`: `smoke.demoDemandMaxUsd` when set, otherwise `smoke.maxUsd`; clients with `reportsCost: false` expose zero. `attempt.js` reduces this upper bound to the smaller remaining total/demand balance, including rework. In real mode only, a call receives the smaller of the driver's bound and `briefing.limits.maxUsd` through the existing argument placeholders; test mode keeps the original behavior, where `reserve` refuses what exceeds the remaining room. There are no new command flags or configuration keys. Only Claude Code enforces a money ceiling inside a call: OpenCode has no `{maxUsd}` placeholder and Codex reports no money. With OpenCode the ceiling holds between calls; if a call exceeds its reservation, `ledger.settle` throws and the total cost is reported as unknown.

Codex, and any client with `reportsCost: false`, requires a positive whole number in `smoke.maxTokens` when the drivers are created. A call whose reported tokens exceed `smoke.maxTokens` fails with its measured `usage` attached; the limit is checked after the call finishes.

Usage includes reported input plus output tokens and client turns (Claude Code's `num_turns`, Codex turns, or OpenCode steps). Money follows `smokeDrivers.<client>.reportsCost`: Codex reports `costUsd: 0` with actual token counts. Missing or invalid measurements, including a missing count in an earlier step, produce `costUsd: null` so the ledger stops. Reported costs are never clipped to the reservation. Timeout, cancellation and exit without a final result throw with `usage`, `events` and `state` attached, retaining partial measurements.

| Must pass | Must refuse |
| :- | :- |
| Whole valid review JSON with `approved` | Garbage, surrounding prose, fenced JSON, missing fields or other verdicts |
| Measured usage; Codex tokens without money | Unknown money or token totals presented as free |
| Listed regular files of at most 128 KiB | Directories, other special files, larger files, path traversal or symbolic links |
| Allowed outputs and client/work folders may change | Changes elsewhere in the practice root, including entries lost during the second scan |
| Readable folders in both scans | Access errors that prevent checking the files |
| Positive `smoke.maxTokens` for Codex; calls within the limit | Missing or invalid Codex token limits; calls exceeding the token limit |

Offline verification: `node --test test/smoke-demo-driver.test.js test/smoke-client.test.js`. Fake child processes cover all three clients, writes to another demand or shared state, allowed client/work folders, token limits, regular files and the 128 KiB boundary. Scan tests simulate unreadable folders and disappearing entries while checking that errors retain usage. The configured deadline is checked against elapsed time; two in-memory mutants prove that approving unreadable answers and treating unknown usage as free fail their guards. No real client is launched.

Migration: invoke the plugin as `okit-plugin`; install/update remove only its owned legacy `okit` links. Keep the kit's `okit`/`kit` separate; kit detection ignores plugin executables.

Implemented: `okit-plugin smoke` runs 32 isolated checks. Adding `--client claude-code`, `--client codex` or `--client opencode` selects real client checks, also available through `client-smoke`. Offline tests prove command handling; the Producer must verify real installation and usage for each client.

<a id="section-1"></a>
## Commands

`npm run smoke` runs the runner of this checkout and `okit-plugin smoke` the same runner through the installed bin; both use a scratch home and answer `0` when every selected check passed, `1` when one failed or timed out and `2` when the run was refused.

| Flag | Meaning |
| :- | :- |
| `--real` | use real state/config roots (`OKWORK_HOME` and `CLAUDE_CONFIG_DIR`, or home defaults); package root is unchanged |
| `--keep` | leave the scratch home on disk and print its path |
| `--only <id>` | run only these check ids; comma separated, repeatable, an unknown id is refused |
| `--timeout <ms>` | raise each timeout to at least this many milliseconds; without the flag, use each table timeout (fallback `60000`) |

Exit code, the three `src/cli.js` already uses: `0` every selected check passed, `1` one failed or timed out, `2` unknown flag, unknown `--only` id, or an `OKWORK_HOME` in the environment without `--real`.

<a id="section-2"></a>
## Scratch home rule

Each run builds `<scratch>/home`, `<scratch>/project` and `<scratch>/tmp` under `os.tmpdir()` and runs every child with `HOME`/`USERPROFILE`, `OKWORK_HOME=<scratch>/home/.okwork`, `CLAUDE_CONFIG_DIR=<scratch>/home/.claude`, `XDG_CONFIG_HOME` and `TMPDIR`/`TEMP`/`TMP` inside it. The real home is read only under `--real`. The runner takes the scratch root, the environment and the clock as parameters, so `test/smoke-runner.test.js` drives it with `mkdtemp(join(tmpdir(), 'smoke-'))` exactly as `test/cli.test.js` does today.

<a id="section-3"></a>
## What the runner reuses

The runner reuses the core, adapters and MCP server. `src/smoke.js` accepts injected dependencies to exercise installation, features and removal without starting real clients.

<a id="section-4"></a>
## Checks

Every check has an id, a name, a timeout and a body. `status` is `pass`, `fail`, `timeout`
or `skip`, and only `pass` counts as a success.

**A. Install (`I`)** — id, name, what it does, timeout.

| id | name | what it does | timeout |
| :- | :- | :- | :- |
| `I1` | `files.placed` | `src/cli.js` (the `okit-plugin` bin), `src/mcp/server.js`, `adapters/claude-code/index.js` and `skills/okit-{director,executor,critic,smoke}/SKILL.md` are readable | 5 s |
| `I2` | `commands.registered` | `main()` accepts `daemon`, `autostart`, `status`; each exits `0`, an unknown group exits `2` | 15 s |
| `I3` | `mcp.registered` | `initialize` and `tools/list` over `handleLine` name the tools of `TOOL_NAMES` | 15 s |
| `I4` | `skills.installed` | `installSkill('okit-director')` writes `skills/okit-director/SKILL.md` under the scratch config root; a second call reports `identical` | 10 s |
| `I5` | `hooks.merged` | `installHooks` writes `hooks/hooks.json`; over a user-edited file it keeps the user's entry and reports `written: false` | 10 s |
| `I6` | `permissions.readable` | the `bin` entry and every `SKILL.md` are readable files; the mode is asserted off Windows only | 5 s |
| `I7` | `version.matches` | `serverVersion()` equals the `version` of `package.json`, and `okit-plugin status` prints the table | 10 s |

**B. Every feature, end to end (`E`)**

**Daemon**

| id | name | what it does | timeout |
| :- | :- | :- | :- |
| `E1` | `daemon.run-once` | one `tick` appends one decision line to `logs/<date>.jsonl` with `opened`, `spawned`, `skipped` | 20 s |
| `E2` | `daemon.pause` | `daemonPause` then a pass records `paused` and opens nothing; `daemonResume` clears it | 15 s |
| `E3` | `daemon.killswitch` | `daemon stop` writes `daemon.stop`; `daemon start` clears it before the loop | 15 s |
| `E4` | `daemon.lifecycle` | `daemonRun` with an injected `sleep` and an `AbortSignal` writes `daemon.pid.json` and removes it on exit; a second run is refused by the `daemon` lock | 25 s |
| `E5` | `daemon.status` | `daemonStatus` reads `running: false` from a dead pid and `running: true` while the injected loop lives | 15 s |

**State / Estado**

| id | name | what it does | timeout |
| :- | :- | :- | :- |
| `E6` | `state.atomic` | `inboxAdd` writes `inbox.json` through `writeJsonAtomic`, leaves no `.tmp` behind and reads back | 10 s |
| `E7` | `state.locks` | `withLock` refuses a second holder, releases, and takes over a stale lock whose pid is dead | 20 s |

**Execution / Execução**

| id | name | what it does | timeout |
| :- | :- | :- | :- |
| `E8` | `spawn.command` | `buildCommand` returns the documented argument array for `claude-code`, `codex` and `opencode`, briefing last, no shell | 10 s |
| `E9` | `spawn.process` | `makeSpawner` with an injected `spawn` writes `runs/<runId>.json` as `live` and `runs/<runId>.out`, and `maxMinutes` kills the child | 15 s |
| `E10` | `limits.slots` | `acquireSlot` takes `limits.clients.<client>` or `limits.global` slots, then answers `ok: false` with the cap; `releaseSlot` frees one | 15 s |

**Installation / Instalação**

| id | name | what it does | timeout |
| :- | :- | :- | :- |
| `E11` | `autostart.plan` | `detectAutostart` per platform and `autostartPlan` for `systemd`, `cron`, `launchd`, `schtasks`; `win32` paths keep forward slashes | 10 s |
| `E12` | `autostart.apply` | `applyAutostart` with an injected `run`/`write` installs, uninstalls and reports what it wrote; a second install writes nothing new | 15 s |
| `E13` | `skills.packaged` | each `skills/*/SKILL.md` has `name` and `description` frontmatter, and `installSkillFiles` never overwrites a file that differs | 10 s |
| `E14` | `mcp.tools` | all tools answer `tools/call`; an unknown tool is `-32602` and a bad line is `-32700`, and the loop keeps reading | 30 s |

**Workflow / Fluxo**

| id | name | what it does | timeout |
| :- | :- | :- | :- |
| `E15` | `inbox.flow` | add, list, `inboxSetStatus` along the sequence, all persisted | 15 s |
| `E16` | `orders.flow` | add, list, revoke; the row survives with `revokedReason` and a second revoke is refused | 15 s |
| `E17` | `templates.flow` | add, list, pause and resume, remove; `openDue` twice in one period opens one child | 20 s |

**Views / Visões**

| id | name | what it does | timeout |
| :- | :- | :- | :- |
| `E18` | `status.table` | `statusTable` has its six columns, a capacity line, no ANSI, and another word per locale | 15 s |
| `E19` | `commands.every` | each CLI action (`daemon start|stop|status|pause|resume|run-once`, `autostart show|install|uninstall`, `status`, `actors`) exits `0` with an injected `run`/`spawn` | 30 s |
| `E20` | `quota.below-launch-floor` | with a process runner, `kit quota --cached --json` reads local simulated samples, `kit capacity` reports zero launchable executors, and `kit run` refuses with exit `6`, each executor's reason and the nearest return time; changing `parallel.minQuotaPercent` changes the gate for the same sample; plugin guidance uses plain English and Portuguese | 15 s |

Without a process result from the injected command runner, E20 makes no assertion about the kit. Its integration test finds the installed kit with `detectKit` and skips clearly when it is absent or the sandbox denies process execution with EPERM. HOME, configuration and quota registry are temporary; KIT_HOME continues to identify the kit's code.

**C. Uninstall and idempotence (`U`)**

| id | name | what it does | timeout |
| :- | :- | :- | :- |
| `U1` | `uninstall.skills` | the folder `I4` wrote is gone; a second uninstall of a missing folder reports absent, not an error | 10 s |
| `U2` | `uninstall.autostart` | `applyAutostart` with `action: 'uninstall'` runs the plan's commands, writes no file, and says the same thing twice | 15 s |
| `U3` | `uninstall.state` | removing the scratch root takes `inbox.json`, `orders.json`, `logs/` and `locks/` with it; a rebuilt root starts empty | 15 s |
| `U4` | `idempotence.install` | the `I` group run twice leaves the same tree and the same bytes; the second run reports `skipped: identical` | 30 s |
| `U5` | `idempotence.run` | two runs on fresh scratch roots report the same ids in the same order; only the run id in the artifact names differs | 30 s |

32 checks. `--only` takes ids (`--only I,E7`) and a group letter. `--timeout <ms>` raises the per-check ceiling for a slow Windows host and never lowers a check that has a smaller one; the run itself is capped at 10 minutes.

<a id="section-5"></a>
## Checkout against installed plugin

| | default | `--real` |
| :- | :- | :- |
| plugin root | the package root containing `src/smoke.js` (or injected `io.pluginRoot`) | the same package root (or injected `io.pluginRoot`) |
| state root | `<scratch>/home/.okwork` | `OKWORK_HOME`, else the real `~/.okwork` |
| config root | `<scratch>/home/.claude` | `CLAUDE_CONFIG_DIR`, else the real `~/.claude` |

`--real` is the only mode that touches the user's own files, and it still writes its artifacts to `<state root>/logs/smoke/`, never to the repo.

<a id="section-6"></a>
## Result record

One object per check, and the same fields in the human log: `id`, `name`, `group` (`E7`, `state.locks`, `E`); `status`, one of `pass`, `fail`, `timeout`, `skip`, where only `pass` counts; `durationMs` and the `timeoutMs` it ran under; `error`, the message plus the first stack frame when the body threw; `command`, the argv that ran as a child or `''` when the check stayed in process; `environment`, with `os` (platform, release, arch), `node`, `cwd`, `pluginRoot`, `stateRoot`, `configRoot`, `okitHome` and `pid`; and `logTail`, the last 20 lines of the file that decided the check (`logs/<date>.jsonl`, `runs/<runId>.out`, or the child's stderr).

<a id="section-7"></a>
## Output

Stdout is one fact per line, the shape `report()` of `src/cli.js` already prints: `okit-plugin smoke`, `run: <runid>`, one `pass E7 state.locks 120ms` per check, then `passed: 32 failed: 0 skipped: 0`, the artifact paths and, under `--keep`, the scratch path.

Two files land in `<state root>/logs/smoke/`: `smoke-<runid>.jsonl`, one JSON object per line (the run header, then one record per check in execution order), and `smoke-<runid>.log`, the human text with the whole environment block at the top and each tail inline. Both are UTF-8 with `\n` only, so the Windows file pastes into an issue unchanged. The run id is the UTC instant and the pid (`20261023T091530Z-4242`), which keeps two runs apart and orders them.

<a id="section-8"></a>
## Safety

- **Bounded time**: every check has a timeout and the run a 10 minute cap, so a check that hangs is a `timeout` record and the run still ends.
- **No network**: nothing in the runner opens a socket and no client CLI (`claude`, `codex`, `opencode`) is started, since every spawn is injected.
- **Repeatable**: a fresh scratch home per run, a fixed check order, no randomness in a result but the run id.
- **Contained**: the runner writes only under its own state root and the `--keep` folder, takes the `smoke` lock of that root, and never touches the repo working tree.
- **Safe to interrupt**: `Ctrl-C` writes what it has, removes the lock and exits `1`.

<a id="section-9"></a>
## In-client smoke (real)

The isolated runner starts no client and spends no quota. Selecting a client runs **inside a real client session** with Claude Code, Codex or OpenCode and spends the user's quota. The checks seek evidence that the plugin is installed and used: tools answer, skills are available and records persist. Missing evidence remains unproven.

The synthetic tests already exist: `okit-plugin smoke` above covers the code. This layer tests **real use** with two purposes, and the checks are split accordingly:

1. **the installation** — the plugin, the skills, the hooks, the MCP server and the daemon of the installation the client actually loads;
2. **the logic in real use** — not that a tool answered, but that it answered *right* for a known input, judged from the disk or from the tool's own JSON.

| layer | the question it answers | cost | where it runs |
| :- | :- | :- | :- |
| `okit-plugin smoke` (above) | does the code work? | seconds, no quota | the plugin's own process |
| `okit-plugin client-smoke` (this section) | is the plugin installed, and does it work in real use? | minutes, real quota | a real client session |

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
| `C2` | skills | the installed skills are visible to the session | the `init` event's `skills[]`: `okit-director`, `okit-executor`, `okit-critic`, `okit-smoke` and `okit-setup` under the plugin's namespace |
| `C3` | MCP | the server answered over the real stdio pipe | the `init` event's `mcp_servers[]` holds our server with `status: "connected"`, and the server answered `initialize` and `tools/list` with the current `TOOL_NAMES` inventory |
| `C4` | hooks | a hook of the plugin fired | the client's hook events; while the plugin ships no `hooks/hooks.json`, it is a `skip` with the reason `hook-evidence-unavailable` |
| `C5` | daemon | the daemon of the installation ticked | the runner runs the installed `okit-plugin` bin with `daemon run-once`, and the decision line lands in `logs/<date>.jsonl` |

**B. The logic, in real use (`C6`–`C21`)**

**Slots / Vagas**

| id | resource | the behaviour it asserts | judged from |
| :- | :- | :- | :- |
| `C6` | caps | `limits_status` reports the caps the config declares | the tool's answer against `config.json` |
| `C7` | slot | `acquire_slot` under the cap answers `ok: true` and the slot is real | the answer, and `runs/<runId>.json` is `live` with the client we named |
| `C8` | slot | `acquire_slot` **at** the cap answers `ok: false` and names the cap that refused | the answer's `reason`, and no run file was written for that id |
| `C9` | slot | `release_slot` gives the slot back | the answer is `ok: true` and `runs/<runId>.json` reads `done` |
| `C10` | slot | `release_slot` of a run that never existed refuses | the answer is `ok: false` with `unknown run`, and nothing was written |

**Classification and profiles / Classificação e perfis**

| id | resource | the behaviour it asserts | judged from |
| :- | :- | :- | :- |
| `C11` | effort | `classify` gives `simple` for a known short demand | the answer's `effort` is `simple`, with the `short-body` reason |
| `C12` | effort | `classify` gives `normal` for a known mid demand | the answer's `effort` is `normal`, with the `mid-body` reason |
| `C13` | effort | `classify` gives `hard` for a known long demand | the answer's `effort` is `hard`, with the `long-body` reason |
| `C14` | profile | `profile_pick` resolves the profile the config declares for the class asked | the answer's `model` against the profile of the class, the default catalog included — and the lowered class when the quota is below the floor; with no `config.json` the installation is unconfigured, so it is a `skip` with the reason `config-missing` and the report says the installation is incomplete |

**Inbox**

| id | resource | the behaviour it asserts | judged from |
| :- | :- | :- | :- |
| `C15` | inbox | `inbox_add` stores the demand it answered | the answer, and `inbox.json` holds the item with the title we sent |
| `C16` | inbox | `inbox_list` lists it | the answer's list holds that item |
| `C17` | inbox | `inbox_set_status` moves it and the move persists | the answer, and `inbox.json` reads `delegated` |
| `C18` | inbox | the invalid move is refused | `pending` → `consolidated` is refused, and `inbox.json` still reads `pending` |

**Orders and recurrence / Ordens e recorrência**

| id | resource | the behaviour it asserts | judged from |
| :- | :- | :- | :- |
| `C19` | order | `order_add` stores the order it answered | the answer, and `orders.json` holds the row as active |
| `C20` | order | `order_remove` revokes it and the revoked order stops being listed | `orders.json` keeps the row with `revokedReason`, and `order_list` no longer lists it |
| `C21` | template | a due template is opened by the daemon as a demand | `inbox.json` holds the child the template opened, and the daemon's decision line lists that id under `opened` |

**C. The report (`C22`–`C23`)**

| id | resource | what it proves | judged from |
| :- | :- | :- | :- |
| `C22` | status | the table matches the quota readings | the `status` answer's row for the client carries the same percentage as `quota/<client>.json`, and the status word that follows the floor |
| `C23` | report | the artifacts are where the run said | the two files at the printed path |

23 checks in the group `C`, beside the 32 of the groups `I`, `E` and `U` — different ids, so `--only` of one runner never picks a check of the other.

Claude Code manifest, MCP and hook files are generated by the release build; they are not tracked at the checkout root. The runner judges the installation loaded by the client, not the presence of those files in the checkout.

### The drivers

Install the selected command (`claude`, `codex` or `opencode`), sign in and configure the plugin in that client. A real run spends quota; `--dry-run` starts no model. The commands are `claude -p … --output-format stream-json`, `codex exec --json …` and `opencode run --format json …`. Codex defaults add `--skip-git-repo-check`, `--sandbox workspace-write`, `--approve-for-me` and `--ephemeral`; OpenCode defaults add `--dir <scratch-root>` and `--auto`. Command names, arguments and help checks are configurable in `smokeDrivers` in `config.json`; defaults live in `DEFAULT_CONFIG`.

The installed Codex help confirms the no-repository check bypass, writable sandbox, reviewed approvals and ephemeral session options. OpenCode help confirms JSON format, selected working folder and automatic permission approval; non-interactive mode is the default. Its help does not list a session-persistence option. These help checks do not prove a live model run or real MCP approval behavior.

Codex and OpenCode tool responses are passed to the same checks as Claude Code responses. Since their output does not show plugin, skill, hook or daemon installation details, C1–C5 and C21 are skipped with an explanation, no call is made for those steps, and those skips alone do not make the run red. `smokeDrivers.<client>.reportsInstallation` records whether that evidence is available. `smokeDrivers.<client>.reportsCost` selects money accounting: `true` for Claude Code and OpenCode, `false` for Codex. Missing money or text measurements stop further work; partial measurements from a failed call are retained. Codex's input and output counts are added across replies; cached input is already included in input. A real Codex run requires positive `smoke.maxTokens`; `null` is allowed for previews but refuses a real run. OpenCode's reported step costs and text counts are added. Only Claude Code has a verified money ceiling within one call. The demo preview explains the selected helper's limits without spending; confirmation starts paid demo work only for the same plan, fresh quota evidence and, for Codex, a positive `smoke.maxTokens`.

One scenario, four ways to run it.

| driver | how | what the user sees |
| :- | :- | :- |
| skill | the plugin ships the skill `okit-smoke`; the user types `/okit-smoke` in a session with the plugin installed | the narration of each step, then the report |
| headless | `okit-plugin client-smoke --client claude-code --headless` | the report only, no session left open |
| demo | `okit-plugin client-smoke --client claude-code --demo` | the narration of each step *while* it runs, then the same one-line-per-check report as the other modes |
| dry run | `okit-plugin client-smoke --client claude-code --dry-run` | what the scenario *would* call, step by step — no client, no model, no quota |

The runner always prints two lines around the run: `smoke: start client=claude-code mode=<mode>` before it starts and `smoke: end exit=<code> artifacts=<folder>` when it ends, even when the run was refused or failed. A reader that lost the output of a run still has the exit code and the folder of the artifacts.

The skill is the driver of the scenario; the headless and demo modes are the same scenario without a human in the loop, so a run in CI is the same run as a run on a desk. The dry run walks the same list and reports what it would call, without calling the model and without spending quota: it is the cheap way to check the scenario itself, and the way to rehearse a change to the scenario before it costs anything. In headless mode the runner starts the client with

```
claude -p "<the scenario as a briefing>" \
  --output-format stream-json --include-hook-events --verbose \
  --max-budget-usd <n> --permission-mode default --no-session-persistence
```

Every flag above was read from `claude --help` on Claude Code 2.1.304 (2026-10-23), and the runner refuses a flag the client does not have. Three of them carry their own rule, and the runner must honour them:

| flag | the client's own rule (from `--help`) | what the runner does with it |
| :- | :- | :- |
| `--output-format stream-json` | "requires `--verbose`" when used with `--print` | the runner always passes `--verbose` with it |
| `--include-hook-events` | "only works with `--output-format=stream-json`" | the runner pairs it with `stream-json`, never with `json` |
| `--max-budget-usd <amount>` | "only works with `--print`" | the runner passes it in headless mode and reads the money it spent back |

`--max-turns` does **not** exist in the client: `claude --help` has no such flag, and `docs/maintainers/ARCHITECTURE.md` section 12.1 already says so for 2.1.303. The `--max-turns` of the runner below is the *runner's own* ceiling over the scenario's steps — it never reaches the command line.

The runner reads the client's **event stream**, not the model's prose: the `init` event carries `plugins[]`, `skills[]`, `tools[]` and `mcp_servers[]` (each with a `status`), which is the evidence for `C1`, `C2`, `C3` and for the twelve tools; the `hook_started` and `hook_response` events are the evidence for `C4`; the final `result` event carries `is_error`, `num_turns`, `total_cost_usd`, `permission_denials[]` and `terminal_reason`. The single-result `--output-format json` carries only the `result` event, so it cannot prove `C1`–`C4` and is not what the runner uses.

**The model is not the judge.** The scenario never asks the model "did it work?". The MCP tools are what the scenario *calls*; the files are the *verdict*. Every step is a call, and every verdict comes from a fact on disk or from the tool's own JSON answer: the state root, the run file, the log line, the client's own event stream. The model's own words are never part of a pass criterion — a run that passes is a run whose files say so. That is what makes the demo honest: the narration is free text, the verdict is not.

### Budget: the variables, the ceiling and the quota pre-check

A real run spends the user's money, so it has a price and a floor. Each has a default in `DEFAULT_CONFIG.smoke` and is a **configuration variable**, a key in `config.json` under the state root, that the smoke reads and that a flag can override for one run.

| variable in `config.json` | what it limits |
| :- | :- |
| `smoke.quotaFloorPct` | the quota below which the run is refused before it starts |
| `smoke.maxUsd` | stops further calls at the recorded money total for clients with `reportsCost: true`; Claude Code also enforces it within a call using `--max-budget-usd` |
| `smoke.maxTokens` | total client-reported amount of text read and written across calls; a positive whole number, or `null` (default). A real Codex run requires a positive value; add `"maxTokens": 50000` under `"smoke"` in config.json and choose a suitable ceiling. |
| `smoke.maxTurns` | the steps the scenario may take; the runner enforces it and never passes it to the client (the client has no `--max-turns`) |
| `smoke.maxMinutes` | the wall clock of one run |
| `smoke.checkTimeoutMs` | the deadline of one check |

The flags are one-run overrides of those variables and nothing else: `--quota-floor` overrides `smoke.quotaFloorPct`, `--max-usd` overrides `smoke.maxUsd`, `--max-turns` overrides `smoke.maxTurns`, `--max-minutes` overrides `smoke.maxMinutes` and `--timeout` overrides `smoke.checkTimeoutMs`. A flag without a value takes the value of the variable, and a variable with no key in `config.json` takes its default value. The in-process runner of the section above keeps its own defaults, so the two layers never drift into each other.

Set `smoke.maxTokens` in the configuration to cap the amount of text the client says it read and wrote. Reaching or exceeding the limit stops the next call, including extra calls within one check; unfinished work uses the same budget skip reason as the money limit. A reply can exceed the limit before it is measured. If a reply omits its text use while this ceiling is enabled, new work stops because the remaining allowance cannot be measured. A non-zero exit with a final result preserves it, so Claude Code's budget refusal remains a skip. A result received before process termination is preserved; termination with no result fails the step.

The **quota pre-check** reads the client's own reading before the first step. It accepts valid manually entered readings and observations without an age, as before, and automatic readings from Codex sessions or OpenCode's configured source. A supplied age must be a valid nonnegative number, and the percentage must be between zero and one hundred. The shared pre-check flags readings older than `smoke.quotaMaxAgeMinutes` and refuses readings past `smoke.quotaExpireMinutes`; the Codex/OpenCode smoke run also refuses a flagged old reading. Missing, invalid, expired or another client's data gives `quota-unknown` before any client call, unless `--allow-unknown-quota` is explicitly chosen. Below `smoke.quotaFloorPct`, the run is always refused. Built-in drivers are available for all three clients.

For Claude Code, the ceiling is enforced by its own flag: `--max-budget-usd` stops spending, and the client's own `result` event reports it. The steps that did not run are skipped. A step that never ran never passes. Codex and OpenCode do not offer that verified protection within a call. A Claude Code call that fails without a `result` event is spend nobody measured, so the run stops on purpose and prints that spending could not be measured; a failure that still carries a `result` with `total_cost_usd` is measured and does not stop the run. A step that times out names `timeout` as the stop reason even when it was the last turn allowed, and, on purpose, an OpenCode `error` event after its final `stop` still counts as a failure (Codex only ignores a late error after `turn.completed`).

### Refusal, skip and failure

Three outcomes, and the difference between them is the point.

| outcome | when | in the report |
| :- | :- | :- |
| `pass` | the fact the step proves is there | `pass C15 inbox.added 120ms` |
| `fail` | the step ran and the fact is wrong or missing: the tool answered an error, the file was not written, the state does not have the record | `fail C17 inbox.moved` with `error` and the tail |
| `skip` | the step did not run because something refused it: the quota floor, the money ceiling, the permission prompt, the client refusing a tool, a missing config | `skip C14 profile.picked` with the reason |

A refusal by quota or by permission is a `skip` with its reason, never a `fail`: the plugin is not broken when the user's quota ran out or when the client asked the user for a permission the user did not give. A `fail` is reserved for what the plugin promised and did not deliver.

The exit code says whether the *installation* was proven, and a skipped check is never read as a green run:

| exit | when | what it means |
| :- | :- | :- |
| `2` | the run was refused **before it started**: the quota is below the floor, the quota is unknown without `--allow-unknown-quota`, the flag or the client is unknown | nothing was verified |
| `1` | the run started and a check failed, or an installation check the selected client can report did not pass | a check failed or reported installation evidence is missing |
| `0` | the run started, no check failed, and every check the selected client can report passed; evidence unavailable from Codex/OpenCode is skipped | reported checks passed; skipped checks are listed |

Claude Code reports installation details for `C1`–`C5`. Codex and OpenCode do not report those details, so these checks and the daemon check `C21` are skipped without launching a client call and are not included in the installed-evidence decision. Other failures still make the run return `1`; skips are counted in the summary and shown with the partial-run line.

The reason is a fixed word, so a reader can count refusals without reading prose: `quota-below-floor`, `quota-unknown`, `budget-exhausted`, `permission-denied`, `client-refused`, `hook-evidence-unavailable`, `config-missing`, `no-login`, `timeout`.

A `config-missing` skip carries its own sentence in the human log: **the installation is incomplete**, because without a `config.json` there is no profile to pick. It is the one skip that names a thing the user has to fix, so the report says so in words and not only in a word.

### Shared artifacts

The in-client run writes **the same two artifacts, in the same place, in the same format**: `<state root>/logs/smoke/smoke-<runid>.jsonl` and `smoke-<runid>.log`, the run id in the same shape (`20261023T091530Z-4242`), one JSON object per line, the header first and one record per check after it. The record keeps the fields of the in-process record — `id`, `name`, `group`, `status`, `durationMs`, `timeoutMs`, `error`, `command`, `environment`, `logTail` — and the group of an in-client record is `C`.

The header includes `kind: "smoke-in-client"`, `client` (`claude-code`) and `scenario` (the scenario version). A reader of the in-process log can read the in-client log without a new parser, and both are found by the same glob.

The `logTail` of an in-client record is the tail of the file that decided the step: the state file, the run file, the daemon log or the client's own JSON output. Nothing of the session is kept: a run leaves two files and a line of stdout.

### The real installation is the default

Without offline flags, the runner uses the real installation, configuration, login and state. `--rehearsal` and `--dry-run` only walk the scenario: no client, quota read or state writes, and no installation proof. State resolves through `OKWORK_HOME` or `~/.okwork`. Only run-owned records are cleaned up; artifacts remain. `--keep` retains those records.

### Decisions

Six, taken by the Producer on 2026-10-23. They are decisions, not questions: the section above already follows them.

1. **The quota floor is configurable.** The floor of the in-client run is set by configuration — `smoke.quotaFloorPct`, whatever the configuration says it is — for the in-client run exactly as for the kit.
2. **A missing config is a `skip`, and the report says the installation is incomplete.** `profile_pick` needs a profile for the class asked, the default catalog or the configured one; with no `config.json` the installation is unconfigured, so `C14` is a `skip` with the reason `config-missing`, and the human log says in words that the installation is incomplete, because that is the one skip the user has to fix.
3. **`C4` takes the client's own hook events.** The evidence is what the client reports with `--include-hook-events` (with `stream-json --verbose`); if hook evidence is absent, the check is a `skip` with the reason `hook-evidence-unavailable`, so the run says the hooks are unproven instead of saying they are broken.
4. **The demo narrates and reports.** The demo mode narrates each step in the client's own words *and* prints the same one-line-per-check report as the other modes at the end: the narration is what a person watches, the report is what a person checks.
5. **`--dry-run` exists.** The runner walks the scenario and reports what it would call, without calling the model and without spending quota — the cheap way to check the scenario itself.
6. **The state is read from the files.** The MCP tools are what the scenario *calls*; the files are the *verdict*. The shared state root is exactly the assumption under test, so the runner reads the files directly, which is also the faster of the two ways.

### Current implementation

`src/smoke/scenario.js` exports the scenario as data; `src/smoke/client.js` resolves references and executes drivers, with verdicts in `client-checks.js`. The `skills/okit-smoke/SKILL.md` skill calls the existing runner.

<a id="section-10"></a>
## In-process implementation

`src/smoke/report.js` generates records and artifacts. Tables live in `checks-install.js`, `checks-features.js` and `checks-uninstall.js` under `src/smoke/`. `src/smoke.js` runs the loop with timeout, locking and cleanup. Tests use injected processes; they do not prove real-client operation.

Portuguese version: [SMOKE.pt-BR.md](SMOKE.pt-BR.md).
