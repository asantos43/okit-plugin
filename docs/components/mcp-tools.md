# MCP tools

![okit-plugin: Components](../images/banners/components.svg)

MCP tools expose validated core operations to the client assistant.

Every `locale` field is optional and lists default `en` from the built-in `language` setting. Calls that omit it use the saved `language`; set Portuguese once with `okit-plugin config set language pt-BR`. An explicit `locale` (`en` or `pt-BR`) takes priority for that call.

<a id="tools"></a>
## Tool contract

The server exposes 29 tools. Inputs are JSON objects; ? marks an optional field. Replies are JSON text containing a result or refusal; invalid arguments raise an error. Writing state does not itself launch a model or spend allowance. The list of the tools costs 14255 bytes of JSON, about 3564 tokens of context, and seven of them are generated from the operations registry (`src/core/operations.js`), so a core function is described once.

| Name | Purpose and return | Inputs | Effect |
| :- | :- | :- | :- |
| `trajectory_show` | Read a saved run step by step, including failed tools and tokens | run | read local files only |
| `telemetry_status` | Inspect optional saved measurements; consent, folder, size, last export | {} | read |
| `telemetry_export` | Export saved measurements from an optional date | since? | writes last-export receipt; sends counts only if separately enabled |
| `acquire_slot` | Reserve a slot; result or cap refusal | runId, client, waitMs? | write |
| `release_slot` | Free a slot; release result | runId | write |
| `limits_status` | Inspect caps; client caps and live runs | {} | read |
| `status` | Inspect allowance; rows, markdown, capacityLine and optional showBefore | locale?, all?, client?, size?, slices?, executors? | read |
| `actors_list` | Inspect actor choices; models, effort, availability and remedies | locale?, all?, client? | read |
| `env_report` | Inspect environment; observations and localized text | client?, locale? | read |
| `smoke_demo` | Preview/confirm practice; plan, events, measured totals and exit code | dryRun?, client?, locale?, confirm? | preview reads; valid confirm runs the real client and spends allowance within displayed ceilings; no-money clients require smoke.maxTokens |
| `classify` | Classify work; effort class and reasons | title, body?, kind? | read |
| `profile_pick` | Choose an assistant from saved settings or built-in defaults, even before setup; model, effort, maxTurns or refusal | client, effort, quota? | read |
| `inbox_add` | Store work; confirmed link or suggested task awaiting confirmation | title, body?, kind?, accept?, effort?, client?, appliesTo?, todoLink? | write |
| `todo_sync` | Synchronize tasks; changes/diffs and suggestions; link needs id and confirm | project?, dryRun?, id?, link?, confirm? | write; dryRun previews |
| `todo_check` | Inspect links; demandsWithoutItem and itemsWithoutDemand | project? | read |
| `quota_notice` | Turn the kit's quota-back event into a plain sentence; available, released and text; without the event, says the notice is not available | locale?, event? | read |
| `inbox_list` | Inspect work; items with project reference and owner | status?, client?, appliesTo?, limit?, locale? | read |
| `inbox_claim` | Claim work atomically; ownership result/refusal | id, client, session?, worktree? | write |
| `inbox_release` | Release owned/stale hold; result/refusal | id, client, session? | write |
| `inbox_set_status` | Transition work; updated item (holder required for held work) | id, status, holder? | write |
| `order_add` | Store instruction; order with id | text, scope?, until?, appliesTo? | write |
| `order_list` | Inspect active instructions; orders and derived status | appliesTo? | read |
| `order_remove` | Revoke instruction; order with reason/history retained | id, reason? | write |
| `config_get` | Read the settings of a root; every entry of the schema, or one of them | key? | read |
| `config_set` | Write one setting; what it was and what it is now; without a value the entry is removed | key, value? | write |
| `quota_show` | Read the recorded quota of the clients of a root, or of one client | client? | read |
| `quota_set` | Record the quota of one client; the percentage that is left and its window | client, pct, windowMinutes? | write |
| `daemon` | Read the state of the daemon; whether it runs, whether it is paused, the last pass, or one pass now | action | read; `pause`, `resume` and `run-once` change the state |
| `kit_detect` | Probe the orchestration kit of a root; whether it is installed, its version and why it is broken | {} | read |

<a id="try"></a>
## Try it

With the MCP server active in the client, call env_report with `{}`. Expect environment observations and repair commands without a model launch. Client fields use claude-code, codex or opencode; effort uses simple, normal or hard.

[Overview](README.md) · [Skills](skills.md) · [Português](mcp-tools.pt-BR.md)
