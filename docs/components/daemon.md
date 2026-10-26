# Daemon and schedules

The daemon processes pending and recurring work within concurrency limits and stop controls.

<a id="run"></a>
## Run and stop

Use `okit-plugin daemon run-once` for one pass; `okit-plugin daemon start` keeps the foreground loop running. Each pass reads configuration, checks pause/stop, purges orders past retention, observes allowance, opens due recurrences and serves pending work oldest first. The PROCESS adapter executes work; the core receives its launcher as a dependency.
Defaults are a 60-second interval, 10% quota floor and 14-day log retention. Known allowance below the floor stops the pass; no reading is not treated as below the floor in this daemon check. Slots are separate per-client limits; a period with a live child is not duplicated.

- `okit-plugin daemon status --table`: PID, pause, last pass and capacity table.
- `okit-plugin daemon pause`: prevents new work without ending the loop.
- `okit-plugin daemon resume`: removes the pause marker only.
- `okit-plugin daemon stop`: creates daemon.stop to end the loop; SIGINT/SIGTERM also stop it. The next daemon start clears this marker automatically; resume and run-once do not clear it. The pause marker survives a restart.

<a id="schedules"></a>
## Recurrences

Templates are persisted data in templates.json; the core API creates/edits these records and their authorizing standing order. This version has no CLI command or MCP tool for editing templates.

| Form | Example | Effect |
| :- | :- | :- |
| Five-field cron | `*/15 9-17 * * mon-fri` | Every fifteen minutes within the indicated interval |
| Daily | `daily 06:00` | Once per day |
| Weekly | `weekly mon-fri 09:30` | On the indicated weekdays |
| Monthly | `monthly day 1 08:00` | On the indicated day |
| Event | `after each deploy` | Requires caller-supplied event and eventId; the loop does not detect deployments |

The default time zone is UTC. window bounds time of day; minQuotaPct, onlyWhenIdle and skipIfOpen gate opening; maxRunsPerPeriod bounds repeats. catchup run serves the oldest missed period, skip only the current one. Pausing and locked writes prevent duplicate children. Repeated hours use the first pass; missing hours move to the next valid minute.

<a id="autostart"></a>
## Automatic startup

`okit-plugin autostart show` displays the plan before applying it. install/uninstall register/remove systemd or cron on Linux, launchd on macOS or schtasks on Windows. Inspect the actual platform plan; a daemon can spend allowance when work arrives. Logs and markers live in [state](state.md).
The cron plan installs its file as the user's entire crontab; uninstall runs crontab -r. Review and back up existing entries before applying that plan.

[Overview](README.md) · [Configuration](configuration.md) · [Português](daemon.pt-BR.md)
