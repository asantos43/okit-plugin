# Adapters

Each adapter translates execution, allowance, skills and context for a specific client.

<a id="claude-code"></a>
## Claude Code

NATIVE returns an Agent call with model, effort and briefing without starting a process; PROCESS uses the headless launcher. SessionStart delivers native context. Allowance comes from a manual sample or the status bar collector.
Installation registers the marketplace/plugin, adds the exact SessionStart command to settings.json and uses the payload skills, MCP and compact hook. The optional collector preserves the previous bar.
Update switches registration to the new payload and removes the old command. Uninstall removes the exact entry, plugin/marketplace and restores the registered bar, preserving other settings.
Root: root option, CLAUDE_CONFIG_DIR or ~/.claude.

<a id="codex"></a>
## Codex

NATIVE returns a descriptor for caller-managed delegation; PROCESS uses codex exec. Context comes from a managed AGENTS.md block and explicit prompt, without adapter-installed hooks. Allowance reads recent session tails with a manual fallback and no client writes.
Installation registers the marketplace and requests activation in /plugins; it does not automatically run plugin add/update. The AGENTS.md role block preserves surrounding text; a nonempty AGENTS.override.md prevents this delivery. Copying skills does not prove automatic discovery.
Update replaces registration and updates only the block; uninstall removes the block and registered marketplace. The code does not run plugin uninstall for Codex: check activation in the client. Hooks and actual payload loading need client confirmation.
Root: root option, CODEX_HOME or ~/.codex.

<a id="opencode"></a>
## opencode

PROCESS is the default (opencode run); the Task/NATIVE work-launch bridge is unimplemented. The native configuration hook enriches primary agents without replacing model/variant, creates okit-director and the okit command in memory. The session.compacted event sends the summary to the client log.
Installation copies skills without overwriting differing files, writes plugins/okit-plugin.js pointing to the payload and adds a commands/okit.md block. Edited modules and other plugins survive.
Update removes the old wrapper only when bytes match expectations; uninstall makes the same check and removes only the role block. Copied skills remain: those files have no automatic removal. Allowance uses configured sources or a manual sample.
Root: root option, OPENCODE_CONFIG_DIR, XDG_CONFIG_HOME/opencode or ~/.config/opencode.

<a id="lifecycle"></a>
## Lifecycle

Use `okit-plugin install --client codex --dry-run` to inspect the plan. The installer tracks per-client records, command link and managed PATH, previous versions and optional autostart. Update preserves state; removal deletes only recorded directories and protects those used by other clients. State is removed only with --purge --yes and no remaining clients. Platforms without verified native delivery return a diagnostic; copying files does not prove activation.

[Overview](README.md) · [Hooks](hooks.md) · [Update/remove](../guide/update-and-remove.md) · [Português](adapters.pt-BR.md)
