# Orchestration Kit plugin (okit plugin)

![okit-plugin: Projeto](docs/images/banners/project.svg)

O plugin okit ajuda seu assistente de IA a planejar o trabalho, dividi-lo com ajudantes e conferir o resultado.
Funciona com Claude Code, Codex e opencode, usando os próprios assistentes do cliente.

<a id="install"></a>
## Instalar

1. Tenha Node.js 20 ou mais recente e um cliente de IA instalado. Siga [instalação](docs/guide/install.pt-BR.md) para baixar e ler o instalador da versão para seu sistema.
2. Execute `sh install.sh --client codex` no Linux/macOS ou `./install.ps1 --client codex` no PowerShell do Windows, na pasta do download. Troque `codex` por `claude-code` ou `opencode` conforme necessário. Espere um resumo da versão, destino e registro do cliente; siga a mensagem de ativação e reinicie o cliente.
3. Execute `okit-plugin setup`. Espere as escolhas de modelos detectadas; confirme-as para salvar a configuração.

<a id="first-try"></a>
## Primeira coisa para tentar

Execute `okit-plugin env report --locale pt-BR`. Espere clientes instalados, modelos confirmados, cota restante e espaço para ajudantes; informações ausentes vêm com instruções de correção.
Depois, [peça trabalho ao Diretor](docs/guide/ask-the-director.pt-BR.md).

<a id="documentation"></a>
## Encontre o que precisa

- [Guia do usuário](docs/guide/README.pt-BR.md): instalar, escolher modelos, experimentar uma demonstração e resolver problemas.
- [Referência de componentes](docs/components/README.pt-BR.md): skills, ferramentas, hooks, adaptadores, CLI, configuração e estado.
- [Documentação de manutenção](docs/maintainers/README.pt-BR.md): arquitetura, integração, verificações e versões; [contribuições](CONTRIBUTING.md).

[English](README.md) · [Segurança](SECURITY.md) · [Licença MIT](LICENSE)
