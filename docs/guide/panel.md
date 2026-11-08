# Claude Code panel

![okit-plugin: User guide](../images/banners/guide.svg)

An optional, read-only pane beside the Claude Code chat shows each account's remaining quota, work in progress and recent work. Accounts appear by alias, never emails or credentials. The installation offer describes these features and asks whether to install; opening and toggle instructions appear only after installation succeeds.

<a id="install"></a>
## Install

1. A terminal offers the optional panel after a successful Claude Code install, for the account being installed. Use `--no-panel` to skip both the question and the later hint. Without a terminal, installation only prints the hint. Turn it on later with `okit-plugin install --panel`; add `--client claude-code --account <id>` to select a saved account by id. Updates only refresh an installed panel.

<a id="use"></a>
## Open and close

2. The installed panel opens automatically when Claude Code starts. Set `panel.autoOpen` to `false` in the state root's `config.json` to disable this. The `okit-panel` command (`/okit-panel`) still opens or closes the pane. It refreshes every 3 s (minimum 2 s) while open; no refresh runs while closed.

<a id="board"></a>
Quota is actively read every minute for every saved Claude Code and Codex account, including default. The background service owns the poller. Without it, `panel-state` starts a due read in a separate worker, at most once per minute per account, and immediately shows the last reading. Adding an account or installing its plugin requests a read immediately. Passive status-bar and Codex session readings remain; the newest reading wins.

Claude uses the fixed HTTPS OAuth usage endpoint when its account token is valid. The plugin reads only the access token and expiry in memory for that request, never stores or renews the token, and never modifies credential files. With an expired or missing token, a logged-in account uses a lean Haiku CLI fallback at most every 30 minutes. That real call uses a few tokens, can start the 5h window, and lets Claude renew its own login. Codex uses `app-server` with the account's `CODEX_HOME`, without opening `auth.json`.

Each account shows rotation eligibility: both windows must have **more than 20%** remaining by default (`accountPolicy.minQuotaPct`). Missing readings and readings older than three polling intervals count as unknown and rank last. States explain missing quota: `ok` means the read succeeded; `not-logged-in` requires login; `token-expired` waits for the next permitted fallback; `read-failed` means usage could not be read; `no-reading` means none exists yet. Failures back off from 1 to 15 minutes. Configure `quotaPoll` with `enabled` (true), `intervalSec` (60), and `claudeFallbackMinutes` (30); false disables active reads.

## What the board shows

- ACCOUNTS: running/idle aliases, aligned session 5h and weekly bars, percent left, local 24 h reset times and time remaining (`4h35m` or `1d 21h`). Resets more than 24 h away include the weekday; `!` marks less than 20% left and missing quota shows `unknown`.
- RUNNING: active runs and their last progress line.
- RECENT: completed, failed or no longer live (stale) runs.
- LAUNCHABLE NOW: accounts eligible for simple/normal/hard/critic work.
- Readiness: gaps that prevent launching work.
- `unknown`: unavailable data, never zero quota.

Quota rows use the host theme: at least 50% left is green (`ok`), 20% to below 50% is yellow (`warn`), below 20% is red (`low`), and unknown quota is dim (`dim`). Exactly 50% is green, 20% is yellow and 19.9% is red. Wrapped lines keep the same tone. The percent text (`12% left`) and `!` below 20% remain visible. `panel.color` defaults to `true`; set it to `false` in `config.json` for plain text. Doctor account-choice quota percentages use the same thresholds on a terminal and honor `NO_COLOR`; piped and MCP output remain plain.

What the board looks like (a text rendering, not a capture of the real Claude Code screen):

```text
okit plugin · claude · 2 accounts · ready: no
╔═ ACCOUNTS ═══════════════════════════════════════════════════════════════════╗
║ Personal · running                                                           ║
║   session 5h [████████░░] 80% left resets 17:00 (in 5h00m)                   ║
║   week                    unknown                                            ║
║ Work · idle                                                                  ║
║   session 5h              unknown                                            ║
║   week                    unknown                                            ║
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
