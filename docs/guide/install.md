# Install and start

![okit-plugin: User guide](../images/banners/guide.svg)

Install the plugin for your AI client and confirm that it can see your environment.

<a id="install"></a>
## Install

1. Run `node --version`. Expect `v20` or newer; install [Node.js](https://nodejs.org/) if needed. Have Claude Code, Codex or opencode installed and signed in.
2. Download the installer from the intended [release](https://github.com/asantos43/okit-plugin/releases/latest) and read it before running it. On Linux/macOS:

   ```sh
   curl -fLO https://github.com/asantos43/okit-plugin/releases/latest/download/install.sh
   ```

   Expect `install.sh` in the current folder. On Windows PowerShell:

   ```powershell
   Invoke-WebRequest https://github.com/asantos43/okit-plugin/releases/latest/download/install.ps1 -OutFile install.ps1
   ```

   Expect `install.ps1` in the current folder.
3. In that folder, run `sh install.sh --client codex` on Linux/macOS or `./install.ps1 --client codex` in PowerShell. Replace `codex` with `claude-code` or `opencode` for your client. Expect a verified archive, an installation destination and a registration summary. Follow any client activation instructions printed by the installer; Codex activation uses `/plugins`.
4. Installation and updates save detected active model choices, helper limits, allowance sources and the client in use, filling missing settings only. Your saved choices stay unchanged. Open a new terminal and restart the AI client so they find the installed command. Run `okit-plugin setup` to review remaining choices; every question explains a recommendation. If no active model is detected, follow [models and allowance](models-and-quota.md).
5. Run `okit-plugin env report --locale en`. Expect the client, confirmed active models, allowance, free helper places and folders. Unknown items stay unknown and include repair instructions.

The installer also registers the plugin's MCP server, named `okit`, in Claude Code and Codex with each client's own `claude mcp add --scope user okit -- node <installation>/src/mcp/server.js` / `codex mcp add okit -- node <installation>/src/mcp/server.js` command. OpenCode is not registered by the installer yet. It reads the entry first: one that is already ours is left alone, one that points at the version being replaced is swapped, and an entry named `okit` that is not ours is kept with a warning. Only a stdio server (the field that names the type of the server, `Type` for Claude Code and `transport` for Codex, has to be `stdio`) whose own arguments field names our path is ours: a server of another type, and a header that holds a line that looks like the arguments field, are not ours and are kept. An entry the client shows at another scope than the configured one is treated as not ours and is kept too, even when its arguments name our path. Codex is the exception: there the installer only adds the entry when it is missing, because the client does not say where an entry is kept; an entry that is already there is never replaced nor removed by the installer, and the warning prints the commands to run by hand. The Claude Code behaviour is the one above. If the client refuses, the installation still succeeds and the warning prints the command to run by hand; when the client is not on the machine, the same commands are listed with the other manual steps. An entry the client cannot read (the client fails, times out or answers something else) is a warning too: nothing is written, because the entry of the client may not be ours. Run the installer again to retry: an installation that is already there reads its entry and adds it when it is missing. The commands of the client run from the installation folder, so the configuration of a project is never read nor changed.

For Claude Code, run `okit-plugin update --client claude-code --statusline` after installation to enable allowance collection while preserving your previous status bar. Expect a settings preview; `--no-statusline` declines collection. During installation, a terminal asks and unattended installs skip collection. The downloaded scripts do not accept these two status bar options; use the installed command.

The installer prints the same numbered steps on Linux, macOS and Windows, in one language (`--locale en` or `--locale pt-BR`, then `OKIT_LANGUAGE`, then your saved language), and ends with the next steps and the exact command to run. Add `--verbose` to also see the raw commands it runs. On Windows the command is a `okit-plugin.cmd` shim for PowerShell and cmd.exe plus an extensionless shim for Git Bash (the shell the Claude Code status bar runs through), and a terminal may ask, default No, whether to allow PowerShell scripts for your user; `--set-execution-policy` says yes and `--no-execution-policy` skips it. Both flags also work with bootstrap `update`. A foreign command is preserved but fails installation with repair instructions. Model setup is offered only after success, never during dry-run or `update --check`. See [INSTALL.md](../../INSTALL.md#what-the-installer-prints).

A setting of `config.json` that is not valid (for example `install.timeoutMs` set to `0` or to text) is refused by every command with exit 2, a line that names the setting and the rule (`Invalid install.timeoutMs: an integer from 1 to 2147483647`), and the file untouched; fix the value, or remove it to use the default.

Install/update can edit shell profiles or the Windows user PATH; `--no-path` skips this. Downloads verify SHA-256 for changed bytes; it does not authenticate the source. Real-client proof varies by system: see [release evidence](../maintainers/RELEASING.md#proof-per-pair).

[Next: ask the Director](ask-the-director.md) · [Guide](README.md) · [Português](install.pt-BR.md)
