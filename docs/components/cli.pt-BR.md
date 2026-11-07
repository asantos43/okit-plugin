# CLI

![okit-plugin: Componentes](../images/banners/components.svg)

A pessoa usa comandos no terminal para instalar, manter e diagnosticar o plugin e gerenciar contas.

`--locale` é opcional onde oferecido. Usa `language` (padrão: `en`); peça ao assistente para chamar `config_set` com `key: "language"` e `value: "pt-BR"` para salvar português. Um `--locale en` ou `--locale pt-BR` explícito substitui a escolha salva apenas naquela chamada.

<a id="commands"></a>
## Comandos

`--help` mostra opções; a instalação pode alterar o nome do comando por `install.command`.

No Claude Code, `install` oferece o painel opcional após sucesso; `--no-panel` pula a pergunta e a dica. Ative depois com `okit-plugin install --panel` (modo isolado; incompatível com `--no-panel`). `update` aceita `--no-panel` e apenas atualiza painéis já instalados, sem perguntar.

| Comando | Propósito | Exemplo |
| :- | :- | :- |
| `okit-plugin install` | Instala payload e registra cliente | `okit-plugin install --client codex --dry-run` |
| `okit-plugin update` | Confere, troca ou reverte instalação registrada | `okit-plugin update --client codex --check` |
| `okit-plugin uninstall` | Remove instalação registrada; preserva estado por padrão | `okit-plugin uninstall --client codex --dry-run` |
| `okit-plugin setup` | Propõe modelos e salva após confirmação | `okit-plugin setup --again` |
| `okit-plugin doctor` | Diagnostica a instalação; só lê, com correção por falha | `okit-plugin doctor --client codex` |
| `okit-plugin config ui` | Inicia uma sessão local de configuração | `okit-plugin config ui --no-open` |
| `okit-plugin account` | Adiciona, lista, remove ou renomeia contas; login continua manual | `okit-plugin account list codex --json` |
| `okit-plugin panel-state` | Ler estado versionado de um cliente; veja [esquema](state.pt-BR.md#panel-state) | `okit-plugin panel-state --json --client claude` |

Veja [contas](../guide/accounts.pt-BR.md) para `add`, `list`, `remove`, `rename` e registro do coletor. Alterações de conta salvam a configuração; add cria a pasta. Remove preserva a pasta e o login.

## Entradas internas

A pessoa não executa estas: elas ficam fora de `--help`. O cliente inicia o coletor e os hooks (veja [hooks](hooks.pt-BR.md)); a unidade de inicialização automática, o instalador e os checks smoke offline iniciam as entradas do daemon (veja [daemon](daemon.pt-BR.md)).

| Comando | Iniciado por | Exemplo |
| :- | :- | :- |
| `okit-plugin statusline-collector` | A barra de status do cliente | `okit-plugin statusline-collector` |
| `okit-plugin hook session-start` | O cliente, no início de uma sessão | `okit-plugin hook session-start` |
| `okit-plugin hook post-compact` | O cliente, após uma compactação | `okit-plugin hook post-compact` |
| `okit-plugin daemon start` | A inicialização automática e o instalador: o loop | `okit-plugin daemon start` |
| `okit-plugin daemon stop` | O instalador | `okit-plugin daemon stop` |
| `okit-plugin daemon run-once` | Os checks smoke offline | `okit-plugin daemon run-once` |

Todo o restante é pedido ao assistente, que usa as [ferramentas MCP](mcp-tools.pt-BR.md).

<a id="effects"></a>
## Efeitos e resultados

Install/update/uninstall alteram registros e arquivos gerenciados; setup salva configuração após confirmação. Doctor só lê: tira o retrato com `record: false`, então não grava arquivo nem evento de telemetria. O daemon pode lançar processos e gastar cota.
O doctor termina com `Pronto para lançar executores: sim` ou `não; faltas: …` (e `ready` e `gaps` com `--json`). Pronto significa que cada tamanho (S, M, L) tem um ator que pode lançar em um cliente instalado; clientes não instalados são opcionais. Linhas: modelos confirmados e cota registrada por cliente instalado, coletor da barra de status (com o comando para ativar) e o kit opcional.
Saída 0 indica sucesso; 1 indica falha; uso inválido normalmente retorna 2.
Os checks smoke offline são código interno de teste: testes e update os executam; mantenedores usam `npm run smoke` (`scripts/smoke.js`).

[Visão geral](README.pt-BR.md) · [Daemon](daemon.pt-BR.md) · [English](cli.md)
