# okit-plugin

Migration: use `okit-plugin` for the plugin; `okit`/`kit` belong to the orchestration kit. Install/update replace only legacy plugin links; unrelated kit commands and 0.2.0 records are preserved. See [installation](INSTALL.md).

A plugin for AI clients (Claude Code, Codex, opencode) that helps a Director
spread demands over the client’s own subagents. Node.js >=20, zero dependencies,
with JSON state.

## Install — Instalar

Use the release's [install.sh](install.sh) on Linux/macOS or
[install.ps1](install.ps1) in Windows PowerShell. Read the scripts and follow
[INSTALL.md](INSTALL.md) for prerequisites, flags, verified downloads and updates.
Use `okit-plugin update --check`, `okit-plugin update` or `okit-plugin update --rollback` afterwards.

Install/update make the command available to new shells through an existing writable PATH candidate or managed shell profiles (Windows: user PATH). Restart the AI client after updating PATH. `--no-path` skips PATH edits; uninstall removes only the installer-owned addition. Configuration and fallback instructions: [INSTALL](INSTALL.md).

If the current terminal's PATH lacks the bin directory, install/update and `okit-plugin status` print a bilingual hint with a manual command from `install.path.activate`: `. '<profile>'` for bash/zsh, `source '<profile>'` for fish, or `$env:Path = '<bin>' + ';' + $env:Path` for PowerShell/Windows. Run the printed command yourself or open a new terminal; unknown shells or missing managed profiles get the new-terminal hint. The hint disappears once bin is in PATH.
The release matrix has nine client × system pairs; availability of an archive
does not prove real-client operation. See [proof per pair](docs/RELEASING.md#proof-per-pair).
Each payload includes all runtime adapters by default (`release.sharedAdapters: null`
inherits `release.adapters`), plus the selected client's installation metadata.

## Usage — Uso

```text
okit-plugin install [--from <dir>] [--client <c>] [--prerelease] [--repo <o/r>] [--dest <dir>] [--no-link] [--no-path] [--autostart] [--dry-run] [--yes]
okit-plugin update [--check] [--rollback] [--dry-run] [--no-path]
okit-plugin uninstall [--purge] [--yes] [--dry-run]
okit-plugin setup [--defaults] [--again]
okit-plugin daemon start|stop|status|pause|resume|run-once
okit-plugin daemon status [--table [--locale en|pt-BR]]
okit-plugin autostart install|uninstall|show [--kind systemd|cron|launchd|schtasks]
okit-plugin status [--locale en|pt-BR]
okit-plugin env report [--client <name>] [--locale en|pt-BR]
okit-plugin actors [--client <name>|--all] [--json] [--locale en|pt-BR]
okit-plugin config show
okit-plugin config get <key>
okit-plugin config set <key> <value>
okit-plugin config unset <key>
okit-plugin kit [--require]
okit-plugin hook post-compact
okit-plugin smoke [--real] [--keep] [--only <ids>] [--timeout <ms>]
okit-plugin client-smoke [--client claude-code] [--headless|--demo|--dry-run|--rehearsal]
  [--only <C ids>] [--keep] [--allow-unknown-quota]
  [--max-usd [n]] [--max-turns [n]] [--max-minutes [n]] [--quota-floor [pct]] [--timeout [ms]]
```

`okit-plugin kit` prints one English line: installed (path and version), absent (installation
hint), or broken. It only runs the configured version command. `--require` exits 1
unless installed; otherwise the check is informational. Install/update summaries
(including dry-run) and `okit-plugin status` include a `kit: …` line. When both tools are
present, it links to the [D1 overlap rules](docs/ARCHITECTURE.md#kit-and-plugin-overlap-d1).
See [kit configuration](INSTALL.md#orchestration-kit).

The stdio MCP server exposes 16 tools: `acquire_slot`, `release_slot`,
`limits_status`, `status`, `actors_list`, `env_report`, `classify`, `profile_pick`, `inbox_add`, `inbox_list`,
`inbox_set_status`, `inbox_claim`, `inbox_release`, `order_add`, `order_list`, `order_remove`.

An **actor** is a configured model + effort pair available in a client. Ask “which actors/executors can run?” with `actors` or MCP `actors_list` before sizing and choosing. It lists profiles even when no executors are running; status/slots is the view of running executors. Selection follows status: detected client by default, `--all` for configured clients (all three if empty), `--client` overrides both. JSON includes actors, quota, free slots, launch reasons/remedies and missing-size alternatives.

`actors.sizeClasses` in `DEFAULT_CONFIG` maps S→simple, M→normal, L→hard; configure this named map to change sizes. `actors.criticClass` names the separate critic role. Identical model + effort pairs combine sizes. The nearest available size is suggested for a missing size; quota below the floor or occupied slots explain the remedy. Unknown quota does not block. The table shows the quota state, lowest remaining percentage and reading age; `status` shows the command to record a quota. Use `okit-plugin config set profiles.<client>.<class>.model <value>` to change the model for a client and work class.

Model detection considers only active models as candidates: being listed is not enough to propose a profile. A replacement comes from the same family: the same provider, with `setup.detect.<client>.family.separator` dividing the provider from the name and `family.minimumPrefix` the length the common prefix must reach. A name that does not contain the separator has no provider and is compared whole, so the separator must be the one the client uses in its names (`/` for `provider/model`); a separator that appears in no name leaves every name without a provider. A separator that is empty, or that is not text, turns the automatic replacement off: a configured model that is active still stays (`source: 'listing'`), and a class whose configured model is not active is omitted with `okit-plugin config set profiles.<client>.<class>.model <value>`. A client that answers with no active model proposes nothing and asks for a manual choice with `okit-plugin config set profiles.<client>.<class>.model <value>`.

### Setup

`okit-plugin setup` detects installed clients, shows the model it will use for each work class, and explains why. It asks only when no active model fits; Enter accepts the recommended model, and an invalid answer is asked again up to `setup.maxAttempts` times. All questions share one input session, so no answer is lost; end of input cancels without writing, and an input that had already ended cancels the same way. A client or class name outside the configuration schema is refused before the file changes. A configuration file that cannot be read, or whose root is not an object, is refused with one plain sentence in both languages: nothing is written and the file stays as it is. A `profiles` that is not an object, or a client inside it that is not an object, is refused the same way. When no client with an active model is found, the setup says so with one plain sentence in both languages, writes nothing, and the configuration stays pending. `--defaults` asks nothing, accepts detected choices, and leaves unmatched classes unchanged so you can select them later with `okit-plugin config set profiles.<client>.<class>.model <value>`. The result is recorded in `config.json`; running setup again keeps active settings, while `--again` repeats the setup.

While the setup was not done, `okit-plugin status` shows one line naming the missing step, the end of an install or an update offers the setup, and the `okit-setup` skill conducts the same setup in a conversation. The skill lets the setup ask for every model choice and saves the complete set once, only after its final confirmation.

`okit-plugin inbox list [--locale en|pt-BR]` and MCP `inbox_list` show each holder.
`okit-plugin inbox take <id> --client codex --session <s> --worktree <path>` claims atomically;
another active client/session is refused. `okit-plugin inbox release <id> --client codex --session <s>` releases it.
Only the human CLI allows `okit-plugin inbox take <id> --producer-takeover [--client <c>] [--yes]`:
it shows the owner, session, worktree, timestamp, staleness and uncommitted Git changes before
TTY confirmation (or `--yes`). Transfer preserves `heldBefore` with reason `producer takeover`.
`inbox.holdStaleMinutes` defaults to 120 (integer >= 1); stale claims/releases record `stale`.
`inbox.gitTimeoutMs` defaults to 5000 (integer >= 1). Terminal statuses clear ownership.
The Director, Executor, Critic, Smoke, Setup and Environment skills guide delegation, verification and configuration.

Ask “where are you?”, “what do you have here?” or “which environment?” to use the installed `okit-environment` skill. It runs `okit-plugin env report` (or MCP `env_report`) and explains the client in use, installed clients, confirmed active models, quota, free slots and folders. Each missing item includes its repair command; unconfirmed readings stay unknown. Choose one client with `--client` and a language with `--locale en|pt-BR`. MCP accepts optional `client` and `locale` and returns the same report object plus its formatted `text`.
`smoke` runs 31 isolated checks; `client-smoke` has 23 scenario checks and its
real driver supports Claude Code. Dry-run and rehearsal are offline walks.
See [SMOKE.md](docs/SMOKE.md) for budgets and evidence requirements.

## Configuration — Configuração

State defaults to `~/.okwork`; `OKWORK_HOME` overrides it. Manage editable
settings with `okit-plugin config`; there is no need to edit `config.json` by
hand. Defaults in [src/profiles.js](src/profiles.js) include `lowQuotaPct: 15`,
`limits: {global: 3, clients: {}}`, `staleMinutes: 30`, and the default
profile catalog.

`okit-plugin config show` lists every editable key with its effective value,
its origin (`default` or `user`) and a plain explanation of its effect.
`okit-plugin config get <key>` shows one effective value and origin.
`okit-plugin config set <key> <value>` validates the type, range and known
client or class, then atomically changes only that key while preserving the
rest of the file. It prints the previous and new values. An invalid value or
unknown key is refused without a write. Client and class names in dotted paths
may contain only letters, digits, `-` or `_`; `__proto__`, `constructor` and
`prototype` are reserved and refused. `okit-plugin config unset <key>` returns
the key to its default, and the groups the removal leaves empty are removed
too, so the file reads the same as it read before the value was set.

Set `limits.global` and `limits.clients.<client>` with the command; for
example, `okit-plugin config set limits.global 3` and
`okit-plugin config set limits.clients.claude-code 100`. A client's own cap
replaces the default; clients without an entry each use `global`. There is no
shared total cap.
Positive integers are required; invalid values fail configuration reads, and
unknown client names warn in status. Legacy `perClient` overrides `global`
as a deprecated alias, with a status warning. The command removes that legacy
alias from the user configuration when it writes or unsets `limits.global`.
The old total meaning of `global` is removed. Checks re-read configuration
without restart; status shows live/cap, available slots and whether the cap is
from the client or the default.
The status table ends with one fixed, localized sentence: slots are running
executors, and `actors` lists the available model + effort profiles.
The default catalog gives every client (`claude-code`, `codex`, `opencode`) a
profile per class (`simple`, `normal`, `hard`), each with `model`, `effort`
(`low`, `medium`, `high`) and `maxTurns` (`20`, `40`, `80`), so a clean
install answers `profile_pick` and `actors_list` for every client and class
without a `profiles` entry. Change one profile field with
`okit-plugin config set profiles.<client>.<class>.model|effort|maxTurns <value>`;
your value replaces the class it names, class by class, and the other classes
keep the default. A client outside the catalog has no profile: `profile_pick`
answers with a short bilingual error naming the known clients. To update the
catalog itself, edit `DEFAULT_CONFIG.profiles` in
[src/profiles.js](src/profiles.js).
A class set to `null` is disabled: `okit-plugin config set profiles.<client>.<class> null`
turns it off, `okit-plugin config unset profiles.<client>.<class>` turns it back
on and a `set` of a field under a disabled class is refused without a write; an
empty client group (`{}`) is the absence of a client, not a subscription of one.
All adapters read user quota from `quota/<client>.json`.
Record the remaining percentage shown in the client's `/usage` with
`okit-plugin quota set claude-code 80 [--window-minutes n]`; the clients are the ones
the root configures (`claude-code`, `codex` and `opencode` when it configures none),
and percentages must be numeric, from 0 to 100.
Use `okit-plugin quota show [client]` to inspect records. The command atomically
stores `remainingPct`, optional `windowMinutes` and `recordedAt` under `OKWORK_HOME`.
Smoke warns after `smoke.quotaMaxAgeMinutes` (default 30) and treats the record
as unknown after `smoke.quotaExpireMinutes` (default 120). Both are configurable
in `config.json`; records without `recordedAt` remain valid. On `quota-unknown`,
provide a fresh reading and retry; use `--allow-unknown-quota` only on explicit request.
`postCompact` defaults to enabled, `timeoutSec: 5`, `maxLines: 20`, all sections
enabled. `smoke` defaults: `quotaFloorPct: 20`, `maxUsd: 1`, `maxTurns: null`
(full scenario), `maxMinutes: 15`, `checkTimeoutMs: 60000`.

## Uninstall — Desinstalar

Run `okit-plugin uninstall --dry-run` to review, then `okit-plugin uninstall` to stop the
daemon, unregister the client and remove recorded versions and the command link.
State/configuration remain; `okit-plugin uninstall --purge --yes` removes the state root.
Use the installation destination and state root from the installation record.
These are documentation steps; there is no separate uninstall script.

## Development — Desenvolvimento

Run `node --test test/docs-consistency.test.js` for documentation checks and
`node --test` for the complete suite. Release commands are documented in the
release guide below.

Pull requests are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) first.

Security reports are not public issues, see [SECURITY.md](SECURITY.md).
The design notes live in [docs/DESIGN.md](docs/DESIGN.md).
The release design is in [docs/RELEASING.md](docs/RELEASING.md)
([Português](docs/RELEASING.pt-BR.md)).

## License — Licença

MIT. See [LICENSE](LICENSE).

Portuguese version of this file: [README.pt-BR.md](README.pt-BR.md).
