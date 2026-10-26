# Daemon e agendas

O daemon processa trabalho pendente e recorrente respeitando limites e controles de parada.

<a id="run"></a>
## Executar e interromper

Use `okit-plugin daemon run-once` para uma passagem; `okit-plugin daemon start` mantém o loop em primeiro plano. Cada passagem lê configuração, verifica pausa/parada, limpa ordens fora da retenção, observa cota, abre recorrências devidas e atende pendências das mais antigas às mais novas. O adaptador PROCESS executa o trabalho; o núcleo recebe o lançador como dependência.
O intervalo padrão é 60 segundos, piso de cota 10% e retenção de logs 14 dias. Uma cota conhecida abaixo do piso interrompe a passagem; ausência de leitura não é tratada como abaixo do piso nessa verificação do daemon. Vagas são limites separados por cliente; um período com filho ativo não é duplicado.

- `okit-plugin daemon status --table`: PID, pausa, última passagem e tabela de capacidade.
- `okit-plugin daemon pause`: impede trabalho novo sem encerrar o loop.
- `okit-plugin daemon resume`: remove somente o marcador de pausa.
- `okit-plugin daemon stop`: cria daemon.stop para encerrar o loop; SIGINT/SIGTERM também encerram. O próximo daemon start limpa esse marcador automaticamente; resume e run-once não o limpam. O marcador de pausa sobrevive ao reinício.

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

`okit-plugin autostart show` mostra o plano antes da aplicação. install/uninstall registram/removem systemd ou cron no Linux, launchd no macOS ou schtasks no Windows. Confira o plano do sistema real; um daemon pode consumir cota ao receber trabalho. Logs e marcadores ficam na [pasta de estado](state.pt-BR.md).
O plano cron instala seu arquivo como o crontab inteiro do usuário; uninstall executa crontab -r. Confira e copie as entradas existentes antes de aplicar esse plano.

[Visão geral](README.pt-BR.md) · [Configuração](configuration.pt-BR.md) · [English](daemon.md)
