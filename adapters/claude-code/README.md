# Claude Code adapter

The five functions of `docs/ARCHITECTURE.md` section 4, for Claude Code.
Zero dependencies, Node >= 20 ESM; the core imports this module, never the CLI.

- `spawn(actor, briefing, opts)` — `NATIVE` (default) returns the Agent tool call `{model, effort, prompt}` and starts no process; `PROCESS` (`opts.headless`) goes through `makeSpawner` of `src/spawn-process.js`.
- `readQuota(opts)` — `{source: 'user'}`, with `remainingPct`/`windowMinutes` only when the core stored a number.
- `capabilities()` — models, efforts and the packaging features of section 4.1.
- `installSkill(name, files, opts)` — copies a skill folder to `<root>/skills/<name>/`, never overwriting a file that differs.
- `installHooks(files, opts)` — writes or merges `<root>/hooks/hooks.json`, keeping the user's own entries.

`root` is `opts.root`, else `$CLAUDE_CONFIG_DIR`, else `~/.claude`. The default
export is the same names in one object.