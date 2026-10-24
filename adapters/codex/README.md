# Codex adapter

Implements the five functions in `docs/ARCHITECTURE.md` section 4, plus
`configRoot`, with zero dependencies and Node >= 20 ESM.

- `spawn`: `NATIVE` (default) returns `{mode, runId, agentCall: {model, effort, prompt}}`.
  This is a core descriptor; the caller handles native delegation. `PROCESS`
  (`headless: true`) uses `makeSpawner`, with injectable `spawn`, without a shell.
- `readQuota`: reads only `<stateRoot>/quota/codex.json`, the core's user sample,
  and returns `{source: 'user'}` with finite numbers when provided. No client writes.
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

Facts checked locally on 2026-10-24, `codex-cli 0.163.0`:

| Fact | Command that proved it | Gap |
| :- | :- | :- |
| Noninteractive `exec`, `--model`, `--cd`, `--sandbox`, `--json`, `--skip-git-repo-check`, `-c` | `codex exec --help` | No real model launched; effort key not enumerated by help |
| Config root variable `CODEX_HOME`; default `~/.codex/config.toml` | `codex --help`, `codex exec --help` (`--profile`, `--ignore-user-config`) | Actual home configuration not inspected: task also forbids reads outside repository |
| Known models and efforts listed by `capabilities()` | `codex debug models --help`; `codex debug models --bundled` | Bundled catalog only, no account availability check; `ultra` is not supported by every model |
| Plugin installation `codex plugin add <plugin>@<marketplace>` | `codex plugin --help`, `codex plugin add --help` | No installation performed |
| Marketplace source may be local or Git | `codex plugin marketplace --help`, `codex plugin marketplace add --help` | No registration or refresh performed |
| CLI has hook trust and MCP concepts | `codex --help` (`--dangerously-bypass-hook-trust`, `mcp`) | Hook JSON/TOML schema unverified; installer refuses; `hooks: false` describes adapter support |
| No offline quota file/command verified | `codex --help`, `codex exec --help` | Architecture mentions app-server RPC; it is not a verified local file and is not invoked by this adapter |
| Portable root `plugin.json`; shared marketplace/version | `docs/RELEASING.md`, D-Q2 | Default release configuration generates Claude Code metadata only. The installer registers the Codex marketplace and asks the user to activate it in `/plugins`; actual loading remains unproven. |
| Skills payload copied beneath a chosen root | `docs/RELEASING.md`, Codex artifact and D-Q2 | Actual skills/plugins directories not inspected; user must select the plugin root |
| Native Windows/macOS and desktop proof pending | `docs/RELEASING.md`, per-system table | `windows`/`desktop` conservatively false until verified; no claim that the client lacks them |

D-Q3 concerns opencode's global JS module and does not authorize using Claude's
hook format for Codex. No marketplace identity, model default or machine path is
invented. No network, credentials or client quota files are needed by the adapter.
