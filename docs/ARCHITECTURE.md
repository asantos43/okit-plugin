# Architecture

Status: design phase (pre-alpha). Extends [DESIGN.md](DESIGN.md); answers its open questions. One Node core (>=20, zero dependencies), three thin adapters, one MCP server over the core.

## 1. Subset: the minimal contract
| Record | Fields |
| :- | :- |
| Inbox item | `id`, `title`, `body`, `kind` (free text: `research`, `writing`, `documents`, `data`, `analysis`, `planning`, `review`, `files`, `code`, ...), `accept` (list of checks in plain words, each optionally a command), `effort` (simple\|normal\|hard), `client`, `appliesTo` (project id or path, a list of them, or absent for every project), `status` (pending\|delegated\|criticised\|consolidated\|failed), `stepIds`, `ext.<kind>` (optional typed extras), `createdAt` |
| Standing order | `id`, `text`, `scope` (all\|effort:simple\|effort:normal\|effort:hard), `appliesTo` (project id or path, a list of them, or absent for every project), `active` |
| Effort class | `simple`, `normal`, `hard`; classified by default from `title`, `body` and `kind`; the maintainer may override it on the item |
| Actor profile | `client`, `agentId`, `model`, `effort`, `maxTurns`, `worktree` |
| Quota reading | `client`, `source` (api\|user\|off), `remainingPct`, `windowMinutes`, `readAt` |
| Step briefing | `stepId`, `itemId`, `title`, `goal`, `accept`, `contextRefs`, `terseLevel`, `outLevel` |
| Critic verdict | `stepId`, `verdict` (pass\|revise\|reject), `findings`, `attempt` (1\|2) |

Rules: a demand is any unit of delegable work, not only code: research, writing, documents, data cleanup, analysis, planning, reviews, file and content operations. `kind` is free text, so a new kind needs no core change. Code-only details (branch, PR, test command) live under `ext.<kind>` as optional typed extras, never required fields. There is one global inbox and one global set of standing orders, so `appliesTo` is what keeps a shared store apart: a demand or order that names projects belongs to those, one without the field applies everywhere, and `'global'` is the default that is never stored. A step's `accept` is a slice of the item's list. Briefings carry only what changes; repeated context is referenced by `contextRefs`, never resent. `terseLevel` rises on a repeated attempt, `outLevel` falls on every round trip. The core never invents a model, an effort value or a quota number the client did not report.

## 2. Core API and the same as MCP tools
One Node function per tool, same name on MCP.

| Tool | Input | Output | One line |
| :- | :- | :- | :- |
| `inboxAdd` / `inboxList` / `inboxSetStatus` | `title`, `body`, `kind?`, `accept?`, `effort?`, `client?`, `appliesTo?` / `status?`, `client?`, `appliesTo?`, `limit?` / `id`, `status` | `item` / `items[]` / `item` | Adds a demand and classifies it when `effort` is absent; lists them, by project with `appliesTo`; moves one. |
| `orderAdd` / `orderRemove` / `orderList` | `text`, `scope?`, `appliesTo?` / `id` / `appliesTo?` | `order` / `removed` / `orders[]` | Adds, removes and lists standing orders, by project with `appliesTo`. |
| `classify` | `title`, `body`, `kind?` | `effort`, `reasons[]` | Returns simple, normal or hard plus why. |
| `planStep` | `itemId`, `count?` | `steps[]` | Splits a demand into steps, each with a class and its slice of `accept`. |
| `profilePick` | `client`, `effort`, `quota?` | `actor` | Chooses model, effort level and `maxTurns`. |
| `brief` | `stepId`, `terseLevel?`, `outLevel?` | `briefing` | Builds the step briefing. |
| `quotaRead` / `quotaSet` | `client` / `client`, `remainingPct`, `windowMinutes` | `quota` | Asks the adapter, or stores the number the user gave once. |
| `spawn` / `collect` | `stepId`, `actor?` / `runId` | `runId`, `pid?` / `result`, `tokens?` | Launches the subagent; waits and returns its result. |
| `criticise` | `stepId`, `result` | `verdict` | Checks the step against the demand's own `accept`: a command, a checklist or a read-through. |
| `consolidate` | `itemId` | `summary`, `findings[]` | Merges step results into one answer. |

Classifier rules, terse templates, the JSON store and the lock stay internal.

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

Project-side files live beside the project, not in this root: `<projectRoot>/.okwork/orders.json` for the project layer of standing orders (`projectOrdersPath`), plus the project's own `CLAUDE.md` (Claude Code) or `AGENTS.md` (Codex, opencode).

- Write: serialise to `<file>.<pid>.<random>.tmp`, then `fs.rename` over the target, so a reader never sees half a file. On `EPERM` or `EBUSY` (Windows) retry the rename a few times before failing.
- Lock: `fs.mkdir` the `<name>.lock` folder, which holds `owner.json` `{pid, startedAt}`; `EEXIST` means busy; release with `rmdir`.
- Stale: a lock is stale when it is older than `staleMs` (default 30 s) **and** its pid is dead; with no readable `owner.json` the folder `mtime` is used and there is no pid check. Takeover renames the folder to `<name>.lock.stale.<random>` atomically, then removes it, so two takers cannot both win.
- One writer per file: inbox, orders and runs are separate files, so two steps of one item do not block each other.

## 4. Adapter interface
Each adapter provides exactly these five functions. The core imports an adapter, never a client.

| Function | Input | Output |
| :- | :- | :- |
| `spawn(actor, briefing, opts)` | actor profile, briefing | `{ runId, pid }`, or `{ runId }` for an in-process run |
| `readQuota()` | none | `{ source, remainingPct?, windowMinutes? }` |
| `capabilities()` | none | `{ models[], efforts[], skills, hooks, mcp, desktop, windows }` |
| `installSkill(name, files)` | skill folder | `{ path }` |
| `installHooks(files)` | hook config | `{ path }` |

### 4.1 Claude Code
| Claim | Value | Source (checked 2026-10-22) |
| :- | :- | :- |
| Packaging | Plugin dir with optional `.claude-plugin/plugin.json`; default `skills/`, `agents/`, `hooks/hooks.json`, `.mcp.json`, `bin/` | https://code.claude.com/docs/en/plugins/manifest-reference |
| Install | `/plugin install <name>@<marketplace>`; shell `claude plugin marketplace add` then `claude plugin install`, `--scope project\|local`; `--plugin-dir` for one session | https://code.claude.com/docs/en/plugins/install |
| Skills, hooks, MCP | yes to all three: `skills/<name>/SKILL.md`, `hooks/hooks.json` (exec form avoids shell quoting), `.mcp.json` or `mcpServers` in the manifest with `${CLAUDE_PLUGIN_ROOT}` in `command`, `args`, `env` | https://code.claude.com/docs/en/plugins/manifest-reference |
| Subagent model and effort | frontmatter `model` (`sonnet`, `opus`, `haiku`, `fable`, a full id, `inherit`) and `effort` (`low`, `medium`, `high`, `xhigh`, `max`, levels depend on the model); the Agent tool also takes a per-call `model`, and a per-call `effort` needs v2.1.292 | https://code.claude.com/docs/en/sub-agents |
| Plugin subagent limits | `hooks`, `mcpServers` and `permissionMode` are ignored on plugin subagents; ship them in the plugin instead | https://code.claude.com/docs/en/sub-agents |
| Desktop app | plugin browser under the `+` button, with user, project and local scope; no plugins in cloud or WSL sessions; hooks and skills in settings apply to desktop too; the app reads the same settings files as the CLI | https://code.claude.com/docs/en/desktop |
| Desktop MCP and subagents | `~/.claude.json` and `.mcp.json` work in both, desktop adds `claude_desktop_config.json` that the CLI does not read; a subagent pane and a Background tasks pane list running subagents | https://code.claude.com/docs/en/desktop |
| Windows | native Windows 10 1809+ or Server 2019+; PowerShell and CMD installers; Git for Windows optional; sandboxing not supported natively, supported on WSL 2; substituted plugin paths use forward slashes | https://code.claude.com/docs/en/setup |
| Quota | `/usage` is in-session only and shows plan bars; no documented machine-readable per-user plan endpoint. Analytics APIs need an admin key | https://code.claude.com/docs/en/costs |

Adapter decision: spawn through the Agent tool call with `model` and `effort`; keep `maxTurns` in the agent frontmatter. Do not read a quota number; ask the user once.

### 4.2 Codex
| Claim | Value | Source (checked 2026-10-22) |
| :- | :- | :- |
| Packaging and install | plugin with `plugin.json`; a marketplace is `.agents/plugins/marketplace.json` (repo) or `~/.agents/plugins/marketplace.json` (personal); `codex plugin add`, `codex plugin marketplace add`, `/plugins` browser | https://developers.openai.com/codex/plugins |
| Skills | yes, `SKILL.md`; loaded from `.agents/skills`, `$REPO_ROOT/.agents/skills`, `~/.agents/skills`, `/etc/codex/skills` | https://developers.openai.com/codex/build-skills |
| Hooks | yes, `hooks.json` or `[hooks]` in `config.toml`; events include `SubagentStart` and `SubagentStop`; plugins use `hooks/hooks.json`, with `PLUGIN_ROOT` and `PLUGIN_DATA` | https://developers.openai.com/codex/hooks |
| MCP | yes, `[mcp_servers.<name>]` in `config.toml`; stdio and Streamable HTTP; `codex mcp add`, `codex mcp list` | https://developers.openai.com/codex/extend/mcp |
| Subagent model and effort | per-agent file `.codex/agents/<name>.toml` with `model` and `model_reasoning_effort`; `agents.default_subagent_model` and `agents.default_subagent_reasoning_effort`; values `low`, `medium`, `high`, `xhigh`, `max`, `ultra`, availability depends on the model | https://developers.openai.com/codex/agent-configuration/subagents |
| Spawning | `spawn_agent`, `send_input`, `resume_agent`, `wait_agent`, `close_agent` under `features.multi_agent`; `/subagents` lists them; `agents.max_concurrent_threads_per_session` caps them | https://developers.openai.com/codex/agent-configuration/subagents |
| Desktop app | Codex is the Code surface of the ChatGPT desktop app; macOS, Windows and Linux; MCP and skills supported; plugins in the desktop app and CLI, not in the IDE extension | https://developers.openai.com/codex/app |
| Desktop hooks | `UNVERIFIED`: check whether `[features] hooks` fires in the desktop app before relying on it. Check https://developers.openai.com/codex/hooks for desktop behaviour | |
| Windows | native Windows app; `winget install --id 9PLM9XGG6VKS -s msstore`; WSL optional, WSL 1 dropped at Codex 0.115; hook handlers take `command_windows` | https://developers.openai.com/codex/windows/windows-app |
| Quota | `codex app-server` JSON-RPC has `account/rateLimits/read` (`usedPercent`, `windowDurationMins`, `rateLimits`) and `account/usage/read` | https://developers.openai.com/codex/app-server |

Adapter decision: the one client with a documented machine-readable quota. Read it, and fall back to asking the user when the call fails.

### 4.3 opencode
| Claim | Value | Source (checked 2026-10-22) |
| :- | :- | :- |
| Packaging and install | a plugin is a JS or TS module in project `.opencode/plugins/` or global `~/.config/opencode/plugins/`, or an npm package in the `plugin` array of `opencode.json`; `opencode plugin <module>`, with `--global` and `--force`; global config at `~/.config/opencode/opencode.json` | https://opencode.ai/docs/plugins/ |
| Skills | yes, `SKILL.md` under `.opencode/skills/<name>/`, `~/.config/opencode/skills/<name>/`, `.claude/skills/<name>/` or `.agents/skills/<name>/` | https://opencode.ai/docs/skills/ |
| Hooks | `UNVERIFIED`: no `hooks` key exists in the published schema; lifecycle events are plugin event keys only. Check https://opencode.ai/config.json for a `hooks` key before planning on it | |
| MCP | yes, the `mcp` object with `type: local` (`command`, `cwd`, `environment`, `timeout`) or `type: remote` (`url`, `headers`, `oauth`) | https://opencode.ai/docs/mcp-servers/ |
| Subagent model and effort | `agent.<name>.model` as `provider/model-id` and `agent.<name>.variant`, plus pass-through options such as `reasoningEffort`; markdown agents at `.opencode/agents/<name>.md` | https://opencode.ai/docs/agents/ |
| Effort values | provider variants: Anthropic `high` and `max`; OpenAI `none`, `minimal`, `low`, `medium`, `high`, `xhigh`; Google `low` and `high` | https://opencode.ai/docs/models/ |
| Spawning | a subagent runs through the Task tool or an `@agent-name` mention; `mode` is `primary`, `subagent` or `all`; built-ins `general`, `explore`, `scout`; `subagent_depth` limits nesting (default 1, 0 disables subagents) | https://opencode.ai/docs/agents/ |
| Windows | native support: choco, scoop, `npm install -g opencode-ai`, or GitHub Releases; WSL is recommended; Bun on Windows in progress | https://opencode.ai/docs/windows-wsl |
| Quota | `UNVERIFIED`: no quota command, no documented `--json` on `opencode stats`, and no usage route in the server API. Check `opencode stats --help` and the provider account API | |

Adapter decision: read models from `opencode models`; treat quota as off unless the user supplies a number.

## 5. Quota
- `source: api` — the adapter returned a number this session (Codex today). Use it.
- `source: user` — no number; ask once, store it in `quota/<client>.json`, stale after `windowMinutes`.
- `source: off` — the user declined, or the client has no channel; class choice then ignores quota.

Never estimate, interpolate or carry a number over from another client. A stale or unread reading downgrades a `hard` class to the last class the client still accepted, never the other way. `quotaRead` returns `source: off` instead of failing, so the Director keeps working.

## 6. Windows rules
- Build every path with `node:path`, never by concatenating separators; store them with forward slashes, the form Claude Code substitutes, so what we write matches what the client reads.
- No shell: `child_process.spawn` with an argument array. Shell-form hook commands are the client's concern, not ours.
- Write `\n` only, with an explicit encoding and no platform default, so a file written on Windows reads the same on Linux.
- `fs.mkdir` locks behave the same natively and on WSL; no `flock`, no `setsid`.
- A native Claude Code install has no sandboxing: assume a subagent can touch the whole worktree, so default to `worktree: true` on Windows.
- Manual pass before a release: install the plugin, add an inbox item, delegate one step, read the critic verdict, consolidate, restart the client, confirm the state survived.

`PROCESS` mode starts the clients without a shell; on Windows the `.cmd` shims need the real executable resolved first (open item of the Windows pass).

## 7. Concurrency limit
| Scope | Default | Read from |
| :- | :- | :- |
| Global, all clients | 4 actors at once | `config.json` |
| Per client | 3 actors at once | `config.json`, lowered when quota is low |
| Per worktree | 1 actor | never changed |

The core counts live runs in `runs/<runId>.json` (`status: live`) rather than trusting the client to hold the cap. `spawn` waits up to 60 s for a free slot and then returns `busy`; it never starts a run over the cap. The count falls when `collect` returns, when a result arrives, and on a run older than 30 min. Codex caps itself with `agents.max_concurrent_threads_per_session`; set it to the same number so the two agree.

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
| `orderAdd(root, { text, scope, layer, until, origin, appliesTo }, { projectRoot })` | Adds an active order; `until` must be a date in the future. |
| `orderRemove(root, id, { reason })` | Revokes it: `active: false` with `revokedAt` and `revokedReason`. Nothing is deleted, so the history survives. |
| `orderList(root, { activeOnly, appliesTo, now }, { projectRoot })` | Both layers merged, global first; the same text in a project replaces the global one in place. `activeOnly` drops revoked and expired orders. |
| `orderLint(root, { projectRoot, now })` | What a reader of the files would trip on: empty text, unknown scope, unreadable dates, a repeated id, an active order past its `until`, two live orders with the same text. |
| `orderRender(orders)` | Markdown for a human to read. |

Two layers: `global` (default) in `orders.json` under the state root, and `project` in `<projectRoot>/.okwork/orders.json`; the layer is chosen by `projectRoot` when `layer` is absent. Ids are `G000001` in the global layer and `O000001` in the project one. `scope` is `all` or `effort:simple`, `effort:normal`, `effort:hard`; `origin` is free text, defaulting to `maintainer`, and a template writes `template:<name>`. A template's order is created with its record, moved on a rename and revoked with a reason on removal, so the order that allowed a run stops allowing it.

## 11. The daemon
The daemon is the headless half: nobody watches, so every bound it respects is a technical one. The core spawns nothing itself — `spawn` is injected, so a test drives it and an adapter drives it for real.

The order of one pass, `tick`:

| # | Step | Rule |
| :- | :- | :- |
| 1 | Pause | `daemon.paused` exists: the record says `paused`, nothing is opened and nothing is spawned. The loop keeps running. |
| 2 | Kill switch | `daemon.stop` exists: the record says `stopped: kill switch`, and `daemonRun` leaves the loop. |
| 3 | Quota floor | Every client of the pending demands below `daemon.minQuotaPct` stops the pass. A client with no reading is not below the floor, so an unmeasured client never paralyzes the daemon. |
| 4 | Due templates | `openDue` with the worst reading of the pass: the lowest quota and the least idle of the clients it knows. |
| 5 | Pending demands, oldest first | The inbox lists newest first, so the queue is reversed and a demand waiting behind newer ones never starves. A period serves one run at a time: while a sibling of the same `ext.template` and `ext.period` is still `delegated` or `criticised`, the others wait. |
| 6 | Cap | Per demand: `classify` when the item has no `effort`, `profilePick`, then `acquireSlot` before the spawner runs and `releaseSlot` if it refuses, so a refusal costs nothing. |
| 7 | One decision line | `{ at, opened, spawned, skipped, stopped?, paused? }` appended as a single JSON line to `logs/<date>.jsonl`, so a reader tailing the file always sees a whole pass. |

The daemon never refuses a demand on its own: a demand is skipped only for a technical bound (paused, kill switch, quota floor, the concurrency cap) or a spawner failure, and every skip says which.

| Function | Effect |
| :- | :- |
| `tick(root, deps)` | One pass; returns the decision record and appends it. |
| `daemonRun(root, deps, { signal, sleep })` | The loop: takes the daemon lock, writes `daemon.pid.json`, ticks every `daemon.intervalSeconds`, rotates the logs once a day, leaves on the kill switch or on `signal.abort()`, and removes the pid file on the way out. |
| `daemonStatus(root, { now })` | Whether it is running, its pid, when it started, whether it is paused and the last decision record. |
| `daemonPause(root)` / `daemonResume(root)` | Write and remove the pause file. |
| `rotateLogs(root, keepDays, now)` | Removes `logs/*.jsonl` older than `daemon.logKeepDays` by modification time and returns the names it removed. |

The spawner is injected: `deps` carries `now()`, `quota(client)`, `idle(client)` and `spawn(demand, { client, profile, limits, maxTurns, maxMinutes, runId })`. The `runId` it is given is the slot already reserved for the run, so returning the same id is the cheap path; returning another one moves the slot to that id, and when that id cannot be taken the original is taken again.

Pacing: the interval is paced on a monotonic clock, so a wall-clock jump forwards or backwards moves neither the number of passes nor the per-period idempotency. One daemon per root: `daemonRun` holds the `daemon` lock and throws when another already holds it. `daemonStatus` needs a live pid and a pid file that is not stale, so a daemon that crashed reads as stopped even while its pid file is still on disk. Defaults live under `daemon` in `config.json`: `intervalSeconds` 60, `minQuotaPct` 10, `logKeepDays` 14; a broken value never stops the loop.

## 12. Spawn modes
Two modes per adapter, and the adapter's `spawn()` returns the mode it used. Planned: no adapter is written yet.

| Mode | When | How |
| :- | :- | :- |
| `NATIVE` | default in an interactive session | the client's own subagent: the Agent tool call for Claude Code, `spawn_agent` for Codex, the Task tool for opencode |
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
| `stateRoot(env)` / `paths(root)` / `projectOrdersPath(projectRoot)` | Where the state lives, the environment override first. |

So: absent means every project, one name means that project, a list means each of them, and `global` combined with another project is refused because it says nothing precise. `inboxList`, `orderList` and `templateList` filter by project and always include the shared records; `templateSet` with `appliesTo: 'global'` drops the field, so a template goes back to shared.

## 15. MVP plan
1. Claude Code first, Linux and Windows: adapter, MCP server, the fifteen tools, the JSON store.
2. Codex second on the same core: the adapter reads quota, so quota control is on.
3. opencode third: the adapter plus the effort work that still needs confirming.

One end-to-end test area on a scratch repository, run for every adapter, with two demands: one `code` and one non-code (a short research or writing demand). Each goes inbox item, classified step, delegated subagent with a chosen model and effort, critic verdict against its own `accept` list, consolidated result. Assert a `simple` briefing stays under 1 kB and that a second attempt is terser than the first.

## 16. Open questions for the maintainer
- Effort levels differ per client. Map `simple`/`normal`/`hard` onto each client, or keep one internal scale and let the adapter translate?
- `ultra` exists on Codex only. Accept a smaller effort vocabulary for portability?
- Claude Code `/usage` shows plan bars only in-session. Accept `source: user` there, or drop quota control for that client?
- Should `consolidate` run as a Director turn or as a cheap subagent call?
- Retries: two attempts per step, or one attempt plus one revision?
- Keep `runs/` forever, or prune after consolidation?

Portuguese version: [ARCHITECTURE.pt-BR.md](ARCHITECTURE.pt-BR.md).