# Architecture

Extends [DESIGN.md](DESIGN.md); answers its open questions. One Node core (>=20, zero dependencies), three thin adapters, one MCP server over the core.

## 1. Core contract

The inbox stores demands with `id`, `title`, `body`, `kind`, `accept`, `effort`, `client`, `appliesTo`, `status`, `stepIds`, `ext`, `createdAt`. `kind` is free text. Orders share one file, filtered by `appliesTo`. Briefing, critique and consolidation are skill instructions rather than additional core APIs.

## 2. MCP tools

The core exposes 12 MCP tools in `src/mcp/tools.js`: `acquire_slot`, `release_slot`, `limits_status`, `status`, `classify`, `profile_pick`, `inbox_add`, `inbox_list`, `inbox_set_status`, `order_add`, `order_list`, `order_remove`. Planning, briefing, critique and consolidation are skill guidance, not MCP tools.

## 3. State on disk
Root: `node:path.join(os.homedir(), '.okwork')`, overridable with `OKWORK_HOME`. Never inside a client plugin directory: a plugin root moves on update.

```
config.json               per-client limits, terse rules, adapter paths
inbox.json                inbox items
orders.json               standing orders
templates.json            recurring templates
quota/<client>.json       one quota reading per client
runs/<runId>.json         one file per delegated run
locks/<name>.lock/        mkdir lock directories
logs/<date>.jsonl         append-only events, one decision record per daemon pass
daemon.pid.json           pid and start time of the running daemon
daemon.paused             pause file, written by daemonPause
daemon.stop               kill switch, read by the daemon
```

Project-side files live beside the project, not in this root: the project's own `CLAUDE.md` (Claude Code) or `AGENTS.md` (Codex, opencode). Standing orders are not one of them — they all live in `orders.json` here, bound to a project by `appliesTo`.

- Write: serialise to `<file>.<pid>.<random>.tmp`, then `fs.rename` over the target, so a reader never sees half a file. On `EPERM` or `EBUSY` (Windows) retry the rename a few times before failing.
- Lock: `fs.mkdir` the `<name>.lock` folder, which holds `owner.json` `{pid, startedAt}`; `EEXIST` means busy; release with `rmdir`, which waits out `EPERM`/`EBUSY` like every other call: the file it removes was written and closed a moment ago, and a lock left behind by that refusal holds the owner of a process that is gone and is younger than `staleMs`, which no contender can take. A release answered by `ENOTEMPTY` (emptied, but a contender wrote an entry back before the `rmdir`) or `ENOENT` (another contender removed it first) counts as released: the entry that answered is the only evidence every waiter reads, so retrying would take a lock from a live owner.
- Stale: a lock is stale when it is older than `staleMs` (default 30 s) **and** its pid is dead; with no readable `owner.json` the folder `mtime` is used and there is no pid check. Takeover claims the dead owner's folder in place: it renames the dead owner's `owner.json` out of the folder (only one rename can win) and then creates its own `owner.json` exclusively (`wx`), so two takers cannot both win. The folder is never moved aside. A Windows refusal that outlives the retries of any one step of that claim gives the attempt up and leaves the folder as it was found, so the poll loop judges it again instead of the acquire ending on a raw code.
- One writer per file: inbox, orders and runs are separate files, so two steps of one item do not block each other.

## 4. Adapter interface
Each adapter provides these five operations, plus its documented helpers. The core imports an adapter, never a client.

| Function | Input | Output |
| :- | :- | :- |
| `spawn(actor, briefing, opts)` | actor profile, briefing | `{ runId, pid }`, or `{ runId }` for an in-process run |
| `readQuota()` | none | `{ source, remainingPct?, windowMinutes? }` |
| `capabilities()` | none | `{ models[], efforts[], skills, hooks, mcp, desktop, windows }` |
| `installSkill(name, files)` | skill folder | `{ path }` |
| `installHooks(files)` | client hook config or module path | `{ path }` |

### 4.1 The bundled adapters

| Adapter | Modes | Hook installation |
| :- | :- | :- |
| Claude Code | NATIVE descriptor; PROCESS | Merge JSON hook entries |
| Codex | NATIVE descriptor; PROCESS | Explicit refusal, no I/O |
| opencode | PROCESS | Copy a global JS plugin module |

`adapters/claude-code/index.js` is the five functions of this section for one client, and it is the adapter the core imports instead of the CLI. `spawn` returns `{mode: 'NATIVE', runId, agentCall: {model, effort, prompt}}` with no process started, and reuses `makeSpawner` of `src/spawn-process.js` in `PROCESS`. `readQuota` answers `{source: 'user'}` and adds `remainingPct`/`windowMinutes` only from `quota/claude-code.json`. `installSkill` copies into `<root>/skills/<name>/` through `installSkillFiles`, `installHooks` merges `<root>/hooks/hooks.json` without dropping a user's entry, and `root` is `opts.root`, then `CLAUDE_CONFIG_DIR`, then `~/.claude`. Codex also implements native descriptors and process spawning; opencode supports PROCESS only. Codex hook installation refuses; opencode installs a JS module.

## 5. Quota
- `source: api` — an injected API reading; none of the bundled adapters queries a quota API.
- `source: user` — no number; ask once, store it in `quota/<client>.json`, stale after `windowMinutes`.
- `source: off` — the user declined, or the client has no channel; class choice then ignores quota.

Never estimate quota. `profilePick` lowers one class when `remainingPct < lowQuotaPct`; `source: off` and absent readings do not downgrade. Adapters return `source: user`, with numbers only when stored.

### 5.1 The quota table
`src/status.js` is the view of those readings, not a second source of them: `statusTable(root, deps)` is pure over the readings, the clock, the cap counts and the standing orders that arrive in `deps`, and returns `{markdown, capacityLine, rows}`. Columns are `Subscription | 5h remaining | Week remaining | Resets in | Status | Source (age)`; a `windows` array fills both columns, and without it the single `remainingPct` goes to the 5h column when `windowMinutes <= 360` and to the week otherwise, including when `windowMinutes` is absent.

The Status column is a word, never ANSI: `green` at or more than 15 points above `lowQuotaPct`, `yellow` from the floor up to that, `red` below it, and `off` when there is no reading or the source is `off` — which blocks nothing. The row word follows the tightest of the windows, and a `red` row quotes the standing order that names the quota or the floor, falling back to `lowQuotaPct` itself. Below the table one line says how many executors can launch now (`limits.perClient` minus the live runs of the client, and `limits.global` minus all of them, clamped at 0) and the floor in force. Every word lives in one `LABELS` table with `en` and `pt-BR`, chosen by `deps.locale`.

Readings are cached per client for `ttlMs` (60 s by default) against `deps.now`, so two calls in a row cost one read. `shouldShowStatus({size, slices, executors})` is true for size `L`, `slices >= 2` or `executors > 1`, and the Director shows the table when it is. `okit daemon status --table [--locale en|pt-BR]` prints the same table under its daemon lines, and a daemon pass never reads a quota for it: `daemonStatus(root, { table })` builds it only when those deps are handed in.

## 6. Windows rules
- Build every path with `node:path`, never by concatenating separators; store them with forward slashes, the form Claude Code substitutes, so what we write matches what the client reads.
- No shell: `child_process.spawn` with an argument array. Shell-form hook commands are the client's concern, not ours.
- Write `\n` only, with an explicit encoding and no platform default, so a file written on Windows reads the same on Linux.
- `fs.mkdir` locks behave the same natively and on WSL; no `flock`, no `setsid`.
- Manual pass before a release: install the plugin, add an inbox item, delegate one step, read the critic verdict, consolidate, restart the client, confirm the state survived.

`PROCESS` mode starts the clients without a shell; on Windows the `.cmd` shims need the real executable resolved first (open item of the Windows pass).

## 7. Concurrency limit
| Scope | Default | Read from |
| :- | :- | :- |
| Global, all clients | 4 actors at once | `config.json` |
| Per client | 3 actors at once | `config.json`; quota does not change the cap |

The core counts live runs in `runs/<runId>.json` (`status: live`) rather than trusting the client to hold the cap. `acquireSlot` defaults to `waitMs: 0` and returns `ok: false` when full; callers may request a wait. `releaseSlot` ends a reservation; live counting ignores runs older than `staleMinutes` (30 by default). Codex caps itself with `agents.max_concurrent_threads_per_session`; set it to the same number so the two agree.

## 8. Schedules and recurrence
`src/schedule.js` is pure: an injected instant, no I/O. `src/templates.js` stores a demand that its own schedule opens, one inbox child per period.

| Form | Example | Normalized to |
| :- | :- | :- |
| 5-field cron | `*/15 9-17 * * mon-fri` | `kind: cron` with the five field sets |
| daily | `daily 06:00` | `kind: daily`, `hour`, `minute` |
| weekly | `weekly mon-fri 09:30` | `kind: weekly`, `days` |
| monthly | `monthly day 1 08:00` | `kind: monthly`, `day` |
| event | `after each deploy` | `kind: event`, `event` |

Rules: a cron field takes `*`, lists (`1,2`), ranges (`1-5`), steps (`*/15`) and three-letter names (`mon-fri`, `jan`); Sunday is 0 or 7 on the way in and always 0 inside; two restricted day fields match on either one and a free field matches every day, as in cron; a monthly day longer than a short month runs on that month's last day. Anything else throws a `TypeError` naming every accepted form.

| Function | Question it answers |
| :- | :- |
| `parseSchedule(text)` | What is this text? A normalized schedule, or a `TypeError`. |
| `nextRun(schedule, afterMs, { timeZone })` | First instant strictly after `afterMs`; `null` for an event and for a schedule with no slot inside the search bound. |
| `isInWindow(win, nowMs, { timeZone })` | Is the instant inside a `{from, to}` window of `HH:MM` times, which may cross midnight? No window means always. |
| `eventFires(schedule, eventName)` | Does an event schedule fire on this named event? |
| `evaluateDue(template, nowMs, ctx)` | Should this template run now? |

`evaluateDue` returns `{ due, action, reason, period }`, with `action` one of `run`, `skip` (a decision that will not change) or `defer` (wait for the next pass). `period` is the ISO instant of the slot, or `event:<name>:<id>`. The guards are read in this order: `paused`, the slot for this period, `window`, `minQuotaPct`, `onlyWhenIdle`, `skipIfOpen`, `maxRunsPerPeriod`. Without history a template waits for the first slot of the current day instead of firing for one already gone; with history, `catchup: run` (the default) serves the oldest missed slot and `catchup: skip` serves only the current one. An event needs an id, or it would key one period for its whole life: without `eventId` the run is refused. The slot is read on the wall clock of `timeZone` (default `UTC`), so a repeated hour runs on its first pass and a skipped hour moves to the next valid minute.

## 9. Recurring templates
| Function | Effect |
| :- | :- |
| `templateAdd(root, input, { now })` | Stores a template and the standing order that lets it run unattended; the name must be free. |
| `templateList(root, { name })` | Creation order; one name throws when unknown. |
| `templateSet(root, name, patch)` | Edits a field, pauses, resumes or renames; a rename retags the open children and revokes the old order. |
| `templateRemove(root, name)` | Removes the record and revokes its standing order with a reason. |
| `due(root, nowMs, ctx)` | Decides every template at this instant and writes nothing. |
| `plan(root, nowMs, ctx)` | The dry run: the decisions plus the demands that would be created. |
| `openDue(root, nowMs, ctx)` | Opens one child per due template, once per period; the check and the write share one lock, so a second call in the same period and two racing callers create nothing more. |

Required fields are `name`, `schedule` and `demand` (`title`, plus optional `kind`, `body`, `accept`, `ext`). Optional guards: `window`, `timeZone`, `minQuotaPct`, `onlyWhenIdle` (default false), `skipIfOpen` (default true), `catchup` (`run` or `skip`), `maxRunsPerPeriod`, `paused` and `appliesTo`. Every child carries `ext.template` and `ext.period` and inherits the template's `appliesTo`, so one shared template store still knows which inbox each run belongs to.

## 10. Standing orders
An order is a line the maintainer writes once and the Director reads with every demand. The JSON stays the source; `orderRender` is only a view.

| Function | Effect |
| :- | :- |
| `orderAdd(root, { text, scope, until, origin, appliesTo }, { projectRoot })` | Adds an active order to the one store; `until` must be a date in the future. A `layer` is refused with `layer is gone: use appliesTo`. |
| `orderRemove(root, id, { reason })` | Revokes it: `active: false` with `revokedAt` and `revokedReason`. Nothing is deleted, so the history survives. A second revoke is refused. |
| `orderStatus(order, now)` | The derived status of one order: `revoked`, `expired` or `active`. |
| `orderList(root, { activeOnly, appliesTo, now }, { projectRoot })` | Lists the one store. `activeOnly` drops revoked and expired orders. Every order comes back with its derived `status` and, when inactive, the `purgeAfter` date. |
| `orderMigrateProjects(root, projectRoots)` | One-time migration of the old project-side file into the store; returns `{ moved, skipped }`. |
| `orderLint(root, { now })` | What a reader of the file would trip on: empty text, unknown scope, unreadable dates, a repeated id, an active order past its `until`, two live orders with the same text. |
| `purgeAfter(order, retentionDays, now)` | The instant an inactive order may be purged, or `undefined` for an active one. |
| `orderPurge(root, { now, retentionDays })` | Removes for good every inactive order whose retention is over, and appends `{ at, purged: [ids] }` to `logs/<date>.jsonl`. |
| `orderRender(orders)` | Markdown for a human to read. |

Status is computed from the row and is never written to the file, so a reader of the JSON sees only what was written:

| Status | How it is derived |
| :- | :- |
| `revoked` | `active` is not `true`: the order was revoked, and the reason is in `revokedReason`. |
| `expired` | `until` is a date that is not in the future. At the exact instant of `until` the order is already expired. |
| `active` | Anything else: never revoked and still inside its `until`. |

Revoking marks, it does not delete: the row stays with `active: false`, `revokedAt` and `revokedReason`. Re-adding the same text later makes a new order with a new id, and a second revoke of the same id is refused so the first reason survives. An inactive order is then purged for good once its retention is over, and the purge is logged: `purgeAfter` is `revokedAt` for a revoked order and `until` for an expired one, plus `orders.retentionDays` (default 90) in `config.json`; `orderPurge` removes the row from the one store only once that date has arrived, and writes `{ at, purged: [ids] }` to `logs/<date>.jsonl` so the trail of what went survives the removal. A broken `orders.retentionDays` falls back to the default instead of stopping a reader.

One store: every order lives in `orders.json` under the state root and an id is `G000001`. There is no project layer any more — a project is chosen by `appliesTo`, which names the project ids or paths the order binds, and an order without it binds every project. `orderAdd` with a `layer` is refused with `layer is gone: use appliesTo`. The one-time `orderMigrateProjects(root, projectRoots)` copies each `<projectRoot>/.okwork/orders.json` of the old layout into the store with `appliesTo` set to that project path, `origin` `migrated:project` and a fresh `G` id, keeping text, scope, `until`, `active` and the revoke fields; a row already copied is skipped (same text plus `appliesTo`), the copy happens before the old file is renamed to `orders.json.migrated` and it is never deleted. It runs lazily from `orderList`/`orderAdd` when a `projectRoot` is passed, which is the only remaining use of `projectRoot`. `scope` is `all` or `effort:simple`, `effort:normal`, `effort:hard`; `origin` is free text, defaulting to `maintainer`, and a template writes `template:<name>`. A template's order is created with its record, moved on a rename and revoked with a reason on removal, so the order that allowed a run stops allowing it.

## 11. The daemon
The daemon is the headless half: nobody watches, so every bound it respects is a technical one. The core spawns nothing itself — `spawn` is injected, so a test drives it and an adapter drives it for real.

The order of one pass, `tick`:

| # | Step | Rule |
| :- | :- | :- |
| 1 | Pause | `daemon.paused` exists: the record says `paused`, nothing is opened and nothing is spawned. The loop keeps running. |
| 2 | Kill switch | `daemon.stop` exists: the record says `stopped: kill switch`, and `daemonRun` leaves the loop. |
| 3 | Quota floor | Every client of the pending demands below `daemon.minQuotaPct` stops the pass. A client with no reading is not below the floor, so an unmeasured client never paralyzes the daemon. |
| 4 | Retention | `orderPurge` drops from the one store every inactive order whose `orders.retentionDays` is over and appends `{ at, purged: [ids] }` to `logs/<date>.jsonl`. A paused or stopped daemon purges nothing. |
| 5 | Due templates | `openDue` with the worst reading of the pass: the lowest quota and the least idle of the clients it knows. |
| 6 | Pending demands, oldest first | The inbox lists newest first, so the queue is reversed and a demand waiting behind newer ones never starves. A period serves one run at a time: while a sibling of the same `ext.template` and `ext.period` is still `delegated` or `criticised`, the others wait. |
| 7 | Cap | Per demand: `classify` when the item has no `effort`, `profilePick`, then `acquireSlot` before the spawner runs and `releaseSlot` if it refuses, so a refusal costs nothing. |
| 8 | One decision line | `{ at, opened, spawned, skipped, purged, stopped?, paused? }` appended as a single JSON line to `logs/<date>.jsonl`, so a reader tailing the file always sees a whole pass. |

The daemon never refuses a demand on its own: a demand is skipped only for a technical bound (paused, kill switch, quota floor, the concurrency cap) or a spawner failure, and every skip says which.

| Function | Effect |
| :- | :- |
| `tick(root, deps)` | One pass; returns the decision record and appends it. |
| `daemonRun(root, deps, { signal, sleep })` | The loop: takes the daemon lock, writes `daemon.pid.json`, ticks every `daemon.intervalSeconds`, rotates the logs once a day, leaves on the kill switch or on `signal.abort()`, and removes the pid file on the way out. |
| `daemonStatus(root, { now })` | Whether it is running, its pid, when it started, whether it is paused and the last decision record. |
| `daemonPause(root)` / `daemonResume(root)` | Write and remove the pause file. |
| `rotateLogs(root, keepDays, now)` | Removes `logs/*.jsonl` older than `daemon.logKeepDays` by modification time and returns the names it removed. |

The spawner is injected: `deps` carries `now()`, `quota(client)`, `idle(client)` and `spawn(demand, { client, profile, limits, maxTurns, maxMinutes, runId })`. The `runId` it is given is the slot already reserved for the run, so returning the same id is the cheap path; returning another one moves the slot to that id, and when that id cannot be taken the original is taken again.

Pacing: the interval is paced on a monotonic clock, so a wall-clock jump forwards or backwards moves neither the number of passes nor the per-period idempotency. One daemon per root: `daemonRun` holds the `daemon` lock and throws when another already holds it. `daemonStatus` needs a live pid and a pid file that is not stale, so a daemon that crashed reads as stopped even while its pid file is still on disk. Defaults live under `daemon` in `config.json`: `intervalSeconds` 60, `minQuotaPct` 10, `logKeepDays` 14; a broken value never stops the loop. The retention of the standing orders lives beside it under `orders`: `retentionDays` 90, the whole days an inactive order is kept before it is purged, where a broken value falls back to the default.

## 12. Spawn modes
Claude Code and Codex support NATIVE descriptors and PROCESS spawning. opencode supports PROCESS only; requesting NATIVE is refused.

| Mode | When | How |
| :- | :- | :- |
| `NATIVE` | default in an interactive session | the client's own subagent: the Agent tool call for Claude Code, `spawn_agent` for Codex, opencode has no NATIVE bridge |
| `PROCESS` | the daemon and any other headless run | the headless CLI: `claude -p`, `codex exec`, `opencode run` (flags verified 2026-10-22, below) |

In `NATIVE` the core is not in the loop, so the cap is enforced by the MCP tools `acquire_slot` and `release_slot` around `classify` and `profile_pick`. In `PROCESS` the daemon reserves the slot itself before the spawner runs, and the run is a child process of the daemon.

### 12.1 `PROCESS`, verified 2026-10-22
`src/spawn-process.js` builds the command as a pure value and starts it with `child_process.spawn` and an argument array. No shell, anywhere: the briefing is the last positional argument of every client, so nothing in it is read as shell syntax. A child gets `OKWORK_NO_DAEMON=1`, so a daemon-spawned run never starts a daemon of its own.

| Client | Command |
| :- | :- |
| `claude-code` | `claude -p <briefing> --model <model> --effort <effort> --output-format json --permission-mode <mode> --add-dir <dir>` |
| `codex` | `codex exec --cd <dir> --model <model> --sandbox <workspace-write\|read-only\|danger-full-access> --json --skip-git-repo-check -c model_reasoning_effort=<effort> <briefing>` |
| `opencode` | `opencode run --dir <dir> --model <provider/model> --variant <effort> --format json <briefing>` |

- Claude Code 2.1.303: the permission mode is an option (`acceptEdits` by default); `--dangerously-skip-permissions` exists and is never what we pass. `--max-budget-usd` exists, `--max-turns` does not, so `maxTurns` is not on the command line at all — `maxMinutes` is the only wall-clock bound.
- Codex 0.163: `--skip-git-repo-check` because a worktree of the maintainer's choice need not be a git repository. `-o <file>` would write the last message to a file and is left to the caller.
- opencode 1.19: the model is the full `provider/model` id and the effort is a provider variant.

The working directory is the demand's `appliesTo` when it is one existing absolute folder; a project name, several projects or `global` keeps the run where the daemon was started. The run is detached, both streams go to `runs/<runId>.out`, and `runs/<runId>.json` is written with `status: live` — the file `limits.js` already counts — and gains `endedAt` and `exitCode` on exit. `maxMinutes` sends `SIGTERM` through `child.kill()`; the spawner kills nothing else.

### 12.2 Autostart and the CLI
`src/autostart.js` generates plans, it never acts: `systemd` (a user unit `okit-daemon.service`), `cron` (a `@reboot` line), `launchd` (the agent `com.okit.daemon`) and `schtasks` (a task at every logon). `detectAutostart(platform)` picks the one this platform uses and `applyAutostart(plan, { run })` runs the commands of an action through an injected `run`, so `show` prints the whole plan before anything happens. Windows keeps the paths it stores with forward slashes and no shell.

### 12.3 MCP tools
`src/mcp/server.js` is the MCP server: JSON-RPC 2.0 over newline-delimited JSON on stdio, hand-written and with zero dependencies. `src/mcp/tools.js` holds the table, one tool per core function, and each handler validates its own arguments again because the `inputSchema` is documentation and never the only gate. Only protocol frames go to stdout; diagnostics go to stderr.

| Tool | Input | Wraps | One line |
| :- | :- | :- | :- |
| `acquire_slot` | `runId`, `client`, `waitMs?` | `acquireSlot` | Reserves a slot, or answers `ok: false` with the cap that refused it. |
| `release_slot` | `runId` | `releaseSlot` | Frees the slot of a run. |
| `limits_status` | none | `limitsStatus` | The caps and the live runs per client. |
| `status` | `locale?`, `size?`, `slices?`, `executors?` | `statusTable` / `shouldShowStatus` | The quota table and the capacity line; with the three facts, also `showBefore`. |
| `classify` | `title`, `body?`, `kind?` | `classify` | `simple`, `normal` or `hard`, plus why. |
| `profile_pick` | `client`, `effort`, `quota?` | `profilePick` | Model, reasoning effort and `maxTurns` from `config.json`. |
| `inbox_add` | `title`, `body?`, `kind?`, `accept?`, `effort?`, `client?`, `appliesTo?` | `inboxAdd` | Adds a demand and returns the stored item. |
| `inbox_list` | `status?`, `client?`, `appliesTo?`, `limit?` | `inboxList` | Lists demands newest first. |
| `inbox_set_status` | `id`, `status` | `inboxSetStatus` | Moves one demand along the sequence. |
| `order_add` | `text`, `scope?`, `until?`, `appliesTo?` | `orderAdd` | Adds a standing order. |
| `order_list` | `appliesTo?` | `orderList` | Lists the orders active now. |
| `order_remove` | `id`, `reason?` | `orderRemove` | Revokes one order; the reason defaults to the tool's own. |

Methods: `initialize`, `notifications/initialized`, `ping`, `tools/list` and `tools/call`. Every tool answers `{content: [{type: 'text', text}], isError}` where `text` is the JSON of what the core returned, so a refusal (`ok: false`, a full cap) and a result read the same way. An unknown method is `-32601`, an unknown tool `-32602`, a line that is not JSON `-32700` with a null id; in every case the loop keeps reading.

## 13. Autonomy
Maximum autonomy is the default. The plugin ships no hard-coded list of forbidden actions: a refusal comes from something the user wrote or from a technical bound, never from a rule the maintainers guessed.
- Restrictions are standing orders. The user adds one ("never push to `main`") and `orderRemove` takes it back; nothing else can add a restriction.
- The technical bounds stay configurable: the concurrency cap (`limits.global`, `limits.perClient`, `staleMinutes`), the quota floor (`daemon.minQuotaPct`, `lowQuotaPct`), the kill switch (`daemon.stop`) and the pause file.
- The core never invents a model, an effort value or a quota number the client did not report, and it never widens a cap on its own.

## 14. Global state and `appliesTo`
One inbox, one set of standing orders, one template store, in one folder (`OKWORK_HOME`, default `~/.okwork`), shared by every project. What belongs to a project lives in that project's own files and the record only references it, so a shared store never has to be split.

| Function | Effect |
| :- | :- |
| `validateAppliesTo(value)` | Trims and deduplicates, keeps the shape given, and never stores the default: a record without the field applies everywhere. |
| `validateAppliesToFilter(value)` | The filter of a list: one project, or the shared records alone. A list of projects is refused, since the union would be ambiguous. |
| `inScope(record, wanted)` | Whether a record shows for a project. |
| `stateRoot(env)` / `paths(root)` | Where the state lives, the environment override first. |

So: absent means every project, one name means that project, a list means each of them, and `global` combined with another project is refused because it says nothing precise. `inboxList`, `orderList` and `templateList` filter by project and always include the shared records; `templateSet` with `appliesTo: 'global'` drops the field, so a template goes back to shared.

## 15. Implementation and limits

The three adapters, JSON state, daemon, schedules, installer, release tooling and MCP server are implemented. The real `client-smoke` driver supports Claude Code; other drivers and Windows/macOS proof remain pending. See [RELEASING.md](RELEASING.md#proof-per-pair).
