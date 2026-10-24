# Install and update

The plugin command is now `okit-plugin` (configurable via `install.command`); the kit keeps `okit`/`kit`. Install/update migrate only legacy `okit` links owned by the plugin; uninstall also removes those links. Existing 0.2.0 records remain readable; unrelated kit executables are preserved.

## Install

Each client package includes all runtime adapters by default so `status` can load
every client. `release.sharedAdapters: null` inherits the paths in `release.adapters`;
an explicit path list overrides the shared selection. The selected client's adapter
remains required; custom payloads must retain every adapter imported by `src`.

Read the script before executing it. Node >=20 must already be on PATH
([download Node](https://nodejs.org/)). Linux has been exercised by the Director;
Windows and macOS await the Producer's real-machine checks.

Linux and macOS (the same POSIX script):

```sh
curl -fsSL https://github.com/asantos43/okit-plugin/releases/latest/download/install.sh | sh
```

Windows PowerShell:

```powershell
irm https://github.com/asantos43/okit-plugin/releases/latest/download/install.ps1 | iex
```

For unattended use, select the client first with `OKIT_CLIENT=claude-code`
(PowerShell: `$env:OKIT_CLIENT='claude-code'`). Choices are `claude-code`, `codex`,
and `opencode`. Without a terminal and a choice, the script refuses. To use flags,
download and inspect the script, then run `sh install.sh --client codex` or
`./install.ps1 --client codex`. A terminal lists clients and marks those on PATH.

The script checks Node, OS and architecture, selects the newest stable GitHub
release (or warns when falling back to the newest pre-release), downloads the
exact client/system/architecture archive and checksum manifest into a temporary
folder, verifies SHA-256 before extraction, and invokes the Node installer with
`install --from`. It copies the package into a fixed user data directory, records
one `install.<client>.json` per client, registers the client, creates a shared command link and optionally sets
autostart. Updates retain backups, activate the new version and run `okit-plugin smoke`.
Temporary files are removed on success and failure. Linux uses
`${XDG_DATA_HOME:-$HOME/.local/share}/okit-plugin`; macOS uses
`$HOME/Library/Application Support/okit-plugin`; Windows uses
`%LOCALAPPDATA%/okit-plugin` (fallback `%USERPROFILE%/AppData/Local/okit-plugin`).

Flags: `--client <name>`, `--dest <folder>`, `--prerelease`, `--dry-run`, `--yes`,
`--no-link`, `--autostart`. Dry-run reports release, asset and destination without
downloading the archive or modifying the destination. Default execution with an
existing record updates that installation; the same version reports “up to date”.

## Configuration

All values in the marked configuration block support `OKIT_<KEY>` overrides:
`REPO`, `API`, `CLIENTS` (JSON name/executable map), `NAME` (archive template),
`COMMAND`, `MIN_NODE`, `PACKAGE`, `MANIFEST`, `TAG_PREFIX`, `DIRECTORY`, `DEST`,
`DATA_ROOTS`, `SYSTEMS`, `ARCHITECTURES`, `FORMATS` (JSON maps). `OKIT_CLIENT` chooses a client.
Use the same destination for lifecycle commands. Core settings remain in
`config.json` under `OKWORK_HOME`; API/repository overrides in the bootstrap apply
to its download, while explicit `update` uses the installed core's configuration.

### Orchestration kit

Install the orchestration kit separately using the installation guide shipped with
your kit distribution. Put its executable on PATH or set `install.kit.path` to
the executable file. This plugin only checks its version; it never installs or
changes the kit. The reported path identifies the executable, not its home or
configuration directory; those cannot be inferred reliably from a version probe.

Run `okit-plugin kit [--require]`. The English `kit: …` line reports `installed`, `absent`
or `broken`; only `--require` (or configured `require: true`) makes an unsuccessful
check exit 1. Install/update, including `--dry-run`, and status also print the line.
When installed, see the [D1 overlap rules](docs/ARCHITECTURE.md#kit-and-plugin-overlap-d1).

In `OKWORK_HOME/config.json`, configure `install.kit`:
`executables: ["okit", "kit"]`, `path: null` (PATH only),
`versionArgs: ["--version"]`, `timeoutMs: 3000`, `require: false`,
`hint` (installation instructions shown when absent), and `overlap` (D1 pointer).
A configured path takes precedence over PATH. Invalid/failed version output or
a deadline exceeded is `broken`; the version process is killed on timeout.
The deadline must be a positive integer. These values merge with `DEFAULT_CONFIG.install`.

## Update

Repeat the quick command to update automatically, or run `okit-plugin update`.
`okit-plugin update --check` reports availability; `okit-plugin update --rollback` activates the
retained version. Downloaded scripts also accept `update --check` and
`update --rollback`: these locate `install.json` and invoke the installed CLI
without shell downloads. `sh install.sh uninstall` / `./install.ps1 uninstall`
work the same way. `okit-plugin uninstall` preserves user configuration and state;
`--purge --yes` removes the configured state root too.

## Uninstall

Review `okit-plugin uninstall --dry-run`, then run `okit-plugin uninstall`. To also remove state/configuration, use `okit-plugin uninstall --purge --yes`. Use the same state root and recorded installation destination. There is no separate uninstall script; existing installation scripts forward this action to the CLI.

## Manual installation

For manual installation, download the matching archive and checksum manifest,
verify the archive hash, extract it, then run
`node src/cli.js install --from . --client <name>` in that folder. Alternatively,
`node src/cli.js install --client <name>` downloads the latest release.

The Node installer supports several clients on one machine. `okit-plugin install --client all`
downloads and verifies a separate package for every detected client; its interactive
menu also accepts `1,3` or `all`. `--client <name>` changes only that client.
`okit-plugin update`, `update --check`, `update --rollback` and `uninstall` act on all
registered clients by default; add `--client <name>` to select one. An unregistered
client is refused before changes. Each client has its own retained versions and smoke
check; one failure allows the others to finish. The summary lists each result
(exit 0: all succeeded, 1: failure, 2: refused before starting).

Record names come from `install.recordName`. Legacy `install.json` is read under its
client and migrated on the first write, preserving its previous-version chain.
The command link, autostart and state are shared; removing one client preserves the
others and redirects shared paths to a remaining package. The final uninstall removes
the link. `--purge --yes` is refused if any client would remain. All operations support
`--dry-run` without writes. Use the Node CLI for these lifecycle commands: the unchanged
bootstrap scripts still locate legacy `install.json` records.

Can I delete the downloaded folder afterwards? **Yes** after using the script or
`okit-plugin install --from`: client references point to the fixed installed directory.
For direct manual `claude plugin marketplace add <folder>`, **keep that folder**:
the client still references it.

SHA-256 detects changed bytes. It does **not** authenticate their source: an
attacker replacing both the archive and manifest can produce matching hashes.
Use the intended repository and review the script and release provenance.

[Português](INSTALL.pt-BR.md) · [Release and proof details](docs/RELEASING.md)
