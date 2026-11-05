# Contas

![okit-plugin: Guia do usuário](../images/banners/guide.svg)

Claude Code e Codex podem ter várias contas. Cada uma tem id estável, nome editável e pasta de configuração própria. OpenCode está fora deste recurso. A conta implícita `default` não sobrescreve a pasta e mantém o ambiente atual do cliente.

O daemon agora escolhe a conta do trabalho que não nomeia uma. Ele compara login, modelo e esforço, janelas de cota e vagas de cada conta; depois prefere folga semanal, folga de sessão, menos trabalhos em execução e o lançamento mais antigo. Crítico e verificador preferem outra conta elegível que a do executor. Contas nomeadas e continuações de sessão resolvidas ficam fixas.

Os ajustes incluem `accountPolicy.minQuotaPct` (0), `accountPolicy.paceMarginPct` (15) e `accountPolicy.enforcePace` (false). O padrão informa uso adiantado sem adiar trabalho. A aplicação do ritmo adia trabalho difícil e não urgente até o ritmo alcançar o uso; trabalho simples, urgência explícita e continuações de sessão fixadas ficam isentos. A demanda adiada fica pendente até esse instante, sem criar execução ou ocupar vaga. Doctor e lista de atores explicam a escolha atual no seu idioma.

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

`acquire_slot` aceita o mesmo id opcional. Vagas, limites e cota recusam ids inexistentes; um id inexistente em uma execução gravada conta na própria chave `claude-code:<id>`, e um inválido no cliente puro. O teto do cliente vale separadamente para cada conta; `limits_status` conta em `claude-code` e `claude-code:work`, e `live` soma todas as execuções. Seus campos opcionais `client` e `account` selecionam uma conta. Cada extra usa seu próprio ambiente e pasta. Nos lançamentos do daemon, sem confirmação do cliente em `setup.done`, os perfis configurados valem para todas as contas dele. Com confirmação, clientes de catálogo como Claude Code compartilham modelo e esforço confirmados com as extras; só uma fonte `listing` exige que a extra liste o modelo por conta própria. Alterações posteriores de modelo ou esforço continuam exigindo confirmação. No Windows, a casa prioriza `USERPROFILE` sobre `HOME`.

Processos usam o id informado pelo chamador ou, se omitido, a conta da vaga reservada; contas inexistentes são recusadas antes do lançamento. Extras definem `CODEX_HOME` ou `CLAUDE_CONFIG_DIR`; default preserva o ambiente atual, exceto que, com contas salvas para o cliente, descarta essa variável e usa a pasta que o cliente usa sem sobrescrita. Um lançamento para uma conta que não está logada para antes de iniciar qualquer coisa, no idioma da execução, e diz qual é a conta e o comando que resolve (por exemplo `CLAUDE_CONFIG_DIR=/caminho/absoluto/claude-work claude`, depois `/login`; `CODEX_HOME=/caminho/absoluto/codex-work codex login`; no PowerShell `$env:CODEX_HOME='C:\Contas\Work'; codex login`; para a conta default de um cliente com contas salvas o comando remove a variável, `env -u CODEX_HOME codex login` ou `Remove-Item Env:CODEX_HOME -ErrorAction SilentlyContinue; codex login`, para que uma pasta herdada pelo terminal de outra conta não seja a que entra no login). Só a falta do marcador impede o lançamento: login `unknown` (Keychain do macOS, chaveiro do Codex, pasta ilegível) ou uma variável de credencial no ambiente lança como antes, e cliente sem contas salvas não é verificado. Gravações locais guardam o id estável em `agent.extra.account` somente para extras; exportação, listagem e `trajectory_show` o preservam após renomear. Entregas nativas também registram o id informado. A cota das sessões do Codex usa `CODEX_SESSIONS_DIR`, depois `<CODEX_HOME>/sessions` (só enquanto o Codex não tem contas salvas), depois a pasta de sessões que o cliente usa sem sobrescrita (normalmente `~/.codex/sessions`, a pasta que seus ajustes de instalação nomeiam). Extras sempre consultam as sessões da própria pasta.

<a id="register"></a>
## Registrar o plugin em uma conta

1. Execute `okit-plugin install --client claude-code --account trabalho`. Espere o plugin, a entrada MCP, os hooks e (com `--statusline`) a barra de status somente na pasta dessa conta; nenhuma outra pasta é tocada.
2. Repita com outro id para cada conta que deva ter o plugin. Os arquivos do plugin são compartilhados: uma cópia por cliente, não importa quantas contas a usem.
3. Execute `okit-plugin uninstall --client claude-code --account trabalho` para tirar só essa conta. As outras contas e os arquivos compartilhados ficam até o último registro sair.

A conta precisa estar salva antes (`account add`); um id desconhecido, um cliente sem contas (OpenCode) ou a falta de `--client` é recusado. O `update` move os arquivos compartilhados uma vez e registra a nova versão em todas as contas registradas, por isso não aceita `--account`. Sem `--account`, `install`, `update` e `uninstall` agem na conta default e imprimem uma linha que lista as contas salvas. `uninstall` sem `--account` mantém os arquivos compartilhados enquanto outras contas ainda os usam, e `--purge` exige que nenhum registro reste. A barra de status de uma conta é guardada à parte da default, e o coletor dela grava o arquivo da própria conta. O que está registrado é conhecido pelo registro da instalação, não pelas contas salvas: uma conta que você tirou da lista salva continua contando, mantém os arquivos compartilhados e pode ser retirada com `uninstall --account <id>`, na pasta em que foi registrada. Uma conta salva de novo com outra pasta sob um id registrado é recusada até você desinstalá-la, e uma instalação que traria outra versão é recusada enquanto outras contas usam a atual: o `update` move todas. Os backups guardam só os arquivos que o plugin grava na pasta de uma conta. Credenciais nunca são lidas, copiadas nem impressas. O doctor lê o registro de cada conta registrada; com uma só conta mostra as mesmas linhas de antes.

[Guia](README.pt-BR.md) · [Modelos e quota](models-and-quota.pt-BR.md) · [English](accounts.md)
