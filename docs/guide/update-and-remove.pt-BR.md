# Atualizar ou remover

![okit-plugin: Guia do usuário](../images/banners/guide.svg)

Confira uma atualização ou remoção antes de alterar o plugin instalado.

<a id="update"></a>
## Atualizar

1. Execute `okit-plugin update --check`. Espere a disponibilidade para clientes registrados; nada é gravado. Adicione `--client codex` para selecionar apenas esse cliente.
2. Execute `okit-plugin update`. Espere o resultado e as verificações smoke de cada cliente; a versão anterior é mantida. Reinicie o cliente após sucesso. Se a verificação falhar, espere uma instrução de retorno; execute `okit-plugin update --rollback` para ativar a versão anterior sem baixá-la novamente. A atualização troca a entrada MCP `okit` do cliente quando ela aponta para a versão substituída.
3. Execute `okit-plugin env report --locale pt-BR`. Espere clientes, modelos, cota e pastas atuais. Sua configuração e skills editadas são preservadas. Instalar/atualizar substitui apenas links antigos pertencentes ao plugin; o kit de orquestração separado mantém `okit`/`kit`.

<a id="remove"></a>
## Remover

1. Execute `okit-plugin uninstall --dry-run`. Espere o plano de remoção sem gravações. Use o mesmo destino de instalação e `OKWORK_HOME` de antes.
2. Execute `okit-plugin uninstall`. Espere o cancelamento do registro do cliente e a remoção das versões gerenciadas, registro de início automático e links; o serviço em segundo plano é parado. Configuração e estado ficam preservados. Adicione `--client codex` para remover apenas esse cliente; os outros mantêm o comando compartilhado. Também remove a entrada MCP `okit` do cliente quando ela é nossa; uma entrada que não é nossa é mantida, e uma entrada que o cliente mostra em outro escopo que não o configurado também é mantida.
3. Somente se também quiser apagar configuração e estado, use `okit-plugin uninstall --purge --yes` em vez do comando anterior. Espere a exclusão da pasta de estado também. Isso recusa se outro cliente permanecer; `--yes` pula a confirmação. A remoção desfaz apenas a adição de PATH registrada pelo instalador e preserva seus demais ajustes.

Use o comando instalado para atualizar/remover: scripts de instalação antigos localizam apenas o registro legado de cliente único. Veja [detalhes do ciclo da versão](../maintainers/RELEASING.pt-BR.md#installer-and-updater).

[Guia](README.pt-BR.md) · [English](update-and-remove.md)
