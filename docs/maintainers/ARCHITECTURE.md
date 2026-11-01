# Architecture

![okit-plugin: Maintainers](../images/banners/maintainers.svg)

Core contracts and invariants for persistence, scheduling, adapters and execution.

<a id="contents"></a>
## Contents

- [1. Core contract](#section-1)
- [2. MCP tools](#section-2)
- [3. State on disk](#section-3)
- [4. Adapter interface](#section-4)
- [5. Quota](#section-5)
- [6. Windows rules](#section-6)
- [7. Concurrency limit](#section-7)
- [8. Schedules and recurrence](#section-8)
- [9. Recurring templates](#section-9)
- [10. Standing orders](#section-10)
- [11. The daemon](#section-11)
- [12. Spawn modes](#section-12)
- [13. Autonomy](#section-13)
- [14. Global state and `appliesTo`](#section-14)
- [15. Implementation and limits](#section-15)
- [Operational reference](#section-16)

`src/install/statusline.js` plans, applies and undoes Claude status bar registration with injected filesystem dependencies. The per-client installation record stores the settings path, hash of written bytes and backup path in plugin state. A prior command is tokenized or wrapped with `statuslineRegistration.shell[platform]`; other status bar fields survive. Approved updates repair a missing collector or a changed plugin command; an existing collector without ownership is left alone. Uninstall restores original bytes when the hash matches, otherwise changes only an owned status bar. Preview/check paths never write.

`src/install/mcp-register.js` registers the MCP server of the plugin in the client it installs, through the client's own `mcp` commands (`mcp get`, `mcp add`, `mcp remove`), never by writing the client's configuration. The entry is the one `install.mcp.name` names (`okit`) and the file is `install.mcp.server` inside the installation; the client decides the scope (`install.clients.<client>.mcp.scope`, which only a client whose own `mcp` commands take one accepts). Only Claude Code and Codex are asked; OpenCode is never asked, whatever the configuration says. The entry the client holds is read first: an entry whose arguments are our path, whole (the clients print the arguments joined by spaces and never quoted, so our path with another word at its side is another entry), points at this installation and is left alone; one that points at the installation it replaces is taken out and written again; one that is not ours is kept with a warning. An entry the client cannot read is not an absent entry: the step is a warning and nothing is written, because the `mcp add` of a client replaces the entry of the same name. The uninstall takes our entry out before the plugin it points at is removed. A failure of the step is a warning, never a failure of the installation; an installation that is already there reads its entry again and adds it when it is missing, so a failed add is retried; a dry run shows the plan and runs nothing.

The plugin CLI uses `install.command` (default `okit-plugin`) and its package `bin`. Legacy plugin links migrate on install/update; kit links remain untouched. The kit detector rejects plugin executables, including old `okit` links. MCP identity and `~/.okwork` are unchanged.

Extends [DESIGN.md](DESIGN.md); answers its open questions. One Node core (>=20, zero dependencies), three thin adapters, one MCP server over the core.

<a id="section-1"></a>
## 1. Core contract

`src/smoke/demo/index.js` composes the existing classifier, snapshot actor selection, profiles, inbox and slot functions in an isolated temporary tree. Small scenario, attempt, scheduler, budget and report modules implement the [injected demonstration](DEMO.md); every executor/critic attempt reserves a slot and budget. CLI/MCP/skill entry and consent are implemented; paid launches refuse without proven usage measurement and cost limits; C1–C23 keep their existing meaning.

The inbox stores demands with `id`, `title`, `body`, `kind`, `accept`, `effort`, `client`, `appliesTo`, `status`, `stepIds`, `ext`, `createdAt`. `kind` is free text. Orders share one file, filtered by `appliesTo`. Briefing, critique and consolidation are skill instructions rather than additional core APIs.

<a id="section-2"></a>
## 2. MCP tools

See the reference: [mcp-tools](../components/mcp-tools.md).

`src/env/report.js` centralizes environment readings.

Inbox items optionally carry `hold: {client, session, worktree, takenAt, via}`;
`via` is `claim` or `producer`. `heldBefore` records previous holders with
`releasedAt` and `reason` (including `stale` and `producer takeover`). Old items without
holds remain valid. All mutations use the inbox lock and atomic write.
Identity is client plus session. Same-owner claims repeat idempotently; another active
owner is refused. Staleness uses `inbox.holdStaleMinutes` (integer >= 1).
Owner or stale release and `consolidated`/`failed` clear the hold. Delegation accepts
an optional `holder`; when present it must match an existing owner. Legacy calls omit it.
MCP lists and status show ownership in English or Portuguese. Only `okit-plugin inbox take`
with `--producer-takeover` can force transfer, after situation display (including Git
changes with `inbox.gitTimeoutMs`) and TTY confirmation or `--yes`.
The confirmed holder is compared again inside the lock to reject intervening changes.

<a id="section-3"></a>
## 3. State on disk

See the reference: [state](../components/state.md).

- Write: serialise to `<file>.<pid>.<random>.tmp`, then `fs.rename` over the target, so a reader never sees half a file. On `EPERM` or `EBUSY` (Windows) retry the rename a few times before failing.
- Lock: `fs.mkdir` the `<name>.lock` folder, which holds `owner.json` `{pid, startedAt}`; `EEXIST` means busy; release with `rmdir`, which waits out `EPERM`/`EBUSY` like every other call: the file it removes was written and closed a moment ago, and a lock left behind by that refusal holds the owner of a process that is gone and is younger than `staleMs`, which no contender can take. A release answered by `ENOTEMPTY` (emptied, but a contender wrote an entry back before the `rmdir`) or `ENOENT` (another contender removed it first) counts as released: the entry that answered is the only evidence every waiter reads, so retrying would take a lock from a live owner.
- Stale: a lock is stale when it is older than `staleMs` **and** its pid is dead; with no readable `owner.json` the folder `mtime` is used and there is no pid check. Takeover claims the dead owner's folder in place: it renames the dead owner's `owner.json` out of the folder (only one rename can win) and then creates its own `owner.json` exclusively (`wx`), so two takers cannot both win. The folder is never moved aside. A Windows refusal that outlives the retries of any one step of that claim gives the attempt up and leaves the folder as it was found, so the poll loop judges it again instead of the acquire ending on a raw code.
- One writer per file: inbox, orders and runs are separate files, so two steps of one item do not block each other.

<a id="section-4"></a>
## 4. Adapter interface
The [integration design](INTEGRATION.md) ([Português](INTEGRATION.pt-BR.md))
defines the shared environment, native roles, glossary and whole-flow routing (steps 2–4 complete).

Each adapter provides these five operations, plus its documented helpers. The core imports an adapter, never a client.

- `spawn(actor, briefing, opts)` — actor profile, briefing — `{ runId, pid }`, or `{ runId }` for an in-process run
- `readQuota()` — none — `{ source, remainingPct?, windowMinutes? }`
- `capabilities()` — none — `{ models[], efforts[], skills, hooks, mcp, desktop, windows }`
- `installSkill(name, files)` — skill folder — `{ path }`
- `installHooks(files)` — client hook config or module path — `{ path }`
- `deliverRole(context)` — client, explicit briefing or main session, shared snapshot, applicable work/orders/limits, actor — `ready` with native context, `clarification` or `unsupported`
- `installRole(opts)`, `removeRole(opts)` — injected client root and native support — idempotent managed artifact; preserve user instructions

`src/roles.js` composes the same bilingual role contract without client branches or side effects. Claude SessionStart injects context on startup/resume/compact; Codex uses a delimited AGENTS.md block and launch prompt; opencode uses its native config hook for primary agents and commands. Explicit briefings select Executor/Critic, never model+effort. Missing/ambiguous roles and unsupported formats are reported before launch. Role answers use existing core tools and readable work titles; environment questions never save settings, spawn or spend quota. Installer role registration and packaged Claude hook wiring are part of this path. Hermetic whole-flow tests isolate HOME and client roots for all three adapters, through confirmed setup, shared facts, Director and injected offline smoke. All six skills carry the same bilingual routing map; real-client acceptance stays separate.

### 4.1 The bundled adapters

See the reference: [adapters](../components/adapters.md).

<a id="section-5"></a>
## 5. Quota
See the reference: [configuration](../components/configuration.md).

Never estimate quota. `profilePick` lowers one class when `remainingPct < lowQuotaPct`; `source: off` and absent readings do not downgrade. Adapters return automatic readings when available, with manual fallback.

OpenCode reads configured `opencodeQuota.sources` (provider → command words or
file), never credentials. Commands reuse `execRun`, without a shell or added
environment, with configured time/output limits. Contract version, field names
and window minutes live in `DEFAULT_CONFIG.opencodeQuota`. Invalid, failed or
old sources yield the manual sample. The lowest remaining percentage among
valid providers/windows wins. `quotaOrigin` shows source, age and provider in
`status` and `quota show`. Client smoke consumes the shared env snapshot and preserves its
warning/expiration checks on `ageMinutes`. The execution scenario stays Claude
Code. Only that client's own adapter reading authorizes the run; absent or expired
quota stays unknown. Another client's quota never authorizes it.

### 5.1 The quota table

The actors Quota column shows the localized state, tightest remaining percentage and reading age, without standing-order text in either Markdown or JSON. A client with no configured actors gets only the setup note. Invalid CLI `--client` values print usage and exit 2, as for `status`. Extra locales in `actors.messages` are limited to those accepted by the CLI and MCP (`LABELS`/`LOCALES`).

`actors_list` / `okit-plugin actors [--client <name>|--all] [--json] [--locale en|pt-BR]` is read-only. An actor is a model + effort pair available in a client, with sizes derived from the configured `actors.sizeClasses` map (default S→simple, M→normal, L→hard); `actors.criticClass` is shown separately. `src/actors.js` shares status client selection/quota and reads `limitsStatus` without acquiring/releasing slots. Status describes running executors; actors lists configured profiles even with none running. Duplicate pairs merge sizes. Missing sizes name the nearest runnable size, ties favor the earlier size in the map. Low quota and full capacity include reasons and remedies; unknown quota blocks launch. A client with no profile gets the setup note that points to the profiles in the plugin configuration.

`src/status.js` is the view of those readings, not a second source of them: `statusTable(root, deps)` formats the readings, clock, cap counts and standing orders supplied in `deps`, using the locale's fixed `LABELS`, and returns `{markdown, capacityLine, rows}`. The table ends with one fixed, localized sentence saying slots are running executors and `actors` lists the available model + effort profiles. This sentence is a label, not an input reading in `deps`. Columns are `Subscription | 5h remaining | Week remaining | Resets in | Status | Source (age)`; a `windows` array fills both columns, and without it the single `remainingPct` goes to the 5h column when `windowMinutes <= 360` and to the week otherwise, including when `windowMinutes` is absent.

`okit-plugin status [--all] [--client <name>] [--locale en|pt-BR]` shows only the detected client by default. `--all` shows every configured client (the three known clients when the root names none); `--client claude-code|codex|opencode` chooses one and takes priority over `--all`. If detection fails, all clients appear with a note explaining `--client`. MCP `status` accepts optional `all` and `client` with the same behavior. Executor counts and available slots include only the clients shown. The default profile catalog never adds a client to that list: the clients of a root are the ones its own configuration names.

`detectClient(deps.env)` uses the named `CLIENT_ENV_MARKERS` table: `CLAUDECODE` for Claude Code, `CODEX_THREAD_ID` or `CODEX_CI` for Codex, `OPENCODE` or `OPENCODE_PID` for opencode. Empty or `0` values do not identify a session; configured home folders do not identify a running client. CLI and MCP pass `ctx.env` (the real process environment when not injected); the table itself reads only its injected environment.

The Status column is a word, never ANSI: `green` at or more than 15 points above `lowQuotaPct`, `yellow` from the floor up to that, and `red` below it. The row follows the tightest window, and a red row quotes the standing order about the quota floor, falling back to `lowQuotaPct`. Without a reading, it says “No quota value recorded” and gives the recording command: `okit-plugin quota set <client> <pct>`. No percentage is guessed; adapters read automatic or manual samples. A recorded value shows its age from `recordedAt`, including after a cache refresh; older readings without a date use the first read time. Below the table, each shown client has live/cap, the cap source (client/default), and available slots clamped at zero, plus the quota floor. Every word lives in `LABELS` with `en` and `pt-BR`, chosen by `deps.locale`.

Readings are cached per client for `ttlMs` against `deps.now`, so two calls in a row cost one read. `shouldShowStatus({size, slices, executors})` is true for size `L`, `slices >= 2` or `executors > 1`, and the Director shows the table when it is. `okit-plugin daemon status --table [--locale en|pt-BR]` prints the same table under its daemon lines, and a daemon pass never reads a quota for it: `daemonStatus(root, { table })` builds it only when those deps are handed in.

### 5.2 The profile catalog

`src/profiles.js` holds the catalog in `DEFAULT_CONFIG.profiles`: every client (`claude-code`, `codex`, `opencode`) has a profile per class (`simple`, `normal`, `hard`), and a profile is `{model, effort, maxTurns}`. The efforts and the turn caps come from `PROFILE_EFFORTS` and `PROFILE_MAX_TURNS`, so no value is fixed in the logic. The maintainer owns the model names: they change as the client catalogues change, and the catalog is edited there.

`configOf(config)` merges the user's `config.profiles` over the catalog, class by class: the user's value replaces the class it names and the other classes keep the default, so one override never erases the rest. A class set to `null` is dropped from the catalog. A root without a `profiles` entry keeps the whole catalog, so a clean install answers `profile_pick` and `actors_list` for every client and class.

The catalog is a fallback for the profiles, not a list of subscriptions: `clientsOf` keeps the clients the root's own configuration names (the known clients when it names none), so the quota command never records a client the root does not have.

A refusal is short and bilingual: an unknown client gets the known clients in English and Portuguese, an unknown class gets the classes, and no demand or order id appears in the message. The texts live in `DEFAULT_CONFIG.profileMessages`, so a user replaces them in `config.json`.

### 5.3 The editable configuration schema

`src/config-schema.js` owns `CONFIG_SCHEMA.entries` (`src/config.js` re-exports it and reads the text of a value), the table of every key that
`okit-plugin config show|get|set|unset` accepts. Each entry names its dotted
path, type, allowed range or values, default path, and a plain English /
Portuguese description of its effect. The current keys are `limits.global`,
`limits.clients.<client>`, `profiles.<client>.<class>`,
`profiles.<client>.<class>.model`, `profiles.<client>.<class>.effort`,
`profiles.<client>.<class>.maxTurns`, `lowQuotaPct`,
`daemon.minQuotaPct`, and `smoke.quotaFloorPct`.

Integer limits and turn caps start at 1. Quota percentages range from 0 to
100. Model names are non-empty text, and the allowed efforts come from
`PROFILE_EFFORTS`. Client names come from the default catalog and
`configuredClientsOf`; classes come from the profile catalog. The schema's
scope patterns allow only letters, digits, `-` and `_`, and the reserved path
segments `__proto__`, `constructor` and `prototype` are refused. The command
expands only safe names into the schema, so an unsafe client or class is
refused as an unknown key and a client or class outside the catalog is
refused with the valid list.

`show` prints every expanded key with its effective value, origin (`default`
or `user`) and effect. `get` prints one. `set` converts the text to the
schema type, validates it, and changes only that leaf in `config.json`; it
uses the config lock and `writeJsonAtomic`, so a failed write leaves the old
file intact. `unset` removes the leaf, removes any legacy alias for that
entry, and restores the default. An invalid value or unknown key exits 2 and
writes nothing.

The class key `profiles.<client>.<class>` takes only `null`, the state that
disables a class, and `unset` on it brings the class back. A `set` never
crosses an ancestor that is not an object: it refuses with a short bilingual
message that names the disabled profile and the `config unset` that enables it,
and writes nothing. A client counts as configured only when its entry in
`profiles` names a class of its own, so an empty group is the absence of a
client and removing it changes nothing.

To add a key, add its entry to `CONFIG_SCHEMA.entries`, put its default in
`DEFAULT_CONFIG` (or point `defaultPath` at the existing default), add the
type and range to the entry, and add command tests and bilingual docs. Do not
put a client, class, range, message or key list in the command logic: the
schema is the single source consumed by the code.

### 5.4 Model detection

`src/setup/detect.js` detects clients in parallel and proposes profiles without writing configuration. `detectClients({config, env, run, adapters})` reads each adapter's `listModels`; an adapter failure becomes a catalog result with a reason, never an exception. `proposeProfiles(detected, config)` is pure.

When the real adapter cannot read the model list, its reason says “The model list could not be read, so the built-in catalog is used.” On timeout it says “The model list did not answer in time, so the built-in catalog is used.” Neither phrase includes technical details. The failure code, exit code or configured deadline in milliseconds stays as a string in the adapter response's `error` field, preserved in the detected client record for diagnosis.

Listed is not active. `setup.detect.<client>.activeField` and `activeValues` define activity: Codex uses `visibility` and `list` by default, while the other clients use `null`, so every listed item is active. `listModelsOf` returns active models in `models`, excluded names in `hidden`, and a reason with the listed, active and hidden counts. Only an exit code of zero (or no code at all) is a success; any other value, a numeric string included, is a failure. A command that answered is a listing even when it listed no model at all: only an absent executable, a failure, a deadline and an output the plugin does not understand answer with the catalog.

A client's candidates are the models of every class in `config.profiles.<client>` plus `setup.detect.<client>.candidates`. A configured model stays when it is active. Otherwise, an active candidate of the same family replaces it. The family is a rule of the client: `setup.detect.<client>.family.separator` divides the provider from the rest of the name and `family.minimumPrefix` is the length the common prefix of the rest must reach; the provider must be the same one, and a different provider is never of the same family. A name that does not contain the separator has no provider and is compared whole, so the separator must be the one the client uses in its names (`/` for `provider/model`); a separator that appears in no name leaves every name without a provider. A separator that is empty, or that is not text, is no rule at all: it turns the automatic replacement off, so nothing replaces the configured model; a configured model that is active still stays (`source: 'listing'`), and a class whose configured model is not active is omitted with the command `okit-plugin config set profiles.<client>.<class>.model <model>`. Among the candidates of the family, the longest common prefix wins, a user candidate wins an equal-prefix tie, and catalog order breaks the remaining catalog ties. If no candidate qualifies, the class is omitted with the command `okit-plugin config set profiles.<client>.<class>.model <model>`. A listing that answered with no active model omits every class with that command; only a listing the plugin could not read keeps the catalog model, with the listing's reason. A proposal exposes `{model, effort, source, reason}` per class and `{listed, active, candidatesActive}` per client, never the complete model list.

To add a client, give its adapter a `listModels` function, add its profile classes and its `setup.detect.<client>` entry (`command`, `args`, `timeoutMs`, `parse`, `activeField`, `activeValues`, `family` and `candidates`) to the defaults, and import the adapter in the default list of `src/setup/detect.js`. Users may override these values in `config.json`; the detection logic keeps no fixed activity field, activity value, candidate, client, class, timeout, separator or minimum prefix.

The setup leaves `setup.done` in `config.json`; while that record is absent, `okit-plugin status` shows one line naming the missing step, the end of an install or an update offers the setup, and the `okit-setup` skill conducts the same setup in a conversation. The record is written only when the setup has a model setting to save, or when every class of the detected clients already has an active model. A setup that found no client with an active model writes nothing, says one plain sentence in the language of the run (`--locale`, then `OKIT_LANGUAGE`, then the saved language, then English: the same function as the installer, with no bilingual exception), and leaves the configuration pending.

The installer's output has one pipeline and one exit policy. `src/install/present.js` is the only place that prints (`localizeReason`, then `redact`, then the writer); `src/install/exit.js` gives the exit code from `error.kind` alone (`kindOf`: `usage` and `language` are 2, anything else, including an error with no kind, is a failure of the work and is 1). Every refusal of the settings in `src/profiles.js` is a `ConfigError` with a code from `CONFIG_MESSAGES` (`en` and `pt-BR` per code, the same `{parameters}`) and is shown by `localizeReason`. `src/cli.js` builds `COMMANDS` (groups, actions and valued actions) from `USAGE_LINES`, and `test/install-matrix.test.js` generates its cases from that table, so a new command enters the matrix by being in the usage text; the three entry points the client launches (`hook session-start`, `hook post-compact` and `statusline-collector`) are internal, are not in the usage text and are dispatched by `src/launchers.js`, so the matrix does not run them; the exemptions are a short list with the reason (`config`, `quota`, `telemetry` and `trajectory` are subsystems with their own bilingual convention, still held to the no-secret and exit-class properties). The language is resolved by one function in all Node code (`--locale`, then `OKIT_LANGUAGE`, then the saved configuration, then English). The one documented and tested exception is the shell prelude of `install.sh` and `install.ps1` (`src/release/install-scripts.js`): there is no Node yet, so it reads no configuration and no file, parses no JSON, and uses flag, then `OKIT_LANGUAGE` (exactly `en` or `pt-BR` for both), then the language of the system (the first non-empty of `LC_ALL`, `LC_MESSAGES`, `LANG`, where `pt` followed by the end, `_`, `-` or `.` is `pt-BR`; the UI culture on Windows), then English, with shell built-ins only and never `eval`. A configuration or a setting that is not valid is a usage error (exit 2) in `install`, `update`, `uninstall` and `setup` alike, whether it is a value, a name outside the schema or a model or effort (`SetupRefusal` carries `kind: usage`), and so are the typed answers that run out of valid ones; a plain `new Error` in `src/install/**` or `src/setup/**` must be named with its reason in `PLAIN_ERRORS` of `test/install-invariants.test.js` (a failure of the work or a bug of the caller); one that cannot be read is a failure of the work (1). Regenerate both scripts after a change to the presenter or the prelude (`writeInstallScripts`). Every configuration passes through the single schema (`src/config-schema.js`): `INSTALL_SCHEMA` for the `install.*` settings, read by `installConfig` for `install`, `update`, `uninstall`, `setup`, `kit`, `status` and `config`, and `CONFIG_SCHEMA` for the keys of `config set|get|unset`; a value that is not valid is one refusal of usage (exit 2) that names the key and the rule, in English and in pt-BR from `CONFIG_MESSAGES` and `RULES` (`src/install/rules.js`), never a `TypeError`, a `RangeError` or an exit 1. `test/install-config-fuzz.test.js` builds its invalid values from the schema (every key, every command, both languages), so a key added to `DEFAULT_CONFIG.install` without a node in `INSTALL_SCHEMA` fails it.

One input reader serves every setup question. It keeps the received lines in order, treats end of input as cancellation, and closes after the setup ends. An input that had already ended opens no reader at all: every question is answered with nothing, so the setup cancels instead of waiting for a line that will never come. Before normalizing the raw profiles, the setup checks their own client and class names against the configuration schema; a name outside the schema is refused, in the language of the run, and no file is changed. A configuration file that cannot be read, or whose root is not a plain object, is refused before any write and again on the read under the lock, with the same plain sentence in the language of the run; nothing is written and the file stays as it is. A `profiles` that is not a plain object, or a client inside it that is not a plain object, is refused the same way, and no technical error of the language reaches the user. The `okit-setup` skill never writes an individual setting: the setup asks for each model and writes the complete set once, after the final confirmation.

### 5.5 The input inventory (invariant I9)

Every input the installer takes in is listed in one generated inventory, `test/helpers/input-inventory.js`, and
`test/input-inventory.test.js` proves each row against the real commands. The scanners read the source and fail when
a configuration key, a `--flag` or an `OKIT_*` variable is read that no row names, so a new input cannot skip the
proof. The files are found the same way: `fileReads()` lists every call in `src/` and in `adapters/` (one scan, one table) that reads a file or parses text
(`readFile`, `readFileSync`, `readJson*`, `createReadStream`, `JSON.parse`, `createRequire`, a dynamic `import()`) with
its first argument, and each one must be classified in `READ_POINTS` by a row of `FILE_RULES` or by a named exclusion
that says why it is not an input of an installation. A read nobody classified, a classification that matches no read,
a row of `FILE_RULES` that nothing uses and a new reader in `src/install/` with no row all fail the test. The readers of
the subsystems' own settings (telemetry, quota, trajectory, daemon, todo) are held to the schema the same way: a check
of a saved value outside `CONFIG_SCHEMA` fails unless the file is in `OWN_VALIDATORS` with its reason (the telemetry
has none; it validates its saved numbers with the schema of `config set`, `assertSavedValues`). The rule for every row is the same: a value outside its domain is a refusal of usage, exit 2, in the language of
the run; a file that cannot be read is a failure of the work, exit 1; a field of the wrong type in a file that was read
is exit 2. Never a `TypeError`, a `RangeError` or a mix of languages.

| Input | Where it is listed | Domain | Outside it |
| --- | --- | --- | --- |
| Keys of `config.json` | `TOP_LEVEL_KEYS` | type and range per key; `install.*` by `INSTALL_SCHEMA`, `config set` keys by `CONFIG_SCHEMA` | exit 2 (a reader that never stops, such as the orders, uses its default) |
| Numbers | `INSTALL_NUMBERS`, `CONFIG_NUMBERS` | minimum and maximum written apart from the schema; the maximum passes, maximum + 1 and minimum - 1 are refused | exit 2 |
| Flags | `FLAG_TABLE`, `POSITIONAL_NUMBERS` | one row per flag and command: a value, a switch, `--flag=value`, a missing value, an unknown flag | exit 2 |
| `OKIT_*` variables | `ENV_DOMAINS`, `ENV_OTHER` | the settings of the install scripts (maps, address, repository, names, lines, numbers); `OKIT_LANGUAGE` that is not a language is ignored by design | exit 2 before `uname` and the network, also in `install.sh` and `install.ps1` |
| `config.json` | `FILE_RULES` | JSON; a root that is not an object (`null`, a number, text, a list) is an empty configuration in every command, the telemetry commands included (`storedRootOf`; `telemetry on|off|rede` write an object over it); setup alone reads a wrong `profiles` as an unreadable file | not JSON, empty or a folder: exit 1 |
| `quota/<client>.json` | `FILE_RULES`, read by the adapters | the manual reading of a client (`remainingPct`, `windowMinutes`, `recordedAt`) | not JSON, empty or a folder: exit 1; valid JSON of another type, or a field of the wrong type, is no reading (`status` goes on and says no value is recorded) |
| `settings.json` of the client (role step) | `FILE_RULES` | the file of another program that the Claude Code role hook is merged into | not JSON: exit 1, the file untouched; another shape: kept as it is, the step says the role is unsupported |
| Session files of Codex, the source of opencode | `READ_POINTS` (exclusion) | a source of the client, not an input of the person: parsed inside a `try`/`catch` that returns no reading | never a failure of `status` (proved with a case each) |
| `package.json` of `--from` | `FILE_RULES` | a package with a name, a version and the command | exit 2 (a wrong argument) |
| `install.json` and `install.<client>.json` | `FILE_RULES`, `RECORD_FIELDS` | the record the installer wrote, every field and the records it replaced (`previous`) | not JSON: exit 1; a field of the wrong type: exit 2, naming the field and telling the person to remove the file and run `okit-plugin install` |
| `managed-path.json` | `FILE_RULES`, `PATH_STATE_SCHEMA` | the profile blocks and the Windows PATH entry the installer added | not JSON: exit 1; wrong type: exit 2, same way out |
| Saved numbers of the telemetry (`retentionDays`, `maxBytes`, `maxFileBytes`, `batchSeconds`, `kitTimeoutMs`, `rede.timeoutMs`) | `CONFIG_SCHEMA` | the same limits as `config set` | exit 2 in every telemetry command |
| Release manifest and metadata, settings of the client | `FILE_RULES` | what the release and the client program wrote | exit 1 (remote data or a file of another program that does not match is a failure of the work) |

What is read and is not in the inventory is a new demand, not a defect of the round that finds it.

<a id="section-6"></a>
## 6. Windows rules
- Build every path with `node:path`, never by concatenating separators; store them with forward slashes, the form Claude Code substitutes, so what we write matches what the client reads.
- No shell: `child_process.spawn` with an argument array. Shell-form hook commands are the client's concern, not ours.
- Write `\n` only, with an explicit encoding and no platform default, so a file written on Windows reads the same on Linux.
- `fs.mkdir` locks behave the same natively and on WSL; no `flock`, no `setsid`.
- Manual pass before a release: install the plugin, add an inbox item, delegate one step, read the critic verdict, consolidate, restart the client, confirm the state survived.

`PROCESS` mode starts the clients without a shell; on Windows the `.cmd` shims need the real executable resolved first (open item of the Windows pass).

<a id="section-7"></a>
## 7. Concurrency limit
| Scope | Default | Read from |
| :- | :- | :- |
| Default for each client | Set in configuration | `limits.global` in `config.json` |
| Client override | Replaces the default | `limits.clients.<client>`; quota does not change the cap |

There is no combined cap across clients. For example, `clients: {"claude-code": 100}`
allows that client 100 live runs regardless of `global`. Positive integers are
validated on read; unknown client names produce warnings. Legacy `perClient`
is a deprecated alias that overrides `global` with a status warning; `global`
no longer means a shared pool. Configuration is read for each check without restart.

The core counts live runs in `runs/<runId>.json` (`status: live`) rather than trusting the client to hold the cap. `acquireSlot` defaults to `waitMs: 0` and returns `ok: false` when full; callers may request a wait. `releaseSlot` ends a reservation; live counting ignores runs older than `staleMinutes` . Codex caps itself with `agents.max_concurrent_threads_per_session`; set it to the same number so the two agree.

<a id="section-8"></a>
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

<a id="section-9"></a>
## 9. Recurring templates

**Template writes / Escritas de modelos**

- `templateAdd(root, input, { now })` — Stores a template and the standing order that lets it run unattended; the name must be free.
- `templateList(root, { name })` — Creation order; one name throws when unknown.
- `templateSet(root, name, patch)` — Edits a field, pauses, resumes or renames; a rename retags the open children and revokes the old order.
- `templateRemove(root, name)` — Removes the record and revokes its standing order with a reason.

**Template evaluation / Avaliação de modelos**

- `due(root, nowMs, ctx)` — Decides every template at this instant and writes nothing.
- `plan(root, nowMs, ctx)` — The dry run: the decisions plus the demands that would be created.
- `openDue(root, nowMs, ctx)` — Opens one child per due template, once per period; the check and the write share one lock, so a second call in the same period and two racing callers create nothing more.

Required fields are `name`, `schedule` and `demand` (`title`, plus optional `kind`, `body`, `accept`, `ext`). Optional guards: `window`, `timeZone`, `minQuotaPct`, `onlyWhenIdle` (default false), `skipIfOpen` (default true), `catchup` (`run` or `skip`), `maxRunsPerPeriod`, `paused` and `appliesTo`. Every child carries `ext.template` and `ext.period` and inherits the template's `appliesTo`, so one shared template store still knows which inbox each run belongs to.

<a id="section-10"></a>
## 10. Standing orders
An order is a line the maintainer writes once and the Director reads with every demand. The JSON stays the source; `orderRender` is only a view.

**Order writes / Escritas de ordens**

- `orderAdd(root, { text, scope, until, origin, appliesTo }, { projectRoot })` — Adds an active order to the one store; `until` must be a date in the future. A `layer` is refused with `layer is gone: use appliesTo`.
- `orderRemove(root, id, { reason })` — Revokes it: `active: false` with `revokedAt` and `revokedReason`. Nothing is deleted, so the history survives. A second revoke is refused.
- `orderStatus(order, now)` — The derived status of one order: `revoked`, `expired` or `active`.
- `orderList(root, { activeOnly, appliesTo, now }, { projectRoot })` — Lists the one store. `activeOnly` drops revoked and expired orders. Every order comes back with its derived `status` and, when inactive, the `purgeAfter` date.

**Migration and retention / Migração e retenção**

- `orderMigrateProjects(root, projectRoots)` — One-time migration of the old project-side file into the store; returns `{ moved, skipped }`.
- `orderLint(root, { now })` — What a reader of the file would trip on: empty text, unknown scope, unreadable dates, a repeated id, an active order past its `until`, two live orders with the same text.
- `purgeAfter(order, retentionDays, now)` — The instant an inactive order may be purged, or `undefined` for an active one.
- `orderPurge(root, { now, retentionDays })` — Removes for good every inactive order whose retention is over, and appends `{ at, purged: [ids] }` to `logs/<date>.jsonl`.
- `orderRender(orders)` — Markdown for a human to read.

Status is computed from the row and is never written to the file, so a reader of the JSON sees only what was written:

| Status | How it is derived |
| :- | :- |
| `revoked` | `active` is not `true`: the order was revoked, and the reason is in `revokedReason`. |
| `expired` | `until` is a date that is not in the future. At the exact instant of `until` the order is already expired. |
| `active` | Anything else: never revoked and still inside its `until`. |

Revoking marks, it does not delete: the row stays with `active: false`, `revokedAt` and `revokedReason`. Re-adding the same text later makes a new order with a new id, and a second revoke of the same id is refused so the first reason survives. An inactive order is then purged for good once its retention is over, and the purge is logged: `purgeAfter` is `revokedAt` for a revoked order and `until` for an expired one, plus `orders.retentionDays`  in `config.json`; `orderPurge` removes the row from the one store only once that date has arrived, and writes `{ at, purged: [ids] }` to `logs/<date>.jsonl` so the trail of what went survives the removal. A broken `orders.retentionDays` falls back to the default instead of stopping a reader.

One store: every order lives in `orders.json` under the state root and an id is `G000001`. There is no project layer any more — a project is chosen by `appliesTo`, which names the project ids or paths the order binds, and an order without it binds every project. `orderAdd` with a `layer` is refused with `layer is gone: use appliesTo`. The one-time `orderMigrateProjects(root, projectRoots)` copies each `<projectRoot>/.okwork/orders.json` of the old layout into the store with `appliesTo` set to that project path, `origin` `migrated:project` and a fresh `G` id, keeping text, scope, `until`, `active` and the revoke fields; a row already copied is skipped (same text plus `appliesTo`), the copy happens before the old file is renamed to `orders.json.migrated` and it is never deleted. It runs lazily from `orderList`/`orderAdd` when a `projectRoot` is passed, which is the only remaining use of `projectRoot`. `scope` is `all` or `effort:simple`, `effort:normal`, `effort:hard`; `origin` is free text, defaulting to `maintainer`, and a template writes `template:<name>`. A template's order is created with its record, moved on a rename and revoked with a reason on removal, so the order that allowed a run stops allowing it.

<a id="section-11"></a>
## 11. The daemon
The daemon is the headless half: nobody watches, so every bound it respects is a technical one. The core spawns nothing itself — `spawn` is injected, so a test drives it and an adapter drives it for real.

The order of one pass, `tick`:

**Decision sequence / Sequência de decisão**

- 1 — Pause — `daemon.paused` exists: the record says `paused`, nothing is opened and nothing is spawned. The loop keeps running.
- 2 — Kill switch — `daemon.stop` exists: the record says `stopped: kill switch`, and `daemonRun` leaves the loop.
- 3 — Quota floor — Every client of the pending demands below `daemon.minQuotaPct` stops the pass. A client with no reading is not below the floor, so an unmeasured client never paralyzes the daemon.
- 4 — Retention — `orderPurge` drops from the one store every inactive order whose `orders.retentionDays` is over and appends `{ at, purged: [ids] }` to `logs/<date>.jsonl`. A paused or stopped daemon purges nothing.

**Queue and execution / Fila e execução**

- 5 — Due templates — `openDue` with the worst reading of the pass: the lowest quota and the least idle of the clients it knows.
- 6 — Pending demands, oldest first — The inbox lists newest first, so the queue is reversed and a demand waiting behind newer ones never starves. A period serves one run at a time: while a sibling of the same `ext.template` and `ext.period` is still `delegated` or `criticised`, the others wait.
- 7 — Cap — Per demand: `classify` when the item has no `effort`, `profilePick`, then `acquireSlot` before the spawner runs and `releaseSlot` if it refuses, so a refusal costs nothing.
- 8 — One decision line — `{ at, opened, spawned, skipped, purged, stopped?, paused? }` appended as a single JSON line to `logs/<date>.jsonl`, so a reader tailing the file always sees a whole pass.

The daemon never refuses a demand on its own: a demand is skipped only for a technical bound (paused, kill switch, quota floor, the concurrency cap) or a spawner failure, and every skip says which.

| Function | Effect |
| :- | :- |
| `tick(root, deps)` | One pass; returns the decision record and appends it. |
| `daemonRun(root, deps, { signal, sleep })` | The loop: takes the daemon lock, writes `daemon.pid.json`, ticks every `daemon.intervalSeconds`, rotates the logs once a day, leaves on the kill switch or on `signal.abort()`, and removes the pid file on the way out. |
| `daemonStatus(root, { now })` | Whether it is running, its pid, when it started, whether it is paused and the last decision record. |
| `daemonPause(root)` / `daemonResume(root)` | Write and remove the pause file. |
| `rotateLogs(root, keepDays, now)` | Removes `logs/*.jsonl` older than `daemon.logKeepDays` by modification time and returns the names it removed. |

The spawner is injected: `deps` carries `now()`, `quota(client)`, `idle(client)` and `spawn(demand, { client, profile, limits, maxTurns, maxMinutes, runId })`. The `runId` it is given is the slot already reserved for the run, so returning the same id is the cheap path; returning another one moves the slot to that id, and when that id cannot be taken the original is taken again.

Pacing: a monotonic clock keeps the interval steady when the wall clock changes. One daemon per root holds the `daemon` lock. `daemonStatus` requires a live pid and a recent record. `daemon.intervalSeconds`, `daemon.minQuotaPct` and `daemon.logKeepDays` control pacing, quota floor and log retention; `orders.retentionDays` controls inactive-order retention. Invalid values use configured defaults.

<a id="section-12"></a>
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

See the reference: [mcp-tools](../components/mcp-tools.md).

Methods: `initialize`, `notifications/initialized`, `ping`, `tools/list` and `tools/call`. Every tool answers `{content: [{type: 'text', text}], isError}` where `text` is the JSON of what the core returned, so a refusal (`ok: false`, a full cap) and a result read the same way. An unknown method is `-32601`, an unknown tool `-32602`, a line that is not JSON `-32700` with a null id; in every case the loop keeps reading.

<a id="section-13"></a>
## 13. Autonomy
Maximum autonomy is the default. The plugin ships no hard-coded list of forbidden actions: a refusal comes from something the user wrote or from a technical bound, never from a rule the maintainers guessed.
- Restrictions are standing orders. The user adds one ("never push to `main`") and `orderRemove` takes it back; nothing else can add a restriction.
- The technical bounds stay configurable: the concurrency cap (`limits.global`, `limits.clients`, `staleMinutes`), the quota floor (`daemon.minQuotaPct`, `lowQuotaPct`), the kill switch (`daemon.stop`) and the pause file.
- The core never invents a model, an effort value or a quota number the client did not report, and it never widens a cap on its own.

<a id="section-14"></a>
## 14. Global state and `appliesTo`
One inbox, one set of standing orders, one template store, in one folder (`OKWORK_HOME`, default `~/.okwork`), shared by every project. What belongs to a project lives in that project's own files and the record only references it, so a shared store never has to be split.

| Function | Effect |
| :- | :- |
| `validateAppliesTo(value)` | Trims and deduplicates, keeps the shape given, and never stores the default: a record without the field applies everywhere. |
| `validateAppliesToFilter(value)` | The filter of a list: one project, or the shared records alone. A list of projects is refused, since the union would be ambiguous. |
| `inScope(record, wanted)` | Whether a record shows for a project. |
| `stateRoot(env)` / `paths(root)` | Where the state lives, the environment override first. |

So: absent means every project, one name means that project, a list means each of them, and `global` combined with another project is refused because it says nothing precise. `inboxList`, `orderList` and `templateList` filter by project and always include the shared records; `templateSet` with `appliesTo: 'global'` drops the field, so a template goes back to shared.

<a id="section-15"></a>
## 15. Implementation and limits

The three adapters, JSON state, daemon, schedules, installer, release tooling and MCP server are implemented. The real `client-smoke` driver supports Claude Code; other drivers and Windows/macOS proof remain pending. See [RELEASING.md](RELEASING.md#proof-per-pair).

<a id="kit-and-plugin-overlap-d1"></a>

### Kit and plugin overlap

The orchestration kit and this client plugin can coexist. The plugin owns its
client adapters, MCP tools and state under `OKWORK_HOME`; installing or updating
the plugin does not install, update or migrate the kit. Keep each tool's
configuration with that tool and select the intended executable explicitly if
their command names overlap on PATH (`install.kit.path` selects the kit probe).
Avoid running both orchestrators on the same demand at the same time: their
queues and concurrency limits are independent.

`okit-plugin kit`, install/update summaries and status use a read-only, injected
detector. Only the configured version command runs, with a bounded deadline.
The detector reports executable path and reported version; it does not guess
kit home/configuration folders or detect this plugin from inside the kit.

<a id="section-16"></a>
## Operational reference

See the reference: [cli](../components/cli.md).

See the reference: [configuration](../components/configuration.md).

See the reference: [hooks](../components/hooks.md).

### Development — Desenvolvimento

Every Markdown page under `docs/` and both root READMEs place an area banner immediately after the H1, with localized alt text naming `okit-plugin`. Edit titles, icons and light/dark colour tokens in `docs/images/banners/banners.config.json`, run `node scripts/docs-banners.js`, and verify with `node scripts/docs-banners.js --check`; keep history newest first and avoid stray blank lines.

Run `node --test test/docs-consistency.test.js` for documentation checks and
`node --test` for the complete suite. Release commands are documented in the
release guide below.

Interactive installer tests count status bar consent separately from other
questions and decline the initial setup offer when testing `--no-statusline`.

Quota tests inject a temporary HOME/USERPROFILE and `CODEX_SESSIONS_DIR` (or a
quota reader); they must never discover sessions in the machine's real home.

Pull requests are welcome. Please read [CONTRIBUTING.md](../../CONTRIBUTING.md) first.

Security reports are not public issues, see [SECURITY.md](../../SECURITY.md).
The design notes live in [docs/maintainers/DESIGN.md](DESIGN.md).
The release design is in [docs/maintainers/RELEASING.md](RELEASING.md)
([Português](RELEASING.pt-BR.md)).
