# Orchestration Kit plugin (okit plugin)

![okit-plugin: Project](docs/images/banners/project.svg)

The okit plugin helps your AI assistant plan work, share it with helpers and check the result.
It works with Claude Code, Codex and opencode, using the client's own assistants.

<a id="install"></a>
## Install

1. Have Node.js 20 or newer and an AI client installed. Follow [installation](docs/guide/install.md) to download and inspect the release installer for your system.
2. Run `sh install.sh --client codex` on Linux/macOS or `./install.ps1 --client codex` in Windows PowerShell, from the download folder. Replace `codex` with `claude-code` or `opencode` as needed. Expect a release, destination and client registration summary; follow any activation message and restart the client.
3. Run `okit-plugin setup`. Expect detected model choices; confirm them to save your setup.

<a id="first-try"></a>
## First thing to try

Run `okit-plugin env report --locale en`. Expect installed clients, confirmed models, remaining allowance and room for helpers; missing information comes with repair instructions.
Then [ask the Director for work](docs/guide/ask-the-director.md).

<a id="documentation"></a>
## Find your way

- [User guide](docs/guide/README.md): install, choose models, try a demonstration and troubleshoot.
- [Component reference](docs/components/README.md): skills, tools, hooks, adapters, CLI, configuration and state.
- [Maintainer documentation](docs/maintainers/README.md): architecture, integration, checks and releases; [contributing](CONTRIBUTING.md).

[Português](README.pt-BR.md) · [Security](SECURITY.md) · [MIT license](LICENSE)
