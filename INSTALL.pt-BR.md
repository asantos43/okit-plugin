# Instalar e atualizar

Cada pacote de cliente inclui todos os adaptadores de execução por padrão, para
que `status` carregue todos os clientes. `release.sharedAdapters: null` herda os
caminhos de `release.adapters`; uma lista explícita substitui a seleção compartilhada.
O adaptador do cliente selecionado continua obrigatório; pacotes personalizados
devem manter todos os adaptadores importados por `src`.

O comando do plugin agora é `okit-plugin` (configurável em `install.command`); o kit mantém `okit`/`kit`. Instalar/atualizar migram apenas links `okit` do próprio plugin; desinstalar também os remove. Registros da 0.2.0 continuam legíveis; executáveis alheios do kit são preservados.

## Install

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
`--no-link`, `--autostart`. Dry-run mostra release, arquivo e destino, sem baixar
o pacote nem gravar no destino. Repetir o comando atualiza a instalação registrada;
na mesma versão, informa “up to date”.

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
[regras D1](docs/ARCHITECTURE.md#kit-and-plugin-overlap-d1).

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

[English](INSTALL.md) · [Releases e provas](docs/RELEASING.pt-BR.md)
