# Accounts

![okit-plugin: User guide](../images/banners/guide.svg)

Claude Code and Codex can have multiple accounts. Each has a stable id, an editable label and its own configuration folder. OpenCode is outside this feature. The implicit `default` account has no folder override and keeps the client's current environment.

<a id="manage"></a>
## Manage an account

1. Add a folder with an absolute path, then run the printed manual login command.
2. Register the printed Claude collector command, if applicable, and check `account list`.
3. Rename or remove the saved entry as needed; its id stays stable when renamed.

```sh
okit-plugin account add claude-code Work --config-dir /absolute/path/claude-work
okit-plugin account add codex Work --config-dir /absolute/path/codex-work
okit-plugin account list
okit-plugin account list codex --json
okit-plugin account rename codex work 'Production account'
okit-plugin account rename codex 'Production account' 'Work account'
okit-plugin account remove codex work
```

Use an absolute path. On Windows PowerShell, for example: `okit-plugin account add codex Work --config-dir "$env:USERPROFILE\codex-work"`. Add creates missing folders (mode 0700 on POSIX), saves the account and reports its id, label, folder and login state. Labels must be non-empty, at most 40 characters, unique within the client and contain no control characters.

Login stays manual. Follow the printed command: `CLAUDE_CONFIG_DIR=/absolute/path/claude-work claude` or `CODEX_HOME=/absolute/path/codex-work codex`. On PowerShell: `$env:CODEX_HOME='C:\Accounts\Work'; codex` (Claude uses `CLAUDE_CONFIG_DIR` and `claude`). A `logged-in` result means a local marker exists; it does not verify access. No credentials are read, copied or printed. macOS Keychain and Codex keyring storage report `unknown`.

For Claude Code, add prints a collector command. Register it manually as `statusLine.command` with `statusLine.type` set to `command` in that folder's `settings.json`. Preserve or chain any existing status bar as appropriate. The command sets `CLAUDE_CONFIG_DIR` and `OKWORK_HOME`, so the collector identifies the account by its folder and writes its own sample. Claude uses a POSIX shell, including Git Bash on Windows. Codex reads its own local session quota; it has no Claude status bar to register. The account commands never edit client files.

List shows the default first for each client; JSON contains `client`, `id`, `label`, `configDir` (null for default) and `login`. Remove accepts an id and only changes plugin configuration: the folder, login and recorded history remain. Default cannot be removed. Rename accepts an id or current label, changes only the label and preserves quota/history lookup by id.

Quota, slots and model choices are per account. `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN` override a stored Claude login. Check the environment before interpreting an account's allowance.

For manual quota, call `quota_set` with `client: "claude-code"`, `account: "work"` and `pct: 80`; read it with `quota_show` using the same client and account. Use the stable id, never `claude-code:work` as the client. Omitting `account` keeps the default file `quota/claude-code.json`; the extra uses `quota/claude-code.work.json`. Unknown accounts are refused.

`acquire_slot` accepts the same optional account id. The client cap applies separately to each account; `limits_status` counts them under `claude-code` and `claude-code:work`, and `live` sums all runs. Its optional `client` and `account` select one account. Each extra's models, evidence and config path are observed with its own configuration environment; the default's saved catalog cannot confirm an extra. On Windows, home discovery prefers `USERPROFILE` over `HOME`.

[Guide](README.md) · [Models and quota](models-and-quota.md) · [Português](accounts.pt-BR.md)
