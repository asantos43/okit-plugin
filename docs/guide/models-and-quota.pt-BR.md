# Escolher modelos e registrar cota

![okit-plugin: Guia do usuário](../images/banners/guide.svg)

Escolha os modelos usados pelos ajudantes e confira a cota restante antes do trabalho.

<a id="models"></a>
## Escolher modelos

1. Execute `okit-plugin setup`. Espere clientes detectados, modelos propostos e motivos. Confirme para salvar; sem modelos ativos, a configuração continua pendente. Na conversa, a skill `okit-setup` orienta as mesmas escolhas. Execute `okit-plugin setup --again` para repetir; espere uma nova revisão das escolhas.
2. Execute `okit-plugin actors --all --locale pt-BR`. Espere pares de modelo e esforço disponíveis, tamanhos de tarefa, cota restante e vagas livres. Essas escolhas são chamadas de atores; são ajudantes disponíveis, enquanto `okit-plugin status --all --locale pt-BR` mostra os ajudantes rodando e seus limites.
3. Para mudar uma escolha, use `okit-plugin config set profiles.codex.normal.model MODELO`, trocando `MODELO` por um modelo ativo mostrado pelo cliente. Espere o valor anterior e o novo. `okit-plugin config unset profiles.codex.normal.model` restaura o padrão e informa a mudança. Troque `codex` e `normal` conforme necessário; as categorias são `simple`, `normal` e `hard`.

<a id="quota"></a>
## Registrar cota

1. Execute `okit-plugin quota show`. Espere a leitura, origem e idade de cada cliente, ou um valor desconhecido. Codex pode ler sessões locais recentes; Claude Code pode coletar a barra; opencode precisa de uma fonte configurada ou leitura manual.
2. Se o cliente realmente mostrar 80% restantes, execute `okit-plugin quota set claude-code 80`, trocando o cliente e a porcentagem pela sua leitura. Espere `Quota recorded / Cota registrada: claude-code 80%`. Nunca copie o exemplo como estimativa.
3. Execute `okit-plugin status --all --locale pt-BR`. Espere a leitura salva e vagas livres. Cota e limite de ajudantes simultâneos são separados; cota desconhecida não garante que o trabalho pode começar.

O estado normalmente fica em `~/.okwork`; `OKWORK_HOME` escolhe outra pasta. Use a mesma pasta nos comandos seguintes. `okit-plugin config show` lista ajustes editáveis, valores, origens e efeitos; veja [detalhes da configuração](../components/configuration.pt-BR.md).

[Guia](README.pt-BR.md) · [English](models-and-quota.md)
