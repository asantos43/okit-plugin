# Claude Code panel

![okit-plugin: User guide](../images/banners/guide.svg)

An optional, read-only panel for Claude Code only shows accounts by alias, never emails or credentials.

<a id="install"></a>
## Install

1. Run `okit-plugin install --panel` after installing the main Claude Code plugin; add `--client claude-code --account <id>` to select a saved account by id.

<a id="use"></a>
## Open and close

2. Inside Claude Code, use the `okit-panel` command (`/okit-panel`) to open or close the pane. It refreshes every 3 s (minimum 2 s) while open; no refresh runs while closed.

<a id="board"></a>
## What the board shows

- ACCOUNTS: running/idle aliases, session (5 h) and weekly bars, percent left, UTC reset times and time remaining.
- RUNNING: active runs and their last progress line.
- RECENT: completed, failed or no longer live (stale) runs.
- LAUNCHABLE NOW: accounts eligible for simple/normal/hard/critic work.
- Readiness: gaps that prevent launching work.
- `unknown`: unavailable data, never zero quota.

What the board looks like (a text rendering, not a capture of the real Claude Code screen):

```text
okit plugin · claude · 2 accounts · ready: no
╔═ ACCOUNTS ═══════════════════════════════════════════════════════════════════╗
║ Personal · running                                                           ║
║ session (5 h): [████████░░] 80% left · resets 2026-11-06T17:00:00.000Z (in   ║
║ 5h00m)                                                                       ║
║ week: unknown                                                                ║
║ Work · idle                                                                  ║
║ session (5 h): unknown                                                       ║
║ week: unknown                                                                ║
╚══════════════════════════════════════════════════════════════════════════════╝
╔═ RUNNING ════════════════════════════════════════════════════════════════════╗
║ one: live · demand sample-demand · account Personal · actor hard · opus ·    ║
║ effort high · elapsed 0:02                                                   ║
║ Last progress: Running checks                                                ║
╚══════════════════════════════════════════════════════════════════════════════╝
╔═ RECENT ═════════════════════════════════════════════════════════════════════╗
║ No recent runs.                                                              ║
╚══════════════════════════════════════════════════════════════════════════════╝
╔═ LAUNCHABLE NOW ═════════════════════════════════════════════════════════════╗
║ simple: none                                                                 ║
║ normal: none                                                                 ║
║ hard: none                                                                   ║
║ critic: none                                                                 ║
╚══════════════════════════════════════════════════════════════════════════════╝
╔═ Readiness ══════════════════════════════════════════════════════════════════╗
║ Ready to launch executors: no; gaps: S (no client installed), M (no client   ║
║ installed), L (no client installed); claude-code: 0/2 accounts ready.        ║
╚══════════════════════════════════════════════════════════════════════════════╝
```

<a id="remove"></a>
## Remove

3. Run `okit-plugin uninstall --panel` to remove only the panel, leaving the main plugin alone; `okit-plugin update` refreshes an installed panel.

<a id="troubleshooting"></a>
## If it does not work

If the panel-state JSON is unreadable or its schema is unsupported, inspect the diagnostic output.
Run `okit-plugin panel-state --json --client claude` in a terminal to see the state or error.

[Guide](README.md) · [Accounts](accounts.md) · [Português](panel.pt-BR.md)
