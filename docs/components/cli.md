# CLI

![okit-plugin: Components](../images/banners/components.svg)

People use terminal commands to install, maintain and diagnose the plugin and manage accounts.

`--locale` is optional wherever offered. It uses `language` (default: `en`); ask the assistant to call `config_set` with `key: "language"` and `value: "pt-BR"` to save Portuguese. An explicit `--locale en` or `--locale pt-BR` overrides the saved choice for one command.

<a id="commands"></a>
## Commands

`--help` shows options; installation can change the command name through `install.command`.

| Command | Purpose | Example |
| :- | :- | :- |
| `okit-plugin install` | Install payload and register client | `okit-plugin install --client codex --dry-run` |
| `okit-plugin update` | Check, replace or roll back recorded installation | `okit-plugin update --client codex --check` |
| `okit-plugin uninstall` | Remove recorded installation; keep state by default | `okit-plugin uninstall --client codex --dry-run` |
| `okit-plugin setup` | Propose models and save after confirmation | `okit-plugin setup --again` |
| `okit-plugin doctor` | Diagnose the installation; read only, with a fix per failure | `okit-plugin doctor --client codex` |
| `okit-plugin account` | Add, list, remove or rename accounts; login stays manual | `okit-plugin account list codex --json` |

See [accounts](../guide/accounts.md) for `add`, `list`, `remove`, `rename` and collector registration. Account changes save configuration; add creates the folder. Remove preserves the folder and login.

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
Doctor ends with `Ready to launch executors: yes` or `no; gaps: …`. Ready means every size class (S, M, L) has an actor that can launch on an installed client; clients that are not installed are optional. Rows: models confirmed and quota recorded per installed client, the status bar collector (with the command to enable it) and the optional kit.
Exit 0 indicates success; 1 indicates failure; invalid usage normally returns 2.
Offline smoke checks are internal test code: tests and update run them; maintainers use `npm run smoke` (`scripts/smoke.js`).

[Overview](README.md) · [Daemon](daemon.md) · [Português](cli.pt-BR.md)
