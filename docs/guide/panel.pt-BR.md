# Painel do Claude Code

![okit-plugin: Guia do usuário](../images/banners/guide.svg)

O painel opcional, exclusivo do Claude Code e somente para leitura, mostra contas pelo apelido, nunca emails ou credenciais.

<a id="install"></a>
## Instalar

1. O terminal oferece o painel opcional após uma instalação bem-sucedida do Claude Code, para a conta sendo instalada. Use `--no-panel` para pular a pergunta e a dica posterior. Sem terminal, a instalação apenas imprime a dica. Ative depois com `okit-plugin install --panel`; adicione `--client claude-code --account <id>` para selecionar uma conta salva pelo id. Atualizações apenas atualizam um painel já instalado.

<a id="use"></a>
## Abrir e fechar

2. Dentro do Claude Code, use o comando `okit-panel` (`/okit-panel`) para abrir ou fechar o painel. Ele atualiza a cada 3 s (mínimo de 2 s) enquanto aberto; nenhuma atualização roda quando está fechado.

<a id="board"></a>
## O que o quadro mostra

- ACCOUNTS: apelidos em execução ou ociosos, barras da sessão (5 h) e da semana, percentual restante, horários de renovação em UTC e tempo que falta.
- RUNNING: execuções ativas e sua última linha de progresso.
- RECENT: execuções concluídas, com falha ou que não estão mais ativas (stale).
- LAUNCHABLE NOW: contas aptas para trabalho simple/normal/hard/critic.
- Readiness: o que falta para iniciar o trabalho.
- `unknown`: dado indisponível, nunca cota zero.

Como é o quadro (uma representação em texto, não uma captura da tela real do Claude Code):

```text
okit plugin · claude · 2 accounts · ready: no
╔═ ACCOUNTS ═══════════════════════════════════════════════════════════════════╗
║ Personal · running                                                           ║
║ session (5 h): [████████░░] 80% left · resets 2026-11-06T17:00:00.000Z (in   ║
║ 5h00m)                                                                       ║
║ week: unknown                                                                ║
║ Work · idle                                                                  ║
║ session (5 h): unknown                                                       ║
║ week: unknown                                                                ║
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
