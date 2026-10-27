# Preview a demonstration

![okit-plugin: User guide](../images/banners/guide.svg)

Preview the proposed work and allowance before deciding whether to approve a demonstration.

<a id="preview"></a>
## Preview

1. Run `okit-plugin smoke-demo --dry-run --locale en`. Expect proposed work, helpers, allowance and cost/time/call limits. The preview starts no model and spends no allowance. In chat, ask “Show a demonstration”; the `okit-smoke` skill uses the same preview through `smoke_demo`.
2. Read the preview before approving. After explicit approval, run `okit-plugin smoke-demo --locale en --confirm HASH`, replacing `HASH` with the returned `planHash` and keeping the same client and language. If you selected a client, keep that selection. Changed work, helpers, settings or allowance require a fresh preview and approval. Currently expect a refusal with exit code 2: paid execution lacks proven usage measurement and an enforceable cost ceiling. No model starts.
3. For local installation checks, run `okit-plugin smoke`. Expect one result per check, totals and report paths. A clean run ends with `passed: 32 failed: 0 skipped: 0`; exit 0 means success, 1 a failed check and 2 a refused invocation. These isolated checks do not prove real-client execution.

Choose Claude Code, Codex or OpenCode with `--client claude-code`, `--client codex` or `--client opencode`. For example, `okit-plugin smoke-demo --dry-run --client codex --locale en` shows the selected helper and configured limits without spending allowance. Keep that choice when confirming the preview. The paid demonstration still refuses to start until usage measurement and a cost ceiling are proven.

For client checks, use `okit-plugin smoke --client codex --dry-run` (or `client-smoke`). Install the selected client's command (`claude`, `codex` or `opencode`), sign in and set up the plugin in that client first. Removing `--dry-run` starts real work and spends allowance. Codex and OpenCode cannot show the plugin and hook details that Claude Code reports, so those checks are skipped and described; their tool checks still run. A real Codex run requires a positive `smoke.maxTokens` value in `config.json`; without it the run is refused before any model call. See [smoke evidence and budgets](../maintainers/SMOKE.md) before running real checks.

The `client-smoke` runner has 23 scenario checks.

The preview explains the limits for your helper. Claude Code and OpenCode add up reported spending and stop new work at the money ceiling; missing cost information also stops new work. Codex reports how much text it reads and writes. It can continue across several steps within the time and step limits, and also needs a positive `smoke.maxTokens` ceiling in `config.json` before a real run. Add `"maxTokens": 50000` under `"smoke"` in `config.json` (choose a limit that fits your needs); the default `null` has no text ceiling, so a real Codex run is refused. The limit is checked after each reply, so that reply can exceed it. Codex has no guaranteed money ceiling, and OpenCode cannot guarantee one within a single call. The preview spends nothing.

[Guide](README.md) · [Português](smoke-demo.pt-BR.md)
