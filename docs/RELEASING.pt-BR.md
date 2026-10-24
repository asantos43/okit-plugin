# Desenho do release

Migração do comando: `bin` do pacote e `install.command` agora usam `okit-plugin`; instalar/atualizar migram links antigos `okit` próprios sem tocar no kit. Registros da 0.2.0 continuam aceitos; identidades MCP e estado permanecem iguais.

Status: publicado (veja a página de releases para a versão atual). Build, checksums, notas, checklist, publicador e instalador estão implementados; publicação não prova uso real.
Estende [ARCHITECTURE.md](ARCHITECTURE.md) e [SMOKE.md](SMOKE.md), incluindo o cenário D25 no cliente real. Inglês: [RELEASING.md](RELEASING.md).

## What a release is

Um candidato tem nove artefatos identificados separadamente por cliente × sistema, com a mesma revisão e versão do pacote. São pacotes de fontes Node, não executáveis autônomos: o Node deve atender a `package.json.engines.node`. O pacote é ESM, sem dependências e privado; publicar no registro npm não é a estratégia de instalação.

O payload compartilhado contém `src/`, `skills/` e o adaptador escolhido. Os três adaptadores existem. Por padrão, só Claude Code gera manifestos de plugin/marketplace, MCP e hook de compactação. Codex recebe instruções e adaptador; o instalador registra o marketplace e pede ativação em `/plugins`. opencode recebe o módulo global e as skills. Esses arquivos gerados não ficam na raiz do checkout.

## Per system

A tabela é requisito de empacotamento/prova, não afirmação de que todos os adaptadores funcionam. Os destinos vêm do escopo escolhido, configuração do cliente e home real; o estado vem de `OKWORK_HOME`/`stateRoot`. Nunca embutir o home do autor do build no artefato.

| Cliente | Linux | Windows | macOS |
| :- | :- | :- | :- |
| Claude Code | Raiz do plugin configurada; raiz do adaptador por opção explícita, `CLAUDE_CONFIG_DIR`, depois home. systemd do usuário ou cron explícito; LF, arquivos legíveis e CLI executável; link do bin configurado no PATH. | Mesma precedência de raiz com home nativo; schtasks no logon; preservar LF e caminhos substituídos com barras normais, arquivos legíveis e shim de comando configurado no PATH. Prova nativa pelo Produtor. | Mesma precedência de raiz com home nativo; agente launchd; LF, arquivos legíveis e CLI executável; link do bin configurado no PATH. Prova pelo Produtor. |
| Codex | Fonte de marketplace escolhida resolve raiz do plugin ([D-Q2](#decisions)); systemd do usuário ou cron explícito; LF, arquivos legíveis e CLI executável; link do bin configurado no PATH. Adaptador implementado; prova do par pendente. | Fonte de marketplace escolhida e home nativo ([D-Q2](#decisions)); schtasks; LF, escape de caminhos, arquivos legíveis e shim configurado no PATH. Adaptador implementado; Produtor prova par nativo. | Fonte de marketplace escolhida e home nativo ([D-Q2](#decisions)); launchd; LF, arquivos legíveis e CLI executável; link do bin configurado no PATH. Adaptador implementado; Produtor prova par. |
| opencode | Destinos globais de plugins e skills configurados ([D-Q3](#decisions)); systemd do usuário ou cron explícito; LF, arquivos legíveis e CLI executável; link do bin configurado no PATH. Adaptador implementado; prova do par pendente. | Resolver destinos globais no Windows nativo ([D-Q3](#decisions)); schtasks; LF, escape de caminhos, arquivos legíveis e shim configurado no PATH. Adaptador implementado; Produtor prova par nativo. | Resolver destinos globais no macOS nativo ([D-Q3](#decisions)); launchd; LF, arquivos legíveis e CLI executável; link do bin configurado no PATH. Adaptador implementado; Produtor prova par. |

`src/autostart.js` seleciona hoje systemd no Linux, schtasks no Windows e launchd no macOS. Cron é alternativa explícita, não fallback automático do systemd; o plano atual substitui o crontab do usuário e sua desinstalação o remove. Preservar linhas existentes do cron é requisito antes de oferecer esse caminho ([D-Q4](#decisions)).

Preservar UTF-8/LF na carga e nos logs em todos os sistemas. Conferir bits de execução POSIX após extração; no Windows conferir leitura por ACL e o shim no shell pretendido. Derivar nome e destino do comando de `package.json.bin` (hoje `okit-plugin`) e configurar o destino do link/shim ([D-Q4](#decisions)). Descoberta de plugin pelo cliente não estabelece PATH. Autostart deve resolver explicitamente caminhos do Node e da CLI instalados; o PATH do shell de login é insuficiente. Refazer o plano se a atualização mover a instalação.

## Artifacts

O build implementado usa os seguintes modelos de nomes. `P` é uma codificação segura para arquivos de `package.json.name`, `V` é sua `version`, `C`/`S` são identificadores de cliente/sistema da configuração de release e `A` é a arquitetura. Diretório de saída, formato/extensão `E`, codificação do nome e arquiteturas aceitas vêm da configuração conforme [D-Q5](#decisions); nunca rotular uma arquitetura como se cobrisse todas.

| Saída | Nome derivado | Conteúdo |
| :- | :- | :- |
| Carga por par (nove) | `<P>-<V>-<C>-<S>-<A>.<E>` | Metadados do pacote, licença, `src/` necessário, skills e adaptador selecionado, manifestos/configuração do cliente e instruções de instalação. Preservar caminhos relativos referenciados; excluir estado, credenciais e material só de desenvolvimento. |
| Manifesto de hashes | `<P>-<V>-checksums.sha256` | SHA-256 e nome exato de cada carga e metadados de marketplace, notas e checklist acompanhantes; exclui a si mesmo. Calcular sobre bytes finais após empacotar. |
| Notas | `<P>-<V>-release-notes.md` | Mudanças dessa versão no histórico da raiz, pré-requisitos, nomes por par, instalação/atualização, estado das provas e lacunas conhecidas. |
| Checklist de provas | `<P>-<V>-release-checklist.md` | Nove registros com revisão, hash, ambiente, comandos, códigos de saída e links das evidências. |

Nomes de arquivos de esquema de marketplace seguem os clientes, sob raízes de saída configuradas. As entradas devem resolver a carga/versão exata por par; seleção automática de sistema é **não verificada**, não presumida ([D-Q1 / D-Q2](#decisions)). Identidades e metadados de saída devem coincidir com `package.json`, incluindo `license`, `repository`, `bin` e `engines`; sem constante duplicada de versão. Nova versão é decisão do Produtor, não deste documento.

As notas vêm do histórico de mudanças mantido à mão na raiz em `CHANGELOG.md`, na seção `[Unreleased]`. O comando de notas extrai essa seção preservando o texto; não criar outro histórico nem pasta de fragmentos. Manter as entradas mais novas primeiro dentro de cada categoria.

O manifesto de hashes é escrito e conferido por `src/release/checksums.js`, conduzido por `scripts/checksums.js` (`npm run release:checksums -- write|verify`). Uma linha por arquivo traz o digest SHA-256 minúsculo, dois espaços e o nome exato, ordenadas por nome, LF e UTF-8, calculados sobre os bytes finais do arquivo sem mantê-lo em memória; o manifesto nunca carrega o próprio hash. A verificação recusa arquivo alterado, ausente ou não listado, linha malformada e caminho inseguro.

Fluxo do usuário: obter par e manifesto de hashes da página de releases do GitHub ([D-Q5](#decisions)), verificar SHA-256 antes de extrair, conferir Node contra engines do pacote, extrair no destino configurado e seguir instruções do par. Configurar link/shim do bin, MCP, skills e autostart conforme aplicável; depois provar instalação. SHA-256 detecta bytes alterados; não autentica a origem do download ([D-Q5](#decisions)).

Para Claude Code, o instalador registra o marketplace e chama instalação/atualização pelo cliente. Para Codex, registra a fonte e pede ativação por `/plugins`. Para opencode, instala o módulo global e copia as skills, preservando arquivos diferentes; não configura MCP separadamente. A prova por eventos nativos continua pendente ([D-Q3](#decisions)).

Antes de atualizar, parar daemon anterior, guardar backup do estado configurado e skills/hooks editados, verificar nova carga, trocar referências do cliente e registro no PATH, regenerar caminhos de autostart movidos, reiniciar e repetir provas. Instaladores atuais recusam skills divergentes e preservam entradas de hooks do usuário: não prometer sobrescrita na atualização. Fazer backup do estado e dos skills editados pelo usuário e permitir volta à versão anterior ([D-Q6](#decisions)).

## Installer and updater

`okit-plugin install --client <cliente> [--prerelease] [--repo dono/repo] [--dest pasta] [--no-link] [--autostart] [--dry-run] [--yes]` escolhe a release mais recente e o arquivo do cliente/sistema/arquitetura. Sem release estável, informa o uso de pré-lançamento. Sem `--client`, oferece menu no TTY; sem TTY só escolhe quando há exatamente um cliente detectado.

Após verificar o SHA-256, coloca o pacote em uma pasta estável por versão no diretório de dados do usuário (XDG no Linux, Application Support no macOS, LOCALAPPDATA no Windows). Cada `install.<client>.json` registra as versões ativa e anteriores desse cliente; o nome vem de `install.recordName`. O `install.json` antigo é lido como registro do seu cliente e migrado na primeira escrita, preservando toda a cadeia anterior. Registro e link apontam para esse destino: pode apagar a pasta de download/extração. `DEFAULT_CONFIG.install` e `config.json` configuram rede, limites, clientes, executáveis, diretórios e identidades; o nome do pacote reutiliza `release.name`.

`okit-plugin install --client all` baixa e verifica um pacote separado para cada cliente detectado. O menu interativo aceita vários números (`1,3`) ou `all`. `--client <cliente>` altera só esse cliente. Update, consulta, rollback e uninstall agem em todos os registrados por padrão e aceitam `--client <cliente>`; cliente não registrado é recusado antes de alterações. Cada cliente mantém seu histórico e executa smoke próprio no update. Uma falha não impede os demais; o resumo final lista cada resultado (0: todos passaram, 1: alguma falha, 2: recusado antes de começar).

Link, autostart e estado são compartilhados, com dados compartilhados em cada registro. Uninstall remove só o registro e as pastas retidas do cliente selecionado; caminhos compartilhados passam a um pacote restante e o link só é removido com o último cliente. `--purge --yes` recusa se algum cliente for permanecer. Para esse formato use o CLI Node: os scripts de bootstrap permanecem localizando registros antigos `install.json`.

`okit-plugin update --check` só consulta. `okit-plugin update` para o daemon, copia estado e configuração do cliente para backup datado, mantém a versão anterior, refaz registro/link/autostart, reinicia e executa o smoke da nova CLI. Se a prova falhar, informa `okit-plugin update --rollback`, que reativa a versão mantida sem baixar novamente. Skills e módulos editados são preservados. `okit-plugin uninstall` desfaz a integração e remove versões gerenciadas, mantendo estado e configuração; `--purge --yes` também remove a raiz de estado configurada. Os três aceitam `--dry-run`: consultam metadados quando necessário, sem baixar pacotes nem gravar.

SHA-256 detecta bytes alterados, mas **não autentica a origem**. A extração tar.gz/zip usa apenas Node, preserva execução, limita o tamanho descomprimido e recusa caminhos absolutos, travessia, links e arquivos especiais.

Os guias [INSTALL.pt-BR.md](../INSTALL.pt-BR.md) e [INSTALL.md](../INSTALL.md) documentam `install.sh` (Linux/macOS) e `install.ps1` (Windows). Ambos incorporam o bootstrap de `src/install/bootstrap.js`; o build deriva os blocos marcados de configuração dos defaults install/release e de engines.node. Cada chave aceita override `OKIT_`; o teste de deriva recusa scripts desatualizados após mudança dos defaults.

O build emite `release.publish.bootstrapAttachments`: scripts e guias fora dos arquivos por par. Eles entram no grupo existente `payloads` de `release.publish.attachments`; o publicador os inclui no manifesto, verifica e anexa sem mudança em publish.js. `okit-plugin install --from <pasta>` valida identidade e CLI, copia a origem já verificada ao destino fixo e preserva a origem. O bootstrap confere SHA-256 com ferramentas do sistema antes da extração; o hash não autentica o conteúdo. `update|uninstall` explícitos no script chamam o CLI registrado sem downloads no bootstrap. Linux foi exercitado pelo Diretor; Windows/macOS aguardam o Produtor.

## The local build

O PR 1 é o script `scripts/build-release.js`, também `npm run release:build`. Ele monta as cargas dos pares na máquina que o executa, grava-as na pasta de saída e não publica nada: sem tag, sem envio, sem rede. Os valores que ele usa — os clientes, os sistemas, as arquiteturas, o formato de arquivo por sistema, a pasta de saída, os arquivos que entram no pacote, os nomes de arquivo exigidos pelo cliente e o modelo de nome — estão no bloco `release` do `DEFAULT_CONFIG`, e a configuração do usuário pode substituí-los.

```
node scripts/build-release.js [--out <dir>] [--pair <cliente>:<sistema>] [--arch <arquitetura>] [--dry-run]
```

| Flag | O que faz |
| :- | :- |
| `--out <dir>` | Grava os arquivos em `<dir>`. Sem ela, vão para a pasta de saída configurada, sob o repositório. |
| `--pair <cliente>:<sistema>` | Monta só esse cliente e esse sistema, por exemplo `claude-code:linux`. Sem ela, monta todos os pares configurados. |
| `--arch <arquitetura>` | Monta só essa arquitetura, por exemplo `x64`. Sem ela, monta todas as arquiteturas configuradas. |
| `--dry-run` | Lista os pares que montaria e os que recusa, sem gravar nada. |

O nome de cada arquivo é o modelo de nome da configuração preenchido com o nome do pacote, a versão, o cliente, o sistema, a arquitetura e a extensão, ou seja `<P>-<V>-<C>-<S>-<A>.<E>`: `okit-plugin-0.1.0-claude-code-linux-x64.tar.gz`. O nome, a versão, a licença, o repositório, o bin e os engines vêm de `package.json`; a carga leva os metadados do pacote, a licença, o `src/` necessário, as skills, o adaptador do cliente escolhido, os metadados do cliente e as instruções de instalação dos clientes que a configuração nomeia, e nunca o estado, as credenciais, `.git`, `.delegate`, `test/` ou o material só de desenvolvimento.

Os arquivos são determinísticos: as entradas são ordenadas, a data de modificação é `SOURCE_DATE_EPOCH` ou a data do commit, os modos são explícitos (`0755` para o comando do pacote, `0644` para o resto) e as linhas terminam em LF. Duas construções da mesma fonte produzem os mesmos bytes.

Um par que não pode ser montado é recusado com a razão, e nenhum pacote vazio é gravado no lugar: um cliente cujo adaptador falta, um cliente ou sistema desconhecido, um sistema sem formato de arquivo. Um cliente que tem adaptador é montado, como qualquer outro; os três adaptadores de cliente deste repositório (`claude-code`, `codex` e `opencode`) montam seus pares. O comando então lista os pares recusados e responde com um código diferente de zero.

## Release notes

O PR 3 é `scripts/release-notes.js`, também `npm run release:notes -- [flags]`:

```sh
node scripts/release-notes.js [--out <dir>] [--version <version>] [--dry-run]
```

| Flag | Efeito |
| :- | :- |
| `--out <dir>` | Grava notas aqui; o padrão é a pasta de saída configurada do release, sob o repositório. |
| `--version <version>` | Deve coincidir com `package.json.version`; o padrão é essa versão. |
| `--dry-run` | Lista o destino das notas e cada nome de arquivo por par, sem gravar. |

Os textos, modelo de nome e caminho do histórico de `release.notes` combinam-se com os metadados do pacote e o plano de pares do build. A saída determinística inclui engines do Node, os nove nomes de cargas, nome do manifesto, instalação/atualização e provas e lacunas de cada par. Sem registro de provas, todos são `not proven` (não provado); Windows/macOS são do Produtor. O opcional `release.notes.proofFile` aponta para um objeto JSON relativo ao repositório com chaves `client:system` e valores `not proven`, `proven` ou `PARCIAL` (ou os rótulos configurados). Prova parcial sempre permanece nas lacunas.

Histórico ausente, `[Unreleased]` ausente ou vazio (só subtítulos/comentários não contam), versão divergente ou prova inválida recusa com razão e não grava saída. As linhas preservam texto e espaços. O comando não publica nem calcula hashes das notas; calcular hashes de notas/checklist somente após finalizar os registros, usando o comando de checksums.

## Release checklist

O PR 4 é `scripts/release-checklist.js`, também `npm run release:checklist -- [flags]`:

```sh
node scripts/release-checklist.js [--out <dir>] [--version <version>] [--revision <revision>] [--dry-run]
```

| Flag | O que faz |
| :- | :- |
| `--out <dir>` | Grava o checklist aqui; o padrão é a pasta configurada de saída do release. |
| `--version <version>` | Deve coincidir com `package.json.version`; usa essa versão por padrão. |
| `--revision <revision>` | Registra a revisão conferida; sem a flag, deixa em branco para preencher. |
| `--dry-run` | Lista destino e nomes dos nove pares configurados sem gravar. |

`release.checklist` configura modelo de nome, título, campos, textos das camadas e linha de assinatura. Os assinantes herdam `release.notes.proofBy`, com substituições opcionais em `release.checklist.proofBy`; são lidos o mesmo JSON opcional de prova e os mesmos rótulos de estado das notas. Cada par do build recebe uma seção desmarcada com ambiente, instalação/atualização, ambas as camadas de smoke, campos explícitos de salto/driver ausente e locais das evidências. Windows/macOS exigem assinatura do Produtor. O comando prepara registros; não executa smoke nem publica.

Os SHA-256 dos payloads vêm do manifesto de checksums na pasta de saída quando presente; caso contrário ficam em branco. Nenhum hash é calculado aqui: calcular hashes de notas/checklist só após finalizar. Versão divergente, par/prova/manifesto inválido ou checklist existente com conteúdo diferente recusa com razão e não grava nada. Repetições idênticas são permitidas; não existe `--force`, preservando provas preenchidas. Guardar registros concluídos em `docs/`, conforme D-Q7.

## Publishing — Publicação

```sh
npm run release:publish -- [--dry-run] [--out <dir>]
npm run release:publish -- --publish [--out <dir>]
```

Dry-run é o padrão: prepara arquivos locais e imprime título, tag, SHA alvo, estado de pré-lançamento, anexos exatos e comando `gh` completo com escape para shell; não cria tag nem release. Ambos os modos exigem árvore limpa, fazem fetch de `origin/main`, comparam HEAD com essa revisão e recusam tag local ou remota existente. Fetch e consulta remota de tag exigem rede; só `--publish` publica. Executar de um checkout com alterações já commitadas.

O comando reutiliza o build dos nove pares, escreve manifesto das cargas, gera notas e checklist (com hashes das cargas e SHA da revisão), escreve o manifesto final cobrindo cargas, notas e checklist e o verifica. Pares/versões recusados, provas inválidas, checklist alterado e falhas nos checksums impedem publicação. Só a lista gerada é anexada; arquivos estranhos na saída fazem a verificação recusar.

`release.publish` em `DEFAULT_CONFIG`, sobrescrevível pelo `config.json`, configura executável GitHub (`executable: 'gh'`), executável git (`gitExecutable: 'git'`), remoto (`remote: 'origin'`), branch (`branch: 'main'`), mínimo de pares cliente × sistema (`requiredPairs: 9`), prefixo da tag, modelo de título, pasta de saída e grupos de anexos (`payloads`, `notes`, `checklist`, `checksums`). Remotos HTTPS mantêm sua URL sem credenciais; remotos SSH/scp como `git@host:owner/repo.git` viram `host/owner/repo`. Caminhos locais e URLs de remoto não suportadas recusam antes do build. Nome/versão vêm de `package.json` (D-Q6: 0.1.0). Usar pasta própria por candidato; provas concluídas ficam em `docs/`, conforme D-Q7.

Com `--publish`, os arquivos verificados vão para `gh release create` com tag, repositório configurado, SHA alvo, título e arquivo separado do corpo (`--notes-file`), com `--` antes dos caminhos dos anexos. `release.publish.prerelease` tem padrão `never`: release completa elegível a Latest na área de releases do repositório. `always` sempre passa `--prerelease`; `auto` passa quando o total de pares distintos cliente × sistema for menor que `requiredPairs` ou algum par não tiver o rótulo provado em `release.notes.proofFile`. Modos inválidos recusam antes do build. Reduzir clientes/sistemas não reduz esse mínimo.

`release.publish.latest: true` passa `--latest` explicitamente nas releases completas, tornando a release padrão Latest sem edição manual. Definir como `false` deixa a seleção de Latest para o GitHub; pré-lançamentos nunca recebem `--latest`.

Sempre que essa condição de prova/contagem ocorrer, em qualquer modo, `unprovenNotice` aparece no topo do corpo, seguido das notas da release. O padrão em inglês informa que alguns pares cliente/sistema ainda não foram provados e aponta para a tabela de prova nas notas. As notas anexadas mantêm sua tabela de prova sem esse aviso. `bodyDir: 'body'` e `bodyFile: '{package}-{version}-release-body.md'` configuram subpasta separada e nome com os mesmos marcadores de pacote/versão das notas; o corpo não é anexo nem entra nos checksums. Caminhos inseguros do corpo e arquivos não regulares recusam. O comando não estabelece prova em cliente real.

O padrão configurável `safeName` valida `remote`, `branch`, `executable` e `gitExecutable` antes de qualquer comando: os valores padrão rejeitam hífen inicial, espaços e controles. Posicionais do git seguem `--`; `rev-parse` usa `--verify --end-of-options` porque `--` isolado muda para saída de caminhos. Tanto no dry-run quanto na publicação, a saída dentro do repositório deve ser ignorada pelo git; caso contrário, adicionar a pasta ao `.gitignore` ou escolher `--out` fora do repositório. A recusa ocorre antes do build.
Imediatamente antes de chamar o GitHub, o git é verificado novamente: árvore suja (incluindo alterações geradas em caminhos de saída versionados), SHA alterado ou tag existente recusa publicação. `SAFE_TAG` restringe a tag montada a um componente de ref Git iniciado por letra, dígito ou sublinhado, seguido por letras, dígitos, pontos, sublinhados, sinais de mais ou hífens; pontos consecutivos, ponto final e sufixo `.lock` são proibidos. `GIT_TAG_NAMESPACE` nomeia o prefixo de protocolo Git `refs/tags/`. Falhas após iniciar o GitHub retornam código diferente de zero com `publish failed (the release may be partly created): tag <tag>: <erro>`; inspecionar o release remoto antes de repetir. Recusas de validação mantêm `refused: …`.

## Proof per pair

Cada marca significa **ambas** as camadas no candidato instalado daquele par: `okit-plugin smoke` (em processo, home temporário) e cenário D25 dentro do cliente real indicado, carregando a instalação real com login/estado reais. `--dry-run`, ensaio e spawns simulados não provam uso real. `okit-plugin client-smoke` está implementado para Claude Code; veja [SMOKE.pt-BR.md](SMOKE.pt-BR.md#in-client-smoke-real). Os demais drivers reais estão pendentes. Manter cada par desmarcado até registrar e aceitar ambas as camadas.

| Checklist por par | Quem executa e assina ambas as camadas |
| :- | :- |
| [ ] Claude Code × Linux | Máquina Linux do Diretor ([D-Q7](#decisions)) |
| [ ] Claude Code × Windows | Produtor na máquina Windows nativa |
| [ ] Claude Code × macOS | Produtor na máquina macOS |
| [ ] Codex × Linux | Máquina Linux do Diretor ([D-Q7](#decisions)) |
| [ ] Codex × Windows | Produtor na máquina Windows nativa |
| [ ] Codex × macOS | Produtor na máquina macOS |
| [ ] opencode × Linux | Máquina Linux do Diretor ([D-Q7](#decisions)) |
| [ ] opencode × Windows | Produtor na máquina Windows nativa |
| [ ] opencode × macOS | Produtor na máquina macOS |

Registrar por linha: responsável/data; revisão; versão do pacote; arquivo e SHA-256; sistema/versão/arquitetura; versões de Node/cliente; escopo; caminhos resolvidos de plugin/configuração/estado/bin; passos de instalação e atualização do candidato anterior; verificações de PATH e permissões; resultado de autostart show/install/reinício; ambos os comandos smoke, saídas, totais e motivos; locais de JSONL/log e revisão do cenário D25. Anexar arquivos ou links duráveis, não só “funcionou”. Nunca publicar credenciais. Instalação nova e atualização devem preservar configuração e estado do usuário, inclusive após reiniciar cliente.

Prova em processo exige saída 0 e todos os checks selecionados passando; no release usar conjunto completo. D25 exige C1–C5 passando, nenhuma falha e registro explícito de cada check posterior. Sua saída 0 ainda pode significar `PARCIAL`; falta de prova de hook impede passar o gate de instalação. Configuração ausente significa instalação incompleta. Manter linha com skip/parcial não resolvido desmarcada até aceite escrito do Produtor ([D-Q7](#decisions)); resultado sintético ou ausente não preenche outro par.

## Decisions

1. Release separado para Claude Code, Codex e opencode, em Linux, Windows e macOS: os nove pares continuam no escopo.
2. Build local. GitHub Actions não executa o release sozinho.
3. Cortar tag ou publicar só quando o Produtor pedir explicitamente; preparar candidatos é separado de cortar release.
4. Derivar versões, nomes e caminhos de `package.json` e configuração; sem constantes fixas do projeto no desenho ou na futura implementação.
5. D26 é só documentação: sem código, script, dependência, tag, publicação ou alteração de `SMOKE.md`.
6. **D-Q1 — Claude Code:** usar o marketplace do projeto no GitHub (`asantos43/okit-plugin`), escopo de usuário e uma entrada por sistema.
7. **D-Q2 — Codex:** usar o manifesto portátil (`plugin.json` na raiz), no mesmo marketplace e na mesma versão do Claude Code; validar contra o Codex real instalado.
8. **D-Q3 — opencode:** instalar módulo JS global em `~/.config/opencode/plugins/`; provar o hook do D25 pelos eventos do próprio opencode, sem supor o formato de hook do Claude.
9. **D-Q4 — Integração na máquina:** obter destinos do bin/shim e identidades do autostart da configuração, sem constantes no código; o cron preserva as linhas existentes.
10. **D-Q5 — Saída:** usar `.tar.gz` no Linux e no macOS, `.zip` no Windows, uma carga por arquitetura, com nome `<P>-<V>-<C>-<S>.<E>` e manifesto SHA-256; baixar da página de releases do GitHub.
11. **D-Q6 — Ciclo de vida:** começar em `0.1.0`, manter o pacote privado (sem npm); antes de atualizar, fazer backup do estado e dos skills editados pelo usuário, com volta atrás para a versão anterior.
12. **D-Q7 — Provas:** o Produtor verifica Windows e macOS; o Linux fica com a máquina do Diretor. Guardar os registros de prova em `docs/` deste repositório; um pulo parcial do smoke exige aceite escrito do Produtor.

## Open questions

Não há perguntas em aberto: Q1 a Q7 foram respondidas pelo Produtor em 2026-10-23.

## Implementation status

Build local, checksums, notas, checklist e publicação explícita estão implementados em `src/release/`, com scripts em `package.json`. Instalação, atualização, backup e rollback ficam em `src/install/`. Novos candidatos precisam de provas próprias: mudar versão ou payload invalida o hash anterior.
