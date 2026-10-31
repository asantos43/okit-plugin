# Component reference

![okit-plugin: Components](../images/banners/components.svg)

Look up each component to understand how the plugin organizes and runs work.

<a id="map"></a>
## Map

- [Skills](skills.md): instructions for each role and task.
- [MCP tools](mcp-tools.md): inputs, replies and effects.
- [Control API](control-api.md): local calls to a running server.
- [Hooks](hooks.md): session context and quota collection.
- [Adapters](adapters.md): client capabilities and installation.
- [CLI](cli.md): commands and examples.
- [Daemon](daemon.md): recurring work and stopping.
- [Configuration](configuration.md): keys, defaults and effects.
- [State](state.md): stored files and write protection.

<a id="flow"></a>
## How they fit

```text
Person → client → skills → MCP tools → core → state
CLI ──────────────────────────────────────→ core
Hooks → context/quota → client       daemon → schedules → adapters
```

Skills guide the model; tools validate arguments and call the core. Adapters connect clients. The daemon handles scheduled work; the CLI exposes inspection and control of these resources.

Some core functions live in the operations registry (`src/core/operations.js`): a name, a description in both languages, the schema of its arguments and one handler. The registry holds twenty-four operations today (`config_get`, `config_set`, `quota_show`, `quota_set`, `daemon`, `kit_detect`, `todo_check`, `inbox_add`, `inbox_list`, `inbox_claim`, `inbox_release`, `inbox_set_status`, `order_add`, `order_list`, `order_remove`, `acquire_slot`, `release_slot`, `limits_status`, `status`, `quota_notice`, `actors_list`, `env_report`, `classify`, `profile_pick`); the command line calls them, and the MCP server builds the tools of the same entries from the registry. An operation returns data and never prints.

[Guide](../guide/README.md) · [Português](README.pt-BR.md)
