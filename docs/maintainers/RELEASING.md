# Release design

![okit-plugin: Maintainers](../images/banners/maintainers.svg)

Release artifact, bootstrap, publication and native proof requirements for maintainers.

<a id="contents"></a>
## Contents

- [What a release is](#section-1)
- [Per system](#section-2)
- [Artifacts](#section-3)
- [Installer and updater](#section-4)
- [The local build](#section-5)
- [Release notes](#section-6)
- [Release checklist](#section-7)
- [Publishing](#section-8)
- [Proof per pair](#section-9)
- [Decisions](#section-10)
- [Open questions](#section-11)
- [Implementation status](#section-12)

Command migration: package `bin` and `install.command` now name `okit-plugin`; install/update migrate owned legacy `okit` links without touching the kit. Existing 0.2.0 records remain supported; MCP and state identities stay unchanged.

Status: published (see the releases page for the current version). Build, checksums, notes, checklist, publisher and installer are implemented; publication does not establish real-client proof.
Extends [ARCHITECTURE.md](ARCHITECTURE.md) and [SMOKE.md](SMOKE.md), including the in-client smoke real-client scenario. Portuguese: [RELEASING.pt-BR.md](RELEASING.pt-BR.md).

<a id="section-1"></a>
## What a release is

One release candidate has nine client × system payloads, each published for two architectures (x64 and arm64): eighteen separately identified artifacts from the same source revision and package version, plus the checksum manifest. The code is plain Node with no native part, so the x64 and arm64 archives of one client and system are byte-identical; the architecture in the name only routes the installer to an asset. The arm64 pairs are therefore "payload identical to x64; not run on real arm64 hardware".

Supported system/architecture pairs (the installers refuse anything else and list these): linux/x64, linux/arm64, macos/x64, macos/arm64, windows/x64, windows/arm64. macOS under Rosetta reports x86_64 and gets the x64 asset; Windows arm64 reports arm64. These are Node source bundles, not standalone executables: Node must satisfy `package.json.engines.node`. The package is ESM, dependency-free and private; npm registry publication is not the installation strategy.

The payload contains `src/`, `skills/`, the selected adapter and shared adapters from `release.sharedAdapters` (or `release.adapters` when absent). `release.clientFiles` defines generated manifests, MCP wiring and hooks per client. Codex receives marketplace registration and activation instructions for `/plugins`; opencode receives a global module and skills. Generated files are not tracked at the checkout root.

<a id="section-2"></a>
## Per system

The table is a packaging/proof requirement, not a claim that all adapters work. Destinations resolve from the chosen client scope, its configuration and the actual home; state resolves through `OKWORK_HOME`/`stateRoot`. Never bake the builder's home into an artifact.

**Claude Code**

- Linux: Configured plugin root; adapter root from explicit option, `CLAUDE_CONFIG_DIR`, then home. User systemd or explicit cron; LF, readable files and executable CLI; configured bin link on PATH.
- Windows: Same root precedence using native home; schtasks at logon; retain LF and forward-slash substituted paths, readable files and configured command shim on PATH. Native proof by Producer.
- macOS: Same root precedence using native home; launchd agent; LF, readable files and executable CLI; configured bin link on PATH. Proof by Producer.

**Codex**

- Linux: Chosen marketplace source resolves plugin root ([decisions](#decisions)); user systemd or explicit cron; LF, readable files and executable CLI; configured bin link on PATH. Adapter implemented; pair proof pending.
- Windows: Chosen marketplace source and native home ([decisions](#decisions)); schtasks; LF, path quoting, readable files and configured command shim on PATH. Adapter implemented; Producer proves native pair.
- macOS: Chosen marketplace source and native home ([decisions](#decisions)); launchd; LF, readable files and executable CLI; configured bin link on PATH. Adapter implemented; Producer proves pair.

**opencode**

- Linux: Configured global plugin and skill destinations ([decisions](#decisions)); user systemd or explicit cron; LF, readable files and executable CLI; configured bin link on PATH. Adapter implemented; pair proof pending.
- Windows: Resolve global destinations on native Windows ([decisions](#decisions)); schtasks; LF, path quoting, readable files and configured command shim on PATH. Adapter implemented; Producer proves native pair.
- macOS: Resolve global destinations on native macOS ([decisions](#decisions)); launchd; LF, readable files and executable CLI; configured bin link on PATH. Adapter implemented; Producer proves pair.

`src/autostart.js` currently selects systemd on Linux, schtasks on Windows and launchd on macOS. Cron is an explicit alternative, not an automatic systemd fallback; the current cron plan replaces the user's crontab and its uninstall removes it. Preserving existing cron lines is required before this path is offered ([decisions](#decisions)).

Preserve UTF-8/LF payloads and smoke logs on every system. Check POSIX execute bits after extraction; on Windows check ACL readability and the chosen shim in the intended shell. Derive the command name and target from `package.json.bin` (currently `okit-plugin`), and configure the link/shim destination ([decisions](#decisions)). Client plugin discovery does not establish PATH. Autostart must resolve the installed Node and CLI paths explicitly; a login shell's PATH is insufficient. Re-plan it after an update moves the installation.

<a id="section-3"></a>
## Artifacts

The implemented build uses the following filename templates. Let `P` be a filesystem-safe encoding of `package.json.name`, `V` its `version`, `C`/`S` the client/system identifiers from release configuration and `A` the architecture. The output directory, archive format/extension `E`, name encoding and supported architectures come from configuration under [decisions](#decisions); never silently label one architecture as all architectures.

| Output | Derived filename | Contents |
| :- | :- | :- |
| Pair payload (nine pairs × two architectures) | `<P>-<V>-<C>-<S>-<A>.<E>` | Package metadata, license, required `src/`, skills and selected adapter, client manifests/wiring and installation instructions. Preserve referenced relative paths; exclude state, credentials and development-only material. |
| Digest manifest | `<P>-<V>-checksums.sha256` | SHA-256 and exact filename for every payload and accompanying marketplace metadata, notes and checklist; excludes itself. Hash final bytes after packaging. |
| Notes | `<P>-<V>-release-notes.md` | Root changelog's changes for this version, prerequisites, pair filenames, install/update instructions, proof status and known gaps. |
| Proof checklist | `<P>-<V>-release-checklist.md` | One record per client × system × architecture (eighteen) with revision, digest, environment, commands, exit codes and evidence links. |

Marketplace schema filenames stay as required by the clients, under configured output roots. Their entries must resolve to the exact pair payload/version; automatic OS selection is **unverified**, not assumed ([D-Q1 / D-Q2](#decisions)). All output identities and metadata must agree with `package.json`, including `license`, `repository`, `bin` and `engines`; no duplicated release-version constant. A new version is a Producer decision, not chosen by this document.

Notes come from the manually maintained root change history in `CHANGELOG.md` under `[Unreleased]`. The notes command extracts that section verbatim; never create a second history or a fragment directory. Keep newest entries first within each category.

The digest manifest is written and checked by `src/release/checksums.js`, driven by `scripts/checksums.js` (`npm run release:checksums -- write|verify`). One line per file carries the lowercase SHA-256 digest, two spaces and the exact name, ordered by name, LF and UTF-8, computed over the final bytes of the file without holding it in memory; the manifest never carries its own hash. A verification refuses an altered, absent or unlisted file, a malformed line and an unsafe path.

Operational path: [installation](../guide/install.md), [update/removal](../guide/update-and-remove.md) and [adapters](../components/adapters.md).

<a id="section-4"></a>
## Installer and updater

The package is verified before extraction and placed in a stable version directory under the configured user data root (XDG on Linux, Application Support on macOS, LOCALAPPDATA on Windows). Each `install.<client>.json` records that client's active and previous versions; its name comes from `install.recordName`. Legacy `install.json` is read as its client's record and migrated on the first write, retaining the whole previous chain. Marketplace registration and command links point there, so downloaded/extracted source folders can be deleted. `DEFAULT_CONFIG.install` and user `config.json` control network limits, clients, executables, roots and identities; archive naming reuses `release.name`.

`okit-plugin install --client all` downloads and verifies a separate package for each detected client. The interactive menu accepts several numbers (`1,3`) or `all`. Explicit `--client <client>` changes only that client. Update, check, rollback and uninstall default to all registered clients and accept `--client <client>`; an unregistered client refuses before changes. Each client retains its own history and runs its own update smoke. A failure does not stop the remaining clients; the final summary lists each result (0: all succeeded, 1: any failure, 2: refused before starting).

The link, autostart and state are shared, with shared settings in each record. Uninstall removes only the selected client's registration and retained folders; shared paths are redirected to a remaining package and the link is removed only with the last client. `--purge --yes` refuses if any client would remain. For this record format use the Node CLI: unchanged bootstrap scripts still locate legacy `install.json`.

`okit-plugin update --check` only reports availability. `okit-plugin update` stops the active daemon, backs up state and client configuration, retains the previous version, changes registration/link/autostart paths, restarts and runs the new CLI's smoke. A failed proof reports `okit-plugin update --rollback`; rollback activates the retained version without downloading. User-edited skill/module files are preserved. `okit-plugin uninstall` removes managed registration, links, autostart and version directories while preserving user state/configuration; `--purge --yes` also removes the configured state root. All three accept `--dry-run`, which queries release metadata where needed but downloads no payload and writes nothing.

SHA-256 detects altered bytes; it does **not** authenticate the release source. The dependency-free Node extractor accepts regular tar.gz/zip entries, preserves executable modes, bounds decompressed size and refuses traversal, absolute paths, links and special entries.

The root [INSTALL.md](../../INSTALL.md) and [Portuguese guide](../../INSTALL.pt-BR.md) describe the standalone `install.sh` (Linux/macOS) and `install.ps1` (Windows). Both embed the same bootstrap, generated from `src/install/bootstrap.js`; their marked configuration blocks derive from install/release defaults and Node engines at build time. Every key supports an `OKIT_` environment override. Run the script renderer to refresh checked-in scripts after changing defaults; drift tests reject stale copies.

The build emits `release.publish.bootstrapAttachments` alongside archives: both scripts and both INSTALL guides. These files join the existing `payloads` attachment group in `release.publish.attachments`, so publication hashes, verifies and attaches them without changes to the publisher. They never enter pair archives. `okit-plugin install --from <folder>` validates package identity and CLI, copies a verified extracted source into the fixed destination and keeps the source. The bootstrap verifies SHA-256 with system tools before system extraction; that hash does not authenticate archive contents. Explicit script `update|uninstall` delegates to the recorded CLI without bootstrap downloads. Linux proof belongs to the Director; Windows/macOS remain for the Producer.

**Container install check (opt-in).** `test/container-install.test.js` builds the real Linux x64 `claude-code` archive, serves it from a local fake release server and runs the real `install.sh` as a normal user inside Debian (bash, dash, zsh, fish), Fedora (bash, zsh, fish) and Alpine (busybox `sh`, no bash) containers. It proves that the install exits 0 with the self-check output, that a login launch of each shell finds `okit-plugin`, that a profile of the person which exits before the PATH block makes the install exit non-zero (the self-check's own login launch, of the shell of the person: a POSIX shell that reads `~/.profile` like `sh` does (dash, ash, ksh, mksh, pdksh, busybox) is checked as the `sh` entry; a shell outside that list (csh, nu, xonsh) reads no `.profile` and is not launched), that the exact `statusLine.command` runs under `sh -c` with a minimal environment and the collector writes a reading, and that failures (`OKIT_MIN_NODE=99`, a broken shell, a foreign `okit-plugin` link) exit non-zero. It runs only when `OKIT_CONTAINERS=1` is set and `podman` works; otherwise every case is skipped with the reason "set OKIT_CONTAINERS=1; needs podman and network to pull images". Command: `OKIT_CONTAINERS=1 node --test test/container-install.test.js`. The first run builds the images (`okit-check-debian`, `okit-check-fedora`, `okit-check-alpine`) and may take minutes (900 s allowed for the build step); later runs use the cached layers. It cannot prove macOS, Windows, arm64 hardware, other distributions, interactive terminals or the real Claude Code client; those stay in the per-pair proof below.

**Extra layer (macOS and Windows).** The release checklist adds a third section, "Extra layer: installer on this system", to every macOS and Windows pair, for what only a real machine can prove: the exact `install.sh` / `install.ps1` command and its exit code, the self-check output, `okit-plugin` found in each shell of the system (macOS: zsh, bash, sh in a non-login non-interactive launch; Windows: PowerShell, cmd, Git Bash), the `statusLine` command string and every hook command string from the client settings, each run in the client's shell and exited 0 (each exit code recorded), a collector reading, PATH persistence, a client launched from the GUI (Dock/Finder, Start menu), the asset picked for the CPU (arm64/x64) with an unsupported pair refused, and an uninstall that leaves nothing behind. Linux pairs do not get it: the container check above covers them. A container, a mock or a simulated platform cannot prove real shells, GUI-launched clients, real PATH persistence or arm64 hardware, so the Producer fills the section on the real machine. A Wine simulation is not part of the checklist.

<a id="section-5"></a>
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

<a id="section-6"></a>
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

The configured `release.notes` texts, filename template and history path combine with package metadata and the build's pair plan. Deterministic output includes Node engines, all eighteen payload filenames (nine pairs × x64 and arm64), the checksum manifest name, install/update instructions and every pair's proof and gaps. With no proof record, all pairs are `not proven`; Windows/macOS belong to the Producer. Optional `release.notes.proofFile` names a repository-relative JSON object keyed by `client:system`, with values `not proven`, `proven` or `PARCIAL` (or their configured labels). Partial proof always remains in known gaps.

Missing history, absent or empty `[Unreleased]` (headings/comments alone do not count), mismatched version or invalid proof refuses with a reason and writes no output. Source lines retain their text and whitespace. This command neither publishes nor hashes notes; hash notes/checklist only after their records are final, using the checksum command.

<a id="section-7"></a>
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
| `--dry-run` | Lists the destination and the eighteen configured pair filenames without writing. |

`release.checklist` configures the filename template, title, fields, layer texts and signature line. Pair signers inherit `release.notes.proofBy`, with optional `release.checklist.proofBy` overrides; the same optional proof JSON and status labels as notes are read. Each build pair gets an unchecked section with environment, installation/update, both smoke layers, explicit skip/absent-driver fields and evidence locations. Windows/macOS require the Producer signature. This command prepares evidence records; it runs no smoke and publishes nothing.

The **Extra layer** (macOS and Windows pairs only; see the paragraph after the container install check) is rendered after the two smoke layers with one empty row per configured label, from `release.checklist.extra` (`systems`, `title`, `labels`); a user `systems` array replaces the default, and an invalid one is ignored. The Producer runs it on the real machine and unfilled rows stay unchecked until the Producer's written acceptance.

Payload SHA-256 values come from the checksum manifest in the output directory when present; otherwise they remain blank. No hashes are calculated here: hash notes/checklist only after final completion. A mismatched version, invalid pair/proof/manifest or existing checklist with different contents refuses with a reason and writes nothing. Identical reruns are allowed; there is no `--force`, so filled evidence is preserved. Keep completed proof records under `docs/` as required by D-Q7.

<a id="section-8"></a>
## Publishing

```sh
npm run release:publish -- [--dry-run] [--out <dir>]
npm run release:publish -- --publish [--out <dir>]
```

Dry-run is the default: it prepares local files and prints the title, tag, target SHA, pre-release status, exact attachments and full shell-quoted `gh` command; it creates no tag or release. Both modes require a clean tree, fetch `origin/main`, compare HEAD with it and refuse an existing local or remote tag. Fetch and remote tag lookup require network access; no publication happens without `--publish`. Run from a committed checkout.

The command reuses the eighteen-asset build, writes a payload checksum manifest, generates notes and the checklist (including payload hashes and source SHA), then writes the final manifest covering payloads, notes and checklist and verifies it. Refused pairs/versions, invalid proofs, changed checklists and checksum failures stop publication. Only the generated allowlist is attached; unrelated output files fail checksum verification.

`release.publish` in `DEFAULT_CONFIG`, overridable through `config.json`, configures the GitHub executable (`executable: 'gh'`), git executable (`gitExecutable: 'git'`), remote (`remote: 'origin'`), branch (`branch: 'main'`), minimum client × system count (`requiredPairs: 9`), tag prefix, title template, output directory and attachment groups (`payloads`, `notes`, `checklist`, `checksums`). HTTPS remotes retain their URL with credentials removed; SSH/scp remotes such as `git@host:owner/repo.git` become `host/owner/repo`. Local paths and unsupported remote URLs refuse before building. Package name/version come from `package.json` (D-Q6: 0.1.0). Use a separate output folder per candidate; completed evidence stays in `docs/` per D-Q7.

With `--publish`, verified files go to `gh release create` with the tag, configured repository, target SHA, title and separate body file (`--notes-file`), with `--` before attachment paths. `release.publish.prerelease` defaults to `never`: a full release eligible for Latest in the repository releases area. `always` always passes `--prerelease`; `auto` passes it when the distinct client × system count is below `requiredPairs` or any pair lacks the configured proven status in `release.notes.proofFile`. Invalid modes refuse before building. Reducing clients/systems does not reduce that minimum.

`release.publish.latest: true` explicitly passes `--latest` for full releases, making the default release Latest without manual editing. Set it to `false` to leave Latest selection to GitHub; pre-releases never receive `--latest`.

Whenever that proof/count condition holds, in every mode, `unprovenNotice` appears at the very top of the body, followed by the release notes. Its English default says some client/system pairs are not yet proven and points to the proof table in the notes. The attached notes keep their proof table without this warning. `bodyDir: 'body'` and `bodyFile: '{package}-{version}-release-body.md'` configure a separate subfolder and filename using the notes' package/version placeholders; the body is neither attached nor checksummed. Unsafe body paths and nonregular files refuse. This command does not establish real-client proof.

The configurable `safeName` pattern validates `remote`, `branch`, `executable` and `gitExecutable` before any command: defaults reject leading hyphens, spaces and control characters. Git positional arguments follow `--`; `rev-parse` uses `--verify --end-of-options` because bare `--` switches it to path output. In both dry-run and publication, output inside the repository must be ignored by git; otherwise add the output directory to `.gitignore` or choose `--out` outside the repository. This refusal happens before building.
Immediately before invoking GitHub, git checks run again: a dirty tree (including generated changes in tracked output paths), changed SHA or existing tag refuses publication. `SAFE_TAG` restricts the assembled tag to a single Git ref component beginning with a letter, digit or underscore, followed by letters, digits, dots, underscores, pluses or hyphens; consecutive dots, trailing dots and a `.lock` suffix are forbidden. `GIT_TAG_NAMESPACE` names the Git protocol prefix `refs/tags/`. Failures after GitHub starts return nonzero with `publish failed (the release may be partly created): tag <tag>: <error>`; inspect the remote release before retrying. Validation refusals retain `refused: …`.

<a id="section-9"></a>
## Proof per pair

Every checkbox means **both** layers against that pair's installed candidate: `okit-plugin smoke` (in-process, scratch home) and the in-client smoke scenario inside the actual named client, loading the real installation with its real login/state. `--dry-run`, rehearsal and mocked spawns are not real-client proof. `okit-plugin client-smoke` is implemented for Claude Code; see [SMOKE.md](SMOKE.md#in-client-smoke-real). Other real-client drivers are pending. Keep each pair unchecked until both layers are recorded and accepted.

**Claude Code**

- [ ] Claude Code × Linux — Director’s Linux machine ([decisions](#decisions))
- [ ] Claude Code × Windows — Producer on the native Windows machine
- [ ] Claude Code × macOS — Producer on the macOS machine

**Codex**

- [ ] Codex × Linux — Director’s Linux machine ([decisions](#decisions))
- [ ] Codex × Windows — Producer on the native Windows machine
- [ ] Codex × macOS — Producer on the macOS machine

**opencode**

- [ ] opencode × Linux — Director’s Linux machine ([decisions](#decisions))
- [ ] opencode × Windows — Producer on the native Windows machine
- [ ] opencode × macOS — Producer on the macOS machine

For each row record: tester/date; source revision; package version; artifact filename and SHA-256; OS/version/architecture; Node/client versions; install scope; resolved plugin/config/state/bin paths; installation and update-from-prior-candidate steps; PATH and permission checks; autostart show/install/restart outcome; both smoke commands, exits, totals and reasons; JSONL/log locations and in-client smoke scenario revision. Attach files or durable links, not just “worked”. Never publish credentials. Fresh install and update must preserve user configuration and state, including after client restart.

In-process evidence requires exit 0 and every selected check passing; use the full check set for release. in-client smoke requires C1–C5 to pass, no failures, and explicit accounting for every later check. Its exit 0 can still mean `PARCIAL`; a missing hook proof prevents the installation gate passing. Missing config means incomplete installation. Keep any unresolved skip/partial row unchecked until the Producer gives written acceptance ([decisions](#decisions)); no synthetic or missing result fills another pair.

<a id="section-10"></a>
## Decisions

1. Release separately for Claude Code, Codex and opencode, on Linux, Windows and macOS: all nine pairs remain in scope, each for x64 and arm64.
2. Build locally. GitHub Actions does not run the release on its own.
3. Only cut a tag or publish when the Producer explicitly requests it; preparing candidates is separate from cutting a release.
4. Derive versions, names and paths from `package.json` and configuration; no fixed project constants in the release design or future implementation.

5. **Claude Code:** use the project's GitHub marketplace (`asantos43/okit-plugin`), user scope and one entry per system.
6. **Codex:** use the portable manifest (`plugin.json` at the root), in the same marketplace and at the same version as Claude Code; validate against the actual installed Codex client.
7. **opencode:** install a global JS module in `~/.config/opencode/plugins/`; prove the in-client smoke hook through opencode's own events, without assuming Claude's hook format.
8. **Machine integration:** derive bin/shim destinations and autostart identities from configuration, with no code constants; crontab preservation remains pending.
9. **Output:** use `.tar.gz` on Linux and macOS, `.zip` on Windows, one payload per architecture, named `<P>-<V>-<C>-<S>-<A>.<E>`, with a SHA-256 manifest; download from the GitHub releases page.
10. **Lifecycle:** keep the package private (no npm); before updating, back up state and user-edited skills, with rollback to the previous version.
11. **Proof:** the Producer verifies Windows and macOS; Linux uses the Director's machine. Keep proof records in this repository's `docs/`; a partial smoke skip requires the Producer's written acceptance.

<a id="section-11"></a>
## Open questions

No open questions remain: Q1 to Q7 were answered by the Producer on 2026-10-23.

<a id="section-12"></a>
## Implementation status

Local build, checksums, notes, checklist and explicit publication are implemented in `src/release/`, with scripts in `package.json`. Installation, updates, backups and rollback live in `src/install/`. New candidates need their own proof: changing a version or payload invalidates its previous digest.
