# okit-plugin

A plugin for AI clients (Claude Code, Codex, opencode) that helps a Director
spread demands over the client’s own subagents. Node.js >=20, zero dependencies,
with JSON state.

## Install — Instalar

Use the release's [install.sh](install.sh) on Linux/macOS or
[install.ps1](install.ps1) in Windows PowerShell. Read the scripts and follow
[INSTALL.md](INSTALL.md) for prerequisites, flags, verified downloads and updates.
Use `okit update --check`, `okit update` or `okit update --rollback` afterwards.
The release matrix has nine client × system pairs; availability of an archive
does not prove real-client operation. See [proof per pair](docs/RELEASING.md#proof-per-pair).

## Usage — Uso

```text
okit install [--from <dir>] [--client <c>] [--prerelease] [--repo <o/r>] [--dest <dir>] [--no-link] [--autostart] [--dry-run] [--yes]
okit update [--check] [--rollback] [--dry-run]
okit uninstall [--purge] [--yes] [--dry-run]
okit daemon start|stop|status|pause|resume|run-once
okit daemon status [--table [--locale en|pt-BR]]
okit autostart install|uninstall|show [--kind systemd|cron|launchd|schtasks]
okit status [--locale en|pt-BR]
okit hook post-compact
okit smoke [--real] [--keep] [--only <ids>] [--timeout <ms>]
okit client-smoke [--client claude-code] [--headless|--demo|--dry-run|--rehearsal]
  [--only <C ids>] [--keep] [--allow-unknown-quota]
  [--max-usd [n]] [--max-turns [n]] [--max-minutes [n]] [--quota-floor [pct]] [--timeout [ms]]
```

The stdio MCP server exposes 14 tools: `acquire_slot`, `release_slot`,
`limits_status`, `status`, `classify`, `profile_pick`, `inbox_add`, `inbox_list`,
`inbox_set_status`, `inbox_claim`, `inbox_release`, `order_add`, `order_list`, `order_remove`.

`okit inbox list [--locale en|pt-BR]` and MCP `inbox_list` show each holder.
`okit inbox take <id> --client codex --session <s> --worktree <path>` claims atomically;
another active client/session is refused. `okit inbox release <id> --client codex --session <s>` releases it.
Only the human CLI allows `okit inbox take <id> --producer-takeover [--client <c>] [--yes]`:
it shows the owner, session, worktree, timestamp, staleness and uncommitted Git changes before
TTY confirmation (or `--yes`). Transfer preserves `heldBefore` with reason `producer takeover`.
`inbox.holdStaleMinutes` defaults to 120 (integer >= 1); stale claims/releases record `stale`.
`inbox.gitTimeoutMs` defaults to 5000 (integer >= 1). Terminal statuses clear ownership.
The Director, Executor, Critic and Smoke skills guide delegation and verification.
`smoke` runs 31 isolated checks; `client-smoke` has 23 scenario checks and its
real driver supports Claude Code. Dry-run and rehearsal are offline walks.
See [SMOKE.md](docs/SMOKE.md) for budgets and evidence requirements.

## Configuration — Configuração

State defaults to `~/.okwork`; `OKWORK_HOME` overrides it. Edit `config.json`
there. Defaults in [src/profiles.js](src/profiles.js) include `lowQuotaPct: 15`,
`limits: {global: 3, clients: {}}`, `staleMinutes: 30`, and empty `profiles`.
Set `limits.global` and `limits.clients.<client>` in that file; there is no
configuration command. For example, `"limits": {"global": 3, "clients":
{"claude-code": 100, "codex": 2}}`. A client's own cap replaces the default;
clients without an entry each use `global`. There is no shared total cap.
Positive integers are required; invalid values fail configuration reads, and
unknown client names warn in status. Legacy `perClient` overrides `global`
as a deprecated alias, with a status warning. The old total meaning of `global`
is removed. Checks re-read configuration without restart; status shows live/cap,
available slots and whether the cap is from the client or the default.
Set `profiles.<client>.simple|normal|hard` with `model`, `effort`, `maxTurns`;
no default model is supplied. All adapters read user quota from `quota/<client>.json`.
`postCompact` defaults to enabled, `timeoutSec: 5`, `maxLines: 20`, all sections
enabled. `smoke` defaults: `quotaFloorPct: 20`, `maxUsd: 1`, `maxTurns: null`
(full scenario), `maxMinutes: 15`, `checkTimeoutMs: 60000`.

## Uninstall — Desinstalar

Run `okit uninstall --dry-run` to review, then `okit uninstall` to stop the
daemon, unregister the client and remove recorded versions and the command link.
State/configuration remain; `okit uninstall --purge --yes` removes the state root.
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
