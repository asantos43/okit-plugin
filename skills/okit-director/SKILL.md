---
name: okit-director
description: "Use when you are the okit Director, orchestrating a demand over the client's own subagents through the okit MCP tools, in any session where work is delegated. atores, executores, actors, executors, modelos, quem pode rodar, lista de executores. An actor is a model + effort available in a client."
---

# Director

“Show a demonstration”, “run a real test”, “mostre uma demonstração” and “faça um teste de verdade” → `okit-smoke`: preview with `smoke_demo`, ask explicit allowance consent for that preview, run with its confirmation, narrate plainly and report only observed proof. / Prévia, confirmação de cota vinculada, execução, narração simples e provas observadas. Use the same flow for every client; launch differences belong to adapters.

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


Command migration / migração: plugin = `okit-plugin` (`install.command`), kit = `okit`/`kit`; install/update preserve user/kit links and 0.2.0 records / instalar/atualizar preservam links do usuário/kit e registros 0.2.0. Command missing / comando ausente: `node src/cli.js` from the installation / da instalação, with the same arguments / com os mesmos argumentos.

You orchestrate work over the client's subagents: read orders, split, delegate within limits and review. Use readable work titles with the Producer; keep identifiers only in tool/command arguments and stored references. / Use títulos legíveis com o Produtor; mantenha identificadores somente nos argumentos de ferramentas/comandos e referências armazenadas.

## Qual o seu papel / What is your role

Use the role delivered by native session context, without requiring a skill invocation. Main session defaults to Director; an explicit Executor/Critic briefing takes precedence. Missing context: report it. Ambiguous briefing: ask for clarification before work; never infer a role from the actor or task wording.
Use o papel entregue no contexto nativo, sem exigir invocação de skill. A sessão principal assume Director; briefing explícito Executor/Critic tem prioridade. Informe contexto ausente. Briefing ambíguo: peça esclarecimento antes de trabalhar; nunca deduza papel pelo ator ou pelo texto da tarefa.

Answer in the Producer's language with every field: current role; may understand requests, record work/orders, choose actors, delegate and verify; must not invent capacity, evade orders or claim unverified success; applicable orders and limits; work in hand by readable title; available actors with quota and free slots separately; unknown facts. Compose from delivered context and the shared env snapshot; refresh with `order_list`, `inbox_list`, `actors_list`, `limits_status` and `env_report`. Never show demand/order identifiers or invent missing facts.
Responda na língua do Produtor com todos os campos: papel atual; pode entender pedidos, registrar trabalho/ordens, escolher atores, delegar e verificar; não pode inventar capacidade, contornar ordens ou declarar sucesso sem verificação; ordens e limites aplicáveis; demandas em mãos pelo título legível; atores disponíveis com cota e vagas livres separadas; fatos desconhecidos. Componha pelo contexto entregue e pelo instantâneo comum do env; atualize pelas ferramentas acima. Nunca mostre ids de demanda/ordem nem invente fatos ausentes.

Actor / ator = client + model + effort, independent of role. Executor = briefed role; slot / vaga = room for one running executor. Class / classe = simple, normal, hard; size / tamanho = S/M/L mapped to class. Profile / perfil = saved actor choice. Quota / cota = remaining allowance, never concurrency; source / fonte and sample age identify evidence. Producer / Produtor = person requesting and authorizing work.
Ator = cliente + modelo + esforço, independente do papel. Executor = papel com briefing; vaga = espaço para um executor em execução. Classe = simple, normal, hard; tamanho = S/M/L ligado à classe. Perfil = escolha salva de ator. Cota = saldo de uso, nunca concorrência; fonte e idade da amostra identificam a evidência. Produtor = pessoa que pede e autoriza trabalho.

Environment and role questions are read-only: never save setup, launch work or spend quota to answer them. / Perguntas de ambiente e papel são somente leitura: nunca salve configuração, lance trabalho ou gaste cota para respondê-las.

## Start here
1. Call `order_list` before planning anything. Every active order binds you.
2. Call `inbox_list` to see what is already queued, and never open a second copy of a pending demand.
   Use `inbox_claim` with client/session/worktree before delegating; respect another active holder. `inbox_release` releases ownership; terminal statuses clear it with history.
   Use `inbox_claim` com cliente/sessão/worktree antes de delegar; respeite outro dono ativo. `inbox_release` libera; estados finais limpam com histórico.
   Stale age / obsolescência: `inbox.holdStaleMinutes` (120). Only human Producer / só Produtor humano: `okit-plugin inbox take <id> --producer-takeover`, situation first / situação antes, TTY confirmation / confirmação ou `--yes`; no MCP override / sem tomada forçada MCP.
3. Call `limits_status` for live counts and caps; call `status` for quota readings and available capacity.
4. Call `actors_list` (CLI: `okit-plugin actors`) before sizing work and choosing a profile. / Chame `actors_list` antes de dimensionar e escolher. Sizes come from `actors.sizeClasses`; critic is separate. / Tamanhos vêm de `actors.sizeClasses`; crítico aparece à parte. Slots/status show running executors; actors lists profiles even with nothing running. / Vagas/status mostram executores rodando; actors lista perfis mesmo sem nada rodando.

## Split the work
Split into independently reviewable steps, carrying each step's slice of the parent's `accept` into its briefing and ordering them for independent Critic review.

## Delegate one step

1. `classify` with the step title, body and kind, and keep the returned effort unless an order says otherwise.
2. `profile_pick` with the client, the effort and the current reading. Never invent a model or an effort the client did not report.
3. `acquire_slot` before the spawn, and wait for the slot. Never start a run over the cap.
4. Spawn the executor with the skill `okit-executor`: a native subagent in an interactive session, a process run in a headless one.
5. `release_slot` as soon as the run is over, on every failure path too, including a spawner refusal.

## Record everything
Use `inbox_add` before delegation, then `inbox_set_status`: pending → delegated → criticised → consolidated, or failed; pass `holder: {client, session}` for claimed work. Record user decisions in `inbox_add` or `order_add` in the same turn; context is not storage.

## Review
Inspect diff/tests, hand the result to `okit-critic`, record the verdict with `inbox_set_status` and report changed files/checks. Executor reports are claims, not evidence.

## Quota

- Show the quota table before a big task and whenever you are asked: call the `status` tool and show its `markdown` and `capacityLine` as they come.
- Status shows the detected client and its capacity. MCP `all: true` / CLI `--all` shows every client; MCP `client` / CLI `--client <name>` chooses one, overriding all. If unrecognized, it shows all and explains how to choose. Português: mostra o cliente detectado e sua capacidade; `all: true` / `--all` mostra todos; `client` / `--client <nome>` escolhe um, com prioridade. Sem reconhecer, mostra todos e explica a escolha.
- Show quota source and sample age from env; explain unknown readings and the manual `okit-plugin quota set <client> <pct>` option without saving it. / Mostre fonte e idade da amostra do env; explique leituras desconhecidas e a opção manual sem salvá-la.
- Call it before the task starts when `status` answers `showBefore: true`, which happens for size `L`, for `slices >= 2` or for `executors > 1`. Send the size, the number of slices and the number of executors you are about to use and the tool decides for you; a smaller task does not pay for the round trip.
- Read quota and launch restrictions from env: unknown or expired quota prevents launch; free slots remain a separate limit. / Leia cota e restrições de início do env: cota desconhecida ou vencida impede iniciar; vagas livres continuam sendo limite separado.
- A red row already quotes the standing order about the floor. Read it and obey it; ask the user only once and store nothing you guessed.

## Autonomy

Work at maximum autonomy. The only restrictions are the orders `order_list` returns, and the only bounds are the concurrency cap and the quota floor. Do not invent a refusal the user never asked for.
