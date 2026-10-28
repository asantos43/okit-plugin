# Teste de fumaça

![okit-plugin: Manutenção](../images/banners/maintainers.svg)

Contratos de verificação e provas para verificações isoladas e smoke em clientes reais.

<a id="contents"></a>
## Índice

- [Commands](#section-1)
- [Scratch home rule](#section-2)
- [What the runner reuses](#section-3)
- [Checks](#section-4)
- [Checkout against installed plugin](#section-5)
- [Result record](#section-6)
- [Output](#section-7)
- [Safety](#section-8)
- [In-client smoke (real)](#section-9)
- [In-process implementation](#section-10)

Para executar a prévia, consulte o [guia](../guide/smoke-demo.pt-BR.md); contratos do motor e relatórios estão em [DEMO](DEMO.pt-BR.md).

`okit-plugin smoke-demo --confirm <planHash>` e MCP `smoke_demo` com `confirm` executam os cinco trabalhos com o cliente real escolhido e gastam sua cota. Veja antes a prévia com `--dry-run`; o texto e o contrato do hash não mudam. A confirmação exige o mesmo plano, evidência atual de cota e `smoke.demoRequireQuotaConfirmation: true`. Códigos de saída: 0 para sucesso, 2 para recusa antes do lançamento e 1 para falha/parcial. A prova paga cabe ao dono; testes offline usam processos falsos e não gastam cota. A demonstração real executa os trabalhos um de cada vez. A demonstração pelo MCP não pode ser cancelada no meio; ela termina pelos limites (`smoke.maxMinutes` e tetos de custo).

Cada chamada reserva `min(driver.maxCostUsd, saldo total, saldo da demanda)` e recebe esse teto em dinheiro. O ledger compartilhado cobre execução, revisão e correção; tetos esgotados de dinheiro, tokens, turnos ou tempo impedem novos trabalhos. Falhas com uso medido preservam dinheiro e tokens; uso não medido impede novos trabalhos. Clientes sem custo em dinheiro exigem `smoke.maxTokens` inteiro positivo antes de iniciar e mostram dinheiro como não informado. O teto de tokens é conferido após respostas; chamadas em andamento podem ultrapassá-lo.

O ambiente real mantém os caminhos temporários de home/estado/configuração e recebe de `deps.env` (CLI e MCP fornecem o ambiente do processo na fronteira; `src/smoke/demo` nunca lê `process.env`) somente `PATH` e credenciais explícitas: Claude Code recebe `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_BASE_URL`; Codex recebe `OPENAI_API_KEY`, `OPENAI_BASE_URL`; OpenCode não recebe variáveis de autenticação porque nenhuma consta do contrato de cliente do repositório. `OPENCODE_CONFIG` e a pasta de configuração do host não são repassados. As listas de credenciais seguem a demanda D84; as demais variáveis do host ficam de fora. Um `PATH` ausente ou vazio recusa antes de montar os drivers (saída 2, nada pago, nenhum lançamento, pasta de exemplo removida). A pasta de exemplo é isolada e **não** herda a sessão de login do cliente: exporte antes a chave ou o token do cliente (Claude Code: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` ou `CLAUDE_CODE_OAUTH_TOKEN`; Codex: `OPENAI_API_KEY`; OpenCode: ainda sem variável aceita, então a demonstração real não autentica); senão a chamada falha sem gastar nada.

O ledger da demonstração mantém `smoke.maxTokens` como `null` ou inteiro positivo seguro e soma o inteiro seguro não negativo `usage.tokens` de cada tentativa iniciada. Ao atingir ou ultrapassar o teto, nenhuma nova reserva começa. Uso de tokens ausente ou inválido com teto habilitado deixa o uso sem resolução e bloqueia novas reservas. Reservas e acertos continuam síncronos: trabalhos paralelos compartilham o total, mas tentativas já reservadas podem terminar acima do teto. Uma tentativa que não iniciou não consome tokens.

Um teto de tokens configurado vale para qualquer cliente, inclusive clientes com dinheiro e `reportsCost` verdadeiro ou ausente: seus drivers também devem fornecer `usage.tokens`. Com `maxTokens: null`, a falta de tokens não deixa o ledger desconhecido. Reservas não reservam tokens: o pior caso de ultrapassagem acima do teto configurado é paralelismo × tokens consumidos por uma tentativa (considerando a maior tentativa em andamento). Sem limite de tokens por tentativa, não há limite fixo para essa ultrapassagem.

`src/smoke/demo/index.js` passa `clientRequest(client, config).reportsCost` aos limites do ledger real. Seu snapshot fornece `reportsCost`, `tokens` e `costUsd` finais ao resultado/resumo. Com `reportsCost: false`, dinheiro não é contabilizado, `costUsd` é `null` tanto no total quanto nas demandas acertadas, e essas demandas têm `costKnown: false`. O relatório textual informa no idioma escolhido que o custo em dinheiro não é informado e mostra os tokens usados e o teto. Clientes com custo mostram o total medido. O modo de teste injetado mantém a contabilização simulada em dinheiro.

`src/smoke/demo/driver.js` exporta `realDrivers({ client, config, spawn })` para o executor e o revisor da demonstração. Criar os drivers não inicia nada. Os dois papéis reutilizam `clientRequest` e `invokeClient`, incluindo a conversão compartilhada dos eventos dos clientes. Após confirmação, entry/index fornece o lançador injetado ou `spawn` do Node; erros de construção recusam antes de gastar cota.

O executor combina o texto da tarefa, verificações a corrigir, critérios de aceitação e caminhos permitidos. Inicia na pasta e no ambiente recebidos, encaminha o cancelamento e usa o menor prazo entre `briefing.limits.timeoutMs` e `smoke.checkTimeoutMs`. O chamador fornece o ambiente do cliente, incluindo `PATH` e credenciais, em `briefing.env`; o driver o repassa como recebido. Somente arquivos listados sob `briefing.root` viram artefatos. Os artefatos devem ser arquivos comuns de até 128 KiB; arquivos ausentes ficam de fora e caminhos inseguros ou links simbólicos causam falha. O texto do modelo não fornece conteúdo dos artefatos.

O driver compara nomes, tamanhos e horários de modificação na raiz de exemplo antes e depois da chamada. Mudanças fora dos arquivos permitidos causam falha com "The helper wrote outside the allowed files. / O ajudante escreveu fora dos arquivos permitidos." Ficam fora da comparação `home/`, as pastas de configuração do cliente e o diretório de trabalho da demanda (`briefing.cwd`). Arquivos extras de trabalho são ignorados dentro de `briefing.cwd`; nunca viram artefatos. Um arquivo ou pasta que desaparece durante a segunda varredura conta como mudança. Outras falhas da varredura informam "Could not check the files. / Não foi possível conferir os arquivos." e preservam o uso medido.

O revisor recebe a execução, os artefatos e as verificações e pede um objeto JSON. Todo o texto final precisa ser um objeto válido com veredito exatamente `approved` ou `rejected`, `criteria` como lista e `feedback` como texto. Respostas ilegíveis ou inválidas são rejeitadas com explicação em inglês e português. Um resultado de erro do cliente não pode aprovar o trabalho.

Os dois papéis expõem `maxCostUsd`: `smoke.demoDemandMaxUsd` quando definido, senão `smoke.maxUsd`; clientes com `reportsCost: false` expõem zero. O `attempt.js` reduz esse limite superior ao menor saldo total/por demanda, inclusive no retrabalho. Só no modo real, cada chamada recebe o menor valor entre o limite do driver e `briefing.limits.maxUsd` pelos argumentos configurados existentes; o modo de teste mantém o comportamento original, em que `reserve` recusa o que passa do saldo. Não há novas opções de comando ou chaves de configuração. Somente o Claude Code impõe um teto em dinheiro dentro da chamada: o OpenCode não tem o espaço `{maxUsd}` e o Codex não informa dinheiro. No OpenCode o teto vale entre chamadas; se uma chamada passar do que foi reservado, `ledger.settle` falha e o custo total é informado como desconhecido.

Codex, assim como qualquer cliente com `reportsCost: false`, exige `smoke.maxTokens` inteiro positivo ao criar os drivers. Uma chamada cuja quantidade de texto informada ultrapasse `smoke.maxTokens` falha levando seu `usage` medido; o limite é conferido depois que a chamada termina.

O uso inclui a soma de texto de entrada e saída informado e os turnos do cliente (`num_turns` do Claude Code, turnos do Codex ou etapas do OpenCode). O dinheiro segue `smokeDrivers.<client>.reportsCost`: Codex informa `costUsd: 0` com a quantidade real de texto. Medições ausentes ou inválidas, inclusive em uma etapa anterior, produzem `costUsd: null` para interromper o orçamento. Custos informados nunca são reduzidos ao valor reservado. Prazo vencido, cancelamento e saída sem resultado final lançam erro com `usage`, `events` e `state`, preservando medições parciais.

| Deve aceitar | Deve recusar |
| :- | :- |
| JSON inteiro de revisão válido com `approved` | Lixo, texto ao redor, bloco de código, campos ausentes ou outros vereditos |
| Uso medido; texto do Codex sem dinheiro | Totais desconhecidos de dinheiro ou texto tratados como gratuitos |
| Arquivos comuns listados de até 128 KiB | Diretórios, outros arquivos especiais, arquivos maiores, caminhos que saem da raiz ou links simbólicos |
| Saídas permitidas e pastas do cliente e da demanda podem mudar | Mudanças no restante da raiz de exemplo, inclusive arquivos ou pastas que somem na segunda varredura |
| Pastas legíveis nas duas varreduras | Erros de acesso que impedem conferir os arquivos |
| `smoke.maxTokens` inteiro positivo para Codex; chamadas dentro do limite | Limite de texto ausente ou inválido para Codex; chamadas acima do limite |

Verificação offline: `node --test test/smoke-demo-driver.test.js test/smoke-client.test.js`. Processos falsos cobrem os três clientes, escritas em outra demanda ou no estado compartilhado, pastas permitidas do cliente e da demanda, limites de texto, arquivos comuns e a fronteira de 128 KiB. Testes da varredura simulam pastas ilegíveis e arquivos que desaparecem, conferindo que os erros preservam o uso. O prazo configurado é conferido pelo tempo decorrido; dois mutantes em memória comprovam que aprovar respostas ilegíveis e tratar uso desconhecido como gratuito falham nas verificações. Nenhum cliente real é iniciado.

Migração: execute o plugin como `okit-plugin`; instalar/atualizar removem apenas seus links antigos `okit`. Mantenha `okit`/`kit` do kit separados; o detector ignora executáveis do plugin.

Implementado: `okit-plugin smoke` executa 32 verificações isoladas. Acrescentar `--client claude-code`, `--client codex` ou `--client opencode` seleciona verificações no cliente real, também disponíveis por `client-smoke`. Os testes offline comprovam o tratamento dos comandos; o Produtor precisa verificar instalação e uso reais em cada cliente.

<a id="section-1"></a>
## Commands

`npm run smoke` roda o runner deste checkout e `okit-plugin smoke` o mesmo runner pelo binário instalado; os dois usam um home descartável e respondem `0` quando todo check selecionado passou, `1` quando um falhou ou estourou o tempo e `2` quando a execução foi recusada.

| Flag | Significado |
| :- | :- |
| `--real` | usar estado/configuração reais (`OKWORK_HOME` e `CLAUDE_CONFIG_DIR`, ou padrões no home); raiz do pacote não muda |
| `--keep` | deixar o home descartável em disco e imprimir o caminho |
| `--only <id>` | rodar só estes ids de check; separados por vírgula, repetível, um id desconhecido é recusado |
| `--timeout <ms>` | eleva o timeout de cada check para pelo menos esse valor; sem flag usa a tabela (fallback `60000`) |

Código de saída, os três que `src/cli.js` já usa: `0` quando todo check selecionado passou, `1` quando um falhou ou estourou o tempo, `2` para flag desconhecida, id desconhecido de `--only`, ou um `OKWORK_HOME` no ambiente sem `--real`.

<a id="section-2"></a>
## Scratch home rule

Cada execução cria `<scratch>/home`, `<scratch>/project` e `<scratch>/tmp` sob `os.tmpdir()` e roda todo filho com `HOME`/`USERPROFILE`, `OKWORK_HOME=<scratch>/home/.okwork`, `CLAUDE_CONFIG_DIR=<scratch>/home/.claude`, `XDG_CONFIG_HOME` e `TMPDIR`/`TEMP`/`TMP` dentro dele. O home real só é lido sob `--real`. O runner recebe a raiz descartável, o ambiente e o relógio como parâmetros, então `test/smoke-runner.test.js` o dirige com `mkdtemp(join(tmpdir(), 'smoke-'))` exatamente como `test/cli.test.js` faz hoje.

<a id="section-3"></a>
## What the runner reuses

O runner reutiliza núcleo, adaptadores e servidor MCP. `src/smoke.js` recebe dependências injetadas para exercitar instalação, recursos e remoção sem chamar clientes reais.

<a id="section-4"></a>
## Checks

Cada check tem id, nome, timeout e corpo. `status` é `pass`, `fail`, `timeout` ou `skip`, e só `pass` conta como sucesso.

**A. Instalação (`I`)** — id, nome, o que faz, timeout.

| id | nome | o que faz | timeout |
| :- | :- | :- | :- |
| `I1` | `files.placed` | `src/cli.js` (o bin `okit-plugin`), `src/mcp/server.js`, `adapters/claude-code/index.js` e `skills/okit-{director,executor,critic,smoke}/SKILL.md` são legíveis | 5 s |
| `I2` | `commands.registered` | `main()` aceita `daemon`, `autostart`, `status`; cada uma sai com `0`, um grupo desconhecido sai com `2` | 15 s |
| `I3` | `mcp.registered` | `initialize` e `tools/list` por `handleLine` nomeiam as ferramentas de `TOOL_NAMES` | 15 s |
| `I4` | `skills.installed` | `installSkill('okit-director')` escreve `skills/okit-director/SKILL.md` na raiz de configuração descartável; a segunda chamada reporta `identical` | 10 s |
| `I5` | `hooks.merged` | `installHooks` escreve `hooks/hooks.json`; sobre um arquivo editado pelo usuário mantém a entrada dele e reporta `written: false` | 10 s |
| `I6` | `permissions.readable` | a entrada `bin` e cada `SKILL.md` são arquivos legíveis; o modo é verificado fora do Windows | 5 s |
| `I7` | `version.matches` | `serverVersion()` é igual ao `version` de `package.json`, e `okit-plugin status` imprime a tabela | 10 s |

**B. Cada recurso, de ponta a ponta (`E`)**

**Daemon**

| id | nome | o que faz | timeout |
| :- | :- | :- | :- |
| `E1` | `daemon.run-once` | um `tick` anexa uma linha de decisão em `logs/<date>.jsonl` com `opened`, `spawned`, `skipped` | 20 s |
| `E2` | `daemon.pause` | `daemonPause` e depois uma passada registra `paused` e não abre nada; `daemonResume` limpa | 15 s |
| `E3` | `daemon.killswitch` | `daemon stop` escreve `daemon.stop`; `daemon start` limpa antes do laço | 15 s |
| `E4` | `daemon.lifecycle` | `daemonRun` com `sleep` injetado e um `AbortSignal` escreve `daemon.pid.json` e o remove na saída; uma segunda execução é recusada pelo lock `daemon` | 25 s |
| `E5` | `daemon.status` | `daemonStatus` lê `running: false` de um pid morto e `running: true` enquanto o laço injetado vive | 15 s |

**State / Estado**

| id | nome | o que faz | timeout |
| :- | :- | :- | :- |
| `E6` | `state.atomic` | `inboxAdd` escreve `inbox.json` por `writeJsonAtomic`, não deixa `.tmp` e relê o arquivo | 10 s |
| `E7` | `state.locks` | `withLock` recusa um segundo dono, libera, e toma um lock velho cujo pid está morto | 20 s |

**Execution / Execução**

| id | nome | o que faz | timeout |
| :- | :- | :- | :- |
| `E8` | `spawn.command` | `buildCommand` devolve o array de argumentos documentado para `claude-code`, `codex` e `opencode`, com o briefing por último, sem shell | 10 s |
| `E9` | `spawn.process` | `makeSpawner` com `spawn` injetado escreve `runs/<runId>.json` como `live` e `runs/<runId>.out`, e `maxMinutes` mata o filho | 15 s |
| `E10` | `limits.slots` | `acquireSlot` toma `limits.clients.<client>` ou `limits.global` slots e depois responde `ok: false` com o teto; `releaseSlot` libera um | 15 s |

**Installation / Instalação**

| id | nome | o que faz | timeout |
| :- | :- | :- | :- |
| `E11` | `autostart.plan` | `detectAutostart` por plataforma e `autostartPlan` para `systemd`, `cron`, `launchd`, `schtasks`; em `win32` os caminhos mantêm barra para a frente | 10 s |
| `E12` | `autostart.apply` | `applyAutostart` com `run`/`write` injetados instala, desinstala e relata o que escreveu; uma segunda instalação não escreve nada novo | 15 s |
| `E13` | `skills.packaged` | cada `skills/*/SKILL.md` tem frontmatter `name` e `description`, e `installSkillFiles` nunca sobrescreve um arquivo diferente | 10 s |
| `E14` | `mcp.tools` | as ferramentas respondem a `tools/call`; uma ferramenta desconhecida é `-32602` e uma linha inválida é `-32700`, e o laço continua lendo | 30 s |

**Workflow / Fluxo**

| id | nome | o que faz | timeout |
| :- | :- | :- | :- |
| `E15` | `inbox.flow` | adicionar, listar, `inboxSetStatus` ao longo da sequência, tudo persistido | 15 s |
| `E16` | `orders.flow` | adicionar, listar, revogar; a linha continua com `revokedReason` e uma segunda revogação é recusada | 15 s |
| `E17` | `templates.flow` | adicionar, listar, pausar e retomar, remover; `openDue` duas vezes no mesmo período abre um filho só | 20 s |

**Views / Visões**

| id | nome | o que faz | timeout |
| :- | :- | :- | :- |
| `E18` | `status.table` | `statusTable` tem suas seis colunas, uma linha de capacidade, nenhum ANSI, e outra palavra por idioma | 15 s |
| `E19` | `commands.every` | cada ação do CLI (`daemon start|stop|status|pause|resume|run-once`, `autostart show|install|uninstall`, `status`) sai com `0` com `run`/`spawn` injetados | 30 s |
| `E20` | `quota.below-launch-floor` | com runner de processos, `kit quota --cached --json` lê amostras locais simuladas, `kit capacity` informa zero executores disponíveis e `kit run` recusa com saída `6`, o motivo de cada executor e o horário de retorno mais próximo; mudar `parallel.minQuotaPercent` muda o gate para a mesma amostra; a orientação do plugin usa palavras simples em inglês e português | 15 s |

Sem um resultado de processo do runner de comandos injetado, E20 não afirma nada sobre o kit. Seu teste de integração encontra o kit instalado com `detectKit` e se pula com mensagem clara quando ele está ausente ou o sandbox nega a execução de processos com EPERM. HOME, configuração e registro de cota são temporários; KIT_HOME continua identificando o código do kit.

**C. Desinstalação e idempotência (`U`)**

| id | nome | o que faz | timeout |
| :- | :- | :- | :- |
| `U1` | `uninstall.skills` | a pasta que `I4` escreveu sumiu; uma segunda desinstalação de pasta ausente relata ausente, não erro | 10 s |
| `U2` | `uninstall.autostart` | `applyAutostart` com `action: 'uninstall'` roda os comandos do plano, não escreve arquivo e diz a mesma coisa duas vezes | 15 s |
| `U3` | `uninstall.state` | remover a raiz descartável leva `inbox.json`, `orders.json`, `logs/` e `locks/` junto; uma raiz recriada começa vazia | 15 s |
| `U4` | `idempotence.install` | o grupo `I` rodado duas vezes deixa a mesma árvore e os mesmos bytes; a segunda rodada reporta `skipped: identical` | 30 s |
| `U5` | `idempotence.run` | duas execuções em raízes descartáveis novas relatam os mesmos ids na mesma ordem; só o run id do nome dos artefatos muda | 30 s |

32 checks. O `--only` aceita ids (`--only I,E7`) e a letra do grupo. `--timeout <ms>` ergue o teto por check para um host Windows lento e nunca baixa um check que já tem teto menor; a execução inteira tem teto de 10 minutos.

<a id="section-5"></a>
## Checkout against installed plugin

| | padrão | `--real` |
| :- | :- | :- |
| raiz do plugin | a raiz do pacote que contém `src/smoke.js` (ou `io.pluginRoot` injetado) | a mesma raiz do pacote (ou `io.pluginRoot` injetado) |
| raiz de estado | `<scratch>/home/.okwork` | `OKWORK_HOME`, senão o `~/.okwork` real |
| raiz de configuração | `<scratch>/home/.claude` | `CLAUDE_CONFIG_DIR`, senão o `~/.claude` real |

`--real` é o único modo que toca nos arquivos do usuário, e ainda assim escreve seus artefatos em `<state root>/logs/smoke/`, nunca no repositório.

<a id="section-6"></a>
## Result record

Um objeto por check, e os mesmos campos no log humano: `id`, `name`, `group` (`E7`, `state.locks`, `E`); `status`, um entre `pass`, `fail`, `timeout`, `skip`, e só `pass` conta; `durationMs` e o `timeoutMs` em que rodou; `error`, a mensagem mais o primeiro quadro da pilha quando o corpo lançou; `command`, o argv que rodou como filho ou `''` quando o check ficou no processo; `environment`, com `os` (plataforma, release, arquitetura), `node`, `cwd`, `pluginRoot`, `stateRoot`, `configRoot`, `okitHome` e `pid`; e `logTail`, as últimas 20 linhas do arquivo que decidiu o check (`logs/<date>.jsonl`, `runs/<runId>.out` ou o stderr do filho).

<a id="section-7"></a>
## Output

O stdout é um fato por linha, a forma que `report()` de `src/cli.js` já imprime: `okit-plugin smoke`, `run: <runid>`, uma linha `pass E7 state.locks 120ms` por check, depois `passed: 32 failed: 0 skipped: 0`, os caminhos dos artefatos e, com `--keep`, o caminho do scratch.

Dois arquivos caem em `<state root>/logs/smoke/`: `smoke-<runid>.jsonl`, um objeto JSON por linha (o cabeçalho da execução e um registro por check, na ordem de execução), e `smoke-<runid>.log`, o texto humano com o bloco de ambiente inteiro no topo e cada tail na linha. Ambos são UTF-8 só com `\n`, então o arquivo do Windows cola numa issue sem mudança. O run id é o instante UTC mais o pid (`20261023T091530Z-4242`), o que separa duas execuções e as ordena.

<a id="section-8"></a>
## Safety

- **Tempo limitado**: todo check tem timeout e a execução tem teto de 10 minutos, então um check que trava vira um registro `timeout` e a execução ainda termina.
- **Sem rede**: nada no runner abre socket e nenhum CLI de cliente (`claude`, `codex`, `opencode`) é iniciado, já que todo spawn é injetado.
- **Repetível**: um home descartável novo por execução, uma ordem fixa de checks, nenhuma aleatoriedade no resultado além do run id.
- **Contido**: o runner escreve só sob sua própria raiz de estado e a pasta do `--keep`, toma o lock `smoke` dessa raiz e nunca toca na árvore de trabalho do repositório.
- **Interrupção segura**: `Ctrl-C` escreve o que já tem, remove o lock e sai com `1`.

<a id="section-9"></a>
## In-client smoke (real)

As verificações isoladas não iniciam clientes nem gastam cota. Escolher um cliente executa **dentro de uma sessão real do cliente** com Claude Code, Codex ou OpenCode e gasta a cota do usuário. As verificações buscam provas de que o plugin está instalado e em uso: ferramentas respondem, skills estão disponíveis e registros persistem. A falta de evidência continua sem comprovação.

Os testes sintéticos já existem: o `okit-plugin smoke` acima cobre o código. O que falta é um teste de **uso real**, então esta camada tem dois propósitos, e os checks se dividem assim:

1. **a instalação** — o plugin, as skills, os hooks, o servidor MCP e o daemon da instalação que o cliente realmente carrega;
2. **a lógica em uso real** — não que a ferramenta respondeu, mas que respondeu *certo* para uma entrada conhecida, julgado pelo disco ou pelo JSON da própria ferramenta.

| camada | a pergunta que responde | custo | onde roda |
| :- | :- | :- | :- |
| `okit-plugin smoke` (acima) | o código funciona? | segundos, sem cota | o processo do próprio plugin |
| `okit-plugin client-smoke` (esta seção) | o plugin está instalado, e funciona em uso real? | minutos, cota real | uma sessão real do cliente |

As duas camadas escrevem o mesmo formato de registro na mesma pasta de artefatos e respondem os mesmos três códigos de saída (0, 1, 2), então um leitor lê os dois logs. O que o `0` in-client *significa* é mais estrito que o do runner em processo, e a seção "Recusa, skip e falha" abaixo diz exatamente como.

### O roteiro

Uma lista ordenada de passos, escrita uma vez, usada por todos os drivers. Todo passo é um de três tipos:

- uma **chamada** que o cliente faz, pelo modelo, pelo pipe MCP de verdade;
- uma **preparação** que o runner faz antes das chamadas — uma entrada conhecida, sempre marcada `okit-smoke`, para poder ser achada e removida depois;
- uma **leitura** que o runner faz depois das chamadas — o fato em disco que decide o passo.

Um passo nomeia um recurso, a chamada que o toca e o **comportamento** que ele afirma. A lista é dado, não código, então o kit consegue carregar a mesma lista (veja o ponto de junção abaixo).

**A. A instalação (`C1`–`C5`)**

| id | recurso | o que prova | julgado a partir de |
| :- | :- | :- | :- |
| `C1` | plugin | o cliente carregou o plugin instalado | o `plugins[]` do evento `init`: o nome do nosso plugin e o caminho de onde ele foi carregado |
| `C2` | skills | as skills instaladas estão visíveis na sessão | o `skills[]` do evento `init`: `okit-director`, `okit-executor`, `okit-critic`, `okit-smoke` e `okit-setup` sob o namespace do plugin |
| `C3` | MCP | o servidor respondeu pelo pipe stdio de verdade | o `mcp_servers[]` do evento `init` traz o nosso servidor com `status: "connected"`, e o servidor respondeu `initialize` e `tools/list` com o inventário atual `TOOL_NAMES` |
| `C4` | hooks | um hook do plugin disparou | os eventos de hook do cliente; enquanto o plugin não trouxer `hooks/hooks.json`, é um `skip` com o motivo `hook-evidence-unavailable` |
| `C5` | daemon | o daemon da instalação deu um tick | o runner roda o bin `okit-plugin` instalado com `daemon run-once`, e a linha de decisão cai em `logs/<date>.jsonl` |

**B. A lógica, em uso real (`C6`–`C21`)**

**Slots / Vagas**

| id | recurso | o comportamento que afirma | julgado a partir de |
| :- | :- | :- | :- |
| `C6` | tetos | `limits_status` relata os tetos que a config declara | a resposta da ferramenta contra o `config.json` |
| `C7` | vaga | `acquire_slot` abaixo do teto responde `ok: true` e a vaga é real | a resposta, e `runs/<runId>.json` está `live` com o cliente que nomeamos |
| `C8` | vaga | `acquire_slot` **no** teto responde `ok: false` e nomeia o teto que recusou | o `reason` da resposta, e nenhum arquivo de execução foi escrito para aquele id |
| `C9` | vaga | `release_slot` devolve a vaga | a resposta é `ok: true` e `runs/<runId>.json` lê `done` |
| `C10` | vaga | `release_slot` de uma execução que nunca existiu recusa | a resposta é `ok: false` com `unknown run`, e nada foi escrito |

**Classification and profiles / Classificação e perfis**

| id | recurso | o comportamento que afirma | julgado a partir de |
| :- | :- | :- | :- |
| `C11` | esforço | `classify` dá `simple` para uma demanda curta conhecida | o `effort` da resposta é `simple`, com o motivo `short-body` |
| `C12` | esforço | `classify` dá `normal` para uma demanda média conhecida | o `effort` da resposta é `normal`, com o motivo `mid-body` |
| `C13` | esforço | `classify` dá `hard` para uma demanda longa conhecida | o `effort` da resposta é `hard`, com o motivo `long-body` |
| `C14` | perfil | `profile_pick` resolve o perfil que a config declara para a classe pedida | o `model` da resposta contra o perfil da classe, o catálogo padrão incluído — e a classe rebaixada quando a cota está abaixo do piso; sem `config.json` a instalação está sem configuração, então é um `skip` com o motivo `config-missing` e o relatório diz que a instalação está incompleta |

**Inbox**

| id | recurso | o comportamento que afirma | julgado a partir de |
| :- | :- | :- | :- |
| `C15` | caixa de entrada | `inbox_add` guarda a demanda que respondeu | a resposta, e o `inbox.json` tem o item com o título que mandamos |
| `C16` | caixa de entrada | `inbox_list` a lista | a lista da resposta tem aquele item |
| `C17` | caixa de entrada | `inbox_set_status` a move e o movimento persiste | a resposta, e o `inbox.json` lê `delegated` |
| `C18` | caixa de entrada | o movimento inválido é recusado | `pending` → `consolidated` é recusado, e o `inbox.json` ainda lê `pending` |

**Orders and recurrence / Ordens e recorrência**

| id | recurso | o comportamento que afirma | julgado a partir de |
| :- | :- | :- | :- |
| `C19` | ordem | `order_add` guarda a ordem que respondeu | a resposta, e o `orders.json` tem a linha como ativa |
| `C20` | ordem | `order_remove` a revoga e a ordem revogada deixa de ser listada | o `orders.json` guarda a linha com `revokedReason`, e o `order_list` não a lista mais |
| `C21` | template | um template vencido é aberto pelo daemon como demanda | o `inbox.json` tem a criança que o template abriu, e a linha de decisão do daemon lista aquele id em `opened` |

**C. O relatório (`C22`–`C23`)**

| id | recurso | o que prova | julgado a partir de |
| :- | :- | :- | :- |
| `C22` | status | a tabela bate com as leituras de cota | a linha do cliente na resposta do `status` traz a mesma porcentagem que o `quota/<client>.json`, e a palavra de situação que segue o piso |
| `C23` | relatório | os artefatos estão onde a execução disse | os dois arquivos no caminho impresso |

23 checks no grupo `C`, ao lado dos 32 dos grupos `I`, `E` e `U` — ids diferentes, então o `--only` de um runner nunca pega um check do outro.

Os arquivos de manifesto, MCP e hook do Claude Code são gerados pelo build de release; não ficam na raiz do checkout. O runner julga a instalação carregada pelo cliente, não a presença desses arquivos no checkout.

### Os drivers

Instale o comando escolhido (`claude`, `codex` ou `opencode`), entre na sua conta e configure o plugin nesse cliente. Uma execução real gasta cota; `--dry-run` não inicia modelos. Os comandos são `claude -p … --output-format stream-json`, `codex exec --json …` e `opencode run --format json …`. O Codex usa por padrão `--skip-git-repo-check`, `--sandbox workspace-write`, `--approve-for-me` e `--ephemeral`; OpenCode usa `--dir <pasta-temporária>` e `--auto`. Comandos, argumentos e verificações da ajuda são configuráveis em `smokeDrivers` no `config.json`; os padrões ficam em `DEFAULT_CONFIG`.

A ajuda instalada do Codex confirma as opções para ignorar a exigência de repositório, usar sandbox gravável, encaminhar aprovações para revisão e encerrar sem salvar a sessão. A ajuda do OpenCode confirma saída JSON, escolha da pasta e aprovação automática de permissões; o modo sem interação já é o padrão. A ajuda não lista opção para impedir que a sessão seja salva. Essas verificações da ajuda não comprovam uma execução real do modelo nem o comportamento real de aprovação do MCP.

As respostas das ferramentas de Codex e OpenCode passam pelas mesmas verificações das respostas de Claude Code. Como a saída não mostra detalhes de instalação do plugin, skills, hooks ou daemon, C1–C5 e C21 são pulados com explicação, sem chamada do cliente nesses passos; esses pulos, sozinhos, não deixam a execução vermelha. `smokeDrivers.<client>.reportsInstallation` registra se essa prova está disponível. `smokeDrivers.<client>.reportsCost` escolhe a contagem em dinheiro: `true` para Claude Code e OpenCode, `false` para Codex. A falta de medição de dinheiro ou texto interrompe novos trabalhos; medições parciais de uma chamada que falhou são preservadas. As quantidades de entrada e saída do Codex são somadas entre respostas; entrada reutilizada já está incluída. Uma execução real do Codex exige `smoke.maxTokens` positivo; `null` é aceito na prévia, mas recusa a execução real. Os custos e a quantidade de texto informados por etapa do OpenCode são somados. Só Claude Code tem teto em dinheiro comprovado dentro de uma chamada. A prévia explica os limites do ajudante escolhido sem gastar; a confirmação inicia a demonstração paga só com o mesmo plano, evidência atual de cota e, no Codex, `smoke.maxTokens` positivo.

Um roteiro, quatro maneiras de rodá-lo.

| driver | como | o que o usuário vê |
| :- | :- | :- |
| skill | o plugin traz a skill `okit-smoke`; o usuário digita `/okit-smoke` numa sessão com o plugin instalado | a narração de cada passo, depois o relatório |
| headless | `okit-plugin client-smoke --client claude-code --headless` | só o relatório, sem deixar sessão aberta |
| demo | `okit-plugin client-smoke --client claude-code --demo` | a narração de cada passo *enquanto* roda, depois o mesmo relatório de uma linha por check dos outros modos |
| dry run | `okit-plugin client-smoke --client claude-code --dry-run` | o que o roteiro *chamaria*, passo a passo — sem cliente, sem modelo, sem cota |

O runner sempre imprime duas linhas em volta da execução: `smoke: start client=claude-code mode=<mode>` antes de começar e `smoke: end exit=<code> artifacts=<folder>` quando termina, mesmo quando a execução é recusada ou falha. Quem perdeu a saída de uma execução ainda tem o código de saída e a pasta dos artefatos.

A skill é o driver do roteiro; os modos headless e demo são o mesmo roteiro sem uma pessoa no laço, então uma execução em CI é a mesma execução de uma mesa. O dry run percorre a mesma lista e relata o que chamaria, sem chamar o modelo e sem gastar cota: é o jeito barato de conferir o próprio roteiro, e o jeito de ensaiar uma mudança no roteiro antes que ela custe algo. No modo headless o runner inicia o cliente com

```
claude -p "<o roteiro como briefing>" \
  --output-format stream-json --include-hook-events --verbose \
  --max-budget-usd <n> --permission-mode <modo> --plugin-dir <checkout>
```

Toda flag acima foi lida de `claude --help` no Claude Code 2.1.304 (2026-10-23), e o runner recusa uma flag que o cliente não tem. Três delas trazem a própria regra, e o runner precisa obedecê-la:

| flag | a regra do cliente (do `--help`) | o que o runner faz com ela |
| :- | :- | :- |
| `--output-format stream-json` | "requires `--verbose`" quando usada com `--print` | o runner sempre passa `--verbose` junto |
| `--include-hook-events` | "only works with `--output-format=stream-json`" | o runner combina com `stream-json`, nunca com `json` |
| `--max-budget-usd <amount>` | "only works with `--print`" | o runner passa no modo headless e lê de volta o dinheiro gasto |

`--max-turns` **não** existe no cliente: `claude --help` não tem essa flag, e a seção 12.1 de `docs/maintainers/ARCHITECTURE.md` já diz isso para a 2.1.303. O `--max-turns` do runner abaixo é o teto **do próprio runner** sobre os passos do roteiro — ele nunca chega à linha de comando.

O runner lê o **fluxo de eventos** do cliente, não a prosa do modelo: o evento `init` traz `plugins[]`, `skills[]`, `tools[]` e `mcp_servers[]` (cada um com um `status`), que é a prova de `C1`, `C2`, `C3` e das doze ferramentas; os eventos `hook_started` e `hook_response` são a prova de `C4`; o evento final `result` traz `is_error`, `num_turns`, `total_cost_usd`, `permission_denials[]` e `terminal_reason`. O `--output-format json` de resultado único traz só o evento `result`, então ele não prova `C1`–`C4` e não é o que o runner usa.

**O modelo não é o juiz.** O roteiro nunca pergunta ao modelo "funcionou?". As ferramentas MCP são o que o roteiro *chama*; os arquivos são o *veredito*. Todo passo é uma chamada, e todo veredito vem de um fato em disco ou da resposta JSON da própria ferramenta: a raiz de estado, o arquivo da execução, a linha do log, o fluxo de eventos do próprio cliente. As palavras do modelo nunca entram num critério de aprovação — uma execução que passa é uma execução cujos arquivos dizem isso. É isso que torna a demo honesta: a narração é texto livre, o veredito não é.

### Orçamento: as variáveis, o teto e a pré-checagem de cota

Uma execução real gasta o dinheiro do usuário, então tem preço e piso. Nenhum dos dois está escrito no código: cada um é uma **variável de configuração**, uma chave em `config.json` sob a raiz de estado, que a fumaça lê e que uma flag pode sobrescrever por uma execução.

| variável em `config.json` | o que limita |
| :- | :- |
| `smoke.quotaFloorPct` | a cota abaixo da qual a execução é recusada antes de começar |
| `smoke.maxUsd` | interrompe novas chamadas ao atingir o total em dinheiro nos clientes com `reportsCost: true`; Claude Code também impõe o teto dentro de uma chamada usando `--max-budget-usd` |
| `smoke.maxTokens` | total informado pelo cliente de texto lido e escrito entre chamadas; inteiro positivo ou `null` (padrão). Uma execução real do Codex exige um valor positivo; adicione `"maxTokens": 50000` dentro de `"smoke"` no config.json e escolha um teto adequado. |
| `smoke.maxTurns` | os passos que o roteiro pode dar; o runner o impõe e nunca o passa ao cliente (o cliente não tem `--max-turns`) |
| `smoke.maxMinutes` | o relógio de parede de uma execução |
| `smoke.checkTimeoutMs` | o prazo de um check |

As flags são sobrescritas de uma execução dessas variáveis, e nada mais: `--quota-floor` sobrescreve `smoke.quotaFloorPct`, `--max-usd` sobrescreve `smoke.maxUsd`, `--max-turns` sobrescreve `smoke.maxTurns`, `--max-minutes` sobrescreve `smoke.maxMinutes` e `--timeout` sobrescreve `smoke.checkTimeoutMs`. Uma flag sem valor toma o valor da variável, e uma variável sem chave em `config.json` toma o seu valor padrão. O runner em processo da seção acima mantém os seus próprios defaults, então as duas camadas nunca derivam uma da outra.

Defina `smoke.maxTokens` na configuração para limitar a quantidade de texto que o cliente informa ter lido e escrito. Atingir ou ultrapassar o limite impede a próxima chamada, inclusive chamadas extras dentro da mesma verificação; o trabalho não executado recebe o mesmo motivo de orçamento esgotado usado pelo teto em dinheiro. Uma resposta pode ultrapassar o limite antes de ser medida. Se uma resposta omitir o uso de texto com o teto habilitado, novos trabalhos param porque não é possível medir o restante. Uma saída diferente de zero com resultado final preserva esse resultado, então a recusa de orçamento do Claude Code continua pulando o trabalho. Um resultado recebido antes do encerramento do processo também é preservado; o encerramento sem resultado falha a etapa.

A **pré-checagem de cota** lê a cota do próprio cliente antes do primeiro passo. Continua aceitando leituras manuais válidas e observações sem idade, além de leituras automáticas das sessões do Codex ou da fonte configurada do OpenCode. Quando informada, a idade precisa ser um número válido e não negativo, e o percentual precisa estar entre zero e cem. A pré-checagem compartilhada sinaliza leituras acima de `smoke.quotaMaxAgeMinutes` e recusa leituras vencidas por `smoke.quotaExpireMinutes`; a execução do smoke de Codex/OpenCode também recusa uma leitura sinalizada como antiga. Dados ausentes, inválidos, vencidos ou de outro cliente geram `quota-unknown` antes de chamar o cliente, salvo escolha explícita de `--allow-unknown-quota`. Abaixo de `smoke.quotaFloorPct`, a execução é sempre recusada. Há drivers incluídos para os três clientes.

No Claude Code, o teto é imposto pela própria flag: `--max-budget-usd` interrompe o gasto, e o evento `result` do cliente informa isso. Os passos que não rodaram são pulados. Um passo que nunca rodou nunca é aprovado. Codex e OpenCode não oferecem essa proteção comprovada dentro de uma chamada. Uma chamada do Claude Code que falha sem evento `result` é gasto não medido, então a execução para de propósito e informa que o gasto não pôde ser medido; uma falha que ainda traz um `result` com `total_cost_usd` é medida e não para a execução. Um passo que estoura o tempo registra `timeout` como motivo de parada mesmo sendo o último turno permitido, e, de propósito, um evento `error` do OpenCode depois do `stop` final ainda conta como falha (o Codex só ignora o erro tardio depois de `turn.completed`).

### Recusa, skip e falha

Três resultados, e a diferença entre eles é o ponto.

| resultado | quando | no relatório |
| :- | :- | :- |
| `pass` | o fato que o passo prova está lá | `pass C15 inbox.added 120ms` |
| `fail` | o passo rodou e o fato está errado ou falta: a ferramenta respondeu um erro, o arquivo não foi escrito, o estado não tem o registro | `fail C17 inbox.moved` com `error` e a tail |
| `skip` | o passo não rodou porque algo o recusou: o piso de cota, o teto de dinheiro, o pedido de permissão, o cliente recusando uma ferramenta, uma config ausente | `skip C14 profile.picked` com o motivo |

Uma recusa por cota ou por permissão é um `skip` com o motivo, nunca uma `fail`: o plugin não está quebrado quando a cota do usuário acabou ou quando o cliente pediu uma permissão que o usuário não deu. Uma `fail` fica reservada ao que o plugin prometeu e não entregou.

O código de saída diz se a *instalação* foi provada, e um check pulado nunca é lido como um run verde:

| saída | quando | o que significa |
| :- | :- | :- |
| `2` | a execução foi recusada **antes de começar**: a cota está abaixo do piso, a cota é desconhecida sem `--allow-unknown-quota`, a flag ou o cliente é desconhecido | nada foi verificado |
| `1` | a execução começou e algum check falhou, ou uma verificação de instalação que o cliente pode informar não passou | um check falhou ou falta prova de instalação que o cliente informa |
| `0` | a execução começou, nenhum check falhou e passaram as verificações que o cliente pode informar; provas indisponíveis de Codex/OpenCode são puladas | verificações informadas passaram; os pulos aparecem no resumo |

Claude Code informa detalhes da instalação para `C1`–`C5`. Codex e OpenCode não fornecem esses detalhes; por isso essas verificações e a verificação do daemon `C21` são puladas sem chamar o cliente e não entram na decisão sobre provas da instalação. Outras falhas continuam retornando `1`; os pulos são contados no resumo e aparecem na linha de execução parcial.

O motivo é uma palavra fixa, então um leitor conta recusas sem ler prosa: `quota-below-floor`, `quota-unknown`, `budget-exhausted`, `permission-denied`, `client-refused`, `hook-evidence-unavailable`, `config-missing`, `no-login`, `timeout`.

Um `skip` de motivo `config-missing` traz a própria frase no log humano: **a instalação está incompleta**, porque sem um `config.json` não há perfil para escolher. É o único skip que nomeia uma coisa que o usuário tem de consertar, então o relatório diz isso em palavras e não só numa palavra.

### Artefatos compartilhados

A execução dentro do cliente escreve **os mesmos dois artefatos, no mesmo lugar, no mesmo formato**: `<state root>/logs/smoke/smoke-<runid>.jsonl` e `smoke-<runid>.log`, o run id no mesmo formato (`20261023T091530Z-4242`), um objeto JSON por linha, o cabeçalho primeiro e um registro por check depois. O registro mantém os campos do registro em processo — `id`, `name`, `group`, `status`, `durationMs`, `timeoutMs`, `error`, `command`, `environment`, `logTail` — e o grupo de um registro in-client é `C`.

O cabeçalho inclui `kind: "smoke-in-client"`, `client` (`claude-code`) e `scenario` (a versão do roteiro). Quem lê o log em processo lê o log in-client sem parser novo, e os dois são achados pelo mesmo glob.

O `logTail` de um registro in-client é a tail do arquivo que decidiu o passo: o arquivo de estado, o da execução, o log do daemon ou a saída JSON do próprio cliente. Nada da sessão é guardado: uma execução deixa dois arquivos e uma linha de stdout.

### A instalação real é o padrão

Sem flags offline, o runner usa a instalação, configuração, login e estado reais. `--rehearsal` e `--dry-run` apenas percorrem o cenário: não iniciam cliente, não leem cota nem escrevem estado, e não provam a instalação. O estado resolve por `OKWORK_HOME` ou `~/.okwork`. Só os registros da própria execução são removidos; os artefatos permanecem. `--keep` preserva esses registros.

### Decisões

Seis, tomadas pelo Produtor em 2026-10-23. São decisões, não perguntas: a seção acima já as segue.

1. **O piso de cota é configurável.** O piso da execução in-client é definido por configuração — `smoke.quotaFloorPct`, o que a configuração disser que é —, para a execução in-client exatamente como para o kit.
2. **Config ausente é um `skip`, e o relatório diz que a instalação está incompleta.** `profile_pick` precisa de um perfil para a classe pedida, o do catálogo padrão ou o configurado; sem `config.json` a instalação está sem configuração, então `C14` é um `skip` com o motivo `config-missing`, e o log humano diz em palavras que a instalação está incompleta, porque é o único skip que o usuário tem de consertar.
3. **`C4` toma os próprios eventos de hook do cliente.** A prova é o que o cliente relata com `--include-hook-events` (com `stream-json --verbose`); se faltar evidência de hook, o check é um `skip` com o motivo `hook-evidence-unavailable`, então a execução diz que os hooks estão sem prova em vez de dizer que estão quebrados.
4. **A demo narra e relata.** O modo demo narra cada passo com as palavras do cliente *e* imprime no fim o mesmo relatório de uma linha por check dos outros modos: a narração é o que a pessoa assiste, o relatório é o que a pessoa confere.
5. **`--dry-run` existe.** O runner percorre o roteiro e relata o que chamaria, sem chamar o modelo e sem gastar cota — o jeito barato de conferir o próprio roteiro.
6. **O estado é lido dos arquivos.** As ferramentas MCP são o que o roteiro *chama*; os arquivos são o *veredito*. A raiz de estado compartilhada é exatamente a suposição testada, então o runner lê os arquivos direto, que é também o jeito mais rápido.

### Implementação atual

`src/smoke/scenario.js` exporta o cenário como dados; `src/smoke/client.js` resolve referências e executa os drivers, com vereditos em `client-checks.js`. A skill `skills/okit-smoke/SKILL.md` chama o runner existente.

<a id="section-10"></a>
## In-process implementation

`src/smoke/report.js` gera os registros e artefatos. As tabelas ficam em `checks-install.js`, `checks-features.js` e `checks-uninstall.js` sob `src/smoke/`. `src/smoke.js` executa o laço com timeout, lock e limpeza. Testes usam processos injetados; não provam uso real do cliente.

Versão em inglês: [SMOKE.md](SMOKE.md).
