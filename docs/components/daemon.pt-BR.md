# Daemon e agendas

![okit-plugin: Componentes](../images/banners/components.svg)

O daemon processa trabalho pendente e recorrente respeitando limites e controles de parada.

<a id="run"></a>
## Executar e interromper

Peça ao assistente para usar a ferramenta MCP `daemon` com ação `run-once` para uma passagem. A entrada interna `daemon start` mantém o loop em primeiro plano, iniciado pelo autostart configurado por `okit-plugin setup` ou `okit-plugin install --autostart`. Cada passagem lê configuração, verifica pausa/parada, limpa ordens fora da retenção, observa cota, abre recorrências devidas e atende pendências das mais antigas às mais novas. O adaptador PROCESS executa o trabalho; o núcleo recebe o lançador como dependência.
O intervalo padrão é 60 segundos, piso de cota 10% e retenção de logs 14 dias. Uma cota conhecida abaixo do piso interrompe a passagem; ausência de leitura não é tratada como abaixo do piso nessa verificação do daemon. Vagas são limites separados por cliente; um período com filho ativo não é duplicado.

Para Claude Code e Codex, trabalho sem conta nomeada passa pela política antes da reserva. O lock da vaga lê os registros uma vez para escolha e contagem; o mesmo id segue para preflight e lançamento. Contas salvas usam suas próprias cotas dos adaptadores: default com pouca cota não impede uma extra saudável. Sem confirmação do cliente em `setup.done`, os perfis configurados valem para todas as contas. Com confirmação, clientes de catálogo como Claude Code compartilham modelo e esforço confirmados entre as contas; uma fonte `listing` precisa listar o modelo naquela conta. Sem conta elegível, há motivo localizado e nenhuma execução. O ritmo obrigatório salva `ext.wait_until` e mantém a demanda pendente até lá. Contas nomeadas e `resumeSession: {account}` ficam fixas; o ritmo não adia continuações. Crítico e verificador recebem a conta do executor pelos metadados da demanda ou pela execução referenciada e preferem outra elegível. `critic_of` implica `critic` quando não há papel; revisões preservam a conta do executor no inbox. Vagas religadas mantêm conta escolhida e motivo. A telemetria de cota registra cliente e conta opcional separadamente. Veja os campos em [estado](state.pt-BR.md) e os ajustes em [contas](../guide/accounts.pt-BR.md).

- MCP `daemon`, ação `status`: PID, pausa e última passagem; peça MCP `status` para capacidade.
- MCP `daemon`, action `pause`: impede trabalho novo sem encerrar o loop.
- MCP `daemon`, action `resume`: remove somente o marcador de pausa.
- O instalador usa a entrada interna `daemon stop`: cria daemon.stop para encerrar o loop; SIGINT/SIGTERM também encerram. O próximo daemon start limpa esse marcador automaticamente; resume e run-once não o limpam. O marcador de pausa sobrevive ao reinício.

<a id="schedules"></a>
## Recorrências

Templates são dados persistidos em templates.json; a API do núcleo cria/edita esses registros e sua ordem autorizadora. Não há comando CLI nem ferramenta MCP de edição de templates nesta versão.

| Forma | Exemplo | Efeito |
| :- | :- | :- |
| Cron com cinco campos | `*/15 9-17 * * mon-fri` | A cada quinze minutos no intervalo indicado |
| Diária | `daily 06:00` | Uma vez por dia |
| Semanal | `weekly mon-fri 09:30` | Nos dias indicados |
| Mensal | `monthly day 1 08:00` | No dia indicado |
| Evento | `after each deploy` | Requer event e eventId fornecidos pelo chamador; o loop não detecta deploys |

O fuso padrão é UTC. window limita horários; minQuotaPct, onlyWhenIdle e skipIfOpen condicionam abertura; maxRunsPerPeriod limita repetição. catchup run atende o período perdido mais antigo, skip só o atual. Pausa e gravação sob lock evitam filhos repetidos. Horas repetidas usam a primeira passagem; horas inexistentes avançam ao próximo minuto válido.

<a id="autostart"></a>
## Inicialização automática

`okit-plugin setup` oferece o plano de inicialização antes da aplicação; `okit-plugin install --autostart` também o registra. O instalador registra/remove systemd ou cron no Linux, launchd no macOS ou schtasks no Windows. Confira o plano do sistema real; um daemon pode consumir cota ao receber trabalho. Logs e marcadores ficam na [pasta de estado](state.pt-BR.md).
O plano cron instala seu arquivo como o crontab inteiro do usuário; uninstall executa crontab -r. Confira e copie as entradas existentes antes de aplicar esse plano.

O setup considera todos os registros de clientes no destino descoberto, preserva um plano instalado correspondente e registra a aceitação para todos os clientes cobertos sem alterar seus links. A verificação exige habilitação persistente no systemd, agente launchd carregado sem desabilitação, tarefa Windows pronta/em execução ou o comando cron atual exato (incluindo os caminhos do node e da CLI). Uma falha ao salvar restaura todos os registros alterados e mantém serviços preexistentes, inclusive desabilitados.

[Visão geral](README.pt-BR.md) · [Configuração](configuration.pt-BR.md) · [English](daemon.md)
