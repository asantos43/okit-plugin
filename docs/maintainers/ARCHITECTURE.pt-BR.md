# Arquitetura

![okit-plugin: Manutenção](../images/banners/maintainers.svg)

Contratos e invariantes do núcleo para persistência, agendamento, adaptadores e execução.

<a id="contents"></a>
## Índice

- [1. Core contract](#section-1)
- [2. MCP tools](#section-2)
- [3. State on disk](#section-3)
- [4. Adapter interface](#section-4)
- [5. Quota](#section-5)
- [6. Windows rules](#section-6)
- [7. Concurrency limit](#section-7)
- [8. Schedules and recurrence](#section-8)
- [9. Recurring templates](#section-9)
- [10. Standing orders](#section-10)
- [11. The daemon](#section-11)
- [12. Spawn modes](#section-12)
- [13. Autonomy](#section-13)
- [14. Global state and `appliesTo`](#section-14)
- [15. Implementation and limits](#section-15)
- [Operational reference](#section-16)

`src/install/statusline.js` planeja, aplica e desfaz o registro da barra do Claude com sistema de arquivos injetável. O registro por cliente guarda caminho dos ajustes, hash dos bytes escritos e caminho da cópia no estado do plugin. O comando anterior vira palavras ou usa `statuslineRegistration.shell[platform]`; os demais campos da barra são preservados. Atualizações autorizadas reparam coletor ausente ou comando do plugin alterado; coletor existente sem registro de posse fica intacto. A desinstalação restaura os bytes originais quando o hash confere; caso contrário, altera só a barra que pertence ao plugin. Modos de checagem não escrevem.

`src/install/mcp-register.js` registra o servidor MCP do plugin no cliente em que ele instala, pelos comandos `mcp` do próprio cliente (`mcp get`, `mcp add`, `mcp remove`), nunca escrevendo a configuração do cliente. A entrada é a que `install.mcp.name` nomeia (`okit`) e o arquivo é `install.mcp.server` dentro da instalação; o cliente decide o escopo (`install.clients.<client>.mcp.scope`). A entrada que o cliente tem é lida primeiro: uma entrada que aponta para esta instalação é deixada como está, uma que aponta para a instalação que esta substitui é tirada e escrita de novo, e uma que não é nossa é mantida com um aviso. A desinstalação tira a nossa entrada antes de remover o plugin para onde ela aponta. Uma falha do passo é um aviso, nunca uma falha da instalação; a simulação mostra o plano e não roda nada.

A CLI usa `install.command` (padrão `okit-plugin`) e o `bin` do pacote. Links antigos do plugin migram ao instalar/atualizar; links do kit são preservados. O detector rejeita executáveis do plugin, inclusive links antigos `okit`. A identidade MCP e `~/.okwork` permanecem iguais.

Estende [DESIGN.md](DESIGN.md); responde às perguntas em aberto. Um núcleo em Node (>=20, sem dependências), três adaptadores finos, um servidor MCP sobre o núcleo.

<a id="section-1"></a>
## 1. Core contract

`src/smoke/demo/index.js` compõe classificador, seleção de atores do instantâneo, perfis, inbox e funções de vagas existentes em uma árvore temporária isolada. Módulos pequenos de cenário, tentativa, agendador, orçamento e relatório implementam a [demonstração injetada](DEMO.pt-BR.md); cada tentativa de executor/crítico reserva vaga e orçamento. CLI/MCP/skill e consentimento estão implementados; lançamentos pagos recusam sem medição e teto comprovados; C1–C23 preservam seu significado atual.

O inbox guarda demandas com `id`, `title`, `body`, `kind`, `accept`, `effort`, `client`, `appliesTo`, `status`, `stepIds`, `ext`, `createdAt`. `kind` é texto livre. Ordens ficam em um único arquivo, filtradas por `appliesTo`. Briefing, crítica e consolidação são instruções das skills e não APIs adicionais do núcleo.

<a id="section-2"></a>
## 2. MCP tools

Consulte a referência: [mcp-tools](../components/mcp-tools.pt-BR.md).

`src/env/report.js` centraliza as leituras de ambiente.

Itens podem ter `hold: {client, session, worktree, takenAt, via}`;
`via` vale `claim` ou `producer`. `heldBefore` guarda donos anteriores com
`releasedAt` e `reason` (incluindo `stale` e `producer takeover`). Itens antigos sem
posse continuam válidos. Toda mutação usa a trava da inbox e escrita atômica.
A identidade é cliente mais sessão. O mesmo dono repete idempotentemente; outro dono
ativo é recusado. A obsolescência usa `inbox.holdStaleMinutes` (inteiro >= 1).
Liberação pelo dono ou obsoleta e `consolidated`/`failed` limpam a posse. Delegação aceita
`holder` opcional; quando fornecido, deve corresponder ao dono existente. Chamadas antigas o omitem.
Listagem MCP e status mostram a posse em inglês ou português. Só `okit-plugin inbox take`
com `--producer-takeover` força transferência, após mostrar a situação (incluindo Git
com `inbox.gitTimeoutMs`) e confirmação TTY ou `--yes`.
O dono confirmado é comparado novamente sob a trava para recusar mudanças intervenientes.

<a id="section-3"></a>
## 3. State on disk

Consulte a referência: [state](../components/state.pt-BR.md).

- Escrita: serializar para `<file>.<pid>.<random>.tmp`, depois `fs.rename` sobre o destino, para que nenhum leitor veja arquivo pela metade. Em `EPERM` ou `EBUSY` (Windows), tentar o rename de novo algumas vezes antes de falhar.
- Trava: `fs.mkdir` na pasta `<name>.lock`, que guarda `owner.json` `{pid, startedAt}`; `EEXIST` significa ocupado; liberar com `rmdir`, que espera `EPERM`/`EBUSY` como toda outra chamada: o arquivo removido foi escrito e fechado há um instante, e uma trava deixada para trás por essa recusa guarda o dono de um processo que já saiu e é mais nova que `staleMs`, ou seja, que nenhum concorrente consegue tomar. Uma liberação respondida por `ENOTEMPTY` (esvaziada, mas um concorrente escreveu uma entrada de volta antes do `rmdir`) ou por `ENOENT` (outro concorrente já removeu) conta como liberada: a entrada que respondeu é a única evidência que todo concorrente lê, de modo que tentar de novo tiraria a trava de um dono vivo.
- Trava velha: uma trava é velha quando passa de `staleMs` **e** seu pid está morto; sem `owner.json` legível, usa-se o `mtime` da pasta e não há checagem de pid. A tomada reivindica a pasta do dono morto no lugar: renomeia o `owner.json` do dono morto para fora da pasta (só um rename pode vencer) e depois cria o seu próprio `owner.json` de forma exclusiva (`wx`), para que dois concorrentes não vençam os dois. A pasta nunca é movida para o lado. Uma recusa do Windows que dure mais que as tentativas de qualquer passo dessa reivindicação abandona a tentativa e deixa a pasta como foi encontrada, para que o laço de espera a julgue de novo em vez de a aquisição terminar num código cru.
- Um escritor por arquivo: caixa, ordens e execuções são arquivos separados, para que dois passos do mesmo item não se bloqueiem.

<a id="section-4"></a>
## 4. Adapter interface
O [desenho da integração](INTEGRATION.pt-BR.md) ([English](INTEGRATION.md))
define ambiente comum, papéis nativos, glossário e encaminhamento do fluxo inteiro (passos 2–4 concluídos).

Cada adaptador fornece estas cinco operações, além dos auxiliares documentados. O núcleo importa um adaptador, nunca um cliente.

- `spawn(actor, briefing, opts)` — perfil do ator, resumo — `{ runId, pid }`, ou `{ runId }` para execução no processo
- `readQuota()` — nenhuma — `{ source, remainingPct?, windowMinutes? }`
- `capabilities()` — nenhuma — `{ models[], efforts[], skills, hooks, mcp, desktop, windows }`
- `installSkill(name, files)` — pasta da skill — `{ path }`
- `installHooks(files)` — configuração do cliente ou caminho do módulo — `{ path }`
- `deliverRole(context)` — cliente, briefing explícito ou sessão principal, instantâneo comum, demandas/ordens/limites aplicáveis, ator — `ready` com contexto nativo, `clarification` ou `unsupported`
- `installRole(opts)`, `removeRole(opts)` — raiz do cliente injetada e suporte nativo — artefato gerenciado idempotente; preserva instruções do usuário

`src/roles.js` compõe o mesmo contrato bilíngue sem ramos por cliente nem efeitos colaterais. Claude SessionStart injeta contexto em startup/resume/compact; Codex usa bloco delimitado AGENTS.md e prompt de lançamento; opencode usa hook config nativo para agentes principais e comandos. Briefings explícitos escolhem Executor/Critic, nunca modelo+esforço. Papéis ausentes/ambíguos e formatos sem suporte são relatados antes de iniciar. Respostas usam ferramentas existentes do núcleo e títulos legíveis; perguntas de ambiente nunca salvam configuração, iniciam trabalho ou gastam cota. Registro do instalador e ligação do hook Claude empacotado fazem parte desse caminho. Testes herméticos do fluxo inteiro isolam HOME e raízes dos três clientes, passando por setup confirmado, fatos comuns, Director e smoke offline injetado. As seis skills têm o mesmo mapa bilíngue; aceite real continua separado.

### 4.1 Os adaptadores incluídos

Consulte a referência: [adapters](../components/adapters.pt-BR.md).

<a id="section-5"></a>
## 5. Quota
- Claude Code: `statusline-collector` salva a entrada da barra após registro consentido com `install --statusline` ou `update --statusline`.
- Codex: `codexQuota` controla a leitura das sessões locais; a automática vence quando mais nova que a manual.
- opencode: `opencodeQuota.sources` fornece comandos ou arquivos por provedor; uma fonte válida vence a manual.
- Todos aceitam leitura manual via `okit-plugin quota set <client> <pct>`; sem leitura válida, a cota permanece desconhecida.

Não estimar cota. `profilePick` rebaixa uma classe quando `remainingPct < lowQuotaPct`; `source: off` e leitura ausente não rebaixam. Os adaptadores devolvem leituras automáticas quando disponíveis, com alternativa manual.

OpenCode lê `opencodeQuota.sources` (provedor → palavras do comando ou arquivo),
sem ler credenciais. Comandos reaproveitam `execRun`, sem shell nem acréscimos ao
ambiente, com limites configuráveis de prazo e saída. Versão do contrato, nomes
dos campos e minutos das janelas ficam em `DEFAULT_CONFIG.opencodeQuota`.
Fonte inválida, com erro ou antiga usa o valor manual. Vale o menor restante
entre provedores e períodos válidos. `quotaOrigin` mostra origem, idade e
provedor em `status` e `quota show`. O smoke consome o instantâneo comum do env e preserva os
avisos e a expiração por `ageMinutes`. O cenário continua sendo Claude Code;
só a leitura do adaptador desse cliente autoriza a execução; cota ausente ou
expirada permanece desconhecida. A cota de outro cliente nunca a autoriza.

### 5.1 A tabela de cota

A coluna Cota dos atores mostra o estado traduzido, o menor percentual restante e a idade da leitura, sem texto de ordens em Markdown ou JSON. Um cliente sem atores configurados recebe apenas a nota de configuração. Um `--client` inválido na CLI imprime o uso e sai com código 2, como em `status`. Locales extras em `actors.messages` se limitam aos aceitos pela CLI e pelo MCP (`LABELS`/`LOCALES`).

`actors_list` / `okit-plugin actors [--client <nome>|--all] [--json] [--locale en|pt-BR]` é somente leitura. Ator é um par modelo + esforço disponível em um cliente, com tamanhos derivados do mapa configurado `actors.sizeClasses` (padrão S→simple, M→normal, L→hard); `actors.criticClass` aparece à parte. `src/actors.js` compartilha seleção de cliente/cota do status e lê `limitsStatus` sem adquirir/liberar vagas. Status descreve executores rodando; actors lista perfis mesmo sem nada rodando. Pares iguais combinam tamanhos. Tamanhos ausentes indicam o vizinho disponível mais próximo; empates favorecem o anterior no mapa. Cota baixa e vagas ocupadas incluem motivos e soluções; cota desconhecida bloqueia lançamento. Um cliente sem perfil recebe a nota de configuração que aponta para os perfis na configuração do plugin.

`src/status.js` é a visão dessas leituras, não uma segunda fonte delas: `statusTable(root, deps)` formata as leituras, o relógio, as contagens do limite e as ordens permanentes fornecidos em `deps`, usando os `LABELS` fixos do idioma, e devolve `{markdown, capacityLine, rows}`. A tabela termina com uma frase fixa, traduzida, dizendo que vagas são executores em execução e `actors` lista os perfis modelo + esforço disponíveis. Essa frase é um rótulo, não uma leitura de entrada em `deps`. As colunas são `Subscription | 5h remaining | Week remaining | Resets in | Status | Source (age)`; um array `windows` preenche as duas colunas e, sem ele, o `remainingPct` único vai para a coluna de 5h quando `windowMinutes <= 360` e para a da semana caso contrário, inclusive quando `windowMinutes` está ausente.

`okit-plugin status [--all] [--client <nome>] [--locale en|pt-BR]` mostra apenas o cliente detectado por padrão. `--all` mostra todos os clientes configurados (os três conhecidos quando a raiz não nomeia nenhum); `--client claude-code|codex|opencode` escolhe um e tem prioridade sobre `--all`. Se a detecção falhar, todos aparecem com uma nota explicando `--client`. O `status` do MCP aceita `all` e `client` opcionais com a mesma regra. As contagens de executores em uso e disponíveis incluem apenas os clientes mostrados. O catálogo padrão de perfis nunca acrescenta um cliente a essa lista: os clientes de uma raiz são os que a configuração dela nomeia.

`detectClient(deps.env)` usa a tabela nomeada `CLIENT_ENV_MARKERS`: `CLAUDECODE` para Claude Code, `CODEX_THREAD_ID` ou `CODEX_CI` para Codex, `OPENCODE` ou `OPENCODE_PID` para opencode. Valores vazios ou `0` não identificam uma sessão; pastas de configuração não identificam um cliente em uso. CLI e MCP passam `ctx.env` (o ambiente real do processo quando não injetado); a tabela em si lê apenas o ambiente injetado.

A coluna Situação é uma palavra, nunca ANSI: `verde` com 15 pontos ou mais acima de `lowQuotaPct`, `amarelo` do piso até essa marca e `vermelho` abaixo do piso. A palavra vem da janela mais apertada; uma linha vermelha cita a ordem sobre o piso, recorrendo a `lowQuotaPct` quando não existe uma. Sem leitura, diz “Nenhum valor de cota registrado” e informa o comando que registra: `okit-plugin quota set <cliente> <pct>`. Nenhum percentual é estimado; os adaptadores leem amostras automáticas ou manuais. O valor registrado mostra a idade desde `recordedAt`, inclusive após renovar o cache; leituras antigas sem data usam a hora da primeira leitura. Abaixo da tabela, cada cliente mostrado tem vivas/teto, origem própria/padrão e vagas disponíveis com mínimo zero, além do piso. Toda palavra vive em `LABELS` com `en` e `pt-BR`, escolhida por `deps.locale`.

As leituras ficam em cache por cliente durante `ttlMs` medido em `deps.now`, então duas chamadas seguidas custam uma leitura. `shouldShowStatus({size, slices, executors})` é verdadeiro para tamanho `L`, `slices >= 2` ou `executors > 1`, e é quando o Diretor mostra a tabela. `okit-plugin daemon status --table [--locale en|pt-BR]` imprime a mesma tabela embaixo das linhas do daemon, e uma passagem do daemon nunca lê cota por ela: `daemonStatus(root, { table })` só monta a tabela quando essas dependências são entregues.

### 5.2 O catálogo de perfis

`src/profiles.js` guarda o catálogo em `DEFAULT_CONFIG.profiles`: cada cliente (`claude-code`, `codex`, `opencode`) tem um perfil por classe (`simple`, `normal`, `hard`), e um perfil é `{model, effort, maxTurns}`. Os esforços e os limites de voltas vêm de `PROFILE_EFFORTS` e `PROFILE_MAX_TURNS`, então nenhum valor fica fixo na lógica. Os nomes dos modelos pertencem a quem mantém: mudam junto com os catálogos dos clientes, e o catálogo é editado ali.

`configOf(config)` mescla o `config.profiles` do usuário sobre o catálogo, classe por classe: o valor do usuário substitui a classe que ele nomeia e as outras classes mantêm o padrão, então uma sobrescrita nunca apaga o resto. Uma classe com `null` sai do catálogo. Uma raiz sem entrada `profiles` mantém o catálogo inteiro, então uma instalação limpa responde `profile_pick` e `actors_list` para cada cliente e classe.

O catálogo é um reserva para os perfis, não uma lista de assinaturas: `clientsOf` mantém os clientes que a configuração da raiz nomeia (os conhecidos quando ela não nomeia nenhum), então o comando de cota nunca registra um cliente que a raiz não tem.

Uma recusa é curta e bilíngue: um cliente desconhecido recebe os clientes conhecidos em inglês e português, uma classe desconhecida recebe as classes, e nenhum id de demanda ou de ordem aparece na mensagem. Os textos vivem em `DEFAULT_CONFIG.profileMessages`, então o usuário os substitui no `config.json`.

### 5.3 O esquema editável da configuração

`src/config-schema.js` guarda `CONFIG_SCHEMA.entries` (`src/config.js` o reexporta e lê o texto de um valor), a tabela de toda chave que
`okit-plugin config show|get|set|unset` aceita. Cada entrada informa o
caminho pontilhado, o tipo, a faixa ou os valores permitidos, o caminho do
padrão e uma descrição simples em inglês e português do efeito. As chaves
atuais são `limits.global`, `limits.clients.<client>`,
`profiles.<client>.<class>`, `profiles.<client>.<class>.model`,
`profiles.<client>.<class>.effort`, `profiles.<client>.<class>.maxTurns`,
`lowQuotaPct`, `daemon.minQuotaPct` e `smoke.quotaFloorPct`.

Limites inteiros e tetos de voltas começam em 1. Percentuais de cota vão de
0 a 100. Modelos são textos não vazios, e os esforços permitidos vêm de
`PROFILE_EFFORTS`. Os nomes de clientes vêm do catálogo padrão e de
`configuredClientsOf`; as classes vêm do catálogo de perfis. Os padrões de
escopo do esquema permitem apenas letras, dígitos, `-` e `_`, e os segmentos
reservados `__proto__`, `constructor` e `prototype` são recusados. O comando
expande apenas nomes seguros no esquema, então um cliente ou classe inseguro é
recusado como chave desconhecida e um cliente ou classe fora do catálogo é
recusado com a lista válida.

`show` imprime toda chave expandida com seu valor efetivo, origem (`default`
ou `user`) e efeito. `get` imprime uma. `set` converte o texto para o tipo
do esquema, valida e muda só essa folha em `config.json`; usa a trava de
configuração e `writeJsonAtomic`, então uma escrita falha deixa o arquivo
antigo intacto. `unset` remove a folha, remove qualquer apelido legado da
entrada e restaura o padrão. Valor inválido ou chave desconhecida sai com 2 e
não grava nada.

A chave de classe `profiles.<client>.<class>` aceita só `null`, o estado que
desliga a classe, e `unset` nela religa a classe. Um `set` nunca atravessa um
ancestral que não seja objeto: ele recusa com uma mensagem curta bilíngue que
nomeia o perfil desligado e o `config unset` que o liga, e não grava nada. Um
cliente só conta como configurado quando sua entrada em `profiles` nomeia uma
classe sua, então um grupo vazio é a ausência de um cliente e removê-lo não
muda nada.

Para acrescentar uma chave, acrescente sua entrada em
`CONFIG_SCHEMA.entries`, coloque o padrão em `DEFAULT_CONFIG` (ou aponte
`defaultPath` para o padrão existente), acrescente tipo e faixa à entrada e
adicione testes do comando e documentação bilíngue. Não coloque cliente,
classe, faixa, mensagem ou lista de chaves na lógica do comando: o esquema é
a única fonte consumida pelo código.

### 5.4 Detecção de modelos

`src/setup/detect.js` detecta clientes em paralelo e propõe perfis sem gravar configuração. `detectClients({config, env, run, adapters})` lê o `listModels` de cada adaptador; uma falha do adaptador vira resultado de catálogo com motivo, nunca exceção. `proposeProfiles(detected, config)` é puro.

Quando o adaptador real não consegue ler a lista de modelos, o motivo diz “A lista de modelos não pôde ser lida, então o catálogo interno é usado.” Ao exceder o prazo, diz “A lista de modelos não respondeu a tempo, então o catálogo interno é usado.” Nenhuma frase inclui detalhes técnicos. O código da falha, o código de saída ou o prazo configurado em milissegundos fica como string no campo `error` da resposta do adaptador, preservado no registro do cliente detectado para diagnóstico.

Listado não quer dizer ativo. `setup.detect.<cliente>.activeField` e `activeValues` definem a atividade: Codex usa `visibility` e `list` por padrão, enquanto os outros clientes usam `null`, então todo item listado é ativo. `listModelsOf` devolve modelos ativos em `models`, nomes excluídos em `hidden` e um motivo com as contagens de listados, ativos e ocultos. Só um código de saída zero (ou nenhum código) é sucesso; qualquer outro valor, uma string numérica inclusive, é falha. Um comando que respondeu é listagem mesmo quando não listou modelo nenhum: só um executável ausente, uma falha, um prazo e uma saída que o plugin não entende respondem com o catálogo.

Os candidatos de um cliente são os modelos de todas as classes em `config.profiles.<cliente>` mais `setup.detect.<cliente>.candidates`. O modelo configurado permanece quando está ativo. Caso contrário, um candidato ativo da mesma família o substitui. A família é uma regra do cliente: `setup.detect.<cliente>.family.separator` separa o provedor do resto do nome e `family.minimumPrefix` é o tamanho que o prefixo comum do resto precisa alcançar; o provedor precisa ser o mesmo, e um provedor diferente nunca é da mesma família. Um nome que não contém o separador configurado não tem provedor e é comparado inteiro; portanto o separador deve ser o que o cliente usa nos nomes (ex.: `/` para `provedor/modelo`), e um separador que não aparece em nenhum nome deixa todos os nomes sem provedor. Um separador vazio, ou que não é texto, não é regra nenhuma: desliga a troca automática, de modo que nada substitui o modelo configurado; um modelo configurado que está ativo permanece (`source: 'listing'`), e uma classe cujo modelo configurado não está ativo é omitida com o comando `okit-plugin config set profiles.<cliente>.<classe>.model <modelo>`. Entre os candidatos da família, vence o maior prefixo comum, um candidato do usuário vence o empate de prefixo e a ordem do catálogo resolve os demais empates entre candidatos do catálogo. Se nenhum candidato servir, a classe é omitida com o comando `okit-plugin config set profiles.<cliente>.<classe>.model <modelo>`. Uma listagem que respondeu sem nenhum modelo ativo omite todas as classes com esse comando; só uma listagem que o plugin não conseguiu ler mantém o modelo do catálogo, com o motivo da listagem. Uma proposta expõe `{model, effort, source, reason}` por classe e `{listed, active, candidatesActive}` por cliente, nunca a lista completa de modelos.

Para acrescentar um cliente, dê à sua função `listModels` no adaptador, acrescente suas classes de perfil e sua entrada `setup.detect.<cliente>` (`command`, `args`, `timeoutMs`, `parse`, `activeField`, `activeValues`, `family` e `candidates`) aos padrões e importe o adaptador na lista padrão de `src/setup/detect.js`. Usuários podem sobrescrever esses valores em `config.json`; a lógica de detecção não mantém campo de atividade, valor de atividade, candidato, cliente, classe, prazo, separador ou prefixo mínimo fixos.

O setup deixa `setup.done` em `config.json`; enquanto esse registro não existe, `okit-plugin status` mostra uma linha que nomeia o passo que falta, o fim de uma instalação ou de uma atualização oferece o setup, e a skill `okit-setup` conduz o mesmo setup em uma conversa. O registro é gravado apenas quando o setup tem uma configuração de modelo para gravar, ou quando todas as classes dos clientes detectados já têm um modelo ativo. Um setup que não encontrou nenhum cliente com modelo ativo não grava nada, diz uma frase simples no idioma da execução (`--locale`, depois `OKIT_LANGUAGE`, depois o idioma salvo, depois inglês: a mesma função do instalador, sem exceção bilíngue), e deixa a configuração pendente.

A saída do instalador tem um só caminho e uma só política de saída. `src/install/present.js` é o único lugar que imprime (`localizeReason`, depois `redact`, depois o escritor); `src/install/exit.js` dá o código de saída só a partir de `error.kind` (`kindOf`: `usage` e `language` são 2; qualquer outro, inclusive um erro sem `kind`, é falha do trabalho e vale 1). Toda recusa dos ajustes em `src/profiles.js` é um `ConfigError` com um código de `CONFIG_MESSAGES` (`en` e `pt-BR` por código, com os mesmos `{parâmetros}`) e é exibida por `localizeReason`. `src/cli.js` monta `COMMANDS` (grupos, ações e ações com valor) a partir de `USAGE_LINES`, e `test/install-matrix.test.js` gera seus casos dessa tabela; assim um comando novo entra na matriz por estar no texto de uso; as três entradas que o cliente inicia (`hook session-start`, `hook post-compact` e `statusline-collector`) são internas, não estão no texto de uso e são despachadas por `src/launchers.js`, então a matriz não as executa; as isenções são uma lista curta com o motivo (`config`, `quota`, `telemetry` e `trajectory` são subsistemas com convenção bilíngue própria, ainda sujeitos às propriedades de nenhum segredo e de classe de saída). O idioma é resolvido por uma só função em todo código Node (`--locale`, depois `OKIT_LANGUAGE`, depois a configuração salva, depois inglês). A única exceção documentada e testada é o prelúdio de shell do `install.sh` e do `install.ps1` (`src/release/install-scripts.js`): ainda não há Node, então ele não lê configuração nem arquivo, não analisa JSON e usa a flag, depois `OKIT_LANGUAGE` (exatamente `en` ou `pt-BR` nos dois), depois o idioma do sistema (o primeiro valor não vazio entre `LC_ALL`, `LC_MESSAGES`, `LANG`, onde `pt` seguido do fim, `_`, `-` ou `.` é `pt-BR`; a cultura da interface no Windows), depois inglês, só com recursos internos do shell e nunca `eval`. Uma configuração ou um ajuste inválido é erro de uso (saída 2) em `install`, `update`, `uninstall` e `setup` por igual, seja um valor, um nome fora do esquema ou um modelo ou esforço (`SetupRefusal` leva `kind: usage`), e também as respostas digitadas que acabam sem uma válida; um `new Error` simples em `src/install/**` ou `src/setup/**` precisa estar nomeado, com o motivo, em `PLAIN_ERRORS` de `test/install-invariants.test.js` (falha do trabalho ou erro de quem chama); uma que não pode ser lida é falha do trabalho (1). Regere os dois scripts depois de mudar o apresentador ou o prelúdio (`writeInstallScripts`). Toda configuração passa pelo esquema único (`src/config-schema.js`): `INSTALL_SCHEMA` para os ajustes `install.*`, lidos por `installConfig` em `install`, `update`, `uninstall`, `setup`, `kit`, `status` e `config`, e `CONFIG_SCHEMA` para as chaves de `config set|get|unset`; um valor inválido é uma só recusa de uso (saída 2) que nomeia a chave e a regra, em inglês e em pt-BR a partir de `CONFIG_MESSAGES` e `RULES` (`src/install/rules.js`), nunca um `TypeError`, um `RangeError` ou uma saída 1. `test/install-config-fuzz.test.js` monta os valores inválidos a partir do esquema (toda chave, todo comando, os dois idiomas); assim uma chave acrescentada a `DEFAULT_CONFIG.install` sem um nó em `INSTALL_SCHEMA` o faz falhar.

Um único leitor atende todas as perguntas do setup. Ele guarda as linhas recebidas em ordem, trata o fim da entrada como cancelamento e fecha no fim da execução. Uma entrada que já havia terminado não abre leitor nenhum: cada pergunta é respondida com nada, então o setup cancela em vez de esperar por uma linha que nunca chega. Antes de normalizar os perfis brutos, o setup confere os próprios nomes de cliente e classe com o esquema da configuração; um nome fora do esquema é recusado no idioma da execução e nenhum arquivo muda. Um arquivo de configuração que não pode ser lido, ou cuja raiz não é um objeto simples, é recusado antes de qualquer gravação e também na releitura sob a trava, com a mesma frase simples no idioma da execução; nada é gravado e o arquivo fica como está. Um `profiles` que não é um objeto simples, ou um cliente dentro dele que não é um objeto simples, é recusado do mesmo jeito, e nenhum erro técnico da linguagem chega ao usuário. A skill `okit-setup` nunca grava uma escolha isolada: o setup pergunta cada modelo e grava o conjunto completo uma única vez, depois da confirmação final.

### 5.5 O inventário de entradas (invariante I9)

Toda entrada que o instalador recebe está num inventário gerado, `test/helpers/input-inventory.js`, e
`test/input-inventory.test.js` prova cada linha contra os comandos reais. Os varredores leem o código-fonte e falham
quando uma chave de configuração, uma `--flag` ou uma variável `OKIT_*` é lida sem linha que a nomeie, então uma
entrada nova não escapa da prova. Os arquivos são achados do mesmo jeito: `fileReads()` lista toda chamada em `src/` e em `adapters/`
(uma varredura, uma tabela) que lê um arquivo ou interpreta texto (`readFile`, `readFileSync`, `readJson*`, `createReadStream`, `JSON.parse`,
`createRequire`, um `import()` dinâmico) com o primeiro argumento, e cada uma precisa ser classificada em `READ_POINTS`
por uma linha de `FILE_RULES` ou por uma exclusão nomeada que diga por que não é entrada de uma instalação. Uma leitura
que ninguém classificou, uma classificação que não casa com leitura alguma, uma linha de `FILE_RULES` que nada usa e um
leitor novo em `src/install/` sem linha fazem o teste falhar. Os leitores das configurações dos subsistemas
(telemetria, cota, trajetória, daemon, todo) são cobrados contra o esquema do mesmo modo: uma checagem de valor salvo
fora do `CONFIG_SCHEMA` falha, a menos que o arquivo esteja em `OWN_VALIDATORS` com o motivo (a telemetria não tem
nenhuma; valida os números salvos com o esquema do `config set`, `assertSavedValues`). A regra é a mesma em toda linha: um valor fora do domínio é recusa de uso, saída 2,
no idioma da execução; um arquivo que não pode ser lido é falha do trabalho, saída 1; um campo de tipo errado num
arquivo lido é saída 2. Nunca um `TypeError`, um `RangeError` nem mistura de idiomas.

| Entrada | Onde está listada | Domínio | Fora dele |
| --- | --- | --- | --- |
| Chaves de `config.json` | `TOP_LEVEL_KEYS` | tipo e faixa por chave; `install.*` pelo `INSTALL_SCHEMA`, chaves do `config set` pelo `CONFIG_SCHEMA` | saída 2 (um leitor que nunca para, como o das ordens, usa o padrão) |
| Números | `INSTALL_NUMBERS`, `CONFIG_NUMBERS` | mínimo e máximo escritos à parte do esquema; o máximo passa, máximo + 1 e mínimo - 1 são recusados | saída 2 |
| Flags | `FLAG_TABLE`, `POSITIONAL_NUMBERS` | uma linha por flag e comando: um valor, uma chave sem valor, `--flag=valor`, valor ausente, flag desconhecida | saída 2 |
| Variáveis `OKIT_*` | `ENV_DOMAINS`, `ENV_OTHER` | as configurações dos scripts de instalação (mapas, endereço, repositório, nomes, linhas, números); `OKIT_LANGUAGE` que não é idioma é ignorada de propósito | saída 2 antes de `uname` e da rede, também em `install.sh` e `install.ps1` |
| `config.json` | `FILE_RULES` | JSON; raiz que não é objeto (`null`, número, texto, lista) é configuração vazia em todo comando, inclusive nos de telemetria (`storedRootOf`; `telemetry on|off|rede` gravam um objeto no lugar); só o setup lê um `profiles` errado como arquivo ilegível | não é JSON, vazio ou pasta: saída 1 |
| `quota/<client>.json` | `FILE_RULES`, lido pelos adaptadores | a leitura manual de um cliente (`remainingPct`, `windowMinutes`, `recordedAt`) | não é JSON, vazio ou pasta: saída 1; JSON válido de outro tipo, ou campo do tipo errado, não é leitura (o `status` segue e diz que não há valor registrado) |
| `settings.json` do cliente (passo do papel) | `FILE_RULES` | o arquivo de outro programa em que o gancho do papel do Claude Code é mesclado | não é JSON: saída 1, arquivo intocado; outra forma: mantido como está, o passo diz que o papel não é suportado |
| Sessões do Codex, fonte do opencode | `READ_POINTS` (exclusão) | fonte do cliente, não entrada da pessoa: interpretada dentro de um `try`/`catch` que devolve nenhuma leitura | nunca falha o `status` (provado com um caso de cada) |
| `package.json` de `--from` | `FILE_RULES` | um pacote com nome, versão e o comando | saída 2 (argumento errado) |
| `install.json` e `install.<cliente>.json` | `FILE_RULES`, `RECORD_FIELDS` | o registro que o instalador gravou, todo campo e os registros que ele substituiu (`previous`) | não é JSON: saída 1; campo de tipo errado: saída 2, com o nome do campo e a orientação de remover o arquivo e rodar `okit-plugin install` |
| `managed-path.json` | `FILE_RULES`, `PATH_STATE_SCHEMA` | os blocos de perfil e a entrada do PATH do Windows que o instalador acrescentou | não é JSON: saída 1; tipo errado: saída 2, mesma saída |
| Números salvos da telemetria (`retentionDays`, `maxBytes`, `maxFileBytes`, `batchSeconds`, `kitTimeoutMs`, `rede.timeoutMs`) | `CONFIG_SCHEMA` | os mesmos limites do `config set` | saída 2 em todo comando da telemetria |
| Manifesto e metadados do release, configurações do cliente | `FILE_RULES` | o que o release e o programa do cliente gravaram | saída 1 (dado remoto ou arquivo de outro programa que não confere é falha do trabalho) |

O que é lido e não está no inventário é uma demanda nova, não um defeito da rodada que o encontra.

<a id="section-6"></a>
## 6. Windows rules
- Construir todo caminho com `node:path`, nunca concatenando separadores; guardar com barra direta, a forma que o Claude Code substitui, para que o que escrevemos corresponda ao que o cliente lê.
- Sem shell: `child_process.spawn` com array de argumentos. Comandos de hook na forma shell são preocupação do cliente, não nossa.
- Escrever só `\n`, com codificação explícita e sem padrão de plataforma, para que um arquivo escrito no Windows seja lido igual no Linux.
- Travas com `fs.mkdir` se comportam igual de forma nativa e no WSL; sem `flock`, sem `setsid`.
- Passagem manual antes de uma versão: instalar o plugin, adicionar um item na caixa, delegar um passo, ler o voto da crítica, consolidar, reiniciar o cliente, confirmar que o estado sobreviveu.

O modo `PROCESS` inicia os clientes sem shell; no Windows os shims `.cmd` exigem resolver antes o executável de verdade (item em aberto da passagem do Windows).

<a id="section-7"></a>
## 7. Concurrency limit
| Escopo | Padrão | Lido de |
| :- | :- | :- |
| Padrão para cada cliente | Definido na configuração | `limits.global` em `config.json` |
| Configuração própria | Suplanta o padrão | `limits.clients.<client>`; cota não altera o teto |

Não há teto somado entre clientes. Por exemplo, `clients: {"claude-code": 100}`
permite 100 execuções vivas nesse cliente independentemente de `global`.
Inteiros positivos são validados na leitura; clientes desconhecidos geram aviso.
O antigo `perClient` é apelido obsoleto que suplanta `global`, com aviso no status;
`global` não significa mais um total compartilhado. Cada verificação relê a configuração sem reiniciar.

O núcleo conta execuções vivas em `runs/<runId>.json` (`status: live`) em vez de confiar que o cliente respeita o teto. `acquireSlot` usa `waitMs: 0` por padrão e retorna `ok: false` sem vaga; o chamador pode pedir espera. `releaseSlot` encerra a reserva; a contagem ignora execuções mais velhas que `staleMinutes` . O Codex se limita sozinho com `agents.max_concurrent_threads_per_session`; deixar no mesmo número para os dois concordarem.

<a id="section-8"></a>
## 8. Schedules and recurrence
`src/schedule.js` é puro: um instante injetado, nada de I/O. `src/templates.js` guarda uma demanda que o próprio agendamento abre, um item da caixa por período.

| Forma | Exemplo | Normalizado em |
| :- | :- | :- |
| cron de 5 campos | `*/15 9-17 * * mon-fri` | `kind: cron` com os cinco conjuntos de campos |
| diária | `daily 06:00` | `kind: daily`, `hour`, `minute` |
| semanal | `weekly mon-fri 09:30` | `kind: weekly`, `days` |
| mensal | `monthly day 1 08:00` | `kind: monthly`, `day` |
| evento | `after each deploy` | `kind: event`, `event` |

Regras: um campo cron aceita `*`, listas (`1,2`), intervalos (`1-5`), passos (`*/15`) e nomes de três letras (`mon-fri`, `jan`); domingo é 0 ou 7 na entrada e sempre 0 dentro; dois campos de dia restritos casam por qualquer um deles e um campo livre casa com todo dia, como no cron; um dia mensal maior que um mês curto roda no último dia daquele mês. Qualquer outra coisa lança um `TypeError` nomeando todas as formas aceitas.

| Função | Pergunta que responde |
| :- | :- |
| `parseSchedule(text)` | Que texto é este? Um agendamento normalizado, ou um `TypeError`. |
| `nextRun(schedule, afterMs, { timeZone })` | Primeiro instante estritamente depois de `afterMs`; `null` para um evento e para um agendamento sem vaga dentro do limite de busca. |
| `isInWindow(win, nowMs, { timeZone })` | O instante está dentro de uma janela `{from, to}` de horários `HH:MM`, que pode cruzar a meia-noite? Sem janela, sempre. |
| `eventFires(schedule, eventName)` | Um agendamento de evento dispara neste evento nomeado? |
| `evaluateDue(template, nowMs, ctx)` | Este modelo deve rodar agora? |

`evaluateDue` devolve `{ due, action, reason, period }`, com `action` entre `run`, `skip` (uma decisão que não muda) e `defer` (esperar a próxima passagem). `period` é o instante ISO da vaga, ou `event:<name>:<id>`. As guardas são lidas nesta ordem: `paused`, a vaga deste período, `window`, `minQuotaPct`, `onlyWhenIdle`, `skipIfOpen`, `maxRunsPerPeriod`. Sem histórico, um modelo espera pela primeira vaga do dia corrente em vez de disparar por uma que já passou; com histórico, `catchup: run` (o padrão) serve a vaga perdida mais antiga e `catchup: skip` serve só a atual. Um evento precisa de um id, ou passaria a vida inteira com a mesma chave de período: sem `eventId` a execução é recusada. A vaga é lida no relógio de parede de `timeZone` (padrão `UTC`), então uma hora repetida roda na primeira passagem e uma hora pulada vai para o próximo minuto válido.

<a id="section-9"></a>
## 9. Recurring templates

**Template writes / Escritas de modelos**

- `templateAdd(root, input, { now })` — Guarda um modelo e a ordem permanente que deixa ele rodar sem ninguém assistindo; o nome precisa estar livre.
- `templateList(root, { name })` — Ordem de criação; um nome desconhecido lança erro.
- `templateSet(root, name, patch)` — Edita um campo, pausa, retoma ou renomeia; uma renomeação retagueia os filhos abertos e revoga a ordem antiga.
- `templateRemove(root, name)` — Remove o registro e revoga sua ordem permanente com um motivo.

**Template evaluation / Avaliação de modelos**

- `due(root, nowMs, ctx)` — Decide todos os modelos neste instante e não escreve nada.
- `plan(root, nowMs, ctx)` — O ensaio geral: as decisões mais as demandas que seriam criadas.
- `openDue(root, nowMs, ctx)` — Abre um filho por modelo vencido, uma vez por período; a checagem e a escrita dividem uma trava, então uma segunda chamada no mesmo período e dois chamadores em corrida não criam nada a mais.

Campos obrigatórios: `name`, `schedule` e `demand` (`title`, mais `kind`, `body`, `accept`, `ext` opcionais). Guardas opcionais: `window`, `timeZone`, `minQuotaPct`, `onlyWhenIdle` (padrão falso), `skipIfOpen` (padrão verdadeiro), `catchup` (`run` ou `skip`), `maxRunsPerPeriod`, `paused` e `appliesTo`. Cada filho carrega `ext.template` e `ext.period` e herda o `appliesTo` do modelo, para que um armazenamento global de modelos ainda saiba a qual caixa cada execução pertence.

<a id="section-10"></a>
## 10. Standing orders
Uma ordem é uma linha que o mantenedor escreve uma vez e o Diretor lê a cada demanda. O JSON continua sendo a fonte; `orderRender` é só uma visão.

**Order writes / Escritas de ordens**

- `orderAdd(root, { text, scope, until, origin, appliesTo }, { projectRoot })` — Adiciona uma ordem ativa no armazenamento único; `until` precisa ser uma data no futuro. Um `layer` é recusado com `layer is gone: use appliesTo`.
- `orderRemove(root, id, { reason })` — Revoga: `active: false` com `revokedAt` e `revokedReason`. Nada é apagado, então o histórico sobrevive. Uma segunda revogação é recusada.
- `orderStatus(order, now)` — O status derivado de uma ordem: `revoked`, `expired` ou `active`.
- `orderList(root, { activeOnly, appliesTo, now }, { projectRoot })` — Lista o armazenamento único. `activeOnly` descarta revogadas e vencidas. Cada ordem volta com o `status` derivado e, quando inativa, a data `purgeAfter`.

**Migration and retention / Migração e retenção**

- `orderMigrateProjects(root, projectRoots)` — Migração única do arquivo antigo do lado do projeto para o armazenamento; devolve `{ moved, skipped }`.
- `orderLint(root, { now })` — O que quem lê o arquivo tropeçaria: texto vazio, escopo desconhecido, data ilegível, id repetido, ordem ativa com `until` passado, duas ordens vivas com o mesmo texto.
- `purgeAfter(order, retentionDays, now)` — O instante em que uma ordem inativa pode ser expurgada, ou `undefined` para uma ativa.
- `orderPurge(root, { now, retentionDays })` — Remove para sempre toda ordem inativa cuja retenção acabou, e anexa `{ at, purged: [ids] }` a `logs/<date>.jsonl`.
- `orderRender(orders)` — Markdown para leitura humana.

O status é computado a partir da linha e nunca é gravado no arquivo, então quem lê o JSON vê só o que foi escrito:

| Status | Como é derivado |
| :- | :- |
| `revoked` | `active` não é `true`: a ordem foi revogada, e o motivo está em `revokedReason`. |
| `expired` | `until` é uma data que não está no futuro. No instante exato de `until` a ordem já está vencida. |
| `active` | Qualquer outra coisa: nunca revogada e ainda dentro do seu `until`. |

Revogar marca, não apaga: a linha continua com `active: false`, `revokedAt` e `revokedReason`. Adicionar de novo o mesmo texto depois cria uma ordem nova com id novo, e uma segunda revogação do mesmo id é recusada para que o primeiro motivo sobreviva. Uma ordem inativa é então expurgada para sempre quando a retenção acaba, e a expurgo fica registrado: `purgeAfter` é `revokedAt` para uma ordem revogada e `until` para uma vencida, mais `orders.retentionDays`  no `config.json`; `orderPurge` remove a linha do armazenamento único só quando essa data chega, e escreve `{ at, purged: [ids] }` em `logs/<date>.jsonl` para que o rastro do que saiu sobreviva à remoção. Um `orders.retentionDays` quebrado volta ao padrão em vez de travar quem lê.

Um armazenamento: toda ordem vive em `orders.json` na raiz do estado e o id é `G000001`. Não existe mais a camada de projeto — o projeto é escolhido pelo `appliesTo`, que nomeia os ids ou caminhos aos quais a ordem se liga, e uma ordem sem ele vale para todos. `orderAdd` com `layer` é recusado com `layer is gone: use appliesTo`. A migração única `orderMigrateProjects(root, projectRoots)` copia cada `<projectRoot>/.okwork/orders.json` do layout antigo para o armazenamento com `appliesTo` apontando para aquele projeto, `origin` `migrated:project` e um id `G` novo, preservando texto, escopo, `until`, `active` e os campos de revogação; uma linha já copiada é pulada (mesmo texto mais `appliesTo`), a cópia acontece antes de o arquivo antigo ser renomeado para `orders.json.migrated` e ele nunca é apagado. Ela roda de forma preguiçosa em `orderList`/`orderAdd` quando um `projectRoot` é passado, que é o único uso que resta de `projectRoot`. `scope` é `all` ou `effort:simple`, `effort:normal`, `effort:hard`; `origin` é texto livre, com padrão `maintainer`, e um modelo escreve `template:<name>`. A ordem de um modelo é criada junto com o registro, movida em uma renomeação e revogada com motivo na remoção, então a ordem que permitia a execução deixa de permitir.

<a id="section-11"></a>
## 11. The daemon
O daemon é a metade sem tela: ninguém assiste, então todo limite que ele respeita é técnico. O núcleo não inicia nada por conta própria — `spawn` é injetado, então um teste o conduz e um adaptador o conduz de verdade.

A ordem de uma passagem, `tick`:

**Decision sequence / Sequência de decisão**

- 1 — Pausa — `daemon.paused` existe: o registro diz `paused`, nada é aberto e nada é iniciado. O laço continua rodando.
- 2 — Chave de parada — `daemon.stop` existe: o registro diz `stopped: kill switch`, e `daemonRun` sai do laço.
- 3 — Piso de cota — Todos os clientes das demandas pendentes abaixo de `daemon.minQuotaPct` param a passagem. Um cliente sem leitura não está abaixo do piso, então um cliente não medido nunca paralisa o daemon.
- 4 — Retenção — `orderPurge` tira do armazenamento único toda ordem inativa cujo `orders.retentionDays` já acabou e anexa `{ at, purged: [ids] }` a `logs/<date>.jsonl`. Um daemon pausado ou parado não expurga nada.

**Queue and execution / Fila e execução**

- 5 — Modelos vencidos — `openDue` com a pior leitura da passagem: a cota mais baixa e a menor ociosidade dos clientes que ele conhece.
- 6 — Demandas pendentes, mais antiga primeiro — A caixa lista das mais novas para as mais antigas, então a fila é invertida e uma demanda que espera atrás de outras nunca passa fome. Um período atende uma execução por vez: enquanto um irmão do mesmo `ext.template` e `ext.period` está `delegated` ou `criticised`, os outros esperam.
- 7 — Teto — Por demanda: `classify` quando o item não tem `effort`, `profilePick`, depois `acquireSlot` antes de o iniciador rodar e `releaseSlot` se ele recusar, então uma recusa não custa nada.
- 8 — Uma linha de decisão — `{ at, opened, spawned, skipped, purged, stopped?, paused? }` anexada como uma única linha JSON em `logs/<date>.jsonl`, para quem lê o fim do arquivo ver sempre uma passagem inteira.

O daemon nunca recusa uma demanda por conta própria: uma demanda é pulada apenas por um limite técnico (pausa, chave de parada, piso de cota, teto de concorrência) ou por falha do iniciador, e cada pulo diz qual foi.

| Função | Efeito |
| :- | :- |
| `tick(root, deps)` | Uma passagem; devolve o registro de decisão e o anexa. |
| `daemonRun(root, deps, { signal, sleep })` | O laço: toma a trava do daemon, escreve `daemon.pid.json`, dá uma passagem a cada `daemon.intervalSeconds`, roda a rotação dos logs uma vez por dia, sai na chave de parada ou em `signal.abort()`, e remove o arquivo de pid na saída. |
| `daemonStatus(root, { now })` | Diz se está rodando, seu pid, quando começou, se está pausado e o último registro de decisão. |
| `daemonPause(root)` / `daemonResume(root)` | Escrevem e removem o arquivo de pausa. |
| `rotateLogs(root, keepDays, now)` | Remove `logs/*.jsonl` mais velhos que `daemon.logKeepDays` por hora de modificação e devolve os nomes removidos. |

O iniciador é injetado: `deps` traz `now()`, `quota(client)`, `idle(client)` e `spawn(demand, { client, profile, limits, maxTurns, maxMinutes, runId })`. O `runId` que ele recebe é a vaga já reservada para a execução, então devolver o mesmo id é o caminho barato; devolver outro move a vaga para esse id, e quando esse id não pode ser tomado o original é tomado de novo.

Ritmo: um relógio monotônico mantém o intervalo mesmo quando o relógio de parede muda. Um daemon por raiz segura a trava `daemon`. `daemonStatus` exige pid vivo e registro recente. `daemon.intervalSeconds`, `daemon.minQuotaPct` e `daemon.logKeepDays` controlam ritmo, piso e retenção de logs; `orders.retentionDays` controla a retenção das ordens inativas. Valores inválidos usam os padrões configurados.

<a id="section-12"></a>
## 12. Spawn modes
Claude Code e Codex suportam descritores NATIVE e processos PROCESS. opencode suporta apenas PROCESS; NATIVE é recusado.

| Modo | Quando | Como |
| :- | :- | :- |
| `NATIVE` | padrão em uma sessão interativa | o subagente do próprio cliente: a chamada da ferramenta Agent no Claude Code, `spawn_agent` no Codex, opencode não tem ponte NATIVE |
| `PROCESS` | o daemon e qualquer outra execução sem tela | a CLI sem tela: `claude -p`, `codex exec`, `opencode run` (flags verificadas em 2026-10-22, abaixo) |

Em `NATIVE` o núcleo não está no laço, então o teto é garantido pelas ferramentas MCP `acquire_slot` e `release_slot` em volta de `classify` e `profile_pick`. Em `PROCESS` o daemon reserva a vaga antes de o iniciador rodar, e a execução é um processo filho do daemon.

### 12.1 `PROCESS`, verificado em 2026-10-22
`src/spawn-process.js` monta o comando como um valor puro e o inicia com `child_process.spawn` e um vetor de argumentos. Nenhum shell, em momento algum: o briefing é o último argumento posicional de cada cliente, então nada dele é lido como sintaxe de shell. O filho recebe `OKWORK_NO_DAEMON=1`, para uma execução iniciada pelo daemon nunca iniciar um daemon.

| Cliente | Comando |
| :- | :- |
| `claude-code` | `claude -p <briefing> --model <model> --effort <effort> --output-format json --permission-mode <mode> --add-dir <dir>` |
| `codex` | `codex exec --cd <dir> --model <model> --sandbox <workspace-write\|read-only\|danger-full-access> --json --skip-git-repo-check -c model_reasoning_effort=<effort> <briefing>` |
| `opencode` | `opencode run --dir <dir> --model <provider/model> --variant <effort> --format json <briefing>` |

- Claude Code 2.1.303: o modo de permissão é uma opção (`acceptEdits` por padrão); `--dangerously-skip-permissions` existe e nunca é o que passamos. `--max-budget-usd` existe, `--max-turns` não existe, então `maxTurns` não vai para a linha de comando — `maxMinutes` é o único limite de relógio de parede.
- Codex 0.163: `--skip-git-repo-check` porque a worktree escolhida pelo mantenedor não precisa ser um repositório git. `-o <file>` gravaria a última mensagem em um arquivo e fica a cargo de quem chama.
- opencode 1.19: o modelo é o id completo `provider/model` e o esforço é uma variante do provedor.

O diretório de trabalho é o `appliesTo` da demanda quando ele é uma única pasta absoluta existente; um nome de projeto, vários projetos ou `global` mantêm a execução onde o daemon foi iniciado. O processo é detachado, as duas saídas vão para `runs/<runId>.out`, e `runs/<runId>.json` é escrito com `status: live` — o arquivo que `limits.js` já conta — e ganha `endedAt` e `exitCode` na saída. `maxMinutes` envia `SIGTERM` por `child.kill()`; o iniciador não mata mais nada.

### 12.2 Início automático e a CLI
`src/autostart.js` gera planos, nunca age: `systemd` (uma unidade de usuário `okit-daemon.service`), `cron` (uma linha `@reboot`), `launchd` (o agente `com.okit.daemon`) e `schtasks` (uma tarefa a cada login). `detectAutostart(platform)` escolhe a que esta plataforma usa e `applyAutostart(plan, { run })` roda os comandos de uma ação por um `run` injetado, para que `show` imprima o plano inteiro antes de qualquer ação. No Windows os caminhos guardados usam barras para frente e nenhum shell.

### 12.3 Ferramentas MCP
`src/mcp/server.js` é o servidor MCP: JSON-RPC 2.0 sobre JSON delimitado por quebras de linha no stdio, escrito à mão e sem dependências. `src/mcp/tools.js` guarda a tabela, uma ferramenta por função do núcleo, e cada manipulador valida os próprios argumentos de novo porque o `inputSchema` é documentação e nunca a única porta de entrada. Só quadros de protocolo vão para a saída padrão; o diagnóstico vai para a saída de erro.

Consulte a referência: [mcp-tools](../components/mcp-tools.pt-BR.md).

Métodos: `initialize`, `notifications/initialized`, `ping`, `tools/list` e `tools/call`. Toda ferramenta responde `{content: [{type: 'text', text}], isError}`, onde `text` é o JSON do que o núcleo devolveu, então uma recusa (`ok: false`, um teto cheio) e um resultado se leem do mesmo jeito. Um método desconhecido é `-32601`, uma ferramenta desconhecida `-32602`, uma linha que não é JSON `-32700` com id nulo; em todos os casos o laço continua lendo.

<a id="section-13"></a>
## 13. Autonomy
Autonomia máxima é o padrão. O plugin não traz nenhuma lista fixa de ações proibidas: uma recusa vem de algo que o usuário escreveu ou de um limite técnico, nunca de uma regra que os mantenedores adivinharam.
- As restrições são ordens permanentes. O usuário adiciona uma ("nunca dar push para `main`") e `orderRemove` a retira; nada mais pode adicionar restrição.
- Os limites técnicos continuam configuráveis: o teto de concorrência (`limits.global`, `limits.clients`, `staleMinutes`), o piso de cota (`daemon.minQuotaPct`, `lowQuotaPct`), a chave de parada (`daemon.stop`) e o arquivo de pausa.
- O núcleo nunca inventa um modelo, um valor de esforço ou um número de cota que o cliente não informou, e nunca aumenta um teto por conta própria.

<a id="section-14"></a>
## 14. Global state and `appliesTo`
Uma caixa, um conjunto de ordens permanentes, um armazenamento de modelos, em uma pasta (`OKWORK_HOME`, padrão `~/.okwork`), compartilhada por todos os projetos. O que pertence a um projeto fica nos arquivos do próprio projeto e o registro apenas o referencia, então um armazenamento compartilhado nunca precisa ser dividido.

| Função | Efeito |
| :- | :- |
| `validateAppliesTo(value)` | Apara e tira duplicatas, mantém a forma recebida e nunca guarda o padrão: um registro sem o campo vale para todo projeto. |
| `validateAppliesToFilter(value)` | O filtro de uma listagem: um projeto, ou só os registros compartilhados. Uma lista de projetos é recusada, porque a união seria ambígua. |
| `inScope(record, wanted)` | Se um registro aparece para um projeto. |
| `stateRoot(env)` / `paths(root)` | Onde o estado mora, com a sobrescrita do ambiente primeiro. |

Então: ausente significa todos os projetos, um nome significa aquele projeto, uma lista significa cada um deles, e `global` junto com outro projeto é recusado porque não diz nada preciso. `inboxList`, `orderList` e `templateList` filtram por projeto e sempre incluem os registros compartilhados; `templateSet` com `appliesTo: 'global'` apaga o campo, então o modelo volta a ser compartilhado.

<a id="section-15"></a>
## 15. Implementation and limits

Os três adaptadores, estado JSON, daemon, agendamento, instalador, release e servidor MCP estão implementados. O runner real de `client-smoke` atende Claude Code; os demais drivers e as provas Windows/macOS continuam pendentes. Veja [RELEASING.pt-BR.md](RELEASING.pt-BR.md#proof-per-pair).

<a id="kit-and-plugin-overlap-d1"></a>

### Kit and plugin overlap

O kit de orquestração e o plugin podem coexistir. O plugin cuida dos adaptadores,
ferramentas MCP e estado em `OKWORK_HOME`. Instalar ou atualizar o plugin não
instala, atualiza nem migra o kit. Mantenha a configuração de cada ferramenta
com ela e escolha o executável desejado no PATH (`install.kit.path` escolhe a sondagem).
Evite dois orquestradores na mesma demanda: filas e limites são independentes.

`okit-plugin kit`, resumos de instalação/atualização e status usam um detector
somente leitura, com dependências injetadas. Só o comando de versão configurado
executa, com prazo limitado. O detector informa caminho e versão; não adivinha
pastas pessoais/configuração do kit nem detecta o plugin de dentro do kit.

<a id="section-16"></a>
## Operational reference

Consulte a referência: [cli](../components/cli.pt-BR.md).

Consulte a referência: [configuration](../components/configuration.pt-BR.md).

Consulte a referência: [hooks](../components/hooks.pt-BR.md).

### Development — Desenvolvimento

Toda página Markdown em `docs/` e os dois READMEs da raiz trazem um banner da área logo após o H1, com texto alternativo no idioma da página e o nome `okit-plugin`. Edite títulos, ícones e cores dos temas claro/escuro em `docs/images/banners/banners.config.json`, rode `node scripts/docs-banners.js` e confira com `node scripts/docs-banners.js --check`; mantenha o histórico mais recente primeiro e evite linhas em branco soltas.

Rode `node --test test/docs-consistency.test.js` para verificar a documentação e
`node --test` para a suíte completa. Os testes de cota injetam HOME/USERPROFILE
temporários e `CODEX_SESSIONS_DIR` (ou um leitor de cota); nunca devem descobrir
sessões na pasta pessoal real da máquina. Os comandos de release estão no guia
referenciado abaixo.

Os testes interativos do instalador contam o consentimento da barra de status
separadamente e recusam a oferta de setup inicial ao testar `--no-statusline`.

Pull requests são bem-vindos. Leia [CONTRIBUTING.md](../../CONTRIBUTING.md) antes.

Relatos de segurança não são issues públicas, veja [SECURITY.md](../../SECURITY.md).
As notas de design estão em [docs/maintainers/DESIGN.pt-BR.md](DESIGN.pt-BR.md).
O desenho do release está em [docs/maintainers/RELEASING.pt-BR.md](RELEASING.pt-BR.md)
([English](RELEASING.md)).
