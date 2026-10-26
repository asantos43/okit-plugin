# Codex adapter

Implements the five functions in `docs/maintainers/ARCHITECTURE.md` section 4, plus
`configRoot`, with zero dependencies and Node >= 20 ESM.

- `spawn`: `NATIVE` (default) returns `{mode, runId, agentCall: {model, effort, prompt}}`.
  This is a core descriptor; the caller handles native delegation. `PROCESS`
  (`headless: true`) uses `makeSpawner`, with injectable `spawn`, without a shell.
- `readQuota`: uses a fresh automatic session reading when newer than
  `<stateRoot>/quota/codex.json`; otherwise uses that manual sample. Returns
  `source: 'automatic'|'manual'`, `recordedAt` and `ageMinutes` when known.
  No client writes. / Usa a leitura automática recente quando mais nova que
  a amostra manual; caso contrário usa a manual. Informa origem e idade, sem
  gravar nos arquivos do cliente.
- `capabilities`: a fresh known-model/effort table from the bundled catalog;
  availability and effort support depend on the model and account.
- `installSkill`: copies to `<root>/skills/<name>/`; differing files are preserved,
  identical files are skipped. Copying does not register a marketplace plugin.
- `installHooks`: rejects with an explicit reason and performs no I/O. Hooks exist
  in this CLI, but its configuration schema could not be verified within scope.

Root precedence: `opts.root`, then `opts.env.CODEX_HOME` (default `process.env`),
then `path.join(os.homedir(), '.codex')`. No builder home is embedded.
For skill packaging, pass the chosen plugin root explicitly. Automatic discovery
of `<CODEX_HOME>/skills` is unverified; copying there alone does not prove loading.
PROCESS also passes the resolved root as `CODEX_HOME` to the child.

`readCodexSessionQuota` in `session-quota.js` returns `null` without a reading;
it never throws. `codexQuota` in `config.json` controls the sessions directory,
environment override name, recent-file count, initial/maximum tail bytes,
maximum age, filename prefix/suffix and `fields.*`. Defaults live in
`DEFAULT_CONFIG.codexQuota`; `config set codexQuota.tailBytes 32768` changes
the initial read size. Files are ranked by mtime; candidates without a usable
event are skipped. The last valid event of the first usable file wins.
A stale last event does not cause an older event to be reused. Windows carry
`windowMinutes`, `remainingPct`, `resetsAt` (ISO time converted from seconds);
the overall percentage is the smallest remaining percentage of the windows.
Only bounded tails are read, with `openFile` injectable for byte-count tests.
Symbolic links are skipped. / Sem leitura, retorna `null`, sem lançar erro.
A configuração controla pasta, variável de ambiente, arquivos recentes,
janela de bytes, idade e campos. A última leitura válida do arquivo mais
recente vence; leitura vencida não recupera evento anterior. A cota usa o
menor percentual restante das janelas. Links simbólicos são ignorados.

Facts checked locally on 2026-10-24, `codex-cli 0.163.0`:

| Fact | Command that proved it | Gap |
| :- | :- | :- |
| Noninteractive `exec`, `--model`, `--cd`, `--sandbox`, `--json`, `--skip-git-repo-check`, `-c` | `codex exec --help` | No real model launched; effort key not enumerated by help |
| Config root variable `CODEX_HOME`; default `~/.codex/config.toml` | `codex --help`, `codex exec --help` (`--profile`, `--ignore-user-config`) | Actual home configuration not inspected: task also forbids reads outside repository |
| Known models and efforts listed by `capabilities()` | `codex debug models --help`; `codex debug models --bundled` | Bundled catalog only, no account availability check; `ultra` is not supported by every model |
| Plugin installation `codex plugin add <plugin>@<marketplace>` | `codex plugin --help`, `codex plugin add --help` | No installation performed |
| Marketplace source may be local or Git | `codex plugin marketplace --help`, `codex plugin marketplace add --help` | No registration or refresh performed |
| CLI has hook trust and MCP concepts | `codex --help` (`--dangerously-bypass-hook-trust`, `mcp`) | Hook JSON/TOML schema unverified; installer refuses; `hooks: false` describes adapter support |
| Local session quota | Supplied verified `event_msg` / `token_count` / `rate_limits` format | Reads session tails only; no RPC or quota command |
| Portable root `plugin.json`; shared marketplace/version | `docs/maintainers/RELEASING.md`, D-Q2 | Default release configuration generates Claude Code metadata only. The installer registers the Codex marketplace and asks the user to activate it in `/plugins`; actual loading remains unproven. |
| Skills payload copied beneath a chosen root | `docs/maintainers/RELEASING.md`, Codex artifact and D-Q2 | Actual skills/plugins directories not inspected; user must select the plugin root |
| Native Windows/macOS and desktop proof pending | `docs/maintainers/RELEASING.md`, per-system table | `windows`/`desktop` conservatively false until verified; no claim that the client lacks them |

D-Q3 concerns opencode's global JS module and does not authorize using Claude's
hook format for Codex. No marketplace identity, model default or machine path is
invented. Session quota needs no network or credentials.
