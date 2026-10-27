# Instalar e começar

![okit-plugin: Guia do usuário](../images/banners/guide.svg)

Instale o plugin para seu cliente de IA e confirme que ele consegue ver seu ambiente.

<a id="install"></a>
## Instalar

1. Execute `node --version`. Espere `v20` ou mais recente; instale o [Node.js](https://nodejs.org/) se necessário. Tenha Claude Code, Codex ou opencode instalado e com login feito.
2. Baixe o instalador da [versão](https://github.com/asantos43/okit-plugin/releases/latest) desejada e leia antes de executar. No Linux/macOS:

   ```sh
   curl -fLO https://github.com/asantos43/okit-plugin/releases/latest/download/install.sh
   ```

   Espere `install.sh` na pasta atual. No PowerShell do Windows:

   ```powershell
   Invoke-WebRequest https://github.com/asantos43/okit-plugin/releases/latest/download/install.ps1 -OutFile install.ps1
   ```

   Espere `install.ps1` na pasta atual.
3. Nessa pasta, execute `sh install.sh --client codex` no Linux/macOS ou `./install.ps1 --client codex` no PowerShell. Troque `codex` por `claude-code` ou `opencode` para seu cliente. Espere um pacote verificado, um destino de instalação e um resumo do registro. Siga as instruções de ativação do cliente impressas pelo instalador; no Codex, a ativação usa `/plugins`.
4. Abra um terminal novo e reinicie o cliente de IA para encontrarem o comando instalado. Se apareceu um comando de ativação, você pode executá-lo no terminal atual. Execute `okit-plugin setup`; espere as escolhas de modelos detectadas e a confirmação antes de salvar. Se nenhum modelo ativo for detectado, siga [modelos e cota](models-and-quota.pt-BR.md).
5. Execute `okit-plugin env report --locale pt-BR`. Espere o cliente, modelos ativos confirmados, cota, vagas livres para ajudantes e pastas. Itens desconhecidos continuam desconhecidos e incluem instruções de correção.

No Claude Code, execute `okit-plugin update --client claude-code --statusline` após instalar para ativar a coleta de cota preservando a barra anterior. Espere uma prévia dos ajustes; `--no-statusline` recusa a coleta. Durante a instalação, o terminal pergunta e instalações sem terminal pulam a coleta. Os scripts baixados não aceitam essas duas opções da barra; use o comando instalado.

Instalar/atualizar pode editar perfis do terminal ou o PATH do usuário no Windows; `--no-path` pula isso. O download verifica SHA-256 contra bytes alterados; isso não autentica a origem. A comprovação no cliente real varia por sistema: veja [provas da versão](../maintainers/RELEASING.pt-BR.md#proof-per-pair).

[Depois: pedir ao Diretor](ask-the-director.pt-BR.md) · [Guia](README.pt-BR.md) · [English](install.md)
