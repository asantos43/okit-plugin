# CLI

![okit-plugin: Componentes](../images/banners/components.svg)

`--locale` é opcional em todos os comandos que o oferecem. Usa `language` (padrão: `en`); configure português uma vez com `okit-plugin config set language pt-BR`. Um `--locale en` ou `--locale pt-BR` explícito substitui a escolha salva apenas naquela chamada.

Use okit-plugin no terminal para consultar e controlar o plugin.

<a id="commands"></a>
## Comandos

Cada linha mostra o comando e um exemplo; substitua <id> pelo identificador retornado pela fila. --help mostra opções; instalação pode alterar o nome por install.command.

| Comando | Propósito | Exemplo |
| :- | :- | :- |
| `okit-plugin install` | Instala payload e registra cliente | `okit-plugin install --client codex --dry-run` |
| `okit-plugin update` | Confere, troca ou reverte instalação registrada | `okit-plugin update --client codex --check` |
| `okit-plugin uninstall` | Remove instalação registrada; preserva estado por padrão | `okit-plugin uninstall --client codex --dry-run` |
| `okit-plugin setup` | Propõe modelos e salva após confirmação | `okit-plugin setup` |
| `okit-plugin env report` | Consulta cliente, modelos, cota, pastas e soluções | `okit-plugin env report` |
| `okit-plugin actors` | Consulta opções de modelo/esforço | `okit-plugin actors --all --json` |
| `okit-plugin status` | Consulta cota e vagas livres | `okit-plugin status --all` |
| `okit-plugin config show` | Mostra ajustes efetivos, origem e efeito | `okit-plugin config show` |
| `okit-plugin config get` | Lê um ajuste | `okit-plugin config get limits.global` |
| `okit-plugin config set` | Valida e salva um ajuste permitido | `okit-plugin config set limits.global 3` |
| `okit-plugin config unset` | Remove sobrescrita e restaura padrão | `okit-plugin config unset limits.global` |
| `okit-plugin quota show` | Consulta cota automática/manual e idade | `okit-plugin quota show codex` |
| `okit-plugin quota set` | Registra percentual restante informado pela pessoa | `okit-plugin quota set codex 60` |
| `okit-plugin inbox list` | Lista trabalho e posse | `okit-plugin inbox list` |
| `okit-plugin inbox take` | Assume trabalho; tomada humana exige confirmação | `okit-plugin inbox take <id> --client codex` |
| `okit-plugin inbox release` | Libera trabalho próprio ou obsoleto | `okit-plugin inbox release <id> --client codex` |
| `okit-plugin todo sync` | Sincroniza listas de tarefas configuradas por projeto | `okit-plugin todo sync --dry-run --project /projects/example` |
| `okit-plugin todo check` | Lista trabalhos sem tarefas e tarefas sem trabalho | `okit-plugin todo check --project /projects/example` |
| `okit-plugin kit` | Detecta orchestration-kit sem instalar | `okit-plugin kit --require` |
| `okit-plugin daemon start` | Executa loop do daemon em primeiro plano | `okit-plugin daemon start` |
| `okit-plugin daemon stop` | Solicita término pelo arquivo de parada | `okit-plugin daemon stop` |
| `okit-plugin daemon status` | Mostra PID, pausa e última passagem | `okit-plugin daemon status --table` |
| `okit-plugin daemon pause` | Pausa trabalho novo e mantém loop ativo | `okit-plugin daemon pause` |
| `okit-plugin daemon resume` | Retira marcador de pausa | `okit-plugin daemon resume` |
| `okit-plugin daemon run-once` | Processa uma passagem e retorna decisões | `okit-plugin daemon run-once` |
| `okit-plugin autostart show` | Consulta plano de inicialização da plataforma | `okit-plugin autostart show --kind systemd` |
| `okit-plugin autostart install` | Aplica plano de inicialização | `okit-plugin autostart install --kind systemd` |
| `okit-plugin autostart uninstall` | Remove registro de inicialização | `okit-plugin autostart uninstall --kind systemd` |
| `okit-plugin hook session-start` | Devolve contexto nativo de papel com JSON no stdin | `okit-plugin hook session-start` |
| `okit-plugin hook post-compact` | Devolve resumo limitado de restauração com JSON no stdin | `okit-plugin hook post-compact` |
| `okit-plugin statusline-collector` | Coleta cota do JSON no stdin e encadeia barra anterior | `okit-plugin statusline-collector` |
| `okit-plugin smoke` | Executa verificações offline isoladas em estado temporário | `okit-plugin smoke` |
| `okit-plugin client-smoke` | Executa cenário no cliente ou prévia/ensaio offline | `okit-plugin client-smoke --client claude-code --dry-run` |
| `okit-plugin smoke-demo` | Mostra prévia e exige contrato de confirmação/custo | `okit-plugin smoke-demo --dry-run --json` |

| `okit-plugin telemetry` | Medições opcionais de uso | `okit-plugin telemetry status` |
| `okit-plugin trajectory` | Lê ou ativa gravações locais de execuções | `okit-plugin trajectory status` |

Use `okit-plugin telemetry status`, `okit-plugin telemetry on`, `okit-plugin telemetry off`, `okit-plugin telemetry rede on` / `okit-plugin telemetry rede off`, `okit-plugin telemetry export [--since ISO]` e `okit-plugin telemetry check`. Gravação e envio exigem escolhas separadas.

Use `okit-plugin trajectory list`, `okit-plugin trajectory show <run>`, `okit-plugin trajectory export <run>`, `okit-plugin trajectory prune`, `okit-plugin trajectory on`, `okit-plugin trajectory off` e `okit-plugin trajectory status`. Escolha uma execução salva na lista. Export mostra JSON localmente; nada é enviado. Veja [gravações](state.pt-BR.md#trajectories).

<a id="effects"></a>
## Efeitos e resultados

Consultas não iniciam modelos. Setup/config/quota/inbox gravam estado quando solicitado; install/update/uninstall e autostart alteram registros e arquivos gerenciados. O daemon pode lançar processos e gastar cota. Hooks recebem JSON do cliente; consulte exemplos de entrada em [hooks](hooks.pt-BR.md).
Saída 0 indica sucesso; 1 indica falha; uso inválido normalmente retorna 2. Smoke pode indicar verificações puladas: leia o relatório. A prévia da demonstração não gasta cota e a execução paga atualmente recusa sem medição/teto garantidos. --real no smoke deve ser reservado a teste autorizado no cliente.

[Visão geral](README.pt-BR.md) · [Daemon](daemon.pt-BR.md) · [English](cli.md)
