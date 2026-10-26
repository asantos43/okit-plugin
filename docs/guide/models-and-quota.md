# Choose models and record allowance

Choose the models your helpers use and check the remaining allowance before work.

<a id="models"></a>
## Choose models

1. Run `okit-plugin setup`. Expect detected clients, proposed models and reasons. Confirm to save; missing active models leave setup pending. In chat, the `okit-setup` skill guides the same choices. Run `okit-plugin setup --again` to repeat; expect another review of the choices.
2. Run `okit-plugin actors --all --locale en`. Expect available model and effort pairs, task sizes, remaining allowance and free helper places. These choices are called actors; they are available helpers, while `okit-plugin status --all --locale en` shows running helpers and their limits.
3. To change a choice, use `okit-plugin config set profiles.codex.normal.model MODEL`, replacing `MODEL` with an active model shown by your client. Expect the previous and new value. `okit-plugin config unset profiles.codex.normal.model` restores the default and reports the change. Replace `codex` and `normal` as needed; work categories are `simple`, `normal` and `hard`.

<a id="quota"></a>
## Record allowance

1. Run `okit-plugin quota show`. Expect each client's reading, source and age, or an unknown value. Codex can read recent local sessions; Claude Code can collect the status bar; opencode needs a configured source or a manual reading.
2. If the client actually shows 80% remaining, run `okit-plugin quota set claude-code 80`, replacing the client and percentage with your reading. Expect `Quota recorded / Cota registrada: claude-code 80%`. Never copy this example as an estimate.
3. Run `okit-plugin status --all --locale en`. Expect the saved reading and free helper places. Allowance and simultaneous helper limits are separate; unknown allowance is not a promise that work can run.

State normally lives in `~/.okwork`; `OKWORK_HOME` selects another folder. Keep the same folder for later commands. `okit-plugin config show` lists editable settings, their values, origins and effects; see [configuration details](../components/configuration.md).

[Guide](README.md) · [Português](models-and-quota.pt-BR.md)
