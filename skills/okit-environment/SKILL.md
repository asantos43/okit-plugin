---
name: okit-environment
description: Use when the user asks where you are, what you have here, which environment, optional usage measurements, or invokes /okit-environment. Use quando perguntar onde você está, o que você tem aqui, qual ambiente ou sobre medições opcionais de uso.
---

# Environment / Ambiente

For optional usage measurements, call `telemetry_status` to show what is saved, the local folder, size and last export. Recording starts off; only counts, durations, states, model/effort/client names and a hashed project are saved. Prompts, messages, file contents, demand text and paths are dropped. Ask the user to turn the recording on (and off again) when they want it; you never turn it on by yourself. Sending is separately off and the user turns it on and off too; only aggregate counts are sent and the address and the headers are never revealed. Export with `telemetry_export`, optionally from a date.

Para medições opcionais de uso, chame `telemetry_status` para mostrar o que é salvo, a pasta local, o tamanho e a última exportação. A gravação começa desligada; somente contagens, durações, estados, nomes de modelo/esforço/cliente e resumo irreversível do projeto são salvos. Prompts, mensagens, conteúdo de arquivos, texto de demandas e caminhos são descartados. Peça ao usuário para ligar a gravação (e desligá-la) quando ele quiser; você nunca a liga sozinho. O envio começa desligado e quem liga e desliga é o usuário; somente contagens agrupadas são enviadas e o endereço e os cabeçalhos nunca são revelados. Exporte com `telemetry_export`, opcionalmente a partir de uma data.

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


Call the MCP tool `env_report`. The saved `language` is used automatically (default: `en`); a Portuguese user sets it once with `config_set`, the key `language` and the value `pt-BR`. Pass `locale` only to choose another language for one call. Pass `client` only when the user asks about one client.

Explain the returned facts in plain words: which client is in use, what is installed, confirmed active models, available work choices, quota, free slots and plugin/state folders. Keep unknown readings unknown. Name each missing item and say what fixes it: the tool to call, or the command only the user can run. Do not run a repair or change settings just to answer an environment question.

Chame a ferramenta MCP `env_report`. O idioma salvo em `language` é usado automaticamente (padrão: `en`); quem fala português configura uma vez com `config_set`, a chave `language` e o valor `pt-BR`. Passe `locale` somente para escolher outro idioma em uma chamada. Passe `client` somente quando a pergunta for sobre um cliente.

Explique os fatos retornados em palavras simples: cliente em uso, o que está instalado, modelos ativos confirmados, opções de trabalho, cota, vagas livres e pastas do plugin e de estado. Mantenha como desconhecido o que não foi confirmado. Cite cada item que falta e o que corrige: a ferramenta a chamar ou o comando que só o usuário pode rodar. Não execute correções nem altere configurações só para responder sobre o ambiente.
