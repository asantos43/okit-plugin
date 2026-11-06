# Daemon and schedules

![okit-plugin: Components](../images/banners/components.svg)

The daemon processes pending and recurring work within concurrency limits and stop controls.

<a id="run"></a>
## Run and stop

Ask the assistant to use the MCP tool `daemon` with action `run-once` for one pass. The internal `daemon start` entry point keeps the foreground loop running, started by autostart configured through `okit-plugin setup` or `okit-plugin install --autostart`. Each pass reads configuration, checks pause/stop, purges orders past retention, observes allowance, opens due recurrences and serves pending work oldest first. The PROCESS adapter executes work; the core receives its launcher as a dependency.
Defaults are a 60-second interval, 10% quota floor and 14-day log retention. Known allowance below the floor stops the pass; no reading is not treated as below the floor in this daemon check. Slots are separate per-client limits; a period with a live child is not duplicated.

For Claude Code and Codex, work without a named account uses the account policy before reserving a slot. The slot lock reads run records once for both choice and counting; the same selected id goes to preflight and launch. Saved accounts use their own adapter quota readings, so a low default account cannot stop a healthy extra. Daemon and doctor share one rule for available actors: clients without saved accounts use configured profiles; saved accounts with a `listing` source must list the model, even without `setup.done`. With a `catalog` source, configured profiles apply until that client has setup confirmation; then the confirmed model and effort are shared across default and extras. No eligible account means a localized reason and no run. Enforced pacing stores `ext.wait_until` and keeps the demand pending until then. Named accounts and `resumeSession: {account}` stay fixed; pacing does not defer continuations. Critic and verifier receive the executor account from demand metadata or the referenced executor run and prefer another eligible account. `critic_of` implies `critic` when no role is given; reviews preserve the inbox's executor account. Relinked slots retain the chosen account and reason. Quota telemetry records the client and optional account separately. See [state](state.md) for fields and [accounts](../guide/accounts.md) for settings.

- MCP `daemon`, action `status`: PID, pause and last pass; ask for MCP `status` for capacity.
- MCP `daemon`, action `pause`: prevents new work without ending the loop.
- MCP `daemon`, action `resume`: removes the pause marker only.
- The installer uses internal `daemon stop`: creates daemon.stop to end the loop; SIGINT/SIGTERM also stop it. The next daemon start clears this marker automatically; resume and run-once do not clear it. The pause marker survives a restart.

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

`okit-plugin setup` offers the startup plan before applying it; `okit-plugin install --autostart` also registers it. The installer registers/removes systemd or cron on Linux, launchd on macOS or schtasks on Windows. Inspect the actual platform plan; a daemon can spend allowance when work arrives. Logs and markers live in [state](state.md).
The cron plan installs its file as the user's entire crontab; uninstall runs crontab -r. Review and back up existing entries before applying that plan.

Setup considers every client record in the discovered destination, preserves a matching installed plan and records acceptance for all covered clients without changing their link settings. Readiness requires persistent systemd enablement, a loaded launchd agent without a disabled override, a ready/running Windows task, or the exact current cron command (node and CLI paths included). A failed record save restores all touched records and keeps pre-existing services, including disabled ones.

[Overview](README.md) · [Configuration](configuration.md) · [Português](daemon.pt-BR.md)
