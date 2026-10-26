# Claude Code adapter

The five functions of `docs/ARCHITECTURE.md` section 4, for Claude Code.
Zero dependencies, Node >= 20 ESM; the core imports this module, never the CLI.

- `spawn(actor, briefing, opts)` — `NATIVE` (default) returns the Agent tool call `{model, effort, prompt}` and starts no process; `PROCESS` (`opts.headless`) goes through `makeSpawner` of `src/spawn-process.js`.
- `readQuota(opts)` — reads `quota/claude-code.json` under the state root. Manual samples keep `source: 'user'`; collector samples return `source: 'automatic'`, `windows`, `remainingPct`, `windowMinutes`, `recordedAt` and `ageMinutes`.
- `capabilities()` — models, efforts and the packaging features of section 4.1.
- `installSkill(name, files, opts)` — copies a skill folder to `<root>/skills/<name>/`, never overwriting a file that differs.
- `installHooks(files, opts)` — writes or merges `<root>/hooks/hooks.json`, keeping the user's own entries.

`root` is `opts.root`, else `$CLAUDE_CONFIG_DIR`, else `~/.claude`. The default
export is the same names in one object.

`okit-plugin statusline-collector [--previous <command> <args...>]` collects the
status bar JSON, then runs the previous bar with identical input and binary output.
`statuslineCollector` in the state root's `config.json` configures `previous`
(command and arguments as an array), `fields` (`rateLimits`, `usedPercentage`,
`resetsAt`), `windows` (input keys mapped to minutes), `timeoutMs`, `maxInputBytes`
and `maxOutputBytes`. Defaults are in `src/profiles.js`. Reset timestamps arrive
in epoch seconds and are stored as ISO dates. The least remaining percentage
selects the top-level quota and window. Missing quota, including API/gateway
input, preserves the existing sample. Previous-command failures are silent and
exit zero; input/output exceeding configured byte limits is discarded.
No shell is implied; name an interpreter explicitly when required.
No settings registration is performed.

O coletor lê a entrada da barra e executa o comando anterior com a mesma entrada
e saída preservada. Configure comando, argumentos, campos, janelas e limites em
`statuslineCollector` no `config.json` da pasta de estado. A menor porcentagem
restante representa a cota. Entrada sem cota preserva a leitura antiga; falhas do
comando anterior não interrompem a barra. `quota show` informa origem e idade;
leituras manuais continuam com origem `user`, automáticas com `automatic`.
Nenhum ajuste do Claude Code é registrado ou alterado.
