# Ferramentas MCP

![okit-plugin: Componentes](../images/banners/components.svg)

Todo campo `locale` é opcional e informa o padrão `en`, vindo da configuração inicial de `language`. Chamadas que o omitem usam o idioma salvo em `language`; configure português uma vez com `okit-plugin config set language pt-BR`. Um `locale` explícito (`en` ou `pt-BR`) tem prioridade naquela chamada.

As ferramentas MCP expõem operações validadas do núcleo ao assistente do cliente.

<a id="tools"></a>
## Contrato das ferramentas

O servidor expõe 29 ferramentas. Entradas são objetos JSON; ? indica campo opcional. Respostas são texto JSON com resultado ou recusa; argumentos inválidos geram erro. Escrita de estado não lança modelo nem gasta cota por si só. A lista das ferramentas custa 14255 bytes de JSON, cerca de 3564 tokens de contexto, e vinte e quatro delas são geradas do registro de operações (`src/core/operations.js`), então uma função do núcleo é descrita uma vez só.

| Nome | Propósito e retorno | Entradas | Efeito |
| :- | :- | :- | :- |
| `trajectory_show` | Lê execução salva passo a passo, com ferramentas que falharam e tokens | run | lê somente arquivos locais |
| `telemetry_status` | Consulta medições opcionais; consentimento, pasta, tamanho, última exportação | {} | leitura |
| `telemetry_export` | Exporta medições salvas a partir de uma data opcional | since? | grava recibo; envia somente contagens se ativado separadamente |
| `acquire_slot` | Reserva vaga; resultado ou recusa pelo limite | runId, client, waitMs? | escrita |
| `release_slot` | Libera vaga; resultado da liberação | runId | escrita |
| `limits_status` | Consulta limites; limites por cliente e execuções ativas | {} | leitura |
| `status` | Consulta cota; linhas, markdown, capacityLine e showBefore opcional | locale?, all?, client?, size?, slices?, executors? | leitura |
| `quota_notice` | Transforma o evento de cota liberada do kit em frase simples; available, released e text; sem o evento, diz que o aviso não está disponível | locale?, event? | leitura |
| `actors_list` | Consulta atores; modelos, esforço, disponibilidade e soluções | locale?, all?, client? | leitura |
| `env_report` | Consulta ambiente; observações e texto localizado | client?, locale? | leitura |
| `smoke_demo` | Prévia/confirmação de exemplo; plano, eventos, totais medidos e código de saída | dryRun?, client?, locale?, confirm? | prévia lê; confirm válido executa o cliente real e gasta cota nos tetos mostrados; cliente sem dinheiro exige smoke.maxTokens |
| `classify` | Classifica trabalho; classe de esforço e motivos | title, body?, kind? | leitura |
| `profile_pick` | Escolhe um assistente pelas escolhas salvas ou padrões incluídos, mesmo antes da configuração; modelo, esforço, maxTurns ou recusa | client, effort, quota? | leitura |
| `inbox_add` | Grava trabalho; vínculo confirmado ou sugestão aguardando confirmação | title, body?, kind?, accept?, effort?, client?, appliesTo?, todoLink? | escrita |
| `todo_sync` | Sincroniza tarefas; mudanças e sugestões; link exige id e confirm | project?, dryRun?, id?, link?, confirm? | escrita; dryRun só mostra |
| `todo_check` | Confere vínculos; demandsWithoutItem e itemsWithoutDemand | project? | leitura |
| `inbox_list` | Consulta trabalho; itens com referência de projeto e dono | status?, client?, appliesTo?, limit?, locale? | leitura |
| `inbox_claim` | Assume trabalho atomicamente; resultado de posse/recusa | id, client, session?, worktree? | escrita |
| `inbox_release` | Libera posse própria/obsoleta; resultado/recusa | id, client, session? | escrita |
| `inbox_set_status` | Transiciona trabalho; item atualizado (holder necessário com posse ativa) | id, status, holder? | escrita |
| `order_add` | Grava instrução; ordem com id | text, scope?, until?, appliesTo? | escrita |
| `order_list` | Consulta instruções ativas; ordens e estado derivado | appliesTo? | leitura |
| `order_remove` | Revoga instrução; ordem com motivo/histórico preservado | id, reason? | escrita |
| `config_get` | Lê os ajustes de uma raiz; todas as entradas do esquema, ou uma delas | key? | leitura |
| `config_set` | Grava um ajuste de uma raiz; o que era e o que passou a ser; sem valor o ajuste é removido | key, value? | escrita |
| `quota_show` | Lê a cota registrada dos clientes de uma raiz, ou de um cliente | client? | leitura |
| `quota_set` | Registra a cota de um cliente; a porcentagem que resta e sua janela | client, pct, windowMinutes? | escrita |
| `daemon` | Lê o estado do daemon de uma raiz; se roda, se está pausado, a última passagem, ou uma passagem agora | action | leitura; `pause`, `resume` e `run-once` mudam o estado |
| `kit_detect` | Investiga o kit de orquestração de uma raiz; se está instalado, qual versão tem e por que está com defeito | {} | leitura |

<a id="try"></a>
## Consultar

Com o servidor MCP ativo no cliente, chame env_report com `{}`. Espere observações do ambiente e comandos de reparo; nenhuma execução de modelo. Campos client usam claude-code, codex ou opencode; effort usa simple, normal ou hard.

[Visão geral](README.pt-BR.md) · [Skills](skills.pt-BR.md) · [English](mcp-tools.md)
