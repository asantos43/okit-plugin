# Contas

![okit-plugin: Guia do usuário](../images/banners/guide.svg)

Claude Code e Codex podem ter várias contas. Cada uma tem id estável, nome editável e pasta de configuração própria. OpenCode está fora deste recurso. A conta implícita `default` não sobrescreve a pasta e mantém o ambiente atual do cliente.

<a id="manage"></a>
## Gerenciar uma conta

1. Adicione uma pasta distinta com caminho absoluto neste sistema e execute o comando impresso de login manual.
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

O login é manual. Siga o comando impresso: `CLAUDE_CONFIG_DIR=/caminho/absoluto/claude-trabalho claude` ou `CODEX_HOME=/caminho/absoluto/codex-trabalho codex`. No PowerShell: `$env:CODEX_HOME='C:\Contas\Trabalho'; codex` (Claude usa `CLAUDE_CONFIG_DIR` e `claude`). Cada aspa de uma pasta impressa para o PowerShell é dobrada, então uma pasta cujo nome tem uma aspa (`C:\Users\O'Brien\acc`) continua sendo uma só string. `logged-in` indica que existe um marcador local; não verifica acesso. O login da conta default é lido na pasta que o cliente usa sem sobrescrita, a que seus ajustes de instalação nomeiam. Nenhuma credencial é lida, copiada ou impressa. macOS Keychain e armazenamento por keyring do Codex aparecem como `unknown`.

Para Claude Code, add imprime um comando do coletor. Registre-o manualmente em `statusLine.command`, com `statusLine.type` igual a `command`, no `settings.json` daquela pasta. Preserve ou encadeie uma barra existente conforme necessário. O comando define `CLAUDE_CONFIG_DIR` e `OKWORK_HOME`: o coletor identifica a conta pela pasta e grava sua própria amostra. O coletor grava só o arquivo da conta que a pasta nomeia: uma pasta que não nomeia conta salva (a pasta de uma conta removida, ou de uma que nunca foi salva) não grava nada, então a leitura de uma conta nunca é sobrescrita pelos limites de outra. A pasta que o cliente usa sem sobrescrita é a pasta da própria conta default e grava o arquivo da default. Claude usa um shell POSIX, inclusive Git Bash no Windows. Codex lê a quota das próprias sessões locais; não tem a barra do Claude para registrar. Os comandos de conta nunca editam arquivos dos clientes.

List mostra default primeiro em cada cliente; o JSON contém `client`, `id`, `label`, `configDir` (null para default) e `login`. Remove aceita id e só altera a configuração do plugin: pasta, login e histórico gravado permanecem. Default não pode ser removida. Rename aceita id ou nome atual, altera apenas o nome e mantém a consulta de quota e histórico pelo id.

Quota, slots e escolhas de modelos são por conta. Relatórios incluem extras instaladas mesmo sem default instalada. Pastas devem ser únicas no cliente, incluindo a pasta conhecida de default; equivalências léxicas e diferenças de caixa no Windows contam como a mesma pasta. Falhas de disco mostram mensagem traduzida e código do sistema. `ANTHROPIC_API_KEY` e `CLAUDE_CODE_OAUTH_TOKEN` prevalecem sobre um login Claude guardado. Quando um cliente tem contas salvas, a pasta da conta default é sempre a que o cliente usa sem sobrescrita; um `CLAUDE_CONFIG_DIR` ou `CODEX_HOME` que não nomeia essa pasta nem a de uma conta salva não é seguido e o doctor avisa `config-dir-unregistered` (cadastre a pasta com `account add` ou remova a variável).

Para cota manual, chame `quota_set` com `client: "claude-code"`, `account: "work"` e `pct: 80`; consulte com `quota_show` usando cliente e conta iguais. Utilize o id estável; o cliente continua sendo `claude-code`, nunca um nome de exibição. Orientações dos relatórios e do doctor incluem o id da extra; as da default permanecem iguais. Toda linha JSON que lista contas (`status`, `actors_list`, `env_report`, `quota_show` e o doctor) informa o cliente puro e o id da conta em `account`; o texto de exibição fica só na tabela, então a linha de uma conta mantém a mesma chave depois de um renome. Sem `account`, o arquivo continua `quota/claude-code.json`; a extra usa `quota/claude-code.work.json`. Recusas de conta no MCP usam o locale do pedido ou o idioma salvo, como na CLI.

`acquire_slot` aceita o mesmo id opcional. Vagas, limites e cota recusam ids inexistentes; ids inexistentes em execuções gravadas contam no cliente puro. O teto do cliente vale separadamente para cada conta; `limits_status` conta em `claude-code` e `claude-code:work`, e `live` soma todas as execuções. Seus campos opcionais `client` e `account` selecionam uma conta. Modelos, evidências e pasta de cada extra usam o ambiente dela; o catálogo salvo da default não confirma uma extra. No Windows, a casa prioriza `USERPROFILE` sobre `HOME`.

Processos usam o id informado pelo chamador ou, se omitido, a conta da vaga reservada; contas inexistentes são recusadas antes do lançamento. Extras definem `CODEX_HOME` ou `CLAUDE_CONFIG_DIR`; default preserva o ambiente atual, exceto que, com contas salvas para o cliente, descarta essa variável e usa a pasta que o cliente usa sem sobrescrita. Gravações locais guardam o id estável em `agent.extra.account` somente para extras; exportação, listagem e `trajectory_show` o preservam após renomear. Entregas nativas também registram o id informado. A cota das sessões do Codex usa `CODEX_SESSIONS_DIR`, depois `<CODEX_HOME>/sessions` (só enquanto o Codex não tem contas salvas), depois a pasta de sessões que o cliente usa sem sobrescrita (normalmente `~/.codex/sessions`, a pasta que seus ajustes de instalação nomeiam). Extras sempre consultam as sessões da própria pasta.

[Guia](README.pt-BR.md) · [Modelos e quota](models-and-quota.pt-BR.md) · [English](accounts.md)
