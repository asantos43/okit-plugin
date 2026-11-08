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
4. Installation and updates offer model setup for the clients selected for this installation. Claude Code also asks for small, everyday and complex tasks, with haiku, sonnet and opus among its available options. Each client has one numbered list followed by three short questions; the current choice is the default. A class with only one option is explained in the confirmation table. `--client all` reviews all selected clients; standalone `okit-plugin setup` still reviews all detected clients. If no active model is detected, follow [models and allowance](models-and-quota.md).

   The output groups Choices, numbered installation steps, aligned self-check rows, Notes and finally Next. Under “Run this now:”, copy the command on its own line to activate the installed command in this terminal (for example `. '/home/you/.zprofile'`). It names the profile that actually holds the PATH block; fish and PowerShell show their equivalent. Alternatively, open a new terminal, then restart the AI client. The installer cannot change its parent terminal's PATH. Runs without a terminal print guidance without questions.

   At the end, interactive `okit-plugin setup` offers to start the background service with the machine. The default is no; `--defaults` never installs autostart. `okit-plugin uninstall` removes it.
5. Ask your assistant: “What is the environment?” (it calls `env_report`). Expect the client, confirmed active models, allowance, free helper places and folders. Unknown items stay unknown and include repair instructions.

The installer also registers the plugin's MCP server, named `okit`, in Claude Code and Codex with each client's own `claude mcp add --scope user okit -- node <installation>/src/mcp/server.js` / `codex mcp add okit -- node <installation>/src/mcp/server.js` command. OpenCode is not registered by the installer yet. It reads the entry first: one that is already ours is left alone, one that points at the version being replaced is swapped, and an entry named `okit` that is not ours is kept with a warning. Only a stdio server whose own arguments are our path, whole, is ours: in Claude Code, the field that names the type of the server (`Type`) has to be `stdio` and the arguments field has to name our path; a server of another type, and a header that holds a line that looks like the arguments field, are not ours and are kept. Codex answers with JSON (`mcp get --json`), where the boundary of each argument is exact: the entry is ours when its transport is a stdio one whose `args` holds exactly one element, our path, whole. An entry the client shows at another scope than the configured one is treated as not ours and is kept too, even when its arguments name our path. Codex is the exception: there the installer only adds the entry when it is missing, because the client does not say where an entry is kept (its `mcp get` searches the ancestors of the folder it runs in for a trusted project, so it can show the entry of that project); an entry that is already there is never replaced nor removed by the installer, and the warning prints the commands to run by hand. The Claude Code behaviour is the one above. When the installation folder holds whitespace in its path, the text of Claude Code cannot tell our entry from a foreign one whose arguments were split, so the installer only adds the entry that is missing and leaves the one that is there, printing the commands to run by hand; in Codex the JSON holds the boundary of each argument, so a path with whitespace is ours there. If the client refuses, the installation still succeeds and the warning prints the command to run by hand; when the client is not on the machine, the same commands are listed with the other manual steps. An entry the client cannot read (the client fails, times out or answers something else) is a warning too: nothing is written, because the entry of the client may not be ours. Run the installer again to retry: an installation that is already there reads its entry and adds it when it is missing. The commands of the client run from the installation folder. Claude Code's `mcp get` names the scope of the entry it shows, and an entry at another scope is never touched. Codex does not name the scope and can show the entry of a trusted project above the installation folder, so for Codex the installer only ever adds the entry, never replaces nor removes one, and prints the commands to run by hand.
The self-check after the install proves the same server: it starts it under a temporary state folder (your own state is never touched), asks it to answer and then asks its control API one tool call; a server that does not answer fails the install with the command to run again.
When something is not right later, run `okit-plugin doctor`: it reads the whole installation and answers one row per thing it looked at, with the exact command that repairs each failure; it never writes anything.

For Claude Code, run `okit-plugin update --client claude-code --statusline` after installation to enable allowance collection while preserving your previous status bar. Expect a settings preview; `--no-statusline` declines collection. During installation, a terminal asks and unattended installs skip collection. The downloaded scripts do not accept these two status bar options; use the installed command.

After a successful Claude Code install, the terminal also offers the [optional panel](panel.md). `--no-panel` skips its question and hint; without a terminal, only a later hint appears. Enable it later with `okit-plugin install --panel`. `update` refreshes an installed panel without asking.

The panel offer describes the optional read-only pane beside the chat: each account's remaining quota, work in progress and recent work. Automatic opening, `panel.autoOpen: false` and `/okit-panel` are explained after a successful panel installation. The panel is offered only for Claude Code. Installation steps, quota recording, panel, models, kit and closing summary are blocks separated by one blank line, including after answers.

Model setup works identically for Claude Code, Codex and opencode. On the first installation it proposes models and asks to save them (default Yes). If the listing is unavailable, it uses the built-in catalog, never an empty table. If no choices are available, it skips the question and explains how to enable a model and run `okit-plugin setup`; unconfirmed choices remain pending. Reinstalling confirmed profiles shows the current small/everyday/complex choices in one short block per client and asks “Review or change the models? [y/N]” once for all selected clients. No keeps the choices; Yes opens the wizard with the saved values as defaults. Cancelling leaves the configuration unchanged. Without a terminal, unconfirmed defaults are labelled “Suggested models” with `okit-plugin setup` to confirm them; confirmed choices are labelled “Current models” with `okit-plugin setup --again` to change them. Neither asks a question. Updates with confirmed choices matching the new version's proposals stay quiet with one Models ok row; differing proposals or unconfirmed choices offer setup. The closing summary reports pending confirmation only for clients whose profiles still need it.

The installer and `setup --again` share the wizard. After each model choice it asks for effort, showing the allowed values and the current or proposed default; an empty answer keeps that default. Claude Code and Codex offer `low`, `medium`, `high`; OpenCode offers `high`, the intersection of its adapter capabilities and the profile schema. All three clients support efforts. A client without effort support skips this question and column. The confirmation uses aligned terminal columns for work, model and effort; the current-model review also shows effort. Models and efforts are saved together only after confirmation.

On reinstall, an owned command pointing to an older or legacy installation is repointed to the installed payload. “Already on your PATH” means the command resolves to this installation. A foreign command is preserved and the output gives the exact command to run. When PATH or a shell profile changes, follow the reload command or open a new terminal. The installation folder in Notes is the parent of the versioned payload folders.

`OKit (optional)` refers to the separate OKit tool, needed only for the OKit orchestration workflow: [INSTALL.md#orchestration-kit](../../INSTALL.md#orchestration-kit).

Uninstall removes an existing plugin-owned command even when this install reused it; foreign files are preserved, and other registered accounts keep the shared command.

The installer prints the same numbered steps on Linux, macOS and Windows, in one language (`--locale en` or `--locale pt-BR`, then `OKIT_LANGUAGE`, then your saved language), and ends with the next steps and the exact command to run. Add `--verbose` to also see the raw commands it runs. On Windows the command is a `okit-plugin.cmd` shim for PowerShell and cmd.exe plus an extensionless shim for Git Bash (the shell the Claude Code status bar runs through), and a terminal may ask, default No, whether to allow PowerShell scripts for your user; `--set-execution-policy` says yes and `--no-execution-policy` skips it. Both flags also work with bootstrap `update`. A foreign command is preserved but fails installation with repair instructions. Model setup is offered only after success, never during dry-run or `update --check`. See [INSTALL.md](../../INSTALL.md#what-the-installer-prints).

A setting of `config.json` that is not valid (for example `install.timeoutMs` set to `0` or to text) is refused by every command with exit 2, a line that names the setting and the rule (`Invalid install.timeoutMs: an integer from 1 to 2147483647`), and the file untouched; fix the value, or remove it to use the default.

To register the plugin in one saved account of Claude Code or Codex, add `--client` and `--account`; see [accounts](accounts.md#register).

Install/update can edit shell profiles or the Windows user PATH; `--no-path` skips this. Downloads verify SHA-256 for changed bytes; it does not authenticate the source. Real-client proof varies by system: see [release evidence](../maintainers/RELEASING.md#proof-per-pair).

[Next: ask the Director](ask-the-director.md) · [Guide](README.md) · [Português](install.pt-BR.md)
