# Escolher modelos e registrar cota

![okit-plugin: Guia do usuário](../images/banners/guide.svg)

Escolha os modelos usados pelos ajudantes e confira a cota restante antes do trabalho.

<a id="models"></a>
## Escolher modelos

1. Execute `okit-plugin setup`. A instalação já salva as escolhas encontradas sem substituir as suas. Cada pergunta restante recomenda uma escolha em palavras simples, explicando tarefas pequenas, trabalhos do dia a dia ou trabalhos complexos. Confirme para salvar as escolhas revisadas; sem modelos ativos, a configuração continua pendente. Há textos em inglês e português do Brasil. A detecção não gasta cota. Na conversa, a skill `okit-setup` orienta as mesmas escolhas. Execute `okit-plugin setup --again` para revisar novamente.

   Ao final, o `okit-plugin setup` interativo oferece iniciar o daemon com a máquina. O padrão é não; `--defaults` nunca instala a inicialização automática. `okit-plugin uninstall` a remove.
2. Peça ao seu assistente: “Quais atores estão disponíveis?” (ele chama `actors_list`). Espere pares de modelo e esforço disponíveis, tamanhos de tarefa, cota restante e vagas livres. Essas escolhas são chamadas de atores; são ajudantes disponíveis, enquanto o status mostra os ajudantes rodando e seus limites.
3. Para mudar uma escolha, peça ao seu assistente para chamar `config_set` com a chave `profiles.codex.normal.model` e o modelo que o cliente mostra. Espere o valor anterior e o novo. A mesma chamada sem valor restaura o padrão e informa a mudança. Troque `codex` e `normal` conforme necessário; as categorias são `simple`, `normal` e `hard`.

<a id="quota"></a>
As escolhas salvas no setup contam como confirmadas quando a lista de modelos não pode ser lida, inclusive no Windows. Uma lista lida com sucesso que exclui um modelo continua bloqueando esse modelo. Depois de trocar um modelo, é preciso uma lista válida ou `okit-plugin setup --again`. Configurações antigas sem confirmação salva também precisam desse comando. A confirmação registra sua escolha; ela não verifica acesso à conta.

A confirmação de atores vale para o par exato de modelo e esforço. Listagens apenas de modelos não confirmam um esforço diferente da escolha salva ou do perfil de referência; use `okit-plugin setup --again` para confirmar um novo esforço. Outro perfil com o mesmo modelo não autoriza essa mudança.

## Registrar cota

O relatório do ambiente (`env_report`) identifica clientes ausentes como `não instalado (opcional)`; eles não geram pendências de modelos ou cota e o setup os ignora. Isso vale no Linux, macOS e Windows. Clientes instalados continuam precisando de escolhas confirmadas.

A mesma lista de atores também identifica clientes ausentes como opcionais sem pedir configuração de perfis. O status os exclui da capacidade de executores que podem iniciar.

O relatório também verifica se os ajustes atuais do Claude Code registram `statusline-collector`. Se estiver inativo ou ilegível, mostra `okit-plugin install --client claude-code --statusline` para ligar a coleta preservando a barra existente. Ativo significa registrado nos ajustes; uma leitura recente ainda depende de o Claude Code enviar atualizações da barra.

O coletor é uma entrada interna que o cliente inicia, não um comando seu: ele precisa ser uma invocação do plugin com o subcomando do coletor, como `okit-plugin statusline-collector`. Um comando como `echo statusline-collector` só imprime o nome: o relatório o mostra como inativo e a instalação o preserva como barra anterior ao ativar a coleta.

1. Peça ao seu assistente: “Quanta cota resta?” (ele chama `quota_show`). Espere a leitura, origem e idade de cada cliente, ou um valor desconhecido. Codex pode ler sessões locais recentes; Claude Code pode coletar a barra; opencode precisa de uma fonte configurada ou leitura manual.
2. Se o cliente realmente mostrar 80% restantes, peça ao seu assistente para registrar: `quota_set` com o cliente `claude-code` e a porcentagem 80, trocando os dois pela sua leitura. Espere a leitura registrada: `claude-code` 80%. Nunca copie o exemplo como estimativa.
3. Peça ao seu assistente o status de cada cliente (ele chama `status`). Espere a leitura salva e vagas livres. Cota e limite de ajudantes simultâneos são separados; cota desconhecida não garante que o trabalho pode começar.

O setup e o status consultam a cota automática ou manual disponível. Antes da primeira leitura, o setup pede que você registre a porcentagem real, que o seu assistente grava com `quota_set`; o status repete o pedido. Nenhuma cota é presumida, e os ajudantes ficam bloqueados até haver uma leitura válida.

O estado normalmente fica em `~/.okwork`; `OKWORK_HOME` escolhe outra pasta. Use a mesma pasta nos comandos seguintes. Seu assistente lista os ajustes editáveis, valores, origens e efeitos (`config_get`); veja [detalhes da configuração](../components/configuration.pt-BR.md).

## Quota por conta

[Contas](accounts.pt-BR.md) têm leituras de quota, amostras do coletor, slots e escolhas de modelos separados. Adicione uma com `okit-plugin account add <client> <nome> --config-dir <caminho-absoluto>` e siga as instruções de login manual e coletor Claude. Renomear preserva o id estável e seu histórico. `ANTHROPIC_API_KEY` e `CLAUDE_CODE_OAUTH_TOKEN` prevalecem sobre um login Claude guardado; macOS Keychain e armazenamento por keyring do Codex mostram login como `unknown`. Um marcador local de login não verifica acesso nem quota.

[Guia](README.pt-BR.md) · [English](models-and-quota.md)
