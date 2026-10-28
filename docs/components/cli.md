# CLI

![okit-plugin: Components](../images/banners/components.svg)

Use okit-plugin in the terminal to inspect and control the plugin.

`--locale` is optional everywhere it is offered. It uses `language` (default: `en`); set Portuguese once with `okit-plugin config set language pt-BR`. An explicit `--locale en` or `--locale pt-BR` overrides the saved choice for one command.

<a id="commands"></a>
## Commands

Each row shows a command and example; replace <id> with the identifier returned by the inbox. --help shows options; installation can change the command name through install.command.

| Command | Purpose | Example |
| :- | :- | :- |
| `okit-plugin install` | Install payload and register client | `okit-plugin install --client codex --dry-run` |
| `okit-plugin update` | Check, replace or roll back recorded installation | `okit-plugin update --client codex --check` |
| `okit-plugin uninstall` | Remove recorded installation; keep state by default | `okit-plugin uninstall --client codex --dry-run` |
| `okit-plugin setup` | Propose models and save after confirmation | `okit-plugin setup` |
| `okit-plugin env report` | Inspect client, models, allowance, folders and remedies | `okit-plugin env report` |
| `okit-plugin actors` | Inspect available model/effort choices | `okit-plugin actors --all --json` |
| `okit-plugin status` | Inspect allowance and free slots | `okit-plugin status --all` |
| `okit-plugin config show` | Show effective settings, origin and effect | `okit-plugin config show` |
| `okit-plugin config get` | Read one setting | `okit-plugin config get limits.global` |
| `okit-plugin config set` | Validate and save one supported setting | `okit-plugin config set limits.global 3` |
| `okit-plugin config unset` | Remove override and restore default | `okit-plugin config unset limits.global` |
| `okit-plugin quota show` | Inspect automatic/manual quota and sample age | `okit-plugin quota show codex` |
| `okit-plugin quota set` | Record user-reported remaining percentage | `okit-plugin quota set codex 60` |
| `okit-plugin inbox list` | List work and ownership | `okit-plugin inbox list` |
| `okit-plugin inbox take` | Claim work; human takeover needs confirmation | `okit-plugin inbox take <id> --client codex` |
| `okit-plugin inbox release` | Release owned or stale work | `okit-plugin inbox release <id> --client codex` |
| `okit-plugin todo sync` | Synchronize configured project task lists | `okit-plugin todo sync --dry-run --project /projects/example` |
| `okit-plugin todo check` | List work without tasks and tasks without work | `okit-plugin todo check --project /projects/example` |
| `okit-plugin kit` | Detect orchestration-kit without installing it | `okit-plugin kit --require` |
| `okit-plugin daemon start` | Run daemon loop in foreground | `okit-plugin daemon start` |
| `okit-plugin daemon stop` | Request termination through stop file | `okit-plugin daemon stop` |
| `okit-plugin daemon status` | Show PID, pause state and last pass | `okit-plugin daemon status --table` |
| `okit-plugin daemon pause` | Pause new work while keeping loop alive | `okit-plugin daemon pause` |
| `okit-plugin daemon resume` | Remove pause marker | `okit-plugin daemon resume` |
| `okit-plugin daemon run-once` | Process one pass and return decisions | `okit-plugin daemon run-once` |
| `okit-plugin autostart show` | Inspect platform startup plan | `okit-plugin autostart show --kind systemd` |
| `okit-plugin autostart install` | Apply startup plan | `okit-plugin autostart install --kind systemd` |
| `okit-plugin autostart uninstall` | Remove startup registration | `okit-plugin autostart uninstall --kind systemd` |
| `okit-plugin hook session-start` | Return native role context from JSON stdin | `okit-plugin hook session-start` |
| `okit-plugin hook post-compact` | Return bounded restoration summary from JSON stdin | `okit-plugin hook post-compact` |
| `okit-plugin statusline-collector` | Collect JSON stdin quota and chain prior bar | `okit-plugin statusline-collector` |
| `okit-plugin smoke` | Run isolated offline checks in scratch state | `okit-plugin smoke` |
| `okit-plugin client-smoke` | Run real-client scenario or offline preview/rehearsal | `okit-plugin client-smoke --client claude-code --dry-run` |
| `okit-plugin smoke-demo` | Preview practice; with --confirm and the preview hash it runs the real client and spends allowance within the displayed ceilings | `okit-plugin smoke-demo --dry-run --json` |
| `okit-plugin telemetry` | Optional usage measurements | `okit-plugin telemetry status` |
| `okit-plugin trajectory` | Read or enable local run recordings | `okit-plugin trajectory status` |

Use `okit-plugin telemetry status`, `okit-plugin telemetry on`, `okit-plugin telemetry off`, `okit-plugin telemetry rede on` / `okit-plugin telemetry rede off`, `okit-plugin telemetry export [--since ISO]` and `okit-plugin telemetry check`. Recording and sending require separate choices.

Use `okit-plugin trajectory list`, `okit-plugin trajectory show <run>`, `okit-plugin trajectory export <run>`, `okit-plugin trajectory prune`, `okit-plugin trajectory on`, `okit-plugin trajectory off` and `okit-plugin trajectory status`. Choose a saved run from list. Export prints JSON locally; nothing is sent. See [recordings](state.md#trajectories).

<a id="effects"></a>
## Effects and results

Queries do not launch models. Setup/config/quota/inbox write state when requested; install/update/uninstall and autostart change managed files and registration. The daemon can launch processes and spend allowance. Hooks consume client JSON; see input examples in [hooks](hooks.md).
Exit 0 indicates success; 1 indicates failure; invalid usage normally returns 2. Smoke may report skipped checks: read the report. A demonstration preview spends no allowance and paid execution currently refuses without enforceable measurement/ceilings. Reserve smoke --real for an authorized client test.

[Overview](README.md) · [Daemon](daemon.md) · [Português](cli.pt-BR.md)
