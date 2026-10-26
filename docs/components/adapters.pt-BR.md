# Adaptadores

Cada adaptador traduz execução, cota, skills e contexto para um cliente específico.

<a id="claude-code"></a>
## Claude Code

O modo NATIVE devolve uma chamada Agent com modelo, esforço e briefing, sem criar processo; PROCESS usa o lançador headless. SessionStart entrega o contexto nativo. Cota vem da amostra manual ou do coletor da barra.
A instalação registra marketplace/plugin, adiciona o comando exato de SessionStart em settings.json e usa skills, MCP e hook compact do payload. O coletor opcional preserva a barra anterior.
Update troca o registro para o payload novo e retira o comando antigo. Uninstall remove a entrada exata, o plugin/marketplace e restaura a barra registrada, preservando os demais ajustes.
Raiz: opção root, CLAUDE_CONFIG_DIR ou ~/.claude.

<a id="codex"></a>
## Codex

NATIVE devolve descritor para delegação pelo chamador; PROCESS usa codex exec. Contexto vem de bloco gerenciado em AGENTS.md e prompt explícito, sem hooks instalados pelo adaptador. Cota lê caudas recentes de sessões, com alternativa manual, sem escrever no cliente.
A instalação registra o marketplace e pede ativação em /plugins; não executa automaticamente plugin add/update. O bloco de papel em AGENTS.md preserva o restante; AGENTS.override.md não vazio impede essa entrega. Copiar skills não comprova descoberta automática.
Update troca o registro e atualiza só o bloco; uninstall remove bloco e marketplace registrado. O código não executa plugin uninstall para Codex: confira a ativação no cliente. Hooks e carregamento real do payload precisam de confirmação no cliente.
Raiz: opção root, CODEX_HOME ou ~/.codex.

<a id="opencode"></a>
## opencode

PROCESS é o padrão (opencode run); a ponte Task/NATIVE para lançar trabalho não está implementada. O hook de configuração nativo enriquece agentes principais sem trocar modelo/variante, cria okit-director e o comando okit em memória. O evento session.compacted envia resumo ao log do cliente.
A instalação copia skills sem sobrescrever arquivos diferentes, escreve plugins/okit-plugin.js apontando ao payload e adiciona bloco em commands/okit.md. Preserva módulos editados e outros plugins.
Update remove o wrapper antigo só se seus bytes forem os esperados; uninstall faz a mesma verificação e retira só o bloco de papel. Skills copiadas permanecem: não há remoção automática desses arquivos. Cota usa fontes configuradas ou amostra manual.
Raiz: opção root, OPENCODE_CONFIG_DIR, XDG_CONFIG_HOME/opencode ou ~/.config/opencode.

<a id="lifecycle"></a>
## Ciclo de vida

Use `okit-plugin install --client codex --dry-run` para ver o plano. O instalador mantém registros por cliente, link do comando e PATH gerenciado, versões anteriores e autostart opcional. Update preserva estado; remoção apaga somente diretórios registrados e conserva os usados por outros clientes. Estado só é apagado com --purge --yes, sem outros clientes instalados. Plataformas sem entrega nativa comprovada retornam diagnóstico; copiar arquivos não prova ativação.

[Visão geral](README.pt-BR.md) · [Hooks](hooks.pt-BR.md) · [Atualizar/remover](../guide/update-and-remove.pt-BR.md) · [English](adapters.md)
