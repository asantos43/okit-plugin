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
4. A instalação e as atualizações salvam as escolhas de modelos ativos encontrados, limites de ajudantes, fontes de cota e o cliente em uso, preenchendo apenas ajustes ausentes. Suas escolhas salvas são mantidas. Abra um terminal novo e reinicie o cliente de IA para encontrarem o comando instalado. Execute `okit-plugin setup` para revisar as escolhas restantes; cada pergunta explica uma recomendação. Se nenhum modelo ativo for detectado, siga [modelos e cota](models-and-quota.pt-BR.md).
5. Execute `okit-plugin env report --locale pt-BR`. Espere o cliente, modelos ativos confirmados, cota, vagas livres para ajudantes e pastas. Itens desconhecidos continuam desconhecidos e incluem instruções de correção.

O instalador também registra o servidor MCP do plugin, chamado `okit`, no Claude Code e no Codex com o próprio comando de cada cliente (`claude mcp add --scope user okit -- node <instalação>/src/mcp/server.js` / `codex mcp add okit -- node <instalação>/src/mcp/server.js`). O OpenCode ainda não é registrado pelo instalador. Ele lê a entrada antes: uma que já é nossa fica como está, uma que aponta para a versão substituída é trocada, e uma entrada chamada `okit` que não é nossa é mantida com um aviso. Uma entrada que o cliente mostra em outro escopo que não o configurado também é tratada como não nossa e é mantida, mesmo quando os argumentos dela nomeiam nosso caminho. Se o cliente recusar, a instalação continua e o aviso mostra o comando para rodar à mão; se o cliente não estiver na máquina, os mesmos comandos aparecem com os outros passos manuais. Uma entrada que o cliente não consegue ler (o cliente falha, estoura o tempo ou responde outra coisa) também é um aviso: nada é escrito, porque a entrada do cliente pode não ser nossa. Rode o instalador de novo para tentar de novo: uma instalação que já está lá lê sua entrada e a adiciona quando ela falta. Os comandos do cliente rodam a partir da pasta temporária do sistema, então a configuração de um projeto nunca é lida nem alterada.

No Claude Code, execute `okit-plugin update --client claude-code --statusline` após instalar para ativar a coleta de cota preservando a barra anterior. Espere uma prévia dos ajustes; `--no-statusline` recusa a coleta. Durante a instalação, o terminal pergunta e instalações sem terminal pulam a coleta. Os scripts baixados não aceitam essas duas opções da barra; use o comando instalado.

O instalador imprime os mesmos passos numerados no Linux, no macOS e no Windows, em um só idioma (`--locale en` ou `--locale pt-BR`, depois `OKIT_LANGUAGE`, depois o idioma salvo), e termina com os próximos passos e o comando exato a rodar. Use `--verbose` para ver também os comandos que ele executa. No Windows o comando é um atalho `okit-plugin.cmd` para o PowerShell e o cmd.exe mais um atalho sem extensão para o Git Bash (o shell pelo qual a barra de status do Claude Code roda), e o terminal pode perguntar, com padrão Não, se deve permitir scripts do PowerShell para o seu usuário; `--set-execution-policy` responde sim e `--no-execution-policy` pula a pergunta. Ambas também funcionam com o `update` dos scripts. Um comando alheio é preservado, mas faz a instalação falhar com instruções de correção. A escolha de modelos só é oferecida após sucesso, nunca em dry-run ou `update --check`. Veja [INSTALL.pt-BR.md](../../INSTALL.pt-BR.md#o-que-o-instalador-imprime).

Um ajuste de `config.json` que não é válido (por exemplo `install.timeoutMs` com `0` ou com texto) é recusado por todo comando com saída 2, uma linha que nomeia o ajuste e a regra (`install.timeoutMs inválido: um inteiro de 1 a 2147483647`) e o arquivo intacto; corrija o valor, ou apague-o para usar o padrão.

Instalar/atualizar pode editar perfis do terminal ou o PATH do usuário no Windows; `--no-path` pula isso. O download verifica SHA-256 contra bytes alterados; isso não autentica a origem. A comprovação no cliente real varia por sistema: veja [provas da versão](../maintainers/RELEASING.pt-BR.md#proof-per-pair).

[Depois: pedir ao Diretor](ask-the-director.pt-BR.md) · [Guia](README.pt-BR.md) · [English](install.md)
