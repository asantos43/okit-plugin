# opencode adapter

Node >= 20, ESM, zero dependencies. Implements section 4 of
`docs/ARCHITECTURE.md`; installation follows D-Q3 in `docs/RELEASING.md`.

- `spawn(actor, briefing, opts)` uses `makeSpawner` in `PROCESS` mode by default:
  `opencode run --dir <cwd> --model <provider/model> [--variant <effort>] --format json <briefing>`.
  Arguments are passed without a shell. `opts.spawn` injects a fake process.
- `readQuota({stateRoot, env})` reads only core `quota/opencode.json` and returns
  `{source: 'user'}` with finite stored numbers when available. It never writes quota.
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

Evidence collected on 2026-10-24, installed client 1.19.4. Only help/debug
commands ran; no model, network request or real-client proof was requested.

| Fact | Command / evidence | Gap |
| :- | :- | :- |
| Process flags, provider/model syntax, JSON events | `opencode --help`; `opencode run --help` | No real model run; Task/NATIVE bridge remains unimplemented and is refused. |
| Variant examples: high, max, minimal | `opencode run --help` | Provider-dependent availability; no model catalogue queried offline. |
| Config/data roots under home | `opencode debug paths` | Real config/data files and existing global plugins not inspected: task rules prohibit reads outside repository. |
| XDG config root override | `XDG_CONFIG_HOME=<temporary>/xdg-config opencode debug paths` | Windows/macOS native proof pending. |
| OPENCODE_CONFIG_DIR loads config | Temporary `opencode.json` with username marker; isolated XDG roots; `OPENCODE_CONFIG_DIR=<temporary> opencode --pure debug config` returned the marker | `debug paths` still displays the XDG root; the override adds a config location. Real-home plugin discovery untested. |
| Global JS plugin installation and skills | `docs/RELEASING.md`, D-Q3 and per-system table | Installation exposed; D25 native-event bridge and activation proof deferred. `hooks: true` means plugin installation, not a hooks JSON schema. |
| MCP support | `opencode --help` lists `mcp`; release design separates MCP wiring | MCP installation is outside this adapter contract. |
| No verified plan quota source | `opencode stats --help` describes token usage/cost statistics | Local quota file/API not established; sample is core user data, never inferred from costs. |
| Desktop/Windows not proven here | Release per-system proof requirements | Capability flags remain false until verified; this does not assert the client lacks support. |

D-Q2 concerns Codex packaging and introduces no opencode manifest requirement.
This adapter edits neither Claude Code nor the smoke driver. Module installation
preserves other plugins and config entries, including user edits, on repeat calls.
