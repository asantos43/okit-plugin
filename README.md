# okit-plugin

A plugin for AI clients (Claude Code, Codex, opencode) that helps a Director
agent spread delegable work over the client's own subagents.

The Director classifies each demand by effort (simple, normal, hard), picks the
subagent's model and reasoning effort by class and by the client's remaining
quota, and keeps a small inbox and standing orders. The Director delegates,
critiques and consolidates. No panel, no work across clients.

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

## Contributing

Pull requests are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) first.

Security reports are not public issues, see [SECURITY.md](SECURITY.md).
The design notes live in [docs/DESIGN.md](docs/DESIGN.md).
The release design is in [docs/RELEASING.md](docs/RELEASING.md)
([Português](docs/RELEASING.pt-BR.md)).

## Licence

MIT. See [LICENSE](LICENSE).

Portuguese version of this file: [README.pt-BR.md](README.pt-BR.md).
