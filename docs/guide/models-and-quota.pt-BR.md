# Escolher modelos e registrar cota

![okit-plugin: Guia do usuário](../images/banners/guide.svg)

Escolha os modelos usados pelos ajudantes e confira a cota restante antes do trabalho.

<a id="models"></a>
## Escolher modelos

1. Execute `okit-plugin setup`. A instalação já salva as escolhas encontradas sem substituir as suas. Cada pergunta restante recomenda uma escolha em palavras simples, explicando tarefas pequenas, trabalhos do dia a dia ou trabalhos complexos. Confirme para salvar as escolhas revisadas; sem modelos ativos, a configuração continua pendente. Há textos em inglês e português do Brasil. A detecção não gasta cota. Na conversa, a skill `okit-setup` orienta as mesmas escolhas. Execute `okit-plugin setup --again` para revisar novamente.
2. Execute `okit-plugin actors --all --locale pt-BR`. Espere pares de modelo e esforço disponíveis, tamanhos de tarefa, cota restante e vagas livres. Essas escolhas são chamadas de atores; são ajudantes disponíveis, enquanto `okit-plugin status --all --locale pt-BR` mostra os ajudantes rodando e seus limites.
3. Para mudar uma escolha, use `okit-plugin config set profiles.codex.normal.model MODELO`, trocando `MODELO` por um modelo ativo mostrado pelo cliente. Espere o valor anterior e o novo. `okit-plugin config unset profiles.codex.normal.model` restaura o padrão e informa a mudança. Troque `codex` e `normal` conforme necessário; as categorias são `simple`, `normal` e `hard`.

<a id="quota"></a>
As escolhas salvas no setup contam como confirmadas quando a lista de modelos não pode ser lida, inclusive no Windows. Uma lista lida com sucesso que exclui um modelo continua bloqueando esse modelo. Depois de trocar um modelo, é preciso uma lista válida ou `okit-plugin setup --again`. Configurações antigas sem confirmação salva também precisam desse comando. A confirmação registra sua escolha; ela não verifica acesso à conta.

A confirmação de atores vale para o par exato de modelo e esforço. Listagens apenas de modelos não confirmam um esforço diferente da escolha salva ou do perfil de referência; use `okit-plugin setup --again` para confirmar um novo esforço. Outro perfil com o mesmo modelo não autoriza essa mudança.

## Registrar cota

`okit-plugin env report` identifica clientes ausentes como `não instalado (opcional)`; eles não geram pendências de modelos ou cota e o setup os ignora. Isso vale no Linux, macOS e Windows. Clientes instalados continuam precisando de escolhas confirmadas.

`okit-plugin actors --all` também identifica clientes ausentes como opcionais sem pedir configuração de perfis. O status os exclui da capacidade de executores que podem iniciar.

O relatório também verifica se os ajustes atuais do Claude Code registram `statusline-collector`. Se estiver inativo ou ilegível, mostra `okit-plugin install --client claude-code --statusline` para ligar a coleta preservando a barra existente. Ativo significa registrado nos ajustes; uma leitura recente ainda depende de o Claude Code enviar atualizações da barra.

O coletor precisa ser uma invocação do plugin com o subcomando do coletor, como `okit-plugin statusline-collector`. Um comando como `echo statusline-collector` só imprime o nome: o relatório o mostra como inativo e a instalação o preserva como barra anterior ao ativar a coleta.

1. Execute `okit-plugin quota show`. Espere a leitura, origem e idade de cada cliente, ou um valor desconhecido. Codex pode ler sessões locais recentes; Claude Code pode coletar a barra; opencode precisa de uma fonte configurada ou leitura manual.
2. Se o cliente realmente mostrar 80% restantes, execute `okit-plugin quota set claude-code 80`, trocando o cliente e a porcentagem pela sua leitura. Espere `Quota recorded / Cota registrada: claude-code 80%`. Nunca copie o exemplo como estimativa.
3. Execute `okit-plugin status --all --locale pt-BR`. Espere a leitura salva e vagas livres. Cota e limite de ajudantes simultâneos são separados; cota desconhecida não garante que o trabalho pode começar.

O setup e o status consultam a cota automática ou manual disponível. Antes da primeira leitura, o setup pede que você registre a porcentagem real com `okit-plugin quota set CLIENT <pct>`; o status repete o comando. Nenhuma cota é presumida, e os ajudantes ficam bloqueados até haver uma leitura válida.

O estado normalmente fica em `~/.okwork`; `OKWORK_HOME` escolhe outra pasta. Use a mesma pasta nos comandos seguintes. `okit-plugin config show` lista ajustes editáveis, valores, origens e efeitos; veja [detalhes da configuração](../components/configuration.pt-BR.md).

[Guia](README.pt-BR.md) · [English](models-and-quota.md)
