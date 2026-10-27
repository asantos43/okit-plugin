---
name: okit-environment
description: Use when the user asks where you are, what you have here, which environment, or invokes /okit-environment. Use quando perguntar onde você está, o que você tem aqui ou qual ambiente.
---

# Environment / Ambiente

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


Run `okit-plugin env report` or the MCP tool `env_report`. The saved `language` is used automatically (default: `en`); Portuguese users can set it once with `okit-plugin config set language pt-BR`. Pass `--locale` (MCP `locale`) only to choose another language for one call. Use optional `--client <name>` (MCP `client`) only when the user asks about one client.

If the command is not found, run `node "${CLAUDE_PLUGIN_ROOT}/src/cli.js" env report` with the same arguments.

Explain the returned facts in plain words: which client is in use, what is installed, confirmed active models, available work choices, quota, free slots and plugin/state folders. Keep unknown readings unknown. Name each missing item and quote the reported command that fixes it. Do not run a repair or change settings just to answer an environment question.

Rode `okit-plugin env report` ou a ferramenta MCP `env_report`. O idioma salvo em `language` é usado automaticamente (padrão: `en`); para português, basta usar uma vez `okit-plugin config set language pt-BR`. Passe `--locale` (`locale` no MCP) somente para escolher outro idioma em uma chamada. Use `--client <nome>` (`client` no MCP) somente quando a pergunta for sobre um cliente.

Se o comando não for encontrado, rode `node "${CLAUDE_PLUGIN_ROOT}/src/cli.js" env report` com os mesmos argumentos.

Explique os fatos retornados em palavras simples: cliente em uso, o que está instalado, modelos ativos confirmados, opções de trabalho, cota, vagas livres e pastas do plugin e de estado. Mantenha como desconhecido o que não foi confirmado. Cite cada item que falta e o comando informado para corrigir. Não execute correções nem altere configurações só para responder sobre o ambiente.
