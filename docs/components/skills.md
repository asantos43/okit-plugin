# Skills

Skills guide the model according to the role and intent recognized by the client.

<a id="loading"></a>
## Loading

The client selects instructions by skill description or explicit invocation; copying files does not prove activation. Native context supplies the main role, and explicit briefings supply Executor/Critic roles.
All route environment questions to env_report, actors to actors_list/status and demonstrations to okit-smoke. Resources below include commands and tools; file checks use native client facilities.

<a id="okit-director"></a>
## okit-director

Keeps enabled project tasks in step with saved work; asks before using a suggested task and checks missing links before delivery with `todo_status` and previews repairs with `todo_sync`.

| Skill | Use and instruction | Main resources |
| :- | :- | :- |
| `okit-director` | Orchestrates requested work; loaded when directing or delegating. Read orders and inbox, classify, choose actors, claim work, reserve/release slots, brief Executor and Critic, verify evidence and record transitions. | `order_list`, `inbox_list`, `inbox_claim`, `inbox_release`, `limits_status`, `status`, `actors_list`, `env_report`, `classify`, `profile_pick`, `acquire_slot`, `release_slot`, `inbox_add`, `inbox_set_status`, `order_add` |

<a id="okit-executor"></a>
## okit-executor

| Skill | Use and instruction | Main resources |
| :- | :- | :- |
| `okit-executor` | Carries out one explicit briefing; loaded for an Executor spawned by the Director. Stay inside scope, check the result and report files, evidence and unfinished work. A skill alone does not assign the role. | `order_list`, `inbox_list`, `actors_list`, `limits_status`, `env_report` |

<a id="okit-critic"></a>
## okit-critic

| Skill | Use and instruction | Main resources |
| :- | :- | :- |
| `okit-critic` | Reviews a delivered result; loaded for an independent Critic briefing. Read the diff, run acceptance checks, compare evidence with the goal and return pass, revise or reject with concrete fixes. | `order_list`, `inbox_list`, `actors_list`, `limits_status`, `env_report`, `inbox_set_status` |

<a id="okit-setup"></a>
## okit-setup

| Skill | Use and instruction | Main resources |
| :- | :- | :- |
| `okit-setup` | Guides model setup; loaded for /okit-setup or a conversational configuration request. Run the existing proposal flow, explain detected choices, ask only missing facts and save once after its final confirmation. Never edit individual settings by hand. | `okit-plugin setup`, `okit-plugin config show` |

<a id="okit-smoke"></a>
## okit-smoke

| Skill | Use and instruction | Main resources |
| :- | :- | :- |
| `okit-smoke` | Narrates demonstrations and smoke checks; loaded for /okit-smoke or a demonstration/real-test request. Preview, show limits, obtain explicit allowance consent tied to the plan, then report runner evidence and exit status. Paid demo execution currently refuses without enforceable measurement. | `smoke_demo`, `okit-plugin smoke-demo`, `okit-plugin client-smoke`, `okit-plugin quota set` |

<a id="okit-environment"></a>
## okit-environment

| Skill | Use and instruction | Main resources |
| :- | :- | :- |
| `okit-environment` | Answers environment questions; loaded when asked about client, models, allowance, folders or missing setup. Explain confirmed observations and repair commands, preserve unknowns and change nothing. | `env_report`, `okit-plugin env report` |

Try asking “show the environment” and inspect the report without starting work.

[Overview](README.md) · [MCP](mcp-tools.md) · [Português](skills.pt-BR.md)
