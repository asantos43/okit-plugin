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

### Comando do Windows e scripts do PowerShell

No Windows o comando é só o atalho `okit-plugin.cmd`; o PowerShell também o encontra e
não precisa de uma política de execução que permita scripts. Instalar e atualizar
removem um `okit-plugin.ps1` que este plugin gravou numa versão anterior (um `.ps1`
que não é nosso fica como está); desinstalar remove os dois.
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
