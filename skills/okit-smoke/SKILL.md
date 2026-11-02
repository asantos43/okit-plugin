---
name: okit-smoke
description: Use for /okit-smoke, show a demonstration, run a real test, mostre uma demonstração, faça um teste de verdade, or to narrate the plugin's smoke checks and report.
---

# Smoke

## Question routing / Encaminhamento de perguntas

| Question / Pergunta | Skill → tool / ferramenta |
| :- | :- |
| Where are you? / Onde você está? | `okit-environment` → `env_report` |
| Which actors/helpers? / Quais atores/ajudantes? | `okit-director` → `actors_list`; running executors / executores rodando → `status` |
| How much quota? / Quanta cota? | `okit-environment` → `env_report`; detail / detalhe → `quota_show` or `status` |
| What is missing? / O que falta? | `okit-environment` → `env_report`; explicitly requested setup / configuração solicitada explicitamente → `okit-setup` → ask the user to run `okit-plugin setup`, with its own confirmation / com sua própria confirmação |
| What is your role? / Qual o seu papel? | Delivered / contexto entregue `okit-director`, `okit-executor`, `okit-critic` + `order_list`, `inbox_list`, `actors_list`, `limits_status`, `env_report` |
| Run smoke/demonstration / Rodar smoke/demonstração | `okit-smoke` → `smoke_demo`; explicit allowance consent / confirmação explícita de cota |

Actor / ator = model + effort / modelo + esforço; executor = briefed role / papel com briefing; class / classe = work category / categoria de trabalho; size / tamanho = S/M/L; slot / vaga = simultaneous executor room / espaço para executor simultâneo; profile / perfil = saved choice / escolha salva; quota / cota = remaining allowance / saldo; source / fonte = origin and sample age / origem e idade da amostra.
Producer synonyms / Sinônimos do Produtor: available executor, worker, helper, agent, model, work choice / executor disponível, trabalhador, ajudante, agente, modelo, opção de trabalho; complexity / complexidade; small/medium/large task / tarefa pequena/média/grande; preset / predefinição; usage left, remaining limit / uso restante, limite restante; reading, sample / leitura, amostra. Capacity / capacidade = quota and free slots separately / cota e vagas livres separadas.
Environment questions are read-only: never save configuration, launch work or spend quota. Use readable titles, never demand/order ids in answers. / Perguntas de ambiente são somente leitura: nunca salvar configuração, lançar trabalho ou gastar cota. Use títulos legíveis, nunca ids de demanda/ordem nas respostas.


Drive the existing runner; do not reimplement the scenario or judge success from model prose.

For “show a demonstration” / “mostre uma demonstração” or “run a real test” / “faça um teste de verdade”, use this flow in every client:
1. Call `smoke_demo` with `dryRun: true`. Use the saved `language` (default: `en`); set Portuguese once with `config_set`, the key `language` and the value `pt-BR`. Pass `locale` only for a one-call change. / Use o idioma salvo em `language` (padrão: `en`); configure português uma vez com `config_set`, a chave `language` e o valor `pt-BR`. Passe `locale` apenas para mudar uma chamada. Show titles, chosen helpers, current allowance/source/age, total/per-task cost ceilings, corrections and time/call limits. This preview spends no allowance.
2. Ask “This practice run uses your allowance, up to the displayed total. May I start?” / “Esta execução usa sua cota até o teto mostrado. Posso começar?” Wait for an explicit answer; a demo request alone is not spending consent.
3. Only after approval, pass the preview's `planHash` as `confirm` to `smoke_demo`, preserving client and language. Never approve automatically. Changed work, helpers, settings or allowance require a new preview and confirmation.
4. Narrate the returned events in order: preparation, choice of helpers, available places, work, checks, correction, stop and cleanup. Use ordinary sentences and work titles; hide identifiers, tool names and internal codes. / Narre em ordem, com títulos e frases simples; esconda identificadores, ferramentas e códigos internos.
5. Finish with what the files actually proved, skipped work and its reason, cleanup and the exit code. A preview proves no execution. Without measured usage and an enforceable cost ceiling, report refusal; never substitute a model launch. / Termine com as provas, trabalhos pulados e motivos, limpeza e resultado; sem medição e teto comprovados, informe a recusa.

The demo runs inside the kit: the tool answers with the events, the helpers it chose and the measurements it took. You never run a command of your own, and the checks of the installation are the person's work: ask the user to run `okit-plugin doctor`. / A demonstração roda dentro do kit: a ferramenta responde com os eventos, os auxiliares escolhidos e as medições feitas. Você nunca roda um comando seu, e as verificações da instalação são trabalho da pessoa: peça ao usuário para rodar `okit-plugin doctor`.
