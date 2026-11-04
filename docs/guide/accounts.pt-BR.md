# Contas

![okit-plugin: Guia do usuário](../images/banners/guide.svg)

Claude Code e Codex podem ter várias contas. Cada uma tem id estável, nome editável e pasta de configuração própria. OpenCode está fora deste recurso. A conta implícita `default` não sobrescreve a pasta e mantém o ambiente atual do cliente.

<a id="manage"></a>
## Gerenciar uma conta

1. Adicione uma pasta com caminho absoluto e execute o comando impresso de login manual.
2. Registre o comando impresso do coletor Claude, se aplicável, e confira `account list`.
3. Renomeie ou remova o registro conforme necessário; o id fica estável ao renomear.

```sh
okit-plugin account add claude-code Trabalho --config-dir /caminho/absoluto/claude-trabalho
okit-plugin account add codex Trabalho --config-dir /caminho/absoluto/codex-trabalho
okit-plugin account list
okit-plugin account list codex --json
okit-plugin account rename codex trabalho 'Conta de produção'
okit-plugin account rename codex 'Conta de produção' 'Conta de trabalho'
okit-plugin account remove codex trabalho
```

Use um caminho absoluto. No Windows PowerShell, por exemplo: `okit-plugin account add codex Trabalho --config-dir "$env:USERPROFILE\codex-trabalho"`. Add cria as pastas ausentes (modo 0700 em POSIX), salva a conta e informa id, nome, pasta e estado do login. Nomes devem ser não vazios, ter até 40 caracteres, ser únicos no cliente e não conter caracteres de controle.

O login é manual. Siga o comando impresso: `CLAUDE_CONFIG_DIR=/caminho/absoluto/claude-trabalho claude` ou `CODEX_HOME=/caminho/absoluto/codex-trabalho codex`. No PowerShell: `$env:CODEX_HOME='C:\Contas\Trabalho'; codex` (Claude usa `CLAUDE_CONFIG_DIR` e `claude`). `logged-in` indica que existe um marcador local; não verifica acesso. Nenhuma credencial é lida, copiada ou impressa. macOS Keychain e armazenamento por keyring do Codex aparecem como `unknown`.

Para Claude Code, add imprime um comando do coletor. Registre-o manualmente em `statusLine.command`, com `statusLine.type` igual a `command`, no `settings.json` daquela pasta. Preserve ou encadeie uma barra existente conforme necessário. O comando define `CLAUDE_CONFIG_DIR` e `OKWORK_HOME`: o coletor identifica a conta pela pasta e grava sua própria amostra. Claude usa um shell POSIX, inclusive Git Bash no Windows. Codex lê a quota das próprias sessões locais; não tem a barra do Claude para registrar. Os comandos de conta nunca editam arquivos dos clientes.

List mostra default primeiro em cada cliente; o JSON contém `client`, `id`, `label`, `configDir` (null para default) e `login`. Remove aceita id e só altera a configuração do plugin: pasta, login e histórico gravado permanecem. Default não pode ser removida. Rename aceita id ou nome atual, altera apenas o nome e mantém a consulta de quota e histórico pelo id.

Quota, slots e escolhas de modelos são por conta. `ANTHROPIC_API_KEY` e `CLAUDE_CODE_OAUTH_TOKEN` prevalecem sobre um login Claude guardado. Confira o ambiente antes de interpretar a quota de uma conta.

[Guia](README.pt-BR.md) · [Modelos e quota](models-and-quota.pt-BR.md) · [English](accounts.md)
