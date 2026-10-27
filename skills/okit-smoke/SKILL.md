---
name: okit-smoke
description: Use for /okit-smoke, show a demonstration, run a real test, mostre uma demonstração, faça um teste de verdade, or to narrate the plugin's smoke checks and report.
---

# Smoke

## Question routing / Encaminhamento de perguntas

| Question / Pergunta | Skill → tool or command / ferramenta ou comando |
| :- | :- |
| Where are you? / Onde você está? | `okit-environment` → `env_report` or `okit-plugin env report` |
| Which actors/helpers? / Quais atores/ajudantes? | `okit-director` → `actors_list` or `okit-plugin actors`; running executors / executores rodando → `status` |
| How much quota? / Quanta cota? | `okit-environment` → `env_report`; detail / detalhe → `okit-plugin quota show` or `status` |
| What is missing? / O que falta? | `okit-environment` → `env_report`; explicitly requested setup / configuração solicitada explicitamente → `okit-setup` → `okit-plugin setup`, with its own confirmation / com sua própria confirmação |
| What is your role? / Qual o seu papel? | Delivered / contexto entregue `okit-director`, `okit-executor`, `okit-critic` + `order_list`, `inbox_list`, `actors_list`, `limits_status`, `env_report` |
| Run smoke/demonstration / Rodar smoke/demonstração | `okit-smoke` → `smoke_demo` or `okit-plugin smoke-demo --dry-run` for practice / para exemplo; explicit allowance consent / confirmação explícita de cota; existing checks / verificações existentes: `okit-plugin client-smoke --client claude-code --demo` |

Actor / ator = model + effort / modelo + esforço; executor = briefed role / papel com briefing; class / classe = work category / categoria de trabalho; size / tamanho = S/M/L; slot / vaga = simultaneous executor room / espaço para executor simultâneo; profile / perfil = saved choice / escolha salva; quota / cota = remaining allowance / saldo; source / fonte = origin and sample age / origem e idade da amostra.
Producer synonyms / Sinônimos do Produtor: available executor, worker, helper, agent, model, work choice / executor disponível, trabalhador, ajudante, agente, modelo, opção de trabalho; complexity / complexidade; small/medium/large task / tarefa pequena/média/grande; preset / predefinição; usage left, remaining limit / uso restante, limite restante; reading, sample / leitura, amostra. Capacity / capacidade = quota and free slots separately / cota e vagas livres separadas.
Environment questions are read-only: never save configuration, launch work or spend quota. Use readable titles, never demand/order ids in answers. / Perguntas de ambiente são somente leitura: nunca salvar configuração, lançar trabalho ou gastar cota. Use títulos legíveis, nunca ids de demanda/ordem nas respostas.


Drive the existing runner; do not reimplement the scenario or judge success from model prose.

For “show a demonstration” / “mostre uma demonstração” or “run a real test” / “faça um teste de verdade”, use this flow in every client:
1. Call `smoke_demo` with `dryRun: true`, or `okit-plugin smoke-demo --dry-run --json`. Use the saved `language` (default: `en`); set Portuguese once with `okit-plugin config set language pt-BR`. Pass `locale` / `--locale` only for a one-call change. / Use o idioma salvo em `language` (padrão: `en`); configure português uma vez com `okit-plugin config set language pt-BR`. Passe `locale` / `--locale` apenas para mudar uma chamada. Show titles, chosen helpers, current allowance/source/age, total/per-task cost ceilings, corrections and time/call limits. This preview spends no allowance.
2. Ask “This practice run uses your allowance, up to the displayed total. May I start?” / “Esta execução usa sua cota até o teto mostrado. Posso começar?” Wait for an explicit answer; a demo request alone is not spending consent.
3. Only after approval, pass the preview's `planHash` as `confirm` to `smoke_demo`, or `--confirm <preview>` to the same CLI command, preserving client and language. Never approve automatically. Changed work, helpers, settings or allowance require a new preview and confirmation.
4. Narrate the returned events in order: preparation, choice of helpers, available places, work, checks, correction, stop and cleanup. Use ordinary sentences and work titles; hide identifiers, tool names and internal codes. / Narre em ordem, com títulos e frases simples; esconda identificadores, ferramentas e códigos internos.
5. Finish with what the files actually proved, skipped work and its reason, cleanup and the exit code. A preview proves no execution. Without measured usage and an enforceable cost ceiling, report refusal; never substitute a model launch. / Termine com as provas, trabalhos pulados e motivos, limpeza e resultado; sem medição e teto comprovados, informe a recusa.

The existing checks below remain a separate flow. / As verificações existentes abaixo continuam sendo um fluxo separado.

- Before a real run, warn that it spends the user's quota and ask for confirmation. Without confirmation, use `--dry-run`.
- After confirmation, run `okit-plugin client-smoke --client claude-code --demo` by default. If the command is not found, run `node "${CLAUDE_PLUGIN_ROOT}/src/cli.js"` with the same arguments. Honor the user's requested mode instead: `--headless`, `--dry-run` or `--rehearsal`. The latter two are offline and need no quota confirmation.
- Use the configured `smoke.*` variables for limits; honor requested overrides with `--max-usd`, `--max-turns` and `--max-minutes`. Do not invent fixed cost, turn or time limits.
- Run the command in the foreground and capture the exit code yourself: `okit-plugin client-smoke --client claude-code --demo ; echo "exit=$?"`. Never let the shell swallow the exit code and never ignore it, because the runner's own `smoke: end exit=<code> artifacts=<folder>` line is the authority on how the run ended.
- If the output comes empty, read the newest artifact of the artifacts folder before reporting: the folder of the `smoke: end` line, or the newest `smoke-*.jsonl` and `smoke-*.log` under the state root's `logs/smoke` folder. The artifacts hold the same records the missing output held.
- If the runner exits with `quota-unknown`, ask the Producer for the remaining quota percentage shown in the client's `/usage`. Run `okit-plugin quota set <client> <pct>` with their answer, then rerun the smoke with the same options. Use `--allow-unknown-quota` only when the Producer explicitly requests it. Refresh stale records according to `smoke.quotaMaxAgeMinutes` and `smoke.quotaExpireMinutes`; do not invent age limits.
- Narrate each step as the runner's output arrives, using readable titles, verdict and any failure or skip reason. Keep polling a running command until it exits.
- Finish with one line per verification, the `PARCIAL` line if present, the artifact paths if emitted, and the actual process exit code. For an offline walk, identify planned checks as unexecuted; never claim that it proves the real installation works.
