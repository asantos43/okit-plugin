# Preview a demonstration

![okit-plugin: User guide](../images/banners/guide.svg)

Preview the proposed work and allowance before deciding whether to approve a demonstration.

<a id="preview"></a>
## Preview

1. Run `okit-plugin smoke-demo --dry-run --locale en`. Expect proposed work, helpers, allowance and cost/time/call limits. The preview starts no model and spends no allowance. In chat, ask “Show a demonstration”; the `okit-smoke` skill uses the same preview through `smoke_demo`.
2. Read the preview before approving. After explicit approval, run `okit-plugin smoke-demo --locale en --confirm HASH`, replacing `HASH` with the returned `planHash` and keeping the same client and language. If you selected a client, keep that selection. Changed work, helpers, settings or allowance require a fresh preview and approval. Currently expect a refusal with exit code 2: paid execution lacks proven usage measurement and an enforceable cost ceiling. No model starts.
3. For local installation checks, run `okit-plugin smoke`. Expect one result per check, totals and report paths. A clean run ends with `passed: 32 failed: 0 skipped: 0`; exit 0 means success, 1 a failed check and 2 a refused invocation. These isolated checks do not prove real-client execution.

For existing client checks, `okit-plugin client-smoke --client claude-code --dry-run` prints the proposed commands without running a model. The real driver supports Claude Code; other client drivers are pending. The quota pre-check also accepts a recent, valid automatic reading from Codex sessions or OpenCode's configured source. The `client-smoke` runner has 23 scenario checks. See [smoke evidence and budgets](../maintainers/SMOKE.md) before running real checks, and [demonstration design](../maintainers/DEMO.md) for report details.

[Guide](README.md) · [Português](smoke-demo.pt-BR.md)
