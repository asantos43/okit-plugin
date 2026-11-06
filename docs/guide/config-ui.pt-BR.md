# Página de configuração

![okit-plugin: Guia do usuário](../images/banners/guide.svg)

Edite ajustes e perfis de atores em uma página local no navegador.

<a id="start"></a>
## Iniciar

1. Execute `okit-plugin config ui` para abrir a página; use `--locale en` ou `--locale pt-BR` para escolher o idioma. Guarde a URL exibida para recarregar durante esta sessão.

<a id="edit"></a>
## Editar

2. Confira a linha de prontidão e as tabelas de atores. Cada conta de cliente tem sua tabela; os nomes das contas podem ser salvos na própria página. Os perfis são compartilhados pelas contas do cliente. Atualize os modelos para consultar a lista atual do cliente.
3. Use as abas Atores, Contas, Limites e cota, Idioma, Perfis, Telemetria e Lista de tarefas; grupos futuros aparecem em Outros. Ative ou desative atores, escolha modelo, esforço e máximo de turnos, ou edite um grupo de ajustes. Os ajustes vêm do esquema de configuração; restaurar retorna ao padrão. Campos ocultados são somente leitura.
Contas mostra um cartão para Claude Code e Codex, incluindo cada conta padrão, com nomes, ids estáveis, pastas de configuração e indicadores de login. Desconhecido significa que o login pode estar onde o plugin não lê, como nas Chaves do macOS. O formulário de adição e os botões de conta são uma prévia visual; suas interações chegam na próxima etapa. Continue usando os [comandos de conta](accounts.pt-BR.md) para adicionar, renomear, remover ou entrar. Remover altera apenas os ajustes do plugin; a pasta, o login e o histórico permanecem.
Ajustes de texto e número sem valor aparecem vazios; deixá-los intactos não adiciona uma alteração.
Seções e subseções têm títulos clicáveis com contagens de campos; expanda ou recolha pela seta, mesmo sem JavaScript. Em cada aba, só a primeira seção começa expandida, e apenas com quatro campos ou menos; todas as outras seções e todas as subseções começam recolhidas. Um valor diferente do padrão abre sua seção ou subseção e todas as seções ancestrais. Abas com um só grupo mostram campos ou subseções diretamente, com subseções recolhidas salvo quando um valor difere do padrão.
Abas e títulos de seções editados mostram um ponto, inclusive após Restaurar padrão, até as edições voltarem ao estado inicial. Trocar de aba mantém as edições para revisão, e a aba selecionada permanece após recarregar ao salvar. Use as setas esquerda/direita, Home ou End na barra de abas; sem JavaScript os painéis de ajustes ficam visíveis e Contas permanece oculta.

4. Revise a lista de antes/depois e aplique as alterações. Modelos não confirmados exigem uma confirmação explícita adicional. Falhas de validação mostram o mesmo motivo da linha de comando. Se o arquivo mudou no disco, recarregue antes de tentar novamente.

<a id="safety"></a>
## Segurança e fechamento

A página grava apenas `config.json`, pelo gravador atômico validado de configuração. Ela nunca lê nem mostra credenciais; conteúdos de credenciais são ocultados e não podem ser salvos aqui. Atualizar modelos consulta nomes pelo cliente sem ler seus arquivos de credenciais.
O servidor escuta apenas em `127.0.0.1`, numa porta aleatória. Toda solicitação exige o token da sessão e passa por verificações de Host/Origin. Mantenha a URL com token privada; os links de idioma a preservam para permitir recarregar.
O endereço com token é passado ao iniciador do navegador e fica visível na lista de processos deste computador durante a sessão. Fechar encerra a sessão; `--no-open` evita entregar o endereço a outro programa.

5. Clique em Fechar para encerrar imediatamente. O servidor encerra quando a página é fechada. Ele também encerra por inatividade ou Ctrl+C. Execute o comando novamente para uma nova sessão.

[Guia](README.pt-BR.md) · [English](config-ui.md)
