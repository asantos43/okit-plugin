---
name: okit-setup
description: Use when the user invokes /okit-setup or asks to configure the plugin's models through a conversation, showing what will be written before anything is saved.
---

# Setup

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


Run the setup the plugin already has. Never choose a model by hand, never edit the configuration file and never write an individual setting yourself.

- Detect and ask first: run `okit-plugin setup` once and read what it reports — the installed clients, the model it proposes for each work class and why. It shows the complete proposal and writes nothing until the final confirmation, so a refused run changes nothing. If the command is not found, run `node "${CLAUDE_PLUGIN_ROOT}/src/cli.js"` with the same arguments.
- Explain the proposal in plain words: which client, which work class, which model and why that one.
- Ask only what was not detected. A detected model is a fact: report it, do not ask about it.
- When the user wants a model of their own, give that model as the answer to the setup's own model question; `setup` has no option that takes a model as an argument. Never use the configuration write command.
- Save only through the setup's final confirmation, after the user has seen and accepted the complete proposal. The setup writes the complete set once; a refusal leaves everything unchanged.
- When the setup says the configuration file is not readable, tell the user that and how to fix it with `okit-plugin config show`. Write nothing yourself and do not ask for models: the setup cannot run until the configuration is readable.
- Finish by saying what was written: the client, the work class and the model of every saved choice, and that the setup is done. If the user refused, say that nothing was changed.
