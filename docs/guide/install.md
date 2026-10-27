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
4. Open a new terminal and restart the AI client so they find the installed command. If an activation command was printed, you can run it yourself in the current terminal. Run `okit-plugin setup`; expect detected model choices and confirmation before saving. If no active model is detected, follow [models and allowance](models-and-quota.md).
5. Run `okit-plugin env report --locale en`. Expect the client, confirmed active models, allowance, free helper places and folders. Unknown items stay unknown and include repair instructions.

For Claude Code, run `okit-plugin update --client claude-code --statusline` after installation to enable allowance collection while preserving your previous status bar. Expect a settings preview; `--no-statusline` declines collection. During installation, a terminal asks and unattended installs skip collection. The downloaded scripts do not accept these two status bar options; use the installed command.

Install/update can edit shell profiles or the Windows user PATH; `--no-path` skips this. Downloads verify SHA-256 for changed bytes; it does not authenticate the source. Real-client proof varies by system: see [release evidence](../maintainers/RELEASING.md#proof-per-pair).

[Next: ask the Director](ask-the-director.md) · [Guide](README.md) · [Português](install.pt-BR.md)
