# Release design

Status: D31 implemented: build, checksums, notes, checklist and explicit publication command. Nothing was published by this work.
Extends [ARCHITECTURE.md](ARCHITECTURE.md) and [SMOKE.md](SMOKE.md), including the D25 real-client scenario. Portuguese: [RELEASING.pt-BR.md](RELEASING.pt-BR.md).

## What a release is

One release candidate has nine separately identified client × system artifacts from the same source revision and package version. These are Node source bundles, not standalone executables: Node must satisfy `package.json.engines.node`. The package is ESM, dependency-free and private; npm registry publication is not the installation strategy.

Repository inspection: `package.json.bin` identifies the CLI; `src/` and `skills/` hold the shared payload. The three client adapters are implemented: `adapters/claude-code/index.js`, `adapters/codex/index.js` and `adapters/opencode/index.js`. No client manifest or marketplace entry is tracked. The in-client runner remains a design in [SMOKE.md](SMOKE.md), not a runnable release prerequisite already delivered.

| Client | Verified installation format; intended artifact | Decision / implementation pending |
| :- | :- | :- |
| Claude Code | Plugin directory with skills, MCP wiring and hooks; metadata at `.claude-plugin/plugin.json`. Also needs a marketplace entry under `.claude-plugin/marketplace.json` pointing to the matching payload. [Manifest](https://code.claude.com/docs/en/plugins-reference), [marketplace](https://code.claude.com/docs/en/plugin-marketplaces). | Project GitHub marketplace, user scope and one entry per system ([D-Q1](#decisions)). Existing skill/hook copying alone does not prove plugin registration. |
| Codex | Current docs describe root `plugin.json` and `mcp.json`; `.codex-plugin/plugin.json` is a compatibility fallback. Intended artifact bundles the chosen format, skills and adapter. The CLI has a `/plugins` marketplace browser. [Packaging](https://developers.openai.com/plugins/build/plugins), [installation](https://learn.chatgpt.com/docs/plugins). | Portable root manifest, shared marketplace/version and real installed-client validation ([D-Q2](#decisions)). |
| opencode | Local JS/TS plugin modules load from project `.opencode/plugins/` or global `~/.config/opencode/plugins/`; npm plugins use the config `plugin` array. Intended artifact is a local module plus shared payload. [Plugins](https://opencode.ai/docs/plugins/). Skills and MCP are configured separately: [skills](https://opencode.ai/docs/skills/), [MCP](https://opencode.ai/docs/mcp-servers/). | Global JS module and native-event hook proof; module bridge and update implementation pending ([D-Q3](#decisions)); the core CLI is not itself an opencode plugin. |

Sources checked 2026-10-23. Client schema filenames above are format requirements, not project constants. All project identities, versions, destinations and entry points must come from package metadata and configuration. No unverified platform or client capability is promised by this design.

## Per system

The table is a packaging/proof requirement, not a claim that all adapters work. Destinations resolve from the chosen client scope, its configuration and the actual home; state resolves through `OKWORK_HOME`/`stateRoot`. Never bake the builder's home into an artifact.

| Client | Linux | Windows | macOS |
| :- | :- | :- | :- |
| Claude Code | Configured plugin root; adapter root from explicit option, `CLAUDE_CONFIG_DIR`, then home. User systemd or explicit cron; LF, readable files and executable CLI; configured bin link on PATH. | Same root precedence using native home; schtasks at logon; retain LF and forward-slash substituted paths, readable files and configured command shim on PATH. Native proof by Producer. | Same root precedence using native home; launchd agent; LF, readable files and executable CLI; configured bin link on PATH. Proof by Producer. |
| Codex | Chosen marketplace source resolves plugin root ([D-Q2](#decisions)); user systemd or explicit cron; LF, readable files and executable CLI; configured bin link on PATH. Adapter/proof pending. | Chosen marketplace source and native home ([D-Q2](#decisions)); schtasks; LF, path quoting, readable files and configured command shim on PATH. Adapter pending; Producer proves native pair. | Chosen marketplace source and native home ([D-Q2](#decisions)); launchd; LF, readable files and executable CLI; configured bin link on PATH. Adapter pending; Producer proves pair. |
| opencode | Configured global plugin and skill destinations ([D-Q3](#decisions)); user systemd or explicit cron; LF, readable files and executable CLI; configured bin link on PATH. Adapter/proof pending. | Resolve global destinations on native Windows ([D-Q3](#decisions)); schtasks; LF, path quoting, readable files and configured command shim on PATH. Adapter pending; Producer proves native pair. | Resolve global destinations on native macOS ([D-Q3](#decisions)); launchd; LF, readable files and executable CLI; configured bin link on PATH. Adapter pending; Producer proves pair. |

`src/autostart.js` currently selects systemd on Linux, schtasks on Windows and launchd on macOS. Cron is an explicit alternative, not an automatic systemd fallback; the current cron plan replaces the user's crontab and its uninstall removes it. Preserving existing cron lines is required before this path is offered ([D-Q4](#decisions)).

Preserve UTF-8/LF payloads and smoke logs on every system. Check POSIX execute bits after extraction; on Windows check ACL readability and the chosen shim in the intended shell. Derive the command name and target from `package.json.bin` (currently `okit`), and configure the link/shim destination ([D-Q4](#decisions)). Client plugin discovery does not establish PATH. Autostart must resolve the installed Node and CLI paths explicitly; a login shell's PATH is insufficient. Re-plan it after an update moves the installation.

## Artifacts

Names below are templates to implement, not files generated by D26. Let `P` be a filesystem-safe encoding of `package.json.name`, `V` its `version`, `C`/`S` the client/system identifiers from release configuration and `A` the architecture. The output directory, archive format/extension `E`, name encoding and supported architectures come from configuration under [D-Q5](#decisions); never silently label one architecture as all architectures.

| Output | Derived filename | Contents |
| :- | :- | :- |
| Pair payload (nine) | `<P>-<V>-<C>-<S>-<A>.<E>` | Package metadata, license, required `src/`, skills and selected adapter, client manifests/wiring and installation instructions. Preserve referenced relative paths; exclude state, credentials and development-only material. |
| Digest manifest | `<P>-<V>-checksums.sha256` | SHA-256 and exact filename for every payload and accompanying marketplace metadata, notes and checklist; excludes itself. Hash final bytes after packaging. |
| Notes | `<P>-<V>-release-notes.md` | Root changelog's changes for this version, prerequisites, pair filenames, install/update instructions, proof status and known gaps. |
| Proof checklist | `<P>-<V>-release-checklist.md` | Nine pair records with revision, digest, environment, commands, exit codes and evidence links. |

Marketplace schema filenames stay as required by the clients, under configured output roots. Their entries must resolve to the exact pair payload/version; automatic OS selection is **unverified**, not assumed ([D-Q1 / D-Q2](#decisions)). All output identities and metadata must agree with `package.json`, including `license`, `repository`, `bin` and `engines`; no duplicated release-version constant. A new version is a Producer decision, not chosen by this document.

Notes come from the manually maintained root change history in `CHANGELOG.md` under `[Unreleased]`. The notes command extracts that section verbatim; never create a second history or a fragment directory. Keep newest entries first within each category.

The digest manifest is written and checked by `src/release/checksums.js`, driven by `scripts/checksums.js` (`npm run release:checksums -- write|verify`). One line per file carries the lowercase SHA-256 digest, two spaces and the exact name, ordered by name, LF and UTF-8, computed over the final bytes of the file without holding it in memory; the manifest never carries its own hash. A verification refuses an altered, absent or unlisted file, a malformed line and an unsafe path.

User flow: obtain the chosen pair and digest manifest from the GitHub releases page ([D-Q5](#decisions)), verify SHA-256 before extraction, check Node against package engines, extract to the configured destination and follow that pair's instructions. Configure the package bin link/shim, MCP, skills and autostart as applicable, then prove the installation. SHA-256 detects changed bytes; it does not authenticate the download source ([D-Q5](#decisions)).

For Claude Code, register the approved marketplace with `claude plugin marketplace add <source>`, install `claude plugin install <entry>@<marketplace>`, and update with `claude plugin update <entry>@<marketplace>` using generated identities. [Install/update reference](https://code.claude.com/docs/en/discover-plugins). For Codex, register the chosen source with `codex plugin marketplace add <source>` and install through `/plugins`; use the shared marketplace/version and validate the update route against the installed client ([D-Q2](#decisions)). [Authoring reference](https://developers.openai.com/plugins/build/plugins). For opencode, the intended local flow places the module and referenced payload in the configured scope and registers skills/MCP separately; use the global module and native-event proof ([D-Q3](#decisions)); replacement/update implementation remains pending.

Before updating, stop the old daemon, retain a backup of configured state and user-edited skills/hooks, verify the new payload, change client references and PATH registration, regenerate moved autostart paths, restart and repeat proof. Existing installers refuse differing skill files and preserve user hook entries: do not promise overwrite-on-update. Back up state and user-edited skills and support rollback to the previous version ([D-Q6](#decisions)).

## The local build

PR 1 is the script `scripts/build-release.js`, also `npm run release:build`. It builds the pair payloads on the machine that runs it, writes them under the output folder and publishes nothing: no tag, no upload, no network. The values it uses — the clients, the systems, the architectures, the archive format of each system, the output folder, the files that enter a payload, the client-required file names and the name model — live in the `release` block of `DEFAULT_CONFIG` and the user configuration may replace them.

```
node scripts/build-release.js [--out <dir>] [--pair <client>:<system>] [--arch <arch>] [--dry-run]
```

| Flag | What it does |
| :- | :- |
| `--out <dir>` | Writes the archives to `<dir>`. Without it they go to the configured output folder, under the repository. |
| `--pair <client>:<system>` | Builds only that client and system, e.g. `claude-code:linux`. Without it every configured pair is built. |
| `--arch <arch>` | Builds only that architecture, e.g. `x64`. Without it every configured architecture is built. |
| `--dry-run` | Lists the pairs it would build and the ones it refuses, and writes nothing. |

The name of each archive is the configured name model filled with the package name, the version, the client, the system, the architecture and the extension, so `<P>-<V>-<C>-<S>-<A>.<E>`: `okit-plugin-0.1.0-claude-code-linux-x64.tar.gz`. The name, the version, the licence, the repository, the bin and the engines come from `package.json`; the payload carries the package metadata, the licence, the required `src/`, the skills, the adapter of the chosen client, the client metadata and the installation instructions of the clients the configuration names, and never the state, the credentials, `.git`, `.delegate`, `test/` or the development-only material.

The archives are deterministic: the entries are sorted, the modification time is `SOURCE_DATE_EPOCH` or the date of the commit, the modes are explicit (`0755` for the command of the package, `0644` for the rest) and the lines end with LF. Two builds of the same source produce the same bytes.

A pair that cannot be built is refused with its reason and no empty package is written in its place: a client whose adapter is missing, an unknown client or system, a system without an archive format. A client that has an adapter is built, as any other; the three client adapters of this repository (`claude-code`, `codex` and `opencode`) all build their pairs. The command then lists the refused pairs and answers with a code that is not zero.

## Release notes

PR 3 is `scripts/release-notes.js`, also `npm run release:notes -- [flags]`:

```sh
node scripts/release-notes.js [--out <dir>] [--version <version>] [--dry-run]
```

| Flag | What it does |
| :- | :- |
| `--out <dir>` | Writes notes here; defaults to the configured release output directory under the repository. |
| `--version <version>` | Must match `package.json.version`; defaults to that version. |
| `--dry-run` | Lists the notes destination and every pair filename without writing. |

The configured `release.notes` texts, filename template and history path combine with package metadata and the build's pair plan. Deterministic output includes Node engines, all nine payload filenames, the checksum manifest name, install/update instructions and every pair's proof and gaps. With no proof record, all pairs are `not proven`; Windows/macOS belong to the Producer. Optional `release.notes.proofFile` names a repository-relative JSON object keyed by `client:system`, with values `not proven`, `proven` or `PARCIAL` (or their configured labels). Partial proof always remains in known gaps.

Missing history, absent or empty `[Unreleased]` (headings/comments alone do not count), mismatched version or invalid proof refuses with a reason and writes no output. Source lines retain their text and whitespace. This command neither publishes nor hashes notes; hash notes/checklist only after their records are final, using the checksum command.

## Release checklist

PR 4 is `scripts/release-checklist.js`, also `npm run release:checklist -- [flags]`:

```sh
node scripts/release-checklist.js [--out <dir>] [--version <version>] [--revision <revision>] [--dry-run]
```

| Flag | What it does |
| :- | :- |
| `--out <dir>` | Writes the checklist here; defaults to the configured release output directory. |
| `--version <version>` | Must match `package.json.version`; defaults to that version. |
| `--revision <revision>` | Records the reviewed source revision; omitted means blank for manual completion. |
| `--dry-run` | Lists the destination and nine configured pair filenames without writing. |

`release.checklist` configures the filename template, title, fields, layer texts and signature line. Pair signers inherit `release.notes.proofBy`, with optional `release.checklist.proofBy` overrides; the same optional proof JSON and status labels as notes are read. Each build pair gets an unchecked section with environment, installation/update, both smoke layers, explicit skip/absent-driver fields and evidence locations. Windows/macOS require the Producer signature. This command prepares evidence records; it runs no smoke and publishes nothing.

Payload SHA-256 values come from the checksum manifest in the output directory when present; otherwise they remain blank. No hashes are calculated here: hash notes/checklist only after final completion. A mismatched version, invalid pair/proof/manifest or existing checklist with different contents refuses with a reason and writes nothing. Identical reruns are allowed; there is no `--force`, so filled evidence is preserved. Keep completed proof records under `docs/` as required by D-Q7.

## Publishing

```sh
npm run release:publish -- [--dry-run] [--out <dir>]
npm run release:publish -- --publish [--out <dir>]
```

Dry-run is the default: it prepares local files and prints the title, tag, target SHA, pre-release status, exact attachments and full shell-quoted `gh` command; it creates no tag or release. Both modes require a clean tree, fetch `origin/main`, compare HEAD with it and refuse an existing local or remote tag. Fetch and remote tag lookup require network access; no publication happens without `--publish`. Run from a committed checkout.

The command reuses the nine-pair build, writes a payload checksum manifest, generates notes and the checklist (including payload hashes and source SHA), then writes the final manifest covering payloads, notes and checklist and verifies it. Refused pairs/versions, invalid proofs, changed checklists and checksum failures stop publication. Only the generated allowlist is attached; unrelated output files fail checksum verification.

`release.publish` configures the GitHub executable (`executable: 'gh'`), git executable (`gitExecutable: 'git'`), remote (`remote: 'origin'`), branch (`branch: 'main'`), minimum client × system count (`requiredPairs: 9`), tag prefix, title template, output directory, attachment groups (`payloads`, `notes`, `checklist`, `checksums`) and pre-release notice. Destination comes from the configured remote with URL userinfo removed; package name/version come from `package.json` (D-Q6: 0.1.0). Use a separate output folder per candidate; completed evidence stays in `docs/` per D-Q7.

With `--publish`, verified files go to `gh release create` with the tag, configured repository, target SHA, title and notes file, with `--` before attachment paths. `--prerelease` is mandatory when the number of distinct built client × system pairs is below `requiredPairs` or any pair lacks the configured proven status in `release.notes.proofFile`; reducing clients/systems does not reduce that minimum. Missing/partial proofs remain in the notes with the configured warning. This command does not establish real-client proof.
Immediately before invoking GitHub, git checks run again: a dirty tree (including generated changes in tracked output paths), changed SHA or existing tag refuses publication. `SAFE_TAG` restricts the assembled tag to a single Git ref component beginning with a letter, digit or underscore, followed by letters, digits, dots, underscores, pluses or hyphens; consecutive dots, trailing dots and a `.lock` suffix are forbidden. `GIT_TAG_NAMESPACE` names the Git protocol prefix `refs/tags/`. Failures after GitHub starts return nonzero with `publish failed (the release may be partly created): tag <tag>: <error>`; inspect the remote release before retrying. Validation refusals retain `refused: …`.

## Proof per pair

Every checkbox means **both** layers against that pair's installed candidate: `okit smoke` (in-process, scratch home) and the D25 scenario inside the actual named client, loading the real installation with its real login/state. `--dry-run`, rehearsal and mocked spawns are not real-client proof. The planned `okit client-smoke` interface is described in [SMOKE.md](SMOKE.md#in-client-smoke-real); it is not implemented in this checkout. Until its driver and adapter exist and the run is recorded, keep the pair unchecked.

| Pair checklist | Who performs and signs both layers |
| :- | :- |
| [ ] Claude Code × Linux | Director’s Linux machine ([D-Q7](#decisions)) |
| [ ] Claude Code × Windows | Producer on the native Windows machine |
| [ ] Claude Code × macOS | Producer on the macOS machine |
| [ ] Codex × Linux | Director’s Linux machine ([D-Q7](#decisions)) |
| [ ] Codex × Windows | Producer on the native Windows machine |
| [ ] Codex × macOS | Producer on the macOS machine |
| [ ] opencode × Linux | Director’s Linux machine ([D-Q7](#decisions)) |
| [ ] opencode × Windows | Producer on the native Windows machine |
| [ ] opencode × macOS | Producer on the macOS machine |

For each row record: tester/date; source revision; package version; artifact filename and SHA-256; OS/version/architecture; Node/client versions; install scope; resolved plugin/config/state/bin paths; installation and update-from-prior-candidate steps; PATH and permission checks; autostart show/install/restart outcome; both smoke commands, exits, totals and reasons; JSONL/log locations and D25 scenario revision. Attach files or durable links, not just “worked”. Never publish credentials. Fresh install and update must preserve user configuration and state, including after client restart.

In-process evidence requires exit 0 and every selected check passing; use the full check set for release. D25 requires C1–C5 to pass, no failures, and explicit accounting for every later check. Its exit 0 can still mean `PARCIAL`; a missing hook proof prevents the installation gate passing. Missing config means incomplete installation. Keep any unresolved skip/partial row unchecked until the Producer gives written acceptance ([D-Q7](#decisions)); no synthetic or missing result fills another pair.

## Decisions

1. Release separately for Claude Code, Codex and opencode, on Linux, Windows and macOS: all nine pairs remain in scope.
2. Build locally. GitHub Actions does not run the release on its own.
3. Only cut a tag or publish when the Producer explicitly requests it; preparing candidates is separate from cutting a release.
4. Derive versions, names and paths from `package.json` and configuration; no fixed project constants in the release design or future implementation.
5. D26 is documentation only: no code, script, dependency, tag, publication or change to `SMOKE.md`.
6. **D-Q1 — Claude Code:** use the project's GitHub marketplace (`asantos43/okit-plugin`), user scope and one entry per system.
7. **D-Q2 — Codex:** use the portable manifest (`plugin.json` at the root), in the same marketplace and at the same version as Claude Code; validate against the actual installed Codex client.
8. **D-Q3 — opencode:** install a global JS module in `~/.config/opencode/plugins/`; prove the D25 hook through opencode's own events, without assuming Claude's hook format.
9. **D-Q4 — Machine integration:** derive bin/shim destinations and autostart identities from configuration, with no code constants; cron preserves existing lines.
10. **D-Q5 — Output:** use `.tar.gz` on Linux and macOS, `.zip` on Windows, one payload per architecture, named `<P>-<V>-<C>-<S>.<E>`, with a SHA-256 manifest; download from the GitHub releases page.
11. **D-Q6 — Lifecycle:** start at `0.1.0`, keep the package private (no npm); before updating, back up state and user-edited skills, with rollback to the previous version.
12. **D-Q7 — Proof:** the Producer verifies Windows and macOS; Linux uses the Director's machine. Keep proof records in this repository's `docs/`; a partial smoke skip requires the Producer's written acceptance.

## Open questions

No open questions remain: Q1 to Q7 were answered by the Producer on 2026-10-23.

## Implementation plan

Prerequisites: Producer answers the applicable questions; missing client adapters/manifests and D25 drivers land in their own work. Do not substitute placeholders for installation evidence. Each step below is a separate PR with its own line in the root change history and green `node --test`; none authorizes a tag or publication.

| PR | Small deliverable | Acceptance |
| :- | :- | :- |
| 1 — Local build (done) | Add a local script under `scripts/`, with its entry in `package.json`; consume package metadata and configured pair/output settings, preserve shared paths and generate chosen client metadata. | Run locally on a reviewed revision; nine labeled payloads; inspect contents, identity, LF, permissions and path resolution. Unknown client/system or missing adapter refuses; no publishing side effect. |
| 2 — Checksums (done) | Add final-byte SHA-256 manifest generation/verification using Node built-ins: `src/release/checksums.js` and `scripts/checksums.js`. | Every listed file verifies; modified/missing files refuse; no self-hash. |
| 3 — Notes (done) | Generate version-specific notes from the root history's `[Unreleased]` section and pair metadata. | Version and filenames match package/build; missing history refuses; known gaps and install/update instructions appear. |
| 4 — Checklist (done) | Generate the nine-row record template and document collection of installed-candidate evidence. | Both layers recorded per pair, Producer signs Windows/macOS; skips and absent drivers remain visible. Hash notes/checklist only after records are final. |
| D31 — Publishing (done) | Add default dry-run and explicit verified GitHub publication; version 0.1.0. | Fake GitHub tests; clean origin/main revision, absent tag, verified final manifest; pre-release until nine proven pairs. |

After these PRs, have the Producer select the candidate version, build locally and collect real-machine proof. The Producer's later explicit release request is the separate trigger to confirm that version, extract its changes from the root history, finalize notes/checksums/checklist, tag and publish the proven artifacts. A version or payload change invalidates its digest and requires fresh proof.
