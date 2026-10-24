# okit-plugin

[Installation and updates](INSTALL.md)

A plugin for AI clients (Claude Code, Codex, opencode) that helps a Director
agent spread delegable work over the client's own subagents.

The Director classifies each demand by effort (simple, normal, hard), picks the
subagent's model and reasoning effort by class and by the client's remaining
quota, and keeps a small inbox and standing orders. The Director delegates,
critiques and consolidates. No panel, no work across clients.

In messages to the Producer, the Director identifies demands as `D25 (okit-plugin)` to distinguish projects. Displayed inbox/status items add `ref` while JSON `id`, commands, PR bodies, inbox fields and `critic-waiver Dn` keep the bare id. The state root's optional `project.json` record supplies `name`, falling back to the repository basename in `path`; a demand's single `appliesTo` project takes precedence. Without a name, `ref` is the bare id. Daemon decisions add `ref` to demand entries and `openedRefs` beside the unchanged `opened` ids.

A demand is any unit of delegable work, not only code: research, writing,
documents, data cleanup, analysis, planning, reviews and file operations.

**Status: design phase (pre-alpha).** This repository currently holds only the
structure and the documents. There is no working code yet.

## Planned features

- Effort classification of each incoming demand.
- Subagent choice by effort class and by remaining client quota.
- A small inbox plus standing orders kept by the Director.
- A delegation, critique and consolidation loop.

## Supported clients and platforms

- Clients: Claude Code, Codex, opencode.
- Platforms: Linux, macOS and Windows.
- Core: Node.js >= 20, zero dependencies, state in plain JSON files.

## Restore context after compaction (Claude Code)

`okit hook post-compact` reads the hook JSON (`cwd`) from stdin and prints a
project-scoped summary of open inbox work, active standing-order titles and a
status count. Order titles use `title` when present, otherwise the first line of
`text`; bodies and environment values are never included. Missing/invalid state,
invalid input, errors and timeouts produce no output and exit 0.

Configure `postCompact` in the plugin state's `config.json` (`OKWORK_HOME`):
`enabled` (default `true`), `timeoutSec` (`5`), `maxLines` (`20`),
`sections` (`inbox`, `orders`, `status`, all `true`), `inboxStatuses` and `text`.
Defaults live in `src/profiles.js`; partial section/text overrides are merged.
Set `postCompact.enabled=false` to disable output.

There is no general install command yet. Import `installPostCompactHook` from
`adapters/claude-code/index.js` and call it with `{ root: clientConfigRoot,
config: pluginConfig }` (optional `command` override; default
`okit hook post-compact` requires `okit` on PATH). It merges a `SessionStart`
entry with matcher `compact` and the configured timeout into `hooks/hooks.json`,
preserving user entries; repeating the same installation does not write.
Configuration/input loading uses the default deadline until the configured
deadline is known; that deadline is measured from hook start.

## Contributing

Pull requests are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) first.

Security reports are not public issues, see [SECURITY.md](SECURITY.md).
The design notes live in [docs/DESIGN.md](docs/DESIGN.md).
The release design is in [docs/RELEASING.md](docs/RELEASING.md)
([Português](docs/RELEASING.pt-BR.md)).

## Licence

MIT. See [LICENSE](LICENSE).

Portuguese version of this file: [README.pt-BR.md](README.pt-BR.md).
