# Ask the Director

![okit-plugin: User guide](../images/banners/guide.svg)

Describe the result you want so the Director can plan, assign and review the work.

<a id="ask"></a>
## Ask for work

1. Open your installed AI client in the project you want to change. Ask: “Where are you, and which helpers are available?” Expect the current client, confirmed models, remaining allowance, free helper places and missing information. The `okit-environment` skill answers it with `env_report`.
2. Ask: “Act as Director. Add a short getting-started section to this project's README. Keep the existing instructions and show how you checked the result.” Expect a plan, a choice of helpers based on available capacity and a clear description of what will change. The installed `okit-director` skill guides the work; follow your client's activation instructions if it is unavailable.
3. Ask: “What is running, and what remains?” Expect readable work titles and progress. The same question calls `status`, which shows running helpers, allowance and limits, and `inbox_list`, which lists saved work and its current holder, or shows nothing for an empty list.
4. Read the final changes and checks. Expect observed results and any limitation stated explicitly. Ask for clarification if a model, allowance reading or result could not be confirmed.

The Director coordinates; Executors do assigned work and the Critic checks it. Model and effort choices do not change these roles. Use [models and allowance](models-and-quota.md) to adjust your choices, or [preview a demonstration](smoke-demo.md) first.

To keep a project's task list up to date, configure only that project: ask your assistant to call `config_set` with the key `todo.projects` and the value `{"/projects/example":{"enabled":true,"file":"TODO.md","areaDir":"","section":"## Inbox","checkbox":{"open":" ","progress":"-","done":"x"}}}`. Replace the example with the full project folder. The file and section must already exist; see [configuration](../components/configuration.md). With area files, set areaDir to their folder; new tasks go under the configured section in the main file or a single matching area file.
Ask “Keep this project's task list in sync and show me the proposed changes.” The assistant calls `todo_sync` with `dryRun` to show the changes without writing. `todo_check` lists work without a task and tasks without saved work. The Director asks before using a nearby task suggestion. Taking work marks progress, completing it records completion and date, and releasing or abandoning it restores the original task. A changed file or an outside path is refused; the work stays saved and the Director explains what needs checking. This works the same in all three clients.

[Guide](README.md) · [Português](ask-the-director.pt-BR.md)
