# State on disk

![okit-plugin: Components](../images/banners/components.svg)

The plugin stores configuration, work and observations in the person's state directory.

<a id="root"></a>
## Root and files

The default root is ~/.okwork; OKWORK_HOME replaces the entire directory (it does not append .okwork). Relative paths below start at this root unless stated otherwise. Installation payloads use a separate directory.

| Path | Contents |
| :- | :- |
| `config.json` | Overrides of defaults, profiles and completed-setup record |
| `project.json` | Project name/path used in references |
| `inbox.json` | Version, sequence and work items, status, ownership/history and metadata |
| `orders.json` | Global/project instructions, expiry, revocation and history until retention |
| `templates.json` | Recurring demands, schedules, rules and last run |
| `quota/<client>.json` | Remaining percentage, source, timestamp and known windows; readers choose between automatic and manual; valid JSON of another type is no reading, a file that is not JSON makes `status` fail (exit 1) |
| `runs/<runId>.json` | Slot status, client and start/end times; process launches also record PID and outcome |
| `runs/<runId>.out` | Process launcher stdout/stderr when no other log directory is supplied |
| `locks/config.lock/owner.json`, `inbox.json.lock/owner.json`, `orders.json.lock/owner.json`, `templates.json.lock/owner.json`, `runs.lock/owner.json` | Writer lock owner, PID and timestamp; temporary claim files coordinate recovery |
| `control/<pid>.json`, `control/<pid>.sock` | Record and socket of the [control API](control-api.md) of a running MCP server; private to the user |
| `daemon.lock/owner.json` | Exclusive daemon loop lock |
| `daemon.pid.json`, `daemon.paused`, `daemon.stop` | Loop owner and persisted pause/stop controls |
| `logs/<date>.jsonl` | Daemon decisions and retention purges |
| `logs/smoke/smoke-<runId>.jsonl`, `logs/smoke/smoke-<runId>.log` | Client scenario events and readable report |
| `claude-statusline.original` | Status bar backup before consented registration |
| `autostart/okit-daemon.cron`, `logs/daemon.out` | Cron plan and daemon output for that plan |

<a id="installation"></a>
## Outside the state root

Default payload destination: XDG_DATA_HOME/okit-plugin or ~/.local/share/okit-plugin on Linux; ~/Library/Application Support/okit-plugin on macOS; LOCALAPPDATA/okit-plugin or ~/AppData/Local/okit-plugin on Windows. install.destination overrides it.
There, install.<client>.json records current payload, checksum, previous version, link, autostart and status bar; install.json is the legacy record. <version>-<client>/ holds code; managed-path.json tracks only managed PATH changes. A record or a PATH state with a field of the wrong type is refused (exit 2) with the way out: remove the file and run `okit-plugin install`. The default link directory is ~/.local/bin or ~/AppData/Local/bin on Windows; configuration can override it. Hooks, skills and role blocks live in [client roots](adapters.md).
Autostart also registers ~/.config/systemd/user/okit-daemon.service, ~/Library/LaunchAgents/com.okit.daemon.plist or a Windows task, according to platform and plan.

<a id="integrity"></a>
## Integrity and removal

JSON writes use a temporary file, sync and rename; locks use directories with owners and dead-process recovery. Missing files allow a fallback; invalid JSON does not silently become empty configuration. Do not remove active-process locks. Use `okit-plugin env report` to locate effective state and `okit-plugin config show` to inspect settings.
Update preserves state. Uninstall preserves it by default; --purge --yes requires no remaining clients and deletes the root. Back up history before removal.

<a id="measurements"></a>
## Optional usage measurements

Use telemetry on/off for recording, rede on/off for sending, export [--since ISO] for export, check for integrity and status for folder, size and last export. Nothing is recorded by default. Only counts, durations, states, helper names and a hashed project are saved in atomic OTLP/JSON files; prompts, file contents, demand text and paths are dropped. Files are pruned by age and total size. When kit is configured, its local destination and retention are reused unless overridden. Sending occurs only during export after separate opt-in, contains aggregate counts only and requires HTTPS (HTTP allowed only for localhost). Addresses and headers are never logged.

<a id="trajectories"></a>
## Optional run recordings

`trajectory on` explains that messages, available thoughts, tool inputs/results and usage are saved only on this computer; off is the default, with no recording files created. `trajectory off` stops future recording and keeps existing files. Process completion and practice executor/reviewer attempts record available content, model, effort and role; each reviewer carries the executor attempt reference. Native delegation records the handoff; completion content is available only when supplied as a transcript to the adapter. Unknown values are null, never estimates. Per-step usage is summed only where supplied; missing usage is not treated as zero. `show` displays the last saved step, failed tools and tokens per step; `export` prints the saved JSON locally. Neither command sends anything.
Files under trajectory/ are written atomically with a shared retention lock, removed by age/total size and shortened to the per-run cap with a visible marker. Content matching configured patterns is hidden before writing. Pattern matching cannot detect every secret; review recordings before sharing. Existing process output in runs/ follows the previous launcher behavior and is separate from these redacted files. The version constant is in src/trajectory/schema.js: **to be checked against the current Harbor spec** as a follow-up; no claim of verified compatibility. The shape contains schema_version, session_id, agent (name/version/model_name/extra), steps (messages, thoughts, calls, results, metrics), and final_metrics. Capped files retain available original totals and report the number of retained steps; a truncated input may have incomplete totals.

[Overview](README.md) · [Configuration](configuration.md) · [Português](state.pt-BR.md)
