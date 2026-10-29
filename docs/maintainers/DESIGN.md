# Design

![okit-plugin: Maintainers](../images/banners/maintainers.svg)

Original goals, boundaries and design choices behind the shared plugin core.

<a id="contents"></a>
## Contents

- [Goals](#section-1)
- [Non-goals](#section-2)
- [The three pieces](#section-3)
- [Per-client adapters](#section-4)
- [Windows rules](#section-5)
- [Open questions](#section-6)

Implementation: see [ARCHITECTURE.md](ARCHITECTURE.md) for the current modules.

<a id="section-1"></a>
## Goals

- Spread work over the subagents the AI client already has.
- Take any unit of delegable work, not only code: research, writing, documents, data cleanup, analysis, planning, reviews, file operations.
- Classify each demand by effort so the right subagent gets it.
- Choose the subagent's model and reasoning effort by class and by quota.
- Keep a small inbox and standing orders for the Director.
- Run on Linux, macOS and Windows with the same core.
- Zero dependencies, state in plain JSON files.

<a id="section-2"></a>
## Non-goals

- No panel.
- No work across clients.
- No database dependency; records use JSON and event logs use JSONL.

<a id="section-3"></a>
## The three pieces

### 1. Effort classification

Each demand is classified as simple, normal or hard. The class is derived by
default and the maintainer may override it. The class drives the next step and is
what the tests pin down.

### 2. Subagent choice by class and quota

The class sets a base model and reasoning effort; the client's remaining quota
can lower the final choice by one class. The Director never invents a model that the
client does not expose.

### 3. Inbox and standing orders

A small inbox holds pending demands; standing orders hold instructions that apply
to every demand until removed. Both live in JSON files.

An atomic inbox hold identifies the client/session, worktree and time. Another active
holder is refused; age comes from `inbox.holdStaleMinutes`.
Claim/release and terminal statuses preserve prior holders in `heldBefore`.
Only the human CLI can force a Producer takeover, after showing the situation and
requiring `--producer-takeover` plus TTY confirmation or `--yes`; MCP cannot force it.

The Director delegates the work, critiques the subagent output and consolidates
the results.

<a id="section-4"></a>
## Per-client adapters

One Node core, three thin adapters:

- `adapters/claude-code/` for Claude Code.
- `adapters/codex/` for Codex.
- `adapters/opencode/` for opencode.

Each adapter maps the core's model, reasoning and subagent concepts onto what
its client exposes. Core logic never imports a client directly.

<a id="section-5"></a>
## Windows rules

- Build every path with `node:path`; never concatenate separators by hand.
- Do not depend on a shell; spawn commands directly.
- Atomic writes: write to a temporary file, then `rename` over the target.
- Locks: create a directory with `mkdir` and remove it when done; exclusive on
  every supported platform.

<a id="section-6"></a>
## Open questions

- Automatic quota uses Claude Code's status bar, Codex's local sessions and configured
  `opencodeQuota.sources`. Manual readings remain available; missing quota stays unknown.
- Environment snapshots use adapter quota readers by default. Setup requests a manual
  reading when none exists. Saved model/effort choices live in `setup.done.profiles`;
  they confirm configured models only when live discovery is unavailable. Successful
  empty or hidden listings and absent clients remain authoritative. Legacy setup
  markers alone never confirm models; `setup --again` records the choices.
- Do the terminal and desktop apps of each client support plugins, hooks and
  MCP servers? This still has to be verified.

Portuguese version: [DESIGN.pt-BR.md](DESIGN.pt-BR.md).

Architecture note: [ARCHITECTURE.md](ARCHITECTURE.md) (English) and
[ARCHITECTURE.pt-BR.md](ARCHITECTURE.pt-BR.md).
