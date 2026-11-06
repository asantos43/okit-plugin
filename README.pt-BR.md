# Orchestration Kit plugin (okit plugin)

![okit-plugin: Projeto](docs/images/banners/project.svg)

O plugin okit ajuda seu assistente de IA a planejar o trabalho, dividi-lo com ajudantes e conferir o resultado.
Funciona com Claude Code, Codex e opencode, usando os próprios assistentes do cliente.

A pessoa usa `okit-plugin install`, `update`, `uninstall`, `setup`, `doctor` e `account`; outras operações são pedidas ao assistente, que usa as ferramentas MCP.

## Contas

Use `okit-plugin account add codex Trabalho --config-dir /caminho/absoluto/codex-trabalho` para uma conta extra e siga as instruções de login manual. `account list [<client>] [--json]`, `account rename <client> <id-ou-nome> <novo-nome>` e `account remove <client> <id>` gerenciam contas mantendo ids estáveis e pastas dos clientes intactas. Claude Code também é suportado. Veja [contas](docs/guide/accounts.pt-BR.md).

<a id="install"></a>
## Instalar

1. Tenha Node.js 20 ou mais recente e um cliente de IA instalado. Siga [instalação](docs/guide/install.pt-BR.md) para baixar e ler o instalador da versão para seu sistema.
2. Execute `sh install.sh --client codex` no Linux/macOS ou `./install.ps1 --client codex` no PowerShell do Windows, na pasta do download. Troque `codex` por `claude-code` ou `opencode` conforme necessário. Espere um resumo da versão, destino e registro do cliente; siga a mensagem de ativação e reinicie o cliente.
3. Execute `okit-plugin setup`. Confirme as escolhas de modelos; elas continuam confirmadas quando o cliente não consegue listar modelos. Sem leitura de cota, o setup pede a porcentagem real, que o seu assistente registra (`quota_set`); informe a porcentagem mostrada pelo cliente.

<a id="first-try"></a>
## Primeira coisa para tentar

Peça ao seu assistente: "Qual é o ambiente?" (ele chama `env_report`). Espere clientes instalados, modelos confirmados, cota restante e espaço para ajudantes; informações ausentes vêm com instruções de correção.
Execute `okit-plugin doctor` quando algo não estiver certo: ele lê a instalação inteira e responde uma linha por coisa que olhou, com o comando que repara cada falha.
Depois, [peça trabalho ao Diretor](docs/guide/ask-the-director.pt-BR.md).

<a id="documentation"></a>
## Encontre o que precisa

- [Guia do usuário](docs/guide/README.pt-BR.md): instalar, escolher modelos, experimentar uma demonstração e resolver problemas. Veja a [página de configuração](docs/guide/config-ui.pt-BR.md) e o [painel opcional do Claude Code](docs/guide/panel.pt-BR.md).
- [Referência de componentes](docs/components/README.pt-BR.md): skills, ferramentas, hooks, adaptadores, CLI, configuração e estado.
- [Documentação de manutenção](docs/maintainers/README.pt-BR.md): arquitetura, integração, verificações e versões; [contribuições](CONTRIBUTING.md).

[English](README.md) · [Segurança](SECURITY.md) · [Licença MIT](LICENSE)
