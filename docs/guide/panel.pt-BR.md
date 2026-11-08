# Painel do Claude Code

![okit-plugin: Guia do usuário](../images/banners/guide.svg)

O painel opcional, somente para leitura e ao lado da conversa do Claude Code, mostra a cota restante de cada conta, o trabalho em andamento e o recente. As contas aparecem pelo apelido, nunca emails ou credenciais. A oferta da instalação descreve esses recursos e pergunta se deve instalar; as instruções de abertura e alternância aparecem somente após instalar com sucesso.

<a id="install"></a>
## Instalar

1. O terminal oferece o painel opcional após uma instalação bem-sucedida do Claude Code, para a conta sendo instalada. Use `--no-panel` para pular a pergunta e a dica posterior. Sem terminal, a instalação apenas imprime a dica. Ative depois com `okit-plugin install --panel`; adicione `--client claude-code --account <id>` para selecionar uma conta salva pelo id. Atualizações apenas atualizam um painel já instalado.

<a id="use"></a>
## Abrir e fechar

2. O painel instalado abre automaticamente quando o Claude Code inicia. Defina `panel.autoOpen` como `false` no `config.json` da raiz de estado para desligar isso. O comando `okit-panel` (`/okit-panel`) continua abrindo ou fechando o painel. Ele atualiza a cada 3 s (mínimo de 2 s) enquanto aberto; nenhuma atualização roda quando está fechado.

<a id="board"></a>
As cotas são consultadas ativamente a cada minuto para todas as contas salvas de Claude Code e Codex, incluindo default. O serviço de fundo mantém o poller. Sem ele, `panel-state` inicia a leitura devida em processo separado, no máximo uma vez por minuto por conta, e mostra imediatamente a última leitura. Adicionar uma conta ou instalar seu plugin solicita uma leitura imediata. As leituras passivas da barra e das sessões Codex continuam; vence a mais recente.

Claude usa o endpoint HTTPS fixo de uso OAuth enquanto o token da conta é válido. O plugin lê apenas token de acesso e validade em memória para essa consulta, nunca armazena ou renova o token e nunca altera arquivos de credenciais. Com token vencido ou ausente, uma conta logada usa o fallback enxuto da CLI Haiku, no máximo a cada 30 minutos. Essa chamada real usa poucos tokens, pode iniciar a janela de 5h e permite ao Claude renovar seu próprio login. Codex usa `app-server` com o `CODEX_HOME` da conta, sem abrir `auth.json`.

Cada conta mostra elegibilidade para rotação: ambas as janelas devem ter **mais de 20%** restantes por padrão (`accountPolicy.minQuotaPct`). Leituras ausentes ou com mais de três intervalos de consulta contam como desconhecidas e ficam por último. Os estados explicam a ausência de cota: `ok` indica sucesso; `not-logged-in` exige login; `token-expired` aguarda o próximo fallback permitido; `read-failed` indica falha na consulta; `no-reading` indica que ainda não há leitura. Falhas aumentam a espera de 1 até 15 minutos. Configure `quotaPoll` com `enabled` (true), `intervalSec` (60) e `claudeFallbackMinutes` (30); false desativa as consultas ativas.

## O que o quadro mostra

- ACCOUNTS: apelidos em execução ou ociosos, barras alinhadas de session 5h e semana, percentual restante, horários locais de renovação em 24 h e tempo que falta (`4h35m` ou `1d 21h`). Renovações a mais de 24 h incluem o dia da semana; `!` marca menos de 20% restante e cotas ausentes mostram `unknown`.
- RUNNING: execuções ativas e sua última linha de progresso.
- RECENT: execuções concluídas, com falha ou que não estão mais ativas (stale).
- LAUNCHABLE NOW: contas aptas para trabalho simple/normal/hard/critic.
- Readiness: o que falta para iniciar o trabalho.
- `unknown`: dado indisponível, nunca cota zero.

As cotas usam o tema do cliente: a partir de 50% restante, verde (`ok`); de 20% até menos de 50%, amarelo (`warn`); abaixo de 20%, vermelho (`low`); cota desconhecida, tom apagado (`dim`). Exatamente 50% é verde, 20% é amarelo e 19.9% é vermelho. Linhas quebradas mantêm o tom. O texto percentual (`12% left`) e `!` abaixo de 20% continuam visíveis. `panel.color` tem padrão `true`; defina como `false` no `config.json` para texto sem cores. Os percentuais de cota nas razões de escolha de conta do doctor usam os mesmos limites no terminal e respeitam `NO_COLOR`; saídas canalizadas e MCP continuam sem cores.

Como é o quadro (uma representação em texto, não uma captura da tela real do Claude Code):

```text
okit plugin · claude · 2 accounts · ready: no
╔═ ACCOUNTS ═══════════════════════════════════════════════════════════════════╗
║ Personal · running                                                           ║
║   session 5h [████████░░] 80% left resets 17:00 (in 5h00m)                   ║
║   week                    unknown                                            ║
║ Work · idle                                                                  ║
║   session 5h              unknown                                            ║
║   week                    unknown                                            ║
╚══════════════════════════════════════════════════════════════════════════════╝
╔═ RUNNING ════════════════════════════════════════════════════════════════════╗
║ one: live · demand sample-demand · account Personal · actor hard · opus ·    ║
║ effort high · elapsed 0:02                                                   ║
║ Last progress: Running checks                                                ║
╚══════════════════════════════════════════════════════════════════════════════╝
╔═ RECENT ═════════════════════════════════════════════════════════════════════╗
║ No recent runs.                                                              ║
╚══════════════════════════════════════════════════════════════════════════════╝
╔═ LAUNCHABLE NOW ═════════════════════════════════════════════════════════════╗
║ simple: none                                                                 ║
║ normal: none                                                                 ║
║ hard: none                                                                   ║
║ critic: none                                                                 ║
╚══════════════════════════════════════════════════════════════════════════════╝
╔═ Readiness ══════════════════════════════════════════════════════════════════╗
║ Ready to launch executors: no; gaps: S (no client installed), M (no client   ║
║ installed), L (no client installed); claude-code: 0/2 accounts ready.        ║
╚══════════════════════════════════════════════════════════════════════════════╝
```

<a id="remove"></a>
## Remover

3. Execute `okit-plugin uninstall --panel` para remover só o painel, mantendo o plugin principal; `okit-plugin update` atualiza um painel instalado.

<a id="troubleshooting"></a>
## Se não funcionar

Se o JSON de panel-state estiver ilegível ou o esquema não for suportado, confira a saída de diagnóstico.
Execute `okit-plugin panel-state --json --client claude` no terminal para ver o estado ou erro.

[Guia](README.pt-BR.md) · [Contas](accounts.pt-BR.md) · [English](panel.md)
