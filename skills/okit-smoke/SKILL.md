---
name: okit-smoke
description: Use when the user invokes /okit-smoke or asks to run and narrate the plugin's in-client smoke checks and summarize their report.
---

# Smoke

Drive the existing runner; do not reimplement the scenario or judge success from model prose.

- Before a real run, warn that it spends the user's quota and ask for confirmation. Without confirmation, use `--dry-run`.
- After confirmation, run `okit-plugin client-smoke --client claude-code --demo` by default. If the command is not found, run `node "${CLAUDE_PLUGIN_ROOT}/src/cli.js"` with the same arguments. Honor the user's requested mode instead: `--headless`, `--dry-run` or `--rehearsal`. The latter two are offline and need no quota confirmation.
- Use the configured `smoke.*` variables for limits; honor requested overrides with `--max-usd`, `--max-turns` and `--max-minutes`. Do not invent fixed cost, turn or time limits.
- If the runner exits with `quota-unknown`, ask the Producer for the remaining quota percentage shown in the client's `/usage`. Run `okit-plugin quota set <client> <pct>` with their answer, then rerun the smoke with the same options. Use `--allow-unknown-quota` only when the Producer explicitly requests it. Refresh stale records according to `smoke.quotaMaxAgeMinutes` and `smoke.quotaExpireMinutes`; do not invent age limits.
- Narrate each step as the runner's output arrives, preserving its check id, verdict and any failure or skip reason. Keep polling a running command until it exits.
- Finish with one line per verification, the `PARCIAL` line if present, the artifact paths if emitted, and the actual process exit code. For an offline walk, identify planned checks as unexecuted; never claim that it proves the real installation works.
