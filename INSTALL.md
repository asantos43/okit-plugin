# Install and update

## Install

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
`install.json`, registers the client, creates a command link and optionally sets
autostart. Updates retain backups, activate the new version and run `okit smoke`.
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

## Update

Repeat the quick command to update automatically, or run `okit update`.
`okit update --check` reports availability; `okit update --rollback` activates the
retained version. Downloaded scripts also accept `update --check` and
`update --rollback`: these locate `install.json` and invoke the installed CLI
without shell downloads. `sh install.sh uninstall` / `./install.ps1 uninstall`
work the same way. `okit uninstall` preserves user configuration and state;
`--purge --yes` removes the configured state root too.

## Uninstall

Review `okit uninstall --dry-run`, then run `okit uninstall`. To also remove state/configuration, use `okit uninstall --purge --yes`. Use the same state root and recorded installation destination. There is no separate uninstall script; existing installation scripts forward this action to the CLI.

## Manual installation

For manual installation, download the matching archive and checksum manifest,
verify the archive hash, extract it, then run
`node src/cli.js install --from . --client <name>` in that folder. Alternatively,
`node src/cli.js install --client <name>` downloads the latest release.

Can I delete the downloaded folder afterwards? **Yes** after using the script or
`okit install --from`: client references point to the fixed installed directory.
For direct manual `claude plugin marketplace add <folder>`, **keep that folder**:
the client still references it.

SHA-256 detects changed bytes. It does **not** authenticate their source: an
attacker replacing both the archive and manifest can produce matching hashes.
Use the intended repository and review the script and release provenance.

[Português](INSTALL.pt-BR.md) · [Release and proof details](docs/RELEASING.md)
