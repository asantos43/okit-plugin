# Preview a demonstration

![okit-plugin: User guide](../images/banners/guide.svg)

Preview the proposed work and allowance before deciding whether to approve a demonstration.

<a id="preview"></a>
## Preview

1. Run `okit-plugin smoke-demo --dry-run --locale en`. Expect proposed work, helpers, allowance and cost/time/call limits. The preview starts no model and spends no allowance. In chat, ask “Show a demonstration”; the `okit-smoke` skill uses the same preview through `smoke_demo`.
2. Read the preview before approving. After explicit approval, run `okit-plugin smoke-demo --locale en --confirm HASH`, replacing `HASH` with the returned `planHash` and keeping the same client and language. If you selected a client, keep that selection. Changed work, helpers, settings or allowance require a fresh preview and approval. Confirmation starts the five practice tasks with the selected real client and spends your allowance. MCP `smoke_demo` accepts the same hash in `confirm`. The report includes measured final usage; exit 0 means pass, 2 refusal before launch and 1 fail/partial.
3. For local installation checks, run `okit-plugin smoke`. Expect one result per check, totals and report paths. A clean run ends with `passed: 32 failed: 0 skipped: 0`; exit 0 means success, 1 a failed check and 2 a refused invocation. These isolated checks do not prove real-client execution.

Choose Claude Code, Codex or OpenCode with `--client claude-code`, `--client codex` or `--client opencode`. For example, `okit-plugin smoke-demo --dry-run --client codex --locale en` shows the selected helper and configured limits without spending allowance. Keep that choice when confirming the preview. A client without money reports requires positive integer `smoke.maxTokens`; without it confirmation refuses before launching. Paid proof belongs to the owner; offline tests spend no allowance.

For client checks, use `okit-plugin smoke --client codex --dry-run` (or `client-smoke`). Install the selected client's command (`claude`, `codex` or `opencode`), sign in and set up the plugin in that client first. Removing `--dry-run` starts real work and spends allowance. Codex and OpenCode cannot show the plugin and hook details that Claude Code reports, so those checks are skipped and described; their tool checks still run. A real Codex run requires a positive `smoke.maxTokens` value in `config.json`; without it the run is refused before any model call. See [smoke evidence and budgets](../maintainers/SMOKE.md) before running real checks.

The `client-smoke` runner has 23 scenario checks.

The demonstration shares `smoke.maxUsd` across execution, review and corrections and limits each task with `smoke.demoDemandMaxUsd` (default: total divided by five). Between calls, new work stops once the remaining room is used up. A money ceiling inside a single call exists only for Claude Code: OpenCode has no way to receive it and Codex does not report money. With OpenCode the ceiling applies between calls, and if one call spends more than was reserved, the total cost is shown as unknown. `smoke.demoMaxReworkRounds`, `smoke.maxTurns`, `smoke.maxMinutes` and `smoke.checkTimeoutMs` also apply. Exhausted ceilings or unmeasured usage stop new work and produce a partial report. The demonstration through MCP cannot be cancelled midway; it ends by its limits (`smoke.maxMinutes` and the cost ceilings).

The preview explains the limits for your helper. Claude Code and OpenCode add up reported spending and stop new work at the money ceiling; missing cost information also stops new work. Codex reports how much text it reads and writes. It can continue across several steps within the time and step limits, and also needs a positive `smoke.maxTokens` ceiling in `config.json` before a real run. Add `"maxTokens": 50000` under `"smoke"` in `config.json` (choose a limit that fits your needs); the default `null` has no text ceiling, so a real Codex run is refused. The limit is checked after each reply, so that reply can exceed it. Codex has no guaranteed money ceiling, and OpenCode cannot guarantee one within a single call. The preview spends nothing.

The real demonstration runs in an isolated practice folder and does **not** inherit the client's login session. Before confirming, export the client's key or token: Claude Code uses `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` or `CLAUDE_CODE_OAUTH_TOKEN`; Codex uses `OPENAI_API_KEY`; OpenCode has no accepted variable yet, so the real demonstration does not authenticate. Without this the call fails without spending anything. A missing or empty `PATH` in the environment refuses the confirmation before it starts.

[Guide](README.md) · [Português](smoke-demo.pt-BR.md)
