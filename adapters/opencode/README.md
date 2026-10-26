# opencode adapter

Node >= 20, ESM, zero dependencies. Implements section 4 of
`docs/maintainers/ARCHITECTURE.md`; installation follows D-Q3 in `docs/maintainers/RELEASING.md`.

- `spawn(actor, briefing, opts)` uses `makeSpawner` in `PROCESS` mode by default:
  `opencode run --dir <cwd> --model <provider/model> [--variant <effort>] --format json <briefing>`.
  Arguments are passed without a shell. `opts.spawn` injects a fake process.
- `readQuota({stateRoot, env, config, now})` first reads `opencodeQuota.sources`:
  provider names map to `{command: ['program', 'argument']}` or `{file: 'path'}`.
  Commands reuse the listing executor, without a shell or added environment.
  No credentials are read. Output and execution time are bounded by configuration.
  The tightest valid provider/window returns `source: 'automatic'`, `provider`,
  `remainingPct`, `windowMinutes`, `windows`, `recordedAt`, and `ageMinutes`.
  Missing, invalid or old sources fall back to `quota/opencode.json` (`source: 'user'`).
  The adapter never writes quota.
- `capabilities()` returns fresh arrays. Models are empty until caller discovery;
  efforts list only examples verified in installed help, not an exhaustive enum.
  Provider variants are accepted as supplied by the actor.
- `installSkill(name, files, opts)` copies a folder containing `SKILL.md` to
  `<root>/skills/<name>`; differing files survive, with reasons in `skipped`.
- `installHooks(files, opts)` takes a path to a `.js` plugin module and installs
  its basename in `<root>/plugins/`. Exclusive publication preserves existing
  modules; identical bytes return `written: false`. No config entries are edited.
  Relative imports require the caller to install the corresponding payload.

`configRoot(opts)` resolves `opts.root`, then `OPENCODE_CONFIG_DIR`, then
`XDG_CONFIG_HOME/opencode`, then `os.homedir()/.config/opencode`.
`opts.env` replaces environment lookup. No builder home is embedded.
The default export includes `CLIENT` and all six functions.

`opencodeQuota` defaults: `sources: {}`, `timeoutMs: 3000`,
`maxOutputBytes: 1048576`, `maxAgeMinutes: 120`, `version: 1`,
`windows: {five_hour: 300, weekly: 10080}`. `fields` configures contract names.
Sources print one JSON with `version`, `company`, `source`, epoch-second `read_at`,
and `five_hour`/`weekly` windows (absent windows may be null). Each window has
integer `remaining_percent` (0–100) and epoch-second or null `reset_at`.
At least one window is required. An `error` object provides no reading.

Português: configure fontes por provedor em `opencodeQuota.sources`, com
`command` (lista de palavras) ou `file` (caminho). O menor restante válido
prevalece; erro, prazo excedido, saída grande demais ou leitura antiga usam o
valor manual. O plugin não lê credenciais nem altera o ambiente do comando.
Origem, idade e provedor aparecem em `quota show` e `status`.

Evidence collected on 2026-10-24, installed client 1.19.4. Only help/debug
commands ran; no model, network request or real-client proof was requested.

| Fact | Command / evidence | Gap |
| :- | :- | :- |
| Process flags, provider/model syntax, JSON events | `opencode --help`; `opencode run --help` | No real model run; Task/NATIVE bridge remains unimplemented and is refused. |
| Variant examples: high, max, minimal | `opencode run --help` | Provider-dependent availability; no model catalogue queried offline. |
| Config/data roots under home | `opencode debug paths` | Real config/data files and existing global plugins not inspected: task rules prohibit reads outside repository. |
| XDG config root override | `XDG_CONFIG_HOME=<temporary>/xdg-config opencode debug paths` | Windows/macOS native proof pending. |
| OPENCODE_CONFIG_DIR loads config | Temporary `opencode.json` with username marker; isolated XDG roots; `OPENCODE_CONFIG_DIR=<temporary> opencode --pure debug config` returned the marker | `debug paths` still displays the XDG root; the override adds a config location. Real-home plugin discovery untested. |
| Global JS plugin installation and skills | `docs/maintainers/RELEASING.md`, D-Q3 and per-system table | Installation exposed; D25 native-event bridge and activation proof deferred. `hooks: true` means plugin installation, not a hooks JSON schema. |
| MCP support | `opencode --help` lists `mcp`; release design separates MCP wiring | MCP installation is outside this adapter contract. |
| No verified plan quota source | `opencode stats --help` describes token usage/cost statistics | Local quota file/API not established; sample is core user data, never inferred from costs. |
| Desktop/Windows not proven here | Release per-system proof requirements | Capability flags remain false until verified; this does not assert the client lacks support. |

D-Q2 concerns Codex packaging and introduces no opencode manifest requirement.
This adapter edits neither Claude Code nor the smoke driver. Module installation
preserves other plugins and config entries, including user edits, on repeat calls.
