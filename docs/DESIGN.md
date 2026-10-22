# Design

Status: design phase (pre-alpha).

## Goals

- Spread work over the subagents the AI coding client already has.
- Classify each task by effort so the right subagent gets it.
- Choose the subagent's model and reasoning effort by class and by quota.
- Keep a small inbox and standing orders for the Director.
- Run on Linux, macOS and Windows with the same core.
- Zero dependencies, state in plain JSON files.

## Non-goals

- No panel.
- No work across clients.
- No state outside plain JSON files.

## The three pieces

### 1. Effort classification

Each task is classified as simple, normal or hard. The class drives the next
step and is what the tests pin down.

### 2. Subagent choice by class and quota

The class sets a base model and reasoning effort; the client's remaining quota
raises or lowers the final choice. The Director never invents a model that the
client does not expose.

### 3. Inbox and standing orders

A small inbox holds pending tasks; standing orders hold instructions that apply
to every task until removed. Both live in JSON files.

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

- How does each client expose its remaining quota?
- Do the terminal and desktop apps of each client support plugins, hooks and
  MCP servers? This still has to be verified.

Portuguese version: [DESIGN.pt-BR.md](DESIGN.pt-BR.md).