# Instalar e atualizar

A detecção de shell para dicas de ativação usa `install.path.shellVariable` (`SHELL` por padrão) no Unix e `install.path.windowsShell` (`powershell` por padrão) no Windows. Um nome personalizado de shell Windows também precisa de uma entrada correspondente em `install.path.activate`.

Cada pacote de cliente inclui todos os adaptadores de execução por padrão, para
que `status` carregue todos os clientes. `release.sharedAdapters: null` herda os
caminhos de `release.adapters`; uma lista explícita substitui a seleção compartilhada.
O adaptador do cliente selecionado continua obrigatório; pacotes personalizados
devem manter todos os adaptadores importados por `src`.

O comando do plugin agora é `okit-plugin` (configurável em `install.command`); o kit mantém `okit`/`kit`. Instalar/atualizar migram apenas links `okit` do próprio plugin; desinstalar também os remove. Registros da 0.2.0 continuam legíveis; executáveis alheios do kit são preservados.

## Install

Install/update escolhem um candidato gravável já no PATH (`~/.local/bin`, depois `~/bin`). Caso contrário, o candidato padrão ganha um bloco gerenciado idempotente nos perfis existentes de bash (`.bashrc`, `.profile`), zsh (`.zshrc`, `.zprofile`) ou fish (`.config/fish/config.fish`), conforme `$SHELL`; se nenhum existir, o perfil de login é criado. No Windows, o diretório é acrescentado ao PATH do usuário sem administrador. Uninstall remove apenas o bloco/entrada registrado, após remover o último cliente; rollback o preserva.

Use `--no-path` em install/update (também nos scripts de instalação), ou `install.path.enabled: false`, para receber a instrução manual sem editar perfis/ambiente. `install.path` configura `candidates`, `shells`, `fallbackShell`, `begin`, `end`, `stateFile`, parâmetros Windows e `messages` bilíngues; `install.linkDirectory` sobrepõe a seleção. A mensagem final mostra o link, perfis alterados ou PATH existente e a resolução com o PATH resultante. Reinicie o cliente de IA para ele herdar o PATH. Se uma skill não encontrar o comando, execute o `src/cli.js` da instalação com Node e os mesmos argumentos.

Quando o PATH do terminal atual não contém o diretório bin, install/update e `okit-plugin status` mostram uma dica de ativação no idioma da execução. Rode manualmente o comando informado: `. '<perfil>'` para bash/zsh, `source '<perfil>'` para fish ou `$env:Path = '<bin>' + ';' + $env:Path` para PowerShell no Windows. Os modelos vêm de `install.path.activate`; `shellVariable` usa `SHELL` por padrão. O comando é apenas exibido para execução manual. Para shell desconhecida ou perfil gerenciado ausente, abra um terminal novo. A dica desaparece quando o diretório bin já está no PATH.

Leia o script antes de executá-lo. Node >=20 deve estar no PATH
([obter Node](https://nodejs.org/)). Só Linux foi exercitado pelo Diretor;
Windows e macOS aguardam as provas do Produtor em máquinas reais.

Pares sistema/arquitetura com suporte: linux/x64, linux/arm64, macos/x64, macos/arm64,
windows/x64, windows/arm64. O script escolhe o pacote por `uname -s` / `uname -m`
(no Windows, por `process.arch`); o macOS sob Rosetta informa x86_64 e recebe o
pacote x64. Qualquer outro par (por exemplo Linux armv7l ou i686, FreeBSD, Windows
ia32) é recusado antes de baixar qualquer coisa, com a lista acima. O código é Node
puro, então os pacotes x64 e arm64 são idênticos; os arm64 não foram executados em
hardware arm64 real.

Linux e macOS (um único script POSIX):

```sh
curl -fsSL https://github.com/asantos43/okit-plugin/releases/latest/download/install.sh | sh
```

Windows PowerShell:

```powershell
irm https://github.com/asantos43/okit-plugin/releases/latest/download/install.ps1 | iex
```

Sem terminal, escolha antes com `OKIT_CLIENT=claude-code` (PowerShell:
`$env:OKIT_CLIENT='claude-code'`). As opções são `claude-code`, `codex`, `opencode`.
Sem escolha e sem terminal, o script recusa. Para usar flags, baixe, leia e rode
`sh install.sh --client codex` ou `./install.ps1 --client codex`.
O menu mostra as opções e marca os executáveis encontrados no PATH.

O script confere Node, sistema e arquitetura, consulta a última release estável
do GitHub (ou avisa ao usar o pré-lançamento mais recente), baixa o pacote exato
e o manifesto para uma pasta temporária, confere SHA-256 antes de extrair e chama
o núcleo Node com `install --from`. O núcleo copia para um destino fixo, grava
um `install.<client>.json` por cliente, registra o cliente, cria o link compartilhado e opcionalmente
configura autostart. Atualizações guardam backup e versão anterior, ativam a nova
e rodam `okit-plugin smoke`. O temporário é apagado em sucesso e falha.
No Linux: `${XDG_DATA_HOME:-$HOME/.local/share}/okit-plugin`; macOS:
`$HOME/Library/Application Support/okit-plugin`; Windows:
`%LOCALAPPDATA%/okit-plugin` (alternativa `%USERPROFILE%/AppData/Local/okit-plugin`).

Flags: `--client <nome>`, `--dest <pasta>`, `--prerelease`, `--dry-run`, `--yes`,
`--no-link`, `--autostart`, `--locale <en|pt-BR>`, `--verbose` e, no Windows,
`--set-execution-policy` / `--no-execution-policy`. Dry-run mostra release, arquivo
e destino, sem baixar o pacote nem gravar no destino. O dry-run dos scripts baixados,
antes de qualquer instalação, imprime o mesmo cabeçalho e os passos numerados que não
dependem do pacote (baixar, instalar arquivos no `--dest` escolhido, registrar,
comando) e termina com “Simulação: nada foi alterado.” Repetir o comando atualiza a
instalação registrada; na mesma versão, informa “Em dia”.

### O que o instalador imprime

`install.sh`, `install.ps1` e `okit-plugin install|update|uninstall` imprimem por um
único apresentador, então a saída tem as mesmas linhas no Linux, no macOS e no
Windows. Ela sai em um idioma por execução: `--locale`, senão `OKIT_LANGUAGE`,
senão o `language` salvo, senão inglês. Recusas antes da leitura da configuração
usam `--locale` ou `OKIT_LANGUAGE`, inclusive para flags desconhecidas e JSON inválido.
Os scripts de bootstrap também escolhem esse idioma antes de validar as flags. Um
`--locale` que não é um idioma é recusado em um idioma só: o `--locale` válido, senão
`OKIT_LANGUAGE`, senão inglês. A recusa “Node.js é necessário” do `install.sh` e do
`install.ps1` é a única exceção à ordem acima, porque ainda não há Node para ler a configuração
salva: `--locale` válido, senão `OKIT_LANGUAGE` válido, senão o idioma do sistema, senão inglês.
Os scripts não leem configuração nem arquivo algum e nunca analisam JSON. Só `en` ou `pt-BR`
exatos valem para a flag e a variável; o idioma do sistema é o primeiro valor não vazio entre
`LC_ALL`, `LC_MESSAGES` e `LANG` (a cultura da interface no Windows), e `pt` seguido do fim, de
`_`, `-` ou `.` (`pt_BR.UTF-8`, `pt-BR`, `pt`) é português, qualquer outra coisa é inglês. Quando o
Node roda, o idioma salvo vale como em todo lugar. O `install.sh` faz isso só com recursos internos do
shell, então funciona até quando o `PATH` não tem ferramentas. Os textos de erro mostram o endereço sem consulta,
fragmento nem credenciais, e a pasta temporária como `<temp>`. Um cabeçalho nomeia o pacote,
a versão, o cliente e o sistema; depois, passos numerados
(`[1/5] Baixar e verificar ... ok`) mostram a release, o arquivo e o destino uma só
vez, dentro dos passos; a nota do SHA-256 aparece uma vez; nenhuma pasta temporária é
impressa. A linha final lista os próximos passos, com o comando exato (no Windows,
inclusive a linha `$env:Path` para o terminal atual). Os comandos que o instalador
executa só aparecem com `--verbose`.
Em cada bloco numerado, os estados ficam alinhados após o maior rótulo traduzido,
com pelo menos dois espaços entre o rótulo e seu estado.

As perguntas trazem a explicação primeiro e a pergunta por último, com o padrão em
maiúscula: `[s/N]` em português, `[y/N]` em inglês. `s` e `y` valem como sim nos dois
idiomas.
Cada passo imprime seu resultado uma vez. A escolha de modelos só é oferecida após
instalação ou atualização bem-sucedida, nunca após falha, em `--dry-run` ou com `update --check`.

### A autoverificação depois de instalar e atualizar

Uma instalação só está pronta quando funciona nesta máquina. Depois de `install` e `update` (não depois de
`--dry-run`, `--check`, `--rollback` ou `uninstall`) o instalador verifica cada cliente que acabou de
registrar, nesta ordem, e imprime uma linha, `Autoverificação (Claude Code)`:

1. **Versão**: o registro da instalação e o `package.json` instalado têm a versão que foi instalada.
2. **Comando**: cada shell do seu sistema encontra `okit-plugin` ao iniciar sem perfil, como faria um script:
   bash, zsh, sh e fish no Linux; zsh, bash, sh e um `sh -c` simples no macOS; PowerShell, cmd e Git Bash no
   Windows. Um shell que não está instalado aparece como `pulado` (`Comando (fish)  pulado  fish não está instalado`)
   e nunca faz a execução falhar. Se nenhum shell pôde fazer a verificação, ela falha e pede um shell POSIX.
   A pasta do link é posta na frente do PATH dos processos que a verificação inicia, e a primeira linha que cada
   shell imprime para `okit-plugin` (`command -v`, `Get-Command` ou `where`) deve ser um arquivo dessa pasta: o
   nosso comando. Se outro programa com o mesmo nome vier antes, a linha falha e mostra o caminho encontrado, com
   uma linha de Correção (remova ou renomeie esse arquivo, ou ponha a pasta do link antes dele no PATH).
3. **Barra de status e hook de sessão**: os comandos exatos que o instalador gravou nos ajustes do cliente são
   lidos de volta e executados no shell que o cliente usa (a barra de status recebe uma leitura de exemplo);
   os dois devem terminar com código 0. A verificação roda só o que é exatamente nosso. O hook de sessão só é
   executado quando a sua string é exatamente a que o instalador grava (um caminho do node entre aspas, o nosso
   script, `hook session-start`); um hook com qualquer coisa a mais (um comando acrescentado ou posto antes, outro
   subcomando) aparece como `pulado  o hook de sessão não é exatamente o nosso` e não é executado. Durante a
   verificação o hook não inicia nenhum processo (nenhuma sonda de cliente, nenhum comando de cota).
4. **Leitura de cota**: a barra de status deixa sua leitura. Ela roda com uma pasta de estado temporária, só com a
   parte permitida do seu `config.json` (o original só é lido), removida depois, então o seu estado de cota nunca é gravado
   pela verificação. A cópia tem só as chaves do `config.json` de que os scripts verificados precisam
   (`install.selfcheck.stateKeys`: os campos do coletor da barra de status e os limites); qualquer outro ajuste, como
   uma pasta de medições (`telemetry`) ou um comando de cota (`opencodeQuota.sources`), não é copiado. A verificação nunca roda um comando seu: uma barra de status que você encadeou com `--previous`
   não é iniciada por ela (os processos da verificação levam `OKIT_SELFCHECK`, e o coletor então pula `--previous`).
5. **PATH**: julgado à parte das verificações acima, que acrescentam a pasta do link ao PATH com que começam. Se a
   pasta do link não está no PATH deste terminal e nenhum perfil a adiciona, a verificação falha e dá a linha a
   adicionar. Quando um perfil gerenciado pelo instalador a adiciona, a verificação passa e a execução diz uma só
   vez, nas linhas finais, que é preciso um terminal novo (também quando a versão já estava instalada).

Tudo certo: `Autoverificação (Claude Code)  ok  6 verificações passaram`; a lista dos shells aparece com
`--verbose`. Qualquer falha: a instalação continua no lugar, a linha diz `instalado, mas não funciona: 1 de 6
verificações falharam`, cada verificação que falhou tem sua linha seguida de `Correção: ...` com o comando ou a
edição exata, e o código de saída é 1. Exemplo:

```
Autoverificação (Claude Code)  falhou  instalado, mas não funciona: 1 de 6 verificações falharam
Comando (zsh)                  falhou  o zsh não encontra okit-plugin (código de saída 1)
Correção: Coloque /home/voce/.local/bin no PATH do zsh e rode: okit-plugin install --client claude-code
```

Faça o que a linha de Correção diz (é o comando ou a edição para aquela linha) e rode o instalador de novo;
as linhas puladas não pedem nada.

O que a verificação prova, e o que não prova. Os shells iniciam sem interação (nunca `-l` nem `-i`), mas um shell
ainda pode ler arquivos de inicialização que valem para toda partida (por exemplo `BASH_ENV`, `ENV` ou `~/.zshenv`),
então o resultado pode diferir de um terminal que você abre. No Windows, as formas de iniciar PowerShell, cmd e Git
Bash são provadas por testes que simulam a plataforma; o que só uma máquina Windows real prova fica na lista de
[provas da versão](docs/maintainers/RELEASING.pt-BR.md#proof-per-pair), e nada além disso é prometido aqui. Os shells, o limite de tempo de cada processo (`install.selfcheck.timeoutMs`)
as chaves copiadas do `config.json` e o exemplo enviado à barra de status ficam na parte `install.selfcheck` da configuração.

### Comando do Windows e scripts do PowerShell

No Windows o comando são dois atalhos na pasta do link. O PowerShell e o cmd.exe usam
`okit-plugin.cmd` (não precisa de uma política de execução que permita scripts); o Git
Bash usa o `okit-plugin` sem extensão, um pequeno script `sh` (fim de linha LF) que
converte os caminhos do Windows com `cygpath`, quando existe, e roda o plugin. A barra de
status do Claude Code executa o comando dela pelo Git Bash, então a entrada gravada por
`--statusline` usa o caminho absoluto desse atalho sem extensão. Instalar e atualizar
removem um `okit-plugin.ps1` que este plugin gravou numa versão anterior (um `.ps1`
que não é nosso fica como está) e reescrevem uma entrada antiga da barra de status que
usava o nome do comando solto; desinstalar remove os atalhos. Um arquivo com qualquer um
dos dois nomes que não seja nosso é preservado como qualquer comando alheio.
`okit-plugin env report` avisa quando o coletor está registrado mas ainda não recebeu nenhuma leitura.
Um comando existente de terceiros é preservado e faz o passo do comando e a
instalação falharem. Renomeie ou remova esse comando, ou escolha outra pasta em
`install.linkDirectory` na configuração, e tente novamente.

O instalador pode oferecer permitir scripts do PowerShell para o seu usuário
(`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`). Ele só pergunta quando a
política efetiva bloqueia scripts (Restricted, AllSigned ou Undefined), só num
terminal, e o padrão é Não. Sob uma política de grupo, nada é alterado e ele avisa.
Para desfazer: `Set-ExecutionPolicy -Scope CurrentUser Undefined`.
`--set-execution-policy` responde sim (sem perguntar); `--no-execution-policy` pula o
passo; as duas opções não podem ser combinadas, e a recusa explica isso no idioma
escolhido. Ambas também funcionam com `install.sh update` e `install.ps1 update`,
e são encaminhadas ao reinstalar a mesma versão por qualquer um dos scripts.

## Configuration

Cada valor do bloco marcado aceita `OKIT_<CHAVE>`: `REPO`, `API`, `CLIENTS`
(mapa JSON nome/executável), `NAME` (modelo do pacote), `COMMAND`, `MIN_NODE`,
`PACKAGE`, `MANIFEST`, `TAG_PREFIX`, `DIRECTORY`, `DEST`, `DATA_ROOTS`, `SYSTEMS`,
`ARCHITECTURES`, `FORMATS` (mapas JSON). `OKIT_CLIENT` escolhe o agente. Use o mesmo destino
nos comandos de manutenção. As configurações do núcleo ficam no `config.json`
sob `OKWORK_HOME`; os overrides de API do bootstrap valem para seu download;
`update` explícito usa a configuração do núcleo instalado.

### Kit de orquestração

Instale o kit separadamente conforme o guia de instalação da sua distribuição
do kit. Coloque o executável no PATH ou configure `install.kit.path` com o caminho
do arquivo. O plugin consulta somente a versão; nunca instala nem altera o kit.
O caminho identifica o executável, não as pastas de home/configuração do kit,
que não podem ser inferidas com segurança por essa consulta.

Execute `okit-plugin kit [--require]`. A linha `kit: …`, em inglês, informa `installed`,
`absent` ou `broken`. Apenas `--require` (ou `require: true` configurado) retorna 1
quando a consulta não confirma instalação. Install/update, inclusive `--dry-run`,
e status também imprimem a linha. Quando instalado, consulte as
[regras D1](docs/maintainers/ARCHITECTURE.md#kit-and-plugin-overlap-d1).

Em `OKWORK_HOME/config.json`, configure `install.kit`:
`executables: ["okit", "kit"]`, `path: null` (somente PATH),
`versionArgs: ["--version"]`, `timeoutMs: 3000`, `require: false`,
`hint` (instruções quando ausente) e `overlap` (referência D1).
O caminho configurado tem prioridade. Versão inválida, falha ou prazo excedido
resultam em `broken`; o processo de versão é morto no timeout.
O prazo deve ser inteiro positivo. Os valores complementam `DEFAULT_CONFIG.install`.

## Update

Atualize repetindo o comando rápido ou com `okit-plugin update`. `okit-plugin update --check`
consulta disponibilidade; `okit-plugin update --rollback` volta à versão retida.
Os scripts baixados também aceitam `update --check` e `update --rollback`:
localizam `install.json` e chamam o CLI instalado, sem baixar nada no shell.
`sh install.sh uninstall` / `./install.ps1 uninstall` fazem o mesmo.
`okit-plugin uninstall` preserva estado e configuração; `--purge --yes` apaga também
a raiz de estado configurada.

## Uninstall

Revise com `okit-plugin uninstall --dry-run`, depois execute `okit-plugin uninstall`. Para também apagar estado/configuração, use `okit-plugin uninstall --purge --yes`. Use a mesma raiz de estado e o destino registrado da instalação. Não há script separado de desinstalação; os scripts de instalação existentes encaminham a ação para o CLI.

## Manual installation

Instalação manual: baixe pacote e manifesto, confira SHA-256, extraia e rode
`node src/cli.js install --from . --client <nome>` nessa pasta. Sem `--from`,
`node src/cli.js install --client <nome>` baixa a última release.

O instalador Node suporta vários clientes na mesma máquina. `okit-plugin install --client all`
baixa e verifica um pacote separado para cada cliente detectado; o menu interativo
também aceita `1,3` ou `all`. `--client <nome>` altera só esse cliente.
`okit-plugin update`, `update --check`, `update --rollback` e `uninstall` agem em todos os
registrados por padrão; acrescente `--client <nome>` para selecionar um. Cliente não
registrado é recusado antes de alterações. Cada cliente tem versões retidas e smoke
próprios; uma falha permite que os demais terminem. O resumo lista cada resultado
(saída 0: todos passaram, 1: falha, 2: recusado antes de começar).

Uma só política de saída serve o comando instalado e os dois scripts de instalação (`src/install/exit.js`, `exitCodeFor`): sucesso e simulação saem com 0; falha do trabalho (nenhuma versão publicada, arquivo ausente, soma de verificação errada, erro de rede) sai com 1; erro de uso, de opção ou de idioma sai com 2. O idioma da execução é decidido primeiro (`--locale`, `OKIT_LANGUAGE`, idioma salvo, inglês), antes de qualquer opção ser analisada; assim `--help`, `status` e toda recusa, inclusive as de `install.sh` e `install.ps1`, falam um só idioma; toda linha passa pela porta que oculta segredos, então uma dica do kit com credenciais, consulta ou fragmento aparece sem eles. Isso vale também para o texto de uso (`--version`, nenhum argumento, comando ou ação desconhecidos). A classe de um erro é decidida só pelo seu `kind`: um erro que não diz nada é falha do trabalho (saída 1), então uma versão ou um arquivo ausente nunca é tomado por erro de uso, no comando instalado ou nos scripts. Toda recusa dos ajustes de `config.json` tem um código estável e seus parâmetros e aparece no idioma da execução, a partir de um só catálogo (`CONFIG_MESSAGES`). Um teste gerado (`test/install-matrix.test.js`) executa cada comando da tabela de uso em cada fonte de idioma e verifica que nenhuma linha mistura idiomas, que nenhuma credencial chega à saída e que o código de saída tem a classe da política; Toda configuração passa pelo esquema único (`src/config-schema.js`): um ajuste de `config.json` que não é válido (`install.timeoutMs` como `0`, como texto ou acima de 2147483647, um shell nulo, uma versão que não é texto num pacote de `--from`) é uma só recusa de uso, saída 2, que nomeia a chave e a regra no idioma da execução, com o arquivo intacto, em `install`, `update`, `uninstall`, `setup`, `kit`, `status` e `config`; `config set` de um valor inválido e `config get|unset` de uma chave desconhecida também saem com 2. Um teste gerado (`test/install-config-fuzz.test.js`) prova isso para toda chave do esquema; os comandos que mantêm a própria convenção bilíngue (`config`, `quota`, `telemetry`, `trajectory`) e os protocolos de máquina (`hook`, `statusline-collector`) estão listados ali com o motivo.

Os nomes dos registros vêm de `install.recordName`. O `install.json` antigo é lido
como registro do seu cliente e migrado na primeira escrita, mantendo toda a cadeia
de versões anteriores. Link, autostart e estado são compartilhados; remover um cliente
preserva os demais e redireciona caminhos compartilhados para um pacote restante.
A última desinstalação remove o link. `--purge --yes` é recusado se algum cliente
for permanecer. Todas as operações aceitam `--dry-run` sem gravar. Use o CLI Node para
esses comandos: os scripts de bootstrap permanecem localizando registros antigos
`install.json`.

Posso apagar a pasta depois? **SIM** com script ou `okit-plugin install --from`: o plugin
fica registrado no destino fixo. Na instalação manual direta com
`claude plugin marketplace add <pasta>`, **a pasta precisa ficar**.

SHA-256 detecta bytes alterados, mas **não autentica a origem**. Quem substituir
pacote e manifesto pode gerar hashes correspondentes. Confira o repositório,
leia o script e examine a procedência da release.

[English](INSTALL.md) · [Releases e provas](docs/maintainers/RELEASING.pt-BR.md)
