# Component reference

Look up each component to understand how the plugin organizes and runs work.

<a id="map"></a>
## Map

- [Skills](skills.md): instructions for each role and task.
- [MCP tools](mcp-tools.md): inputs, replies and effects.
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

[Guide](../guide/README.md) · [Português](README.pt-BR.md)
