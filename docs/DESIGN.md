# Design

Implementation: see [ARCHITECTURE.md](ARCHITECTURE.md) for the current modules.

## Goals

- Spread work over the subagents the AI client already has.
- Take any unit of delegable work, not only code: research, writing, documents, data cleanup, analysis, planning, reviews, file operations.
- Classify each demand by effort so the right subagent gets it.
- Choose the subagent's model and reasoning effort by class and by quota.
- Keep a small inbox and standing orders for the Director.
- Run on Linux, macOS and Windows with the same core.
- Zero dependencies, state in plain JSON files.

## Non-goals

- No panel.
- No work across clients.
- No database dependency; records use JSON and event logs use JSONL.

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

The Director delegates the work, critiques the subagent output and consolidates
the results.

## Per-client adapters

One Node core, three thin adapters:

- `adapters/claude-code/` for Claude Code.
- `adapters/codex/` for Codex.
- `adapters/opencode/` for opencode.

Each adapter maps the core's model, reasoning and subagent concepts onto what
its client exposes. Core logic never imports a client directly.

## Windows rules

- Build every path with `node:path`; never concatenate separators by hand.
- Do not depend on a shell; spawn commands directly.
- Atomic writes: write to a temporary file, then `rename` over the target.
- Locks: create a directory with `mkdir` and remove it when done; exclusive on
  every supported platform.

## Open questions

- Bundled adapters read user-supplied quota from the core state; no quota API is queried.
- Do the terminal and desktop apps of each client support plugins, hooks and
  MCP servers? This still has to be verified.

Portuguese version: [DESIGN.pt-BR.md](DESIGN.pt-BR.md).

Architecture note: [ARCHITECTURE.md](ARCHITECTURE.md) (English) and
[ARCHITECTURE.pt-BR.md](ARCHITECTURE.pt-BR.md).
