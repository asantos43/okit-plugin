# Página de configuração

![okit-plugin: Guia do usuário](../images/banners/guide.svg)

Edite ajustes e perfis de atores em uma página local no navegador.

<a id="start"></a>
## Iniciar

1. Em uma sessão Claude Code, Codex ou opencode, invoque `/okit-config` (Claude Code: `/okit-plugin:okit-config`). A skill compartilhada chama `config_ui_open`, retornando uma URL privada com token sem bloquear a sessão. Reutiliza a página daquela sessão; `open: false` só retorna a URL. Mantenha-a na sessão, nunca em arquivos ou na fila. O host do painel Claude não oferece chamada MCP direta, por isso o comando é a skill com namespace.
Em um terminal, execute `okit-plugin config ui`; use `--locale en` ou `--locale pt-BR`, `--no-open` para apenas exibir a URL, ou `--idle-minutes` para alterar o limite de dez minutos de inatividade. O comando fica ativo até fechar ou Ctrl+C. Se a ferramenta estiver indisponível em uma instalação antiga, peça ao Produtor para atualizar o plugin e reiniciar o cliente. Nunca execute um servidor em primeiro plano pelo shell do agente.

<a id="edit"></a>
## Editar

2. Confira a linha de prontidão e as tabelas de atores. Cada conta de cliente tem sua tabela; os nomes das contas podem ser salvos na própria página. Os perfis são compartilhados pelas contas do cliente. Atualize os modelos para consultar a lista atual do cliente.
3. Use as abas Atores, Contas, Limites e cota, Idioma, Perfis, Telemetria e Lista de tarefas; grupos futuros aparecem em Outros. Ative ou desative atores, escolha modelo, esforço e máximo de turnos, ou edite um grupo de ajustes. Os ajustes vêm do esquema de configuração; restaurar retorna ao padrão. Campos ocultados são somente leitura.
Contas mostra um cartão para Claude Code e Codex, incluindo cada conta padrão, com nomes, ids estáveis, pastas de configuração e indicadores de login. Desconhecido significa que o login pode estar onde o plugin não lê, como nas Chaves do macOS. Adicione uma conta com nome e pasta de configuração absoluta, ou salve o nome na linha. Adicionar, renomear e remover pedem para salvar ou restaurar outras edições primeiro, pois recarregam a página. Erros de validação preservam os valores digitados. Remover abre Confirmar remoção e Cancelar com um aviso sobre o que permanece; Escape ou outro clique cancela a confirmação. Remover altera apenas os ajustes do plugin; a pasta, o login e o histórico permanecem. A ajuda de login aparece para contas não conectadas ou desconhecidas; nos demais casos, Entrar abre a ajuda e oculta o botão. Escolha Entrar em um terminal para abrir o login do próprio cliente em uma janela de terminal para a pasta daquela conta. Entre nessa janela e depois pressione Verificar login para atualizar indicadores, comandos e ajuda na própria página sem perder outras edições. No Claude Code, digite `/login` na sessão se solicitado. Nada é digitado por você e o plugin nunca vê suas credenciais. Se nenhuma janela abrir, copie o comando e execute por conta própria; se a cópia estiver indisponível, pressione Ctrl+C no comando selecionado. Orientações de cópia e terminal aparecem em uma linha de status discreta; falhas aparecem na linha de erro. A aba Contas permanece selecionada após alterações bem-sucedidas. Os [comandos de conta](accounts.pt-BR.md) continuam disponíveis.
Ao digitar o nome de uma nova conta, Pasta de configuração recebe um valor sugerido dentro da sua pasta pessoal: `.claude-trabalho-acao` para Claude Code ou `.codex-trabalho-acao` para Codex quando o nome é `Trabalho Ação`. O nome vira um slug em minúsculas, sem acentos, com espaços e caracteres inseguros substituídos por hífens, limitado a 32 caracteres. Nomes vazios ou contendo apenas símbolos não geram sugestão. Você pode editar a pasta; ela então para de acompanhar o nome. Limpe a pasta para voltar a acompanhar. O servidor também deriva essa pasta quando `/api/account-add` recebe `configDir` vazio ou ausente. Uma pasta usada pela conta padrão do cliente ou por outra conta é recusada: escolha outro nome ou pasta. A CLI continua exigindo `--config-dir`.
Ajustes de texto e número sem valor aparecem vazios; deixá-los intactos não adiciona uma alteração.
Seções e subseções têm títulos clicáveis com contagens de campos; expanda ou recolha pela seta, mesmo sem JavaScript. Em cada aba, só a primeira seção começa expandida, e apenas com quatro campos ou menos; todas as outras seções e todas as subseções começam recolhidas. Um valor diferente do padrão abre sua seção ou subseção e todas as seções ancestrais. Abas com um só grupo mostram campos ou subseções diretamente, com subseções recolhidas salvo quando um valor difere do padrão.
Abas e títulos de seções editados mostram um ponto, inclusive após Restaurar padrão, até as edições voltarem ao estado inicial. Trocar de aba mantém as edições para revisão, e a aba selecionada permanece após recarregar ao salvar. Use as setas esquerda/direita, Home ou End na barra de abas; sem JavaScript os painéis de ajustes ficam visíveis e Contas permanece oculta.

4. Revise a lista de antes/depois e aplique as alterações. Modelos não confirmados exigem uma confirmação explícita adicional. Falhas de validação mostram o mesmo motivo da linha de comando. Se o arquivo mudou no disco, recarregue antes de tentar novamente.

<a id="safety"></a>
## Segurança e fechamento

A página grava apenas `config.json`, pelo gravador atômico validado de configuração. Ela nunca lê nem mostra credenciais; conteúdos de credenciais são ocultados e não podem ser salvos aqui. Atualizar modelos consulta nomes pelo cliente sem ler seus arquivos de credenciais.
O servidor escuta apenas em `127.0.0.1`, numa porta aleatória. Toda solicitação exige o token da sessão e passa por verificações de Host/Origin. Mantenha a URL com token privada; os links de idioma a preservam para permitir recarregar.
O endereço com token é passado ao iniciador do navegador e fica visível na lista de processos deste computador durante a sessão. Fechar encerra a sessão; `--no-open` evita entregar o endereço a outro programa.

5. Clique em Fechar para encerrar imediatamente. O servidor encerra ao fechar a página, por inatividade ou quando a sessão MCP responsável termina. No terminal, Ctrl+C também encerra. Invoque a skill ou o comando novamente para abrir outra página.

[Guia](README.pt-BR.md) · [English](config-ui.md)
