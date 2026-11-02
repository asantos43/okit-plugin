# Choose models and record allowance

![okit-plugin: User guide](../images/banners/guide.svg)

Choose the models your helpers use and check the remaining allowance before work.

<a id="models"></a>
## Choose models

1. Run `okit-plugin setup`. Installation already saves detected choices without replacing yours. Every remaining question recommends a choice in everyday words, explaining small tasks, everyday work or complex work. Confirm to save the reviewed choices; missing active models leave setup pending. English and Brazilian Portuguese are available. Detection does not spend allowance. In chat, the `okit-setup` skill guides the same choices. Run `okit-plugin setup --again` to review again.

   At the end, interactive `okit-plugin setup` offers to start the daemon with the machine. The default is no; `--defaults` never installs autostart. `okit-plugin uninstall` removes it.
2. Ask your assistant: “Which actors are available?” (it calls `actors_list`). Expect available model and effort pairs, task sizes, remaining allowance and free helper places. These choices are called actors; they are available helpers, while the status shows running helpers and their limits.
3. To change a choice, ask your assistant to call `config_set` with the key `profiles.codex.normal.model` and the model your client shows. Expect the previous and the new value. The same call without a value restores the default and reports the change. Replace `codex` and `normal` as needed; work categories are `simple`, `normal` and `hard`.

<a id="quota"></a>
Saved setup choices count as confirmed if a model list cannot be read, including on Windows. A successful list that excludes a model still blocks it. Changing a model later requires a successful list or `okit-plugin setup --again`. Older setups without saved confirmation also need this command. Confirmation records your choice; it does not verify account access.

Actor confirmation applies to the exact model and effort pair. Model-only listings cannot confirm an effort different from the saved choice or reference profile; use `okit-plugin setup --again` to confirm a new effort. Another profile using the same model does not authorize that change.

## Record allowance

The environment report (`env_report`) labels absent clients as `not installed (optional)`; they create no missing model or allowance items and setup skips them. This applies on Linux, macOS and Windows. Installed clients still need confirmed choices.

The same list of actors also labels absent clients as optional without asking you to configure profiles. Status excludes them from the capacity of executors that can launch.

The report also checks whether Claude Code's current settings register `statusline-collector`. If inactive or unreadable, it shows `okit-plugin install --client claude-code --statusline` to enable collection while keeping the existing bar. Active means registered in settings; a fresh allowance sample still depends on Claude Code sending status updates.

The collector is an internal entry point the client launches, not a command of yours: it must be a plugin invocation with the collector subcommand, such as `okit-plugin statusline-collector`. A command like `echo statusline-collector` only prints the name: the report shows it as inactive and installation preserves it as the previous bar when enabling collection.

1. Ask your assistant: “How much quota is left?” (it calls `quota_show`). Expect each client's reading, source and age, or an unknown value. Codex can read recent local sessions; Claude Code can collect the status bar; opencode needs a configured source or a manual reading.
2. If the client actually shows 80% remaining, ask your assistant to record it: `quota_set` with the client `claude-code` and the percentage 80, replacing both with your reading. Expect the recorded reading: `claude-code` 80%. Never copy this example as an estimate.
3. Ask your assistant for the status of every client (it calls `status`). Expect the saved reading and free helper places. Allowance and simultaneous helper limits are separate; unknown allowance is not a promise that work can run.

Setup and status read the available automatic or manual allowance. Before the first reading, setup asks you to record the actual percentage, which your assistant does with `quota_set`; the status repeats the request. No allowance is assumed, and helpers remain blocked until a valid reading is available.

State normally lives in `~/.okwork`; `OKWORK_HOME` selects another folder. Keep the same folder for later commands. Your assistant lists the editable settings, their values, origins and effects (`config_get`); see [configuration details](../components/configuration.md).

[Guide](README.md) · [Português](models-and-quota.pt-BR.md)
