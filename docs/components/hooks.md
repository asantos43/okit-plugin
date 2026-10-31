# Hooks

![okit-plugin: Components](../images/banners/components.svg)

Hooks restore context and collect allowance at client events.

<a id="events"></a>
## Events and effects

| Entry | Trigger | Output and writes | Removal |
| :- | :- | :- | :- |
| `hook-session-start.js` | Claude SessionStart: startup, resume, clear and compact | JSON additionalContext with role, work, orders, actors and limits; no persisted context (limits inspection ignores stale records) | uninstall removes the exact command from settings.json; update removes the old-path command |
| `hook-post-compact.js` | Claude SessionStart matching compact; session.compacted through the opencode bridge | Project-scoped inbox/order summary on stdout, bounded by lines/time; no state writes and silent failure | postCompact.enabled=false disables it; remove only the matching hooks/hooks.json entry or remove the plugin; opencode removes only the installation-owned wrapper |
| `statusline-collector.js` | Each Claude status bar update after consented registration | Atomically writes the client's JSON to quota/claude-code-statusline.json; runs the previous bar with identical input and preserves output | uninstall restores the original bar; --no-statusline declines registration during install/update |

<a id="ownership"></a>
## Registration and preservation

Installation registers SessionStart in settings.json. The Claude payload includes hooks/hooks.json for compaction; the opencode installer writes a plugins/okit-plugin.js wrapper. Codex receives no hooks through the adapter.
The collector requires --statusline or terminal confirmation. Without a terminal or flag, registration is skipped. The backup lives in plugin state; uninstall restores original bytes when intact, or only the previous field if other settings changed.
Running `okit-plugin statusline-collector` directly does not register the bar. The collector stores the JSON of the client as it came; the core reads quota/claude-code-statusline.json and derives the quota reading from it. Input without rate limits keeps the previous sample; previous-command failures do not interrupt the client.

<a id="try"></a>
## Check it

Pass JSON containing cwd on stdin to `okit-plugin hook post-compact`: expect a summary only when applicable work/orders exist. `okit-plugin hook session-start` accepts the same JSON and returns role context or a diagnostic. These are internal client entry points: the client launches them and they are not commands of the user help.

[Overview](README.md) · [Adapters](adapters.md) · [Português](hooks.pt-BR.md)
