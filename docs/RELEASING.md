# Release design

Status: D26 design; no build script or publish command exists in this change.
Extends [ARCHITECTURE.md](ARCHITECTURE.md) and [SMOKE.md](SMOKE.md), including the D25 real-client scenario. Portuguese: [RELEASING.pt-BR.md](RELEASING.pt-BR.md).

## What a release is

One release candidate has nine separately identified client × system artifacts from the same source revision and package version. These are Node source bundles, not standalone executables: Node must satisfy `package.json.engines.node`. The package is ESM, dependency-free and private; npm registry publication is not the installation strategy.

Repository inspection: `package.json.bin` identifies the CLI; `src/` and `skills/` hold the shared payload. Only `adapters/claude-code/index.js` is implemented; Codex and opencode have placeholders. No client manifest or marketplace entry is tracked. The in-client runner remains a design in [SMOKE.md](SMOKE.md), not a runnable release prerequisite already delivered.

| Client | Verified installation format; intended artifact | Still unresolved |
| :- | :- | :- |
| Claude Code | Plugin directory with skills, MCP wiring and hooks; metadata at `.claude-plugin/plugin.json`. Also needs a marketplace entry under `.claude-plugin/marketplace.json` pointing to the matching payload. [Manifest](https://code.claude.com/docs/en/plugins-reference), [marketplace](https://code.claude.com/docs/en/plugin-marketplaces). | Marketplace hosting and selection of the system-specific source (Q1). Existing skill/hook copying alone does not prove plugin registration. |
| Codex | Current docs describe root `plugin.json` and `mcp.json`; `.codex-plugin/plugin.json` is a compatibility fallback. Intended artifact bundles the chosen format, skills and adapter. The CLI has a `/plugins` marketplace browser. [Packaging](https://developers.openai.com/plugins/build/plugins), [installation](https://learn.chatgpt.com/docs/plugins). | Supported client versions, manifest choice, marketplace routing and update path (Q2). |
| opencode | Local JS/TS plugin modules load from project `.opencode/plugins/` or global `~/.config/opencode/plugins/`; npm plugins use the config `plugin` array. Intended artifact is a local module plus shared payload. [Plugins](https://opencode.ai/docs/plugins/). Skills and MCP are configured separately: [skills](https://opencode.ai/docs/skills/), [MCP](https://opencode.ai/docs/mcp-servers/). | Module export/bridge and hook evidence, install scope and update procedure (Q3); the core CLI is not itself an opencode plugin. |

Sources checked 2026-10-23. Client schema filenames above are format requirements, not project constants. All project identities, versions, destinations and entry points must come from package metadata and configuration. No unverified platform or client capability is promised by this design.

## Per system

The table is a packaging/proof requirement, not a claim that all adapters work. Destinations resolve from the chosen client scope, its configuration and the actual home; state resolves through `OKWORK_HOME`/`stateRoot`. Never bake the builder's home into an artifact.

| Client | Linux | Windows | macOS |
| :- | :- | :- | :- |
| Claude Code | Configured plugin root; adapter root from explicit option, `CLAUDE_CONFIG_DIR`, then home. User systemd or explicit cron; LF, readable files and executable CLI; configured bin link on PATH. | Same root precedence using native home; schtasks at logon; retain LF and forward-slash substituted paths, readable files and configured command shim on PATH. Native proof by Producer. | Same root precedence using native home; launchd agent; LF, readable files and executable CLI; configured bin link on PATH. Proof by Producer. |
| Codex | Chosen marketplace source resolves plugin root (Q2); user systemd or explicit cron; LF, readable files and executable CLI; configured bin link on PATH. Adapter/proof pending. | Chosen marketplace source and native home (Q2); schtasks; LF, path quoting, readable files and configured command shim on PATH. Adapter pending; Producer proves native pair. | Chosen marketplace source and native home (Q2); launchd; LF, readable files and executable CLI; configured bin link on PATH. Adapter pending; Producer proves pair. |
| opencode | Configured project/global plugin and skill destinations (Q3); user systemd or explicit cron; LF, readable files and executable CLI; configured bin link on PATH. Adapter/proof pending. | Resolve project/global destinations on native Windows (Q3); schtasks; LF, path quoting, readable files and configured command shim on PATH. Adapter pending; Producer proves native pair. | Resolve project/global destinations on native macOS (Q3); launchd; LF, readable files and executable CLI; configured bin link on PATH. Adapter pending; Producer proves pair. |

`src/autostart.js` currently selects systemd on Linux, schtasks on Windows and launchd on macOS. Cron is an explicit alternative, not an automatic systemd fallback; the current cron plan replaces the user's crontab and its uninstall removes it. Producer must settle handling before this path is offered (Q4).

Preserve UTF-8/LF payloads and smoke logs on every system. Check POSIX execute bits after extraction; on Windows check ACL readability and the chosen shim in the intended shell. Derive the command name and target from `package.json.bin` (currently `okit`), and configure the link/shim destination (Q4). Client plugin discovery does not establish PATH. Autostart must resolve the installed Node and CLI paths explicitly; a login shell's PATH is insufficient. Re-plan it after an update moves the installation.

## Artifacts

Names below are templates to implement, not files generated by D26. Let `P` be a filesystem-safe encoding of `package.json.name`, `V` its `version`, and `C`/`S` the client/system identifiers from release configuration. The output directory, archive format/extension `E`, name encoding and supported architectures are configurable choices (Q5); never silently label one architecture as all architectures.

| Output | Derived filename | Contents |
| :- | :- | :- |
| Pair payload (nine) | `<P>-<V>-<C>-<S>.<E>` | Package metadata, license, required `src/`, skills and selected adapter, client manifests/wiring and installation instructions. Preserve referenced relative paths; exclude state, credentials and development-only material. |
| Digest manifest | `<P>-<V>-checksums.sha256` | SHA-256 and exact filename for every payload and accompanying marketplace metadata, notes and checklist; excludes itself. Hash final bytes after packaging. |
| Notes | `<P>-<V>-release-notes.md` | Root changelog's changes for this version, prerequisites, pair filenames, install/update instructions, proof status and known gaps. |
| Proof checklist | `<P>-<V>-release-checklist.md` | Nine pair records with revision, digest, environment, commands, exit codes and evidence links. |

Marketplace schema filenames stay as required by the clients, under configured output roots. Their entries must resolve to the exact pair payload/version; automatic OS selection is **unverified**, not assumed (Q1–Q2). All output identities and metadata must agree with `package.json`, including `license`, `repository`, `bin` and `engines`; no duplicated release-version constant. A new version is a Producer decision, not chosen by this document.

Notes come from the root change history, maintained by hand in `CHANGELOG.md` under `[Unreleased]`. The later notes step extracts the chosen version's changes from that section and preserves source references; never create a second history.

User flow: obtain the chosen pair and digest manifest from the Producer-approved location, verify SHA-256 before extraction, check Node against package engines, extract to the configured destination and follow that pair's instructions. Configure the package bin link/shim, MCP, skills and autostart as applicable, then prove the installation. SHA-256 detects changed bytes; it does not authenticate the download source (Q5).

For Claude Code, register the approved marketplace with `claude plugin marketplace add <source>`, install `claude plugin install <entry>@<marketplace>`, and update with `claude plugin update <entry>@<marketplace>` using generated identities. [Install/update reference](https://code.claude.com/docs/en/discover-plugins). For Codex, register the chosen source with `codex plugin marketplace add <source>` and install through `/plugins`; exact version-pinned update instructions remain Q2. [Authoring reference](https://developers.openai.com/plugins/build/plugins). For opencode, the intended local flow places the module and referenced payload in the configured scope and registers skills/MCP separately; replacement/update details remain Q3.

Before updating, stop the old daemon, retain a backup of configured state and user-edited skills/hooks, verify the new payload, change client references and PATH registration, regenerate moved autostart paths, restart and repeat proof. Existing installers refuse differing skill files and preserve user hook entries: do not promise overwrite-on-update. Migration/rollback guarantees remain Q6.

## Proof per pair

Every checkbox means **both** layers against that pair's installed candidate: `okit smoke` (in-process, scratch home) and the D25 scenario inside the actual named client, loading the real installation with its real login/state. `--dry-run`, rehearsal and mocked spawns are not real-client proof. The planned `okit client-smoke` interface is described in [SMOKE.md](SMOKE.md#in-client-smoke-real); it is not implemented in this checkout. Until its driver and adapter exist and the run is recorded, keep the pair unchecked.

| Pair checklist | Who performs and signs both layers |
| :- | :- |
| [ ] Claude Code × Linux | Linux verifier designated by Producer (Q7) |
| [ ] Claude Code × Windows | Producer on the native Windows machine |
| [ ] Claude Code × macOS | Producer on the macOS machine |
| [ ] Codex × Linux | Linux verifier designated by Producer (Q7) |
| [ ] Codex × Windows | Producer on the native Windows machine |
| [ ] Codex × macOS | Producer on the macOS machine |
| [ ] opencode × Linux | Linux verifier designated by Producer (Q7) |
| [ ] opencode × Windows | Producer on the native Windows machine |
| [ ] opencode × macOS | Producer on the macOS machine |

For each row record: tester/date; source revision; package version; artifact filename and SHA-256; OS/version/architecture; Node/client versions; install scope; resolved plugin/config/state/bin paths; installation and update-from-prior-candidate steps; PATH and permission checks; autostart show/install/restart outcome; both smoke commands, exits, totals and reasons; JSONL/log locations and D25 scenario revision. Attach files or durable links, not just “worked”. Never publish credentials. Fresh install and update must preserve user configuration and state, including after client restart.

In-process evidence requires exit 0 and every selected check passing; use the full check set for release. D25 requires C1–C5 to pass, no failures, and explicit accounting for every later check. Its exit 0 can still mean `PARCIAL`; a missing hook proof prevents the installation gate passing. Missing config means incomplete installation. Keep any unresolved skip/partial row unchecked pending the Producer's decision in Q7; no synthetic or missing result fills another pair.

## Decisions

1. Release separately for Claude Code, Codex and opencode, on Linux, Windows and macOS: all nine pairs remain in scope.
2. Build locally. GitHub Actions does not run the release on its own.
3. Only cut a tag or publish when the Producer explicitly requests it; preparing candidates is separate from cutting a release.
4. Derive versions, names and paths from `package.json` and configuration; no fixed project constants in the release design or future implementation.
5. D26 is documentation only: no code, script, dependency, tag, publication or change to `SMOKE.md`.

## Open questions

1. **Claude Code distribution:** which marketplace owner/source, installation scope and per-system entry/source mapping should be used? Client-side automatic OS selection has not been established.
2. **Codex distribution:** which client versions/surfaces, portable or compatibility manifest, marketplace scope/source mapping, and exact versioned installation/update route? Validate against the chosen real client; the repository has no adapter yet.
3. **opencode integration:** which local module export/bridge, project/global destinations and update sequence? How should its plugin events prove the D25 hook check without assuming Claude's hook format? There is no adapter yet.
4. **Machine integration:** which configurable bin/shim destinations and Windows shells, autostart identities and path overrides? How should existing crontabs be preserved? Current autostart embeds service/task identities; removing those constants is future implementation work, not a D26 code change.
5. **Output configuration:** which archive format, output root, filename encoding, architectures per system, download host and authenticity mechanism? How should per-architecture payloads be named under each pair?
6. **Lifecycle:** which first release version, state/config migration policy, edited-skill handling and rollback guarantees? Keep package private unless separately decided; no npm publication is presumed.
7. **Evidence:** who verifies Linux, where are durable proof records kept, and can any D25 logic skip/partial result be accepted explicitly? Without that decision, incomplete rows remain unproven; Windows/macOS belong to the Producer.

## Implementation plan

Prerequisites: Producer answers the applicable questions; missing client adapters/manifests and D25 drivers land in their own work. Do not substitute placeholders for installation evidence. Each step below is a separate PR with its own line in the root change history and green `node --test`; none authorizes a tag or publication.

| PR | Small deliverable | Acceptance |
| :- | :- | :- |
| 1 — Local build | Add a local script under `scripts/`, with its entry in `package.json`; consume package metadata and configured pair/output settings, preserve shared paths and generate chosen client metadata. | Run locally on a reviewed revision; nine labeled payloads; inspect contents, identity, LF, permissions and path resolution. Unknown client/system or missing adapter refuses; no publishing side effect. |
| 2 — Checksums | Add final-byte SHA-256 manifest generation/verification using Node built-ins. | Every listed file verifies; modified/missing files refuse; no self-hash. |
| 3 — Notes | Generate version-specific notes from the hand-maintained root history's `[Unreleased]` section and pair metadata. | Version and filenames match package/build; missing history refuses; known gaps and install/update instructions appear. |
| 4 — Checklist | Generate the nine-row record template and document collection of installed-candidate evidence. | Both layers recorded per pair, Producer signs Windows/macOS; skips and absent drivers remain visible. Hash notes/checklist only after records are final. |

After these PRs, have the Producer select the candidate version, build locally and collect real-machine proof. The Producer's later explicit release request is the separate trigger to confirm that version, extract its changes from the root history, finalize notes/checksums/checklist, tag and publish the proven artifacts. A version or payload change invalidates its digest and requires fresh proof.
