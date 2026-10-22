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
quota/<client>.json       one quota reading per client
runs/<runId>.json         one file per delegated run
locks/<name>.lock/        mkdir lock directories
logs/<date>.jsonl         append-only events
```

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

## 7. Concurrency limit
| Scope | Default | Read from |
| :- | :- | :- |
| Global, all clients | 4 actors at once | `config.json` |
| Per client | 3 actors at once | `config.json`, lowered when quota is low |
| Per worktree | 1 actor | never changed |

The core counts live runs in `runs/<runId>.json` (`status: live`) rather than trusting the client to hold the cap. `spawn` waits up to 60 s for a free slot and then returns `busy`; it never starts a run over the cap. The count falls when `collect` returns, when a result arrives, and on a run older than 30 min. Codex caps itself with `agents.max_concurrent_threads_per_session`; set it to the same number so the two agree.

## 8. MVP plan
1. Claude Code first, Linux and Windows: adapter, MCP server, the fifteen tools, the JSON store.
2. Codex second on the same core: the adapter reads quota, so quota control is on.
3. opencode third: the adapter plus the effort work that still needs confirming.

One end-to-end test area on a scratch repository, run for every adapter, with two demands: one `code` and one non-code (a short research or writing demand). Each goes inbox item, classified step, delegated subagent with a chosen model and effort, critic verdict against its own `accept` list, consolidated result. Assert a `simple` briefing stays under 1 kB and that a second attempt is terser than the first.

## 9. Open questions for the maintainer
- Effort levels differ per client. Map `simple`/`normal`/`hard` onto each client, or keep one internal scale and let the adapter translate?
- `ultra` exists on Codex only. Accept a smaller effort vocabulary for portability?
- Claude Code `/usage` shows plan bars only in-session. Accept `source: user` there, or drop quota control for that client?
- Should `consolidate` run as a Director turn or as a cheap subagent call?
- Retries: two attempts per step, or one attempt plus one revision?
- Keep `runs/` forever, or prune after consolidation?

Portuguese version: [ARCHITECTURE.pt-BR.md](ARCHITECTURE.pt-BR.md).