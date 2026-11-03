# Solve a problem

![okit-plugin: User guide](../images/banners/guide.svg)

Use the environment report to find the missing item and its repair instruction.

<a id="diagnose"></a>
## Diagnose

1. Ask your assistant: “Where are you?” (it calls `env_report`). Expect installed clients, confirmed models, allowance, free helper places and folders. Read each missing item's repair command; unconfirmed information stays unknown. The `okit-environment` skill answers with the same report.
2. If the command is not found, open a new terminal and restart the AI client. Use the activation command printed by installation if available. The environment report says whether the command is in PATH; your assistant reads it for you. See [installation](install.md).
3. If model setup is pending, run `okit-plugin setup`. Expect detected choices and confirmation; no active model means nothing is saved. If the configuration cannot be read, ask your assistant to call `config_get`; expect the settings or an error identifying the problem. Repair file access or invalid JSON before repeating setup; the plugin preserves unreadable settings.
4. If allowance is unknown or old, ask your assistant: “How much quota is left?” (it calls `quota_show`). Expect its source and age. Record the actual current reading using [models and allowance](models-and-quota.md), then retry. Another client's allowance cannot authorize your run.
5. If helpers cannot start, ask your assistant: “Which actors are available?” (it calls `actors_list`). Expect models, available places and reasons with remedies. The status shows the occupied places. An available model and a running helper are different things.
6. If a demonstration is refused, use [the preview guide](smoke-demo.md). Confirm the current hash and refresh quota evidence; clients without money reports also require positive integer `smoke.maxTokens`. Confirmation executes real work and spends allowance. For check failures, retain the printed report paths and follow [smoke evidence](../maintainers/SMOKE.md).

<a id="doctor"></a>
## Run the doctor first

1. Run `okit-plugin doctor --locale en`. Read the “Ready” or “Needs attention” summary first, then the table of checks. Below the table, `Fix:` lines give repairs and an exact command checks the installation again. The doctor only reads: it writes no file and removes no record. It answers 0 when no row failed, 1 when a row failed, and a warning never fails the run. See [the CLI reference](../components/cli.md#commands).

[Guide](README.md) · [Português](troubleshooting.pt-BR.md)
