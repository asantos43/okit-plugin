# CLI

![okit-plugin: Components](../images/banners/components.svg)

People use terminal commands to install, maintain and diagnose the plugin and manage accounts.

`--locale` is optional wherever offered. It uses `language` (default: `en`); ask the assistant to call `config_set` with `key: "language"` and `value: "pt-BR"` to save Portuguese. An explicit `--locale en` or `--locale pt-BR` overrides the saved choice for one command.

<a id="commands"></a>
## Commands

`--help` shows options; installation can change the command name through `install.command`.

For Claude Code, `install` offers the optional panel after success; `--no-panel` skips the question and hint. Enable it later with `okit-plugin install --panel` (isolated mode; cannot combine with `--no-panel`). `update` accepts `--no-panel` and only refreshes panels already installed, without asking.

| Command | Purpose | Example |
| :- | :- | :- |
| `okit-plugin install` | Install payload and register client | `okit-plugin install --client codex --dry-run` |
| `okit-plugin update` | Check, replace or roll back recorded installation | `okit-plugin update --client codex --check` |
| `okit-plugin uninstall` | Remove recorded installation; keep state by default | `okit-plugin uninstall --client codex --dry-run` |
| `okit-plugin setup` | Propose models and save after confirmation | `okit-plugin setup --again` |
| `okit-plugin doctor` | Diagnose the installation; read only, with a fix per failure | `okit-plugin doctor --client codex` |
| `okit-plugin config ui` | Start a local configuration session | `okit-plugin config ui --no-open` |
| `okit-plugin account` | Add, list, remove or rename accounts; login stays manual | `okit-plugin account list codex --json` |
| `okit-plugin panel-state` | Read one client's versioned state; see [schema](state.md#panel-state) | `okit-plugin panel-state --json --client claude` |

See [accounts](../guide/accounts.md) for `add`, `list`, `remove`, `rename` and collector registration. Account changes save configuration; add creates the folder. Remove preserves the folder and login.

Install/update offers model setup only for the selected clients. Each client has one numbered model list and three class questions with current defaults; a single option is shown in the confirmation table. Standalone `setup` keeps all detected clients. The final Next group shows “Run this now:” and the activation command for the profile containing the PATH block, or asks you to open a new terminal.

## Internal entry points

The person does not run these: they are absent from `--help`. The client starts the collector and the hooks (see [hooks](hooks.md)); the autostart unit, the installer and the offline smoke checks start the daemon entries (see [daemon](daemon.md)).

| Command | Started by | Example |
| :- | :- | :- |
| `okit-plugin statusline-collector` | The client's status bar | `okit-plugin statusline-collector` |
| `okit-plugin hook session-start` | The client, at the start of a session | `okit-plugin hook session-start` |
| `okit-plugin hook post-compact` | The client, after a compaction | `okit-plugin hook post-compact` |
| `okit-plugin daemon start` | The autostart unit and the installer: the loop | `okit-plugin daemon start` |
| `okit-plugin daemon stop` | The installer | `okit-plugin daemon stop` |
| `okit-plugin daemon run-once` | The offline smoke checks | `okit-plugin daemon run-once` |

Everything else is asked of the assistant, which uses the [MCP tools](mcp-tools.md).

<a id="effects"></a>
## Effects and results

Install/update/uninstall change managed files and registration; setup saves configuration after confirmation. Doctor reads only: it takes its snapshot with `record: false`, so it writes no file and no telemetry event. The daemon can launch processes and spend allowance.
The local config server provides authenticated `/api/install/{plan,apply,job,answer,cancel}` routes (polling; no wizard screens yet). Plans expire after ten minutes; Apply requires consent, unchanged fingerprints and an idempotency key. A per-root process lock refuses concurrent installers. Restart requires review. Cancel/close/idle expiry finish the current safe step, preserve completed changes and release the lock; tab unload only detaches. Unresolved observations block Apply; setup, panel and execution-policy follow-ups remain deferred.
Install/update `--dry-run` renders the shared JSON plan without writes, client launches or package/checksum downloads; kit detection remains read-only. Remote payload trees have checksum pending until apply; local sources are hashed. The plan includes mutation paths, redacted diffs, argv and input fingerprints; unresolved observations prevent consent. Setup/panel proposals retain terminal consent. Setup proposals suppress measurements even when enabled; initialization still records observations.
Doctor ends with `Ready to launch executors: yes` or `no; gaps: …`. Ready means every size class (S, M, L) has an actor that can launch on an installed client; clients that are not installed are optional. Rows: models confirmed and quota recorded per installed client, the status bar collector (with the command to enable it) and the optional kit.
Exit 0 indicates success; 1 indicates failure; invalid usage normally returns 2.
Offline smoke checks are internal test code: tests and update run them; maintainers use `npm run smoke` (`scripts/smoke.js`).

[Overview](README.md) · [Daemon](daemon.md) · [Português](cli.pt-BR.md)
