# Install and update

The plugin command is now `okit-plugin` (configurable via `install.command`); the kit keeps `okit`/`kit`. Install/update migrate only legacy `okit` links owned by the plugin; uninstall also removes those links. Existing 0.2.0 records remain readable; unrelated kit executables are preserved.

Shell detection for activation hints uses `install.path.shellVariable` (`SHELL` by default) on Unix and `install.path.windowsShell` (`powershell` by default) on Windows. A custom Windows shell name must also have a matching entry in `install.path.activate`.

## Install

Install/update choose a writable candidate already on PATH (`~/.local/bin`, then `~/bin`). Otherwise the default candidate gets an idempotent managed PATH block in existing bash (`.bashrc`, `.profile`), zsh (`.zshrc`, `.zprofile`) or fish (`.config/fish/config.fish`) profiles selected by `$SHELL`; if none exists, the login profile is created. Windows appends to the user environment PATH without administrator privileges. Uninstall removes only the recorded block/entry, after the last client is removed; rollback preserves it.

Use `--no-path` on install/update (also through the bootstrap scripts), or set `install.path.enabled: false`, to receive a manual instruction without profile/environment edits. `install.path` configures `candidates`, `shells`, `fallbackShell`, `begin`, `end`, `stateFile`, Windows settings and bilingual `messages`; `install.linkDirectory` overrides directory selection. The final message shows the link, edited profiles or existing PATH, and command resolution with the resulting PATH. Restart the AI client so it inherits PATH. If a skill cannot find the command, run the installation's `src/cli.js` with Node and the same arguments.

When the current terminal's PATH lacks the bin directory, install/update and `okit-plugin status` show an activation hint in the language of the run. Run the printed command manually: `. '<profile>'` for bash/zsh, `source '<profile>'` for fish, or `$env:Path = '<bin>' + ';' + $env:Path` for PowerShell on Windows. These templates come from `install.path.activate`; `shellVariable` defaults to `SHELL`. The command is never executed for you. For an unknown shell or missing managed profile, open a new terminal. The hint disappears when the bin directory is already in PATH.

Each client package includes all runtime adapters by default so `status` can load
every client. `release.sharedAdapters: null` inherits the paths in `release.adapters`;
an explicit path list overrides the shared selection. The selected client's adapter
remains required; custom payloads must retain every adapter imported by `src`.

Read the script before executing it. Node >=20 must already be on PATH
([download Node](https://nodejs.org/)). Linux has been exercised by the Director;
Windows and macOS await the Producer's real-machine checks.

Supported system/architecture pairs: linux/x64, linux/arm64, macos/x64, macos/arm64,
windows/x64, windows/arm64. The script picks the asset from `uname -s` / `uname -m`
(on Windows from `process.arch`); macOS under Rosetta reports x86_64 and gets the
x64 asset. Any other pair (for example Linux armv7l or i686, FreeBSD, Windows ia32)
is refused before anything is downloaded, with the list above. The code is plain Node,
so the x64 and arm64 assets are identical; the arm64 ones have not run on real arm64
hardware.

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
`--no-link`, `--autostart`, `--locale <en|pt-BR>`, `--verbose`, and on Windows
`--set-execution-policy` / `--no-execution-policy`. Dry-run reports release, asset
and destination without downloading the archive or modifying the destination. The
downloaded scripts' dry run, before anything is installed, prints the same header
and the numbered steps that need no package (download, install files with the
chosen `--dest`, register, command), then “Dry run: nothing was changed.”
Default execution with an existing record updates that installation; the same
version reports “up to date”.

### What the installer prints

`install.sh`, `install.ps1` and `okit-plugin install|update|uninstall` print through
one presenter, so the output has the same lines on Linux, macOS and Windows. It is
in one language per run: `--locale`, else `OKIT_LANGUAGE`, else the saved `language`,
else English. Refusals before the configuration is readable use `--locale` or
`OKIT_LANGUAGE`, including unknown flags and invalid JSON. The bootstrap scripts
also select this language before validating flags. A `--locale` that is not a
language is refused in one language only: a valid `--locale`, else `OKIT_LANGUAGE`,
else English. The scripts' own “Node required” refusal in
`install.sh` and `install.ps1` is the one exception to the order above, because there is no Node
yet to read the saved configuration: a valid `--locale`, else a valid `OKIT_LANGUAGE`, else the
language of the system, else English. The scripts read no configuration and no file, and never
parse JSON. Only exactly `en` or `pt-BR` count for the flag and the variable; the language of the
system is the first non-empty of `LC_ALL`, `LC_MESSAGES` and `LANG` (the UI culture on Windows),
and `pt` followed by the end, `_`, `-` or `.` (`pt_BR.UTF-8`, `pt-BR`, `pt`) is Portuguese, anything
else English. Once Node runs, the saved language applies as everywhere else. `install.sh` does this
with shell built-ins only, so it works even when `PATH` has no tools. Error texts show an address without its query,
fragment or credentials, and the temporary folder as `<temp>`. A header names the package, version, client and
system; then numbered steps (`[1/5] Download and verify ... ok`) show the release,
asset and destination once, inside the steps; the SHA-256 note appears once; no
temporary folder is printed. A final line lists the next steps, with the exact
command to run (on Windows, including the `$env:Path` line for the current terminal).
Raw commands the installer runs are shown only with `--verbose`.
Within each numbered block, statuses align after the longest translated label,
with at least two spaces between the label and its status.

Questions put the explanation first and the question last, with the default
capitalised: `[y/N]` in English, `[s/N]` in Portuguese. `y` and `s` mean yes in
either language.
Each step prints its result once. Model setup is offered only after a successful
install or update, never after failure, during `--dry-run` or with `update --check`.

### The self-check after install and update

An install is only done when it works on this machine. After `install` and `update` (not after
`--dry-run`, `--check`, `--rollback` or `uninstall`) the installer checks every client it just
registered, in this order, and prints one row, `Self-check (Claude Code)`:

1. **Version**: the install record and the installed `package.json` have the version that was installed.
2. **Command**: each shell of your system finds `okit-plugin` when it starts without a profile, as a script
   would: bash, zsh, sh and fish on Linux; zsh, bash, sh and a plain `sh -c` on macOS; PowerShell, cmd and Git Bash
   on Windows. A shell that is not installed shows `skipped` (`Command (fish)  skipped  fish is not installed`)
   and never fails the run. If no shell could run the check, the check fails and asks for a POSIX shell.
   The link folder is put in front of the PATH of the processes the check starts, and the first line each shell
   prints for `okit-plugin` (`command -v`, `Get-Command` or `where`) must be a file in that folder: our command.
   If another program with the same name comes first, the row fails and shows the path found, with a Fix line
   (remove or rename that file, or put the link folder before it on the PATH).
3. **Status bar and session hook**: the exact commands the installer wrote into the client's settings file are
   read back and run in the shell the client uses (a sample reading is sent to the status bar); both must exit 0.
   The check runs the hook and the status bar only when each is exactly what the installer wrote, byte for byte (it is
   compared with the installer's own output, never parsed). The session hook is run only when its string equals the one
   the installer writes (this node, our script, `hook session-start`); any other hook, such as one with a command
   appended or put before it, another subcommand or another quoting, shows `skipped  the session hook is not exactly
   ours` and is not run; one that differs only in the node path shows `skipped  the session hook was registered with
   another node (install again to refresh it)`. During the check the hook starts no process at all (no client probe,
   no quota command). The status bar is run only when it is the shim form the installer writes
   (`'okit-plugin' 'statusline-collector'`, with `--previous` and its words when your own bar is kept, every word
   single-quoted; on Windows the absolute path of the shim in the link folder), and the shell must find the bare command in
   the link folder; any other bar, including one that runs our script with `node`, shows `skipped  the status bar is not
   ours, so it was not run`. With `--no-link` there is no shim of ours to attest the bare name, so the status bar is not run (`skipped  installed
   without a link, so the check cannot tell which command the status bar names; it was not run`). To find the command the way a new terminal would, the check starts your configured shell,
   which reads its usual startup files (for example `BASH_ENV`, `.bashrc`, `.zshenv`); what those files do is yours,
   exactly as when you open a terminal.
4. **Quota reading**: the status bar leaves its reading. It runs with a temporary state folder, holding the
   allowed part of your `config.json` (the original is only read), that is removed afterwards, so your own quota state is never
   written by the check. The copy holds only the keys of `config.json` that the checked scripts need
   (`install.selfcheck.stateKeys`: the status bar's collector fields and the limits); every other setting, such as a
   measurement folder (`telemetry`) or a quota command (`opencodeQuota.sources`), is not copied. The check never runs a command of yours: a status bar you chained with `--previous` is
   not started by it (the processes of the check carry `OKIT_SELFCHECK`, and the collector then skips `--previous`).
5. **PATH**: judged apart from the checks above, which add the link folder to the PATH they start with. If the link
   folder is not on the PATH of this terminal and no profile adds it, the check fails and gives the line to add.
   When a profile the installer manages adds it, the check passes and the run says once, in its closing lines,
   that a new terminal is needed (also when the version was already installed).

All passed: `Self-check (Claude Code)  ok  6 checks passed`; the list of the shells is shown with `--verbose`.
Any failure: the install stays in place, the row says `installed but not working: 1 of 6 checks failed`, each
failed check has its own row followed by a line `Fix: ...` with the exact command or edit, and the exit code is
1. Example:

```
Self-check (Claude Code)  failed  installed but not working: 1 of 6 checks failed
Command (zsh)             failed  zsh does not find okit-plugin (exit code 1)
Fix: Add /home/you/.local/bin to the PATH of zsh, then run: okit-plugin install --client claude-code
```

Do what the Fix line says (it is the one command or edit for that row) and run the installer again; skipped
rows need nothing.

What the check proves, and what it does not. The shells start non-interactively (never `-l` or `-i`), but a shell
may still read startup files that apply to every start (for example `BASH_ENV`, `ENV` or `~/.zshenv`), so a result
can differ from a terminal you open yourself. On Windows, the forms of the PowerShell, cmd and Git Bash launches are
proven by tests that simulate the platform; what only a real Windows machine proves stays on the list of
[release evidence](docs/maintainers/RELEASING.md#proof-per-pair), and nothing beyond that is promised here. The shells, the time limit of each process (`install.selfcheck.timeoutMs`) and the keys copied from `config.json` and the sample
sent to the status bar are in the `install.selfcheck` part of the configuration.

### Windows command and PowerShell scripts

On Windows the command is two shims in the link directory. PowerShell and cmd.exe use
`okit-plugin.cmd` (it needs no execution policy that allows scripts); Git Bash uses the
extensionless `okit-plugin`, a small `sh` script (LF line endings) that converts the
Windows paths with `cygpath` when it exists and runs the plugin. The Claude Code status
bar runs its command through Git Bash, so the status bar entry written by
`--statusline` names the absolute path of that extensionless shim. Install and update
remove an `okit-plugin.ps1` this plugin wrote in an earlier version (a `.ps1` that is not
ours is left alone), and rewrite an older status bar entry that named the bare command;
uninstall removes the shims. A file of either name that is not ours is preserved like any
foreign command. `okit-plugin env report` says when the collector is registered but has
received no reading yet.
An existing command that belongs to someone else is preserved and fails the
command step and installation. Rename or remove it, or choose another directory
in `install.linkDirectory` in the configuration, then retry.

The installer may offer to allow PowerShell scripts for your user
(`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`). It asks only when the
effective policy blocks scripts (Restricted, AllSigned or Undefined), only in a
terminal, and the default is No. Under a group policy it changes nothing and says so.
To undo it: `Set-ExecutionPolicy -Scope CurrentUser Undefined`. `--set-execution-policy`
answers yes (without asking); `--no-execution-policy` skips the step; they cannot be
combined; the refusal explains this in the selected language. Both options also
work with `install.sh update` and `install.ps1 update`, and are forwarded when
reinstalling the same version through either bootstrap script.

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
When installed, see the [D1 overlap rules](docs/maintainers/ARCHITECTURE.md#kit-and-plugin-overlap-d1).

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

One exit policy serves the installed command and both bootstrap scripts (`src/install/exit.js`, `exitCodeFor`): success and dry run exit 0; a failure of the work (no published release, a missing asset, a bad checksum, a network error) exits 1; a usage, flag or language error exits 2. The language of a run is decided first (`--locale`, `OKIT_LANGUAGE`, the saved language, English), before any flag is analysed, so `--help`, `status` and every refusal, including the refusals of `install.sh` and `install.ps1`, speak one language only; every line goes through the redacting door, so a kit hint with credentials, a query or a fragment is shown without them. This includes the usage text (`--version`, no arguments, an unknown command or action). The class of an error is decided only by its `kind`: an error that says nothing is a failure of the work (exit 1), so a missing release or asset is never taken for a usage error, in the installed command or in the scripts. Every refusal of the settings in `config.json` has a stable code and its parameters and is shown in the language of the run from one catalogue (`CONFIG_MESSAGES`). A generated test (`test/install-matrix.test.js`) runs every command of the usage table under every language source and checks that no line mixes languages, that no credential reaches the output and that the exit code has the class of the policy; Every configuration passes through the single schema (`src/config-schema.js`): a setting of `config.json` that is not valid (`install.timeoutMs` as `0`, as text or above 2147483647, a null shell, a version that is not text in a `--from` package) is one refusal of usage, exit 2, naming the key and the rule in the language of the run, with the file untouched, in `install`, `update`, `uninstall`, `setup`, `kit`, `status` and `config`; `config set` of an invalid value and `config get|unset` of an unknown key also exit 2. A generated test (`test/install-config-fuzz.test.js`) proves it for every key of the schema; the commands that keep their own bilingual convention (`config`, `quota`, `telemetry`, `trajectory`) and the machine protocols (`hook`, `statusline-collector`) are listed there with the reason.

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

[Português](INSTALL.pt-BR.md) · [Release and proof details](docs/maintainers/RELEASING.md)
