# Skills

![okit-plugin: Componentes](../images/banners/components.svg)

As skills orientam o modelo conforme o papel e a intenção reconhecidos pelo cliente.

<a id="loading"></a>
## Carregamento

O cliente seleciona instruções pela descrição da skill ou por invocação explícita; copiar arquivos não comprova ativação. O contexto nativo entrega o papel principal, e briefings explícitos entregam Executor/Critic.
Todas encaminham perguntas de ambiente para env_report, atores para actors_list/status e demonstração para okit-smoke. Os recursos abaixo incluem comandos e ferramentas; verificações de arquivos usam recursos nativos do cliente.

<a id="okit-director"></a>
## okit-director

Mantém as tarefas dos projetos habilitados em dia; pergunta antes de usar uma sugestão, confere vínculos ausentes antes da entrega com `todo_status` e mostra correções com `todo_sync`.

| Skill | Uso e instrução | Recursos principais |
| :- | :- | :- |
| `okit-director` | Orquestra trabalho solicitado; carregada ao dirigir ou delegar. Lê ordens e fila, classifica, escolhe atores, assume trabalho, reserva/libera vagas, orienta Executor e Critic, verifica provas e registra transições. | `order_list`, `inbox_list`, `inbox_claim`, `inbox_release`, `limits_status`, `status`, `actors_list`, `env_report`, `classify`, `profile_pick`, `acquire_slot`, `release_slot`, `inbox_add`, `inbox_set_status`, `order_add` |

<a id="okit-executor"></a>
## okit-executor

| Skill | Uso e instrução | Recursos principais |
| :- | :- | :- |
| `okit-executor` | Executa um briefing explícito; carregada para Executor criado pelo Director. Respeita escopo, verifica resultado e relata arquivos, provas e pendências. Ler a skill não atribui o papel. | `order_list`, `inbox_list`, `actors_list`, `limits_status`, `env_report` |

<a id="okit-critic"></a>
## okit-critic

| Skill | Uso e instrução | Recursos principais |
| :- | :- | :- |
| `okit-critic` | Revisa uma entrega; carregada para briefing independente de Critic. Lê o diff, roda verificações, compara provas com objetivo e retorna pass, revise ou reject com correções concretas. | `order_list`, `inbox_list`, `actors_list`, `limits_status`, `env_report`, `inbox_set_status` |

<a id="okit-setup"></a>
## okit-setup

| Skill | Uso e instrução | Recursos principais |
| :- | :- | :- |
| `okit-setup` | Orienta configuração de modelos; carregada para /okit-setup ou pedido de configuração por conversa. Executa a proposta existente, explica escolhas detectadas, pergunta só fatos ausentes e salva após confirmação final. Não edita ajustes individuais. | `okit-plugin setup`, `okit-plugin config show` |

<a id="okit-smoke"></a>
## okit-smoke

| Skill | Uso e instrução | Recursos principais |
| :- | :- | :- |
| `okit-smoke` | Narra demonstrações e verificações; carregada para /okit-smoke ou pedido de demonstração/teste real. Mostra prévia e limites, pede consentimento explícito de cota vinculado ao plano e relata provas e saída do runner. A demonstração paga recusa sem medição garantida. | `smoke_demo`, `okit-plugin smoke-demo`, `okit-plugin client-smoke`, `okit-plugin quota set` |

<a id="okit-environment"></a>
## okit-environment

| Skill | Uso e instrução | Recursos principais |
| :- | :- | :- |
| `okit-environment` | Responde perguntas de ambiente; carregada para perguntas sobre cliente, modelos, cota, pastas ou configuração ausente. Explica observações confirmadas e comandos de reparo, preserva desconhecidos e não altera nada. | `env_report`, `okit-plugin env report` |

Experimente pedir “mostre o ambiente” e conferir o relatório, sem iniciar trabalho.

A skill de ambiente também explica medições opcionais por telemetry_status e telemetry_export ou okit-plugin telemetry. Gravação e envio começam desligados e exigem pedidos separados; mensagens e conteúdo de arquivos são excluídos.

[Visão geral](README.pt-BR.md) · [MCP](mcp-tools.pt-BR.md) · [English](skills.md)
