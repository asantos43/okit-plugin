# Solve a problem

![okit-plugin: User guide](../images/banners/guide.svg)

Use the environment report to find the missing item and its repair instruction.

<a id="diagnose"></a>
## Diagnose

1. Run `okit-plugin env report --locale en`. Expect installed clients, confirmed models, allowance, free helper places and folders. Read each missing item's repair command; unconfirmed information stays unknown. The `okit-environment` skill answers “Where are you?” with the same report through `env_report`.
2. If the command is not found, open a new terminal and restart the AI client. Use the activation command printed by installation if available. If needed, run `node src/cli.js status` from the installed package folder; expect status plus a PATH repair hint while its bin folder is missing from the current PATH. See [installation](install.md).
3. If model setup is pending, run `okit-plugin setup`. Expect detected choices and confirmation; no active model means nothing is saved. If the configuration cannot be read, run `okit-plugin config show`; expect values or an error identifying the problem. Repair file access or invalid JSON before repeating setup; the plugin preserves unreadable settings.
4. If allowance is unknown or old, run `okit-plugin quota show`. Expect its source and age. Record the actual current reading using [models and allowance](models-and-quota.md), then retry. Another client's allowance cannot authorize your run.
5. If helpers cannot start, run `okit-plugin actors --all --locale en`. Expect models, available places and reasons with remedies. Run `okit-plugin status --all --locale en` to see occupied places. An available model and a running helper are different things.
6. If a demonstration is refused, use [the preview guide](smoke-demo.md). Confirm the current hash and refresh quota evidence; clients without money reports also require positive integer `smoke.maxTokens`. Confirmation executes real work and spends allowance. For check failures, retain the printed report paths and follow [smoke evidence](../maintainers/SMOKE.md).

[Guide](README.md) · [Português](troubleshooting.pt-BR.md)
