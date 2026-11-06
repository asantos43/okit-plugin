# Página de configuração

![okit-plugin: Guia do usuário](../images/banners/guide.svg)

Edite ajustes e perfis de atores em uma página local no navegador.

<a id="start"></a>
## Iniciar

1. Execute `okit-plugin config ui` para abrir a página; use `--locale en` ou `--locale pt-BR` para escolher o idioma. Guarde a URL exibida para recarregar durante esta sessão.

<a id="edit"></a>
## Editar

2. Confira a linha de prontidão e as tabelas de atores. Cada conta de cliente tem sua tabela; os nomes das contas podem ser salvos na própria página. Os perfis são compartilhados pelas contas do cliente. Atualize os modelos para consultar a lista atual do cliente.
3. Use as abas Atores, Limites e cota, Idioma, Perfis, Telemetria e Lista de tarefas; grupos futuros aparecem em Outros. Ative ou desative atores, escolha modelo, esforço e máximo de turnos, ou edite um grupo de ajustes. Os ajustes vêm do esquema de configuração; restaurar retorna ao padrão. Campos ocultados são somente leitura.
Ajustes de texto e número sem valor aparecem vazios; deixá-los intactos não adiciona uma alteração.
Uma aba editada mostra um ponto até seus valores voltarem ao estado inicial. Trocar de aba mantém as edições para revisão, e a aba selecionada permanece após recarregar ao salvar. Use as setas esquerda/direita, Home ou End na barra de abas; sem JavaScript todos os painéis ficam visíveis.

4. Revise a lista de antes/depois e aplique as alterações. Modelos não confirmados exigem uma confirmação explícita adicional. Falhas de validação mostram o mesmo motivo da linha de comando. Se o arquivo mudou no disco, recarregue antes de tentar novamente.

<a id="safety"></a>
## Segurança e fechamento

A página grava apenas `config.json`, pelo gravador atômico validado de configuração. Ela nunca lê nem mostra credenciais; conteúdos de credenciais são ocultados e não podem ser salvos aqui. Atualizar modelos consulta nomes pelo cliente sem ler seus arquivos de credenciais.
O servidor escuta apenas em `127.0.0.1`, numa porta aleatória. Toda solicitação exige o token da sessão e passa por verificações de Host/Origin. Mantenha a URL com token privada; os links de idioma a preservam para permitir recarregar.
O endereço com token é passado ao iniciador do navegador e fica visível na lista de processos deste computador durante a sessão. Fechar encerra a sessão; `--no-open` evita entregar o endereço a outro programa.

5. Clique em Fechar para encerrar imediatamente. O servidor encerra quando a página é fechada. Ele também encerra por inatividade ou Ctrl+C. Execute o comando novamente para uma nova sessão.

[Guia](README.pt-BR.md) · [English](config-ui.md)
