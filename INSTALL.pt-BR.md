# Instalar e atualizar

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
`install.json`, registra o cliente, cria o link de comando e opcionalmente
configura autostart. Atualizações guardam backup e versão anterior, ativam a nova
e rodam `okit smoke`. O temporário é apagado em sucesso e falha.
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

## Update

Atualize repetindo o comando rápido ou com `okit update`. `okit update --check`
consulta disponibilidade; `okit update --rollback` volta à versão retida.
Os scripts baixados também aceitam `update --check` e `update --rollback`:
localizam `install.json` e chamam o CLI instalado, sem baixar nada no shell.
`sh install.sh uninstall` / `./install.ps1 uninstall` fazem o mesmo.
`okit uninstall` preserva estado e configuração; `--purge --yes` apaga também
a raiz de estado configurada.

## Uninstall

Revise com `okit uninstall --dry-run`, depois execute `okit uninstall`. Para também apagar estado/configuração, use `okit uninstall --purge --yes`. Use a mesma raiz de estado e o destino registrado da instalação. Não há script separado de desinstalação; os scripts de instalação existentes encaminham a ação para o CLI.

## Manual installation

Instalação manual: baixe pacote e manifesto, confira SHA-256, extraia e rode
`node src/cli.js install --from . --client <nome>` nessa pasta. Sem `--from`,
`node src/cli.js install --client <nome>` baixa a última release.
Posso apagar a pasta depois? **SIM** com script ou `okit install --from`: o plugin
fica registrado no destino fixo. Na instalação manual direta com
`claude plugin marketplace add <pasta>`, **a pasta precisa ficar**.

SHA-256 detecta bytes alterados, mas **não autentica a origem**. Quem substituir
pacote e manifesto pode gerar hashes correspondentes. Confira o repositório,
leia o script e examine a procedência da release.

[English](INSTALL.md) · [Releases e provas](docs/RELEASING.pt-BR.md)
