# Ferramentas MCP

Todo campo `locale` é opcional e informa o padrão `en`, vindo da configuração inicial de `language`. Chamadas que o omitem usam o idioma salvo em `language`; configure português uma vez com `okit-plugin config set language pt-BR`. Um `locale` explícito (`en` ou `pt-BR`) tem prioridade naquela chamada.

As ferramentas MCP expõem operações validadas do núcleo ao assistente do cliente.

<a id="tools"></a>
## Contrato das ferramentas

O servidor expõe 22 ferramentas. Entradas são objetos JSON; ? indica campo opcional. Respostas são texto JSON com resultado ou recusa; argumentos inválidos geram erro. Escrita de estado não lança modelo nem gasta cota por si só.

| Nome | Propósito e retorno | Entradas | Efeito |
| :- | :- | :- | :- |
| `trajectory_show` | Lê execução salva passo a passo, com ferramentas que falharam e tokens | run | lê somente arquivos locais |
| `telemetry_status` | Consulta medições opcionais; consentimento, pasta, tamanho, última exportação | {} | leitura |
| `telemetry_export` | Exporta medições salvas a partir de uma data opcional | since? | grava recibo; envia somente contagens se ativado separadamente |
| `acquire_slot` | Reserva vaga; resultado ou recusa pelo limite | runId, client, waitMs? | escrita |
| `release_slot` | Libera vaga; resultado da liberação | runId | escrita |
| `limits_status` | Consulta limites; limites por cliente e execuções ativas | {} | leitura |
| `status` | Consulta cota; linhas, markdown, capacityLine e showBefore opcional | locale?, all?, client?, size?, slices?, executors? | leitura |
| `actors_list` | Consulta atores; modelos, esforço, disponibilidade e soluções | locale?, all?, client? | leitura |
| `env_report` | Consulta ambiente; observações e texto localizado | client?, locale? | leitura |
| `smoke_demo` | Prévia/confirmação de exemplo; plano, eventos, totais e código de saída | dryRun?, client?, locale?, confirm? | prévia lê; execução pode escrever/gastar, atualmente recusa sem teto medido |
| `classify` | Classifica trabalho; classe de esforço e motivos | title, body?, kind? | leitura |
| `profile_pick` | Escolhe ator salvo; modelo, esforço, maxTurns ou recusa | client, effort, quota? | leitura |
| `inbox_add` | Grava trabalho; vínculo confirmado ou sugestão aguardando confirmação | title, body?, kind?, accept?, effort?, client?, appliesTo?, todoLink? | escrita |
| `todo_sync` | Sincroniza tarefas; mudanças e sugestões; link exige id e confirm | project?, dryRun?, id?, link?, confirm? | escrita; dryRun só mostra |
| `todo_status` | Confere vínculos; demandsWithoutItem e itemsWithoutDemand | project? | leitura |
| `inbox_list` | Consulta trabalho; itens com referência de projeto e dono | status?, client?, appliesTo?, limit?, locale? | leitura |
| `inbox_claim` | Assume trabalho atomicamente; resultado de posse/recusa | id, client, session?, worktree? | escrita |
| `inbox_release` | Libera posse própria/obsoleta; resultado/recusa | id, client, session? | escrita |
| `inbox_set_status` | Transiciona trabalho; item atualizado (holder necessário com posse ativa) | id, status, holder? | escrita |
| `order_add` | Grava instrução; ordem com id | text, scope?, until?, appliesTo? | escrita |
| `order_list` | Consulta instruções ativas; ordens e estado derivado | appliesTo? | leitura |
| `order_remove` | Revoga instrução; ordem com motivo/histórico preservado | id, reason? | escrita |

<a id="try"></a>
## Consultar

Com o servidor MCP ativo no cliente, chame env_report com `{}`. Espere observações do ambiente e comandos de reparo; nenhuma execução de modelo. Campos client usam claude-code, codex ou opencode; effort usa simple, normal ou hard.

[Visão geral](README.pt-BR.md) · [Skills](skills.pt-BR.md) · [English](mcp-tools.md)
