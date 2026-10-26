# Teste de fumaça

Migração: execute o plugin como `okit-plugin`; instalar/atualizar removem apenas seus links antigos `okit`. Mantenha `okit`/`kit` do kit separados; o detector ignora executáveis do plugin.

Implementado: `okit-plugin smoke` executa 31 checks isolados; `okit-plugin client-smoke` executa o cenário C1–C23 com driver real de Claude Code. Não comprova outros clientes ou sistemas.

## Commands

`npm run smoke` roda o runner deste checkout e `okit-plugin smoke` o mesmo runner pelo binário instalado; os dois usam um home descartável e respondem `0` quando todo check selecionado passou, `1` quando um falhou ou estourou o tempo e `2` quando a execução foi recusada.

| Flag | Significado |
| :- | :- |
| `--real` | usar estado/configuração reais (`OKWORK_HOME` e `CLAUDE_CONFIG_DIR`, ou padrões no home); raiz do pacote não muda |
| `--keep` | deixar o home descartável em disco e imprimir o caminho |
| `--only <id>` | rodar só estes ids de check; separados por vírgula, repetível, um id desconhecido é recusado |
| `--timeout <ms>` | eleva o timeout de cada check para pelo menos esse valor; sem flag usa a tabela (fallback `60000`) |

Código de saída, os três que `src/cli.js` já usa: `0` quando todo check selecionado passou, `1` quando um falhou ou estourou o tempo, `2` para flag desconhecida, id desconhecido de `--only`, ou um `OKWORK_HOME` no ambiente sem `--real`.

## Scratch home rule

Cada execução cria `<scratch>/home`, `<scratch>/project` e `<scratch>/tmp` sob `os.tmpdir()` e roda todo filho com `HOME`/`USERPROFILE`, `OKWORK_HOME=<scratch>/home/.okwork`, `CLAUDE_CONFIG_DIR=<scratch>/home/.claude`, `XDG_CONFIG_HOME` e `TMPDIR`/`TEMP`/`TMP` dentro dele. O home real só é lido sob `--real`. O runner recebe a raiz descartável, o ambiente e o relógio como parâmetros, então `test/smoke-runner.test.js` o dirige com `mkdtemp(join(tmpdir(), 'smoke-'))` exatamente como `test/cli.test.js` faz hoje.

## What the runner reuses

O runner reutiliza núcleo, adaptadores e servidor MCP. `src/smoke.js` recebe dependências injetadas para exercitar instalação, recursos e remoção sem chamar clientes reais.

## Checks

Cada check tem id, nome, timeout e corpo. `status` é `pass`, `fail`, `timeout` ou `skip`, e só `pass` conta como sucesso.

**A. Instalação (`I`)** — id, nome, o que faz, timeout.

| id | nome | o que faz | timeout |
| :- | :- | :- | :- |
| `I1` | `files.placed` | `src/cli.js` (o bin `okit-plugin`), `src/mcp/server.js`, `adapters/claude-code/index.js` e `skills/okit-{director,executor,critic,smoke}/SKILL.md` são legíveis | 5 s |
| `I2` | `commands.registered` | `main()` aceita `daemon`, `autostart`, `status`; cada uma sai com `0`, um grupo desconhecido sai com `2` | 15 s |
| `I3` | `mcp.registered` | `initialize` e `tools/list` por `handleLine` nomeiam as 12 ferramentas de `TOOL_NAMES` | 15 s |
| `I4` | `skills.installed` | `installSkill('okit-director')` escreve `skills/okit-director/SKILL.md` na raiz de configuração descartável; a segunda chamada reporta `identical` | 10 s |
| `I5` | `hooks.merged` | `installHooks` escreve `hooks/hooks.json`; sobre um arquivo editado pelo usuário mantém a entrada dele e reporta `written: false` | 10 s |
| `I6` | `permissions.readable` | a entrada `bin` e cada `SKILL.md` são arquivos legíveis; o modo é verificado fora do Windows | 5 s |
| `I7` | `version.matches` | `serverVersion()` é igual ao `version` de `package.json`, e `okit-plugin status` imprime a tabela | 10 s |

**B. Cada recurso, de ponta a ponta (`E`)**

| id | nome | o que faz | timeout |
| :- | :- | :- | :- |
| `E1` | `daemon.run-once` | um `tick` anexa uma linha de decisão em `logs/<date>.jsonl` com `opened`, `spawned`, `skipped` | 20 s |
| `E2` | `daemon.pause` | `daemonPause` e depois uma passada registra `paused` e não abre nada; `daemonResume` limpa | 15 s |
| `E3` | `daemon.killswitch` | `daemon stop` escreve `daemon.stop`; `daemon start` limpa antes do laço | 15 s |
| `E4` | `daemon.lifecycle` | `daemonRun` com `sleep` injetado e um `AbortSignal` escreve `daemon.pid.json` e o remove na saída; uma segunda execução é recusada pelo lock `daemon` | 25 s |
| `E5` | `daemon.status` | `daemonStatus` lê `running: false` de um pid morto e `running: true` enquanto o laço injetado vive | 15 s |
| `E6` | `state.atomic` | `inboxAdd` escreve `inbox.json` por `writeJsonAtomic`, não deixa `.tmp` e relê o arquivo | 10 s |
| `E7` | `state.locks` | `withLock` recusa um segundo dono, libera, e toma um lock velho cujo pid está morto | 20 s |
| `E8` | `spawn.command` | `buildCommand` devolve o array de argumentos documentado para `claude-code`, `codex` e `opencode`, com o briefing por último, sem shell | 10 s |
| `E9` | `spawn.process` | `makeSpawner` com `spawn` injetado escreve `runs/<runId>.json` como `live` e `runs/<runId>.out`, e `maxMinutes` mata o filho | 15 s |
| `E10` | `limits.slots` | `acquireSlot` toma `limits.perClient` slots e depois responde `ok: false` com o teto; `releaseSlot` libera um | 15 s |
| `E11` | `autostart.plan` | `detectAutostart` por plataforma e `autostartPlan` para `systemd`, `cron`, `launchd`, `schtasks`; em `win32` os caminhos mantêm barra para a frente | 10 s |
| `E12` | `autostart.apply` | `applyAutostart` com `run`/`write` injetados instala, desinstala e relata o que escreveu; uma segunda instalação não escreve nada novo | 15 s |
| `E13` | `skills.packaged` | cada `skills/*/SKILL.md` tem frontmatter `name` e `description`, e `installSkillFiles` nunca sobrescreve um arquivo diferente | 10 s |
| `E14` | `mcp.tools` | as 12 ferramentas respondem a `tools/call`; uma ferramenta desconhecida é `-32602` e uma linha inválida é `-32700`, e o laço continua lendo | 30 s |
| `E15` | `inbox.flow` | adicionar, listar, `inboxSetStatus` ao longo da sequência, tudo persistido | 15 s |
| `E16` | `orders.flow` | adicionar, listar, revogar; a linha continua com `revokedReason` e uma segunda revogação é recusada | 15 s |
| `E17` | `templates.flow` | adicionar, listar, pausar e retomar, remover; `openDue` duas vezes no mesmo período abre um filho só | 20 s |
| `E18` | `status.table` | `statusTable` tem suas seis colunas, uma linha de capacidade, nenhum ANSI, e outra palavra por idioma | 15 s |
| `E19` | `commands.every` | cada ação do CLI (`daemon start|stop|status|pause|resume|run-once`, `autostart show|install|uninstall`, `status`) sai com `0` com `run`/`spawn` injetados | 30 s |

**C. Desinstalação e idempotência (`U`)**

| id | nome | o que faz | timeout |
| :- | :- | :- | :- |
| `U1` | `uninstall.skills` | a pasta que `I4` escreveu sumiu; uma segunda desinstalação de pasta ausente relata ausente, não erro | 10 s |
| `U2` | `uninstall.autostart` | `applyAutostart` com `action: 'uninstall'` roda os comandos do plano, não escreve arquivo e diz a mesma coisa duas vezes | 15 s |
| `U3` | `uninstall.state` | remover a raiz descartável leva `inbox.json`, `orders.json`, `logs/` e `locks/` junto; uma raiz recriada começa vazia | 15 s |
| `U4` | `idempotence.install` | o grupo `I` rodado duas vezes deixa a mesma árvore e os mesmos bytes; a segunda rodada reporta `skipped: identical` | 30 s |
| `U5` | `idempotence.run` | duas execuções em raízes descartáveis novas relatam os mesmos ids na mesma ordem; só o run id do nome dos artefatos muda | 30 s |

31 checks. O `--only` aceita ids (`--only I,E7`) e a letra do grupo. `--timeout <ms>` ergue o teto por check para um host Windows lento e nunca baixa um check que já tem teto menor; a execução inteira tem teto de 10 minutos.

## Checkout against installed plugin

| | padrão | `--real` |
| :- | :- | :- |
| raiz do plugin | a raiz do pacote que contém `src/smoke.js` (ou `io.pluginRoot` injetado) | a mesma raiz do pacote (ou `io.pluginRoot` injetado) |
| raiz de estado | `<scratch>/home/.okwork` | `OKWORK_HOME`, senão o `~/.okwork` real |
| raiz de configuração | `<scratch>/home/.claude` | `CLAUDE_CONFIG_DIR`, senão o `~/.claude` real |

`--real` é o único modo que toca nos arquivos do usuário, e ainda assim escreve seus artefatos em `<state root>/logs/smoke/`, nunca no repositório.

## Result record

Um objeto por check, e os mesmos campos no log humano: `id`, `name`, `group` (`E7`, `state.locks`, `E`); `status`, um entre `pass`, `fail`, `timeout`, `skip`, e só `pass` conta; `durationMs` e o `timeoutMs` em que rodou; `error`, a mensagem mais o primeiro quadro da pilha quando o corpo lançou; `command`, o argv que rodou como filho ou `''` quando o check ficou no processo; `environment`, com `os` (plataforma, release, arquitetura), `node`, `cwd`, `pluginRoot`, `stateRoot`, `configRoot`, `okitHome` e `pid`; e `logTail`, as últimas 20 linhas do arquivo que decidiu o check (`logs/<date>.jsonl`, `runs/<runId>.out` ou o stderr do filho).

## Output

O stdout é um fato por linha, a forma que `report()` de `src/cli.js` já imprime: `okit-plugin smoke`, `run: <runid>`, uma linha `pass E7 state.locks 120ms` por check, depois `passed: 31 failed: 0 skipped: 0`, os caminhos dos artefatos e, com `--keep`, o caminho do scratch.

Dois arquivos caem em `<state root>/logs/smoke/`: `smoke-<runid>.jsonl`, um objeto JSON por linha (o cabeçalho da execução e um registro por check, na ordem de execução), e `smoke-<runid>.log`, o texto humano com o bloco de ambiente inteiro no topo e cada tail na linha. Ambos são UTF-8 só com `\n`, então o arquivo do Windows cola numa issue sem mudança. O run id é o instante UTC mais o pid (`20261023T091530Z-4242`), o que separa duas execuções e as ordena.

## Safety

- **Tempo limitado**: todo check tem timeout e a execução tem teto de 10 minutos, então um check que trava vira um registro `timeout` e a execução ainda termina.
- **Sem rede**: nada no runner abre socket e nenhum CLI de cliente (`claude`, `codex`, `opencode`) é iniciado, já que todo spawn é injetado.
- **Repetível**: um home descartável novo por execução, uma ordem fixa de checks, nenhuma aleatoriedade no resultado além do run id.
- **Contido**: o runner escreve só sob sua própria raiz de estado e a pasta do `--keep`, toma o lock `smoke` dessa raiz e nunca toca na árvore de trabalho do repositório.
- **Interrupção segura**: `Ctrl-C` escreve o que já tem, remove o lock e sai com `1`.

## In-client smoke (real)

O runner acima é a camada barata: não inicia cliente nenhum, não gasta cota e prova o código. Esta seção é a outra camada, e roda **dentro de uma sessão real do cliente** — Claude Code primeiro, Codex e opencode depois. Gasta a cota do usuário de propósito, e compra o que o runner em processo não compra: a prova de que o plugin está *instalado e em uso* — o cliente carregou o plugin, o servidor MCP dele responde por um pipe stdio de verdade, as skills estão lá, os hooks disparam, o daemon dá um tick, e a caixa de entrada, as ordens permanentes e os templates guardam o que o cliente escreveu.

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
| `C3` | MCP | o servidor respondeu pelo pipe stdio de verdade | o `mcp_servers[]` do evento `init` traz o nosso servidor com `status: "connected"`, e o servidor respondeu `initialize` e `tools/list` com os 12 nomes |
| `C4` | hooks | um hook do plugin disparou | os eventos de hook do cliente; enquanto o plugin não trouxer `hooks/hooks.json`, é um `skip` com o motivo `hook-evidence-unavailable` |
| `C5` | daemon | o daemon da instalação deu um tick | o runner roda o bin `okit-plugin` instalado com `daemon run-once`, e a linha de decisão cai em `logs/<date>.jsonl` |

**B. A lógica, em uso real (`C6`–`C21`)**

| id | recurso | o comportamento que afirma | julgado a partir de |
| :- | :- | :- | :- |
| `C6` | tetos | `limits_status` relata os tetos que a config declara | a resposta da ferramenta contra o `config.json` |
| `C7` | vaga | `acquire_slot` abaixo do teto responde `ok: true` e a vaga é real | a resposta, e `runs/<runId>.json` está `live` com o cliente que nomeamos |
| `C8` | vaga | `acquire_slot` **no** teto responde `ok: false` e nomeia o teto que recusou | o `reason` da resposta, e nenhum arquivo de execução foi escrito para aquele id |
| `C9` | vaga | `release_slot` devolve a vaga | a resposta é `ok: true` e `runs/<runId>.json` lê `done` |
| `C10` | vaga | `release_slot` de uma execução que nunca existiu recusa | a resposta é `ok: false` com `unknown run`, e nada foi escrito |
| `C11` | esforço | `classify` dá `simple` para uma demanda curta conhecida | o `effort` da resposta é `simple`, com o motivo `short-body` |
| `C12` | esforço | `classify` dá `normal` para uma demanda média conhecida | o `effort` da resposta é `normal`, com o motivo `mid-body` |
| `C13` | esforço | `classify` dá `hard` para uma demanda longa conhecida | o `effort` da resposta é `hard`, com o motivo `long-body` |
| `C14` | perfil | `profile_pick` resolve o perfil que a config declara para a classe pedida | o `model` da resposta contra o perfil da classe, o catálogo padrão incluído — e a classe rebaixada quando a cota está abaixo do piso; sem `config.json` a instalação está sem configuração, então é um `skip` com o motivo `config-missing` e o relatório diz que a instalação está incompleta |
| `C15` | caixa de entrada | `inbox_add` guarda a demanda que respondeu | a resposta, e o `inbox.json` tem o item com o título que mandamos |
| `C16` | caixa de entrada | `inbox_list` a lista | a lista da resposta tem aquele item |
| `C17` | caixa de entrada | `inbox_set_status` a move e o movimento persiste | a resposta, e o `inbox.json` lê `delegated` |
| `C18` | caixa de entrada | o movimento inválido é recusado | `pending` → `consolidated` é recusado, e o `inbox.json` ainda lê `pending` |
| `C19` | ordem | `order_add` guarda a ordem que respondeu | a resposta, e o `orders.json` tem a linha como ativa |
| `C20` | ordem | `order_remove` a revoga e a ordem revogada deixa de ser listada | o `orders.json` guarda a linha com `revokedReason`, e o `order_list` não a lista mais |
| `C21` | template | um template vencido é aberto pelo daemon como demanda | o `inbox.json` tem a criança que o template abriu, e a linha de decisão do daemon lista aquele id em `opened` |

**C. O relatório (`C22`–`C23`)**

| id | recurso | o que prova | julgado a partir de |
| :- | :- | :- | :- |
| `C22` | status | a tabela bate com as leituras de cota | a linha do cliente na resposta do `status` traz a mesma porcentagem que o `quota/<client>.json`, e a palavra de situação que segue o piso |
| `C23` | relatório | os artefatos estão onde a execução disse | os dois arquivos no caminho impresso |

23 checks no grupo `C`, ao lado dos 31 dos grupos `I`, `E` e `U` — ids diferentes, então o `--only` de um runner nunca pega um check do outro.

Os arquivos de manifesto, MCP e hook do Claude Code são gerados pelo build de release; não ficam na raiz do checkout. O runner julga a instalação carregada pelo cliente, não a presença desses arquivos no checkout.

### Os drivers

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

`--max-turns` **não** existe no cliente: `claude --help` não tem essa flag, e a seção 12.1 de `docs/ARCHITECTURE.md` já diz isso para a 2.1.303. O `--max-turns` do runner abaixo é o teto **do próprio runner** sobre os passos do roteiro — ele nunca chega à linha de comando.

O runner lê o **fluxo de eventos** do cliente, não a prosa do modelo: o evento `init` traz `plugins[]`, `skills[]`, `tools[]` e `mcp_servers[]` (cada um com um `status`), que é a prova de `C1`, `C2`, `C3` e das doze ferramentas; os eventos `hook_started` e `hook_response` são a prova de `C4`; o evento final `result` traz `is_error`, `num_turns`, `total_cost_usd`, `permission_denials[]` e `terminal_reason`. O `--output-format json` de resultado único traz só o evento `result`, então ele não prova `C1`–`C4` e não é o que o runner usa.

**O modelo não é o juiz.** O roteiro nunca pergunta ao modelo "funcionou?". As ferramentas MCP são o que o roteiro *chama*; os arquivos são o *veredito*. Todo passo é uma chamada, e todo veredito vem de um fato em disco ou da resposta JSON da própria ferramenta: a raiz de estado, o arquivo da execução, a linha do log, o fluxo de eventos do próprio cliente. As palavras do modelo nunca entram num critério de aprovação — uma execução que passa é uma execução cujos arquivos dizem isso. É isso que torna a demo honesta: a narração é texto livre, o veredito não é.

### Orçamento: as variáveis, o teto e a pré-checagem de cota

Uma execução real gasta o dinheiro do usuário, então tem preço e piso. Nenhum dos dois está escrito no código: cada um é uma **variável de configuração**, uma chave em `config.json` sob a raiz de estado, que a fumaça lê e que uma flag pode sobrescrever por uma execução.

| variável (uma chave em `config.json`) | o que limita | o valor padrão da variável |
| :- | :- | :- |
| `smoke.quotaFloorPct` | a cota abaixo da qual a execução é recusada antes de começar | `20` |
| `smoke.maxUsd` | o dinheiro que uma execução pode gastar; o próprio cliente o impõe (`--max-budget-usd` no Claude Code, que `claude --help` confirma) | `1.00` |
| `smoke.maxTurns` | os passos que o roteiro pode dar; o runner o impõe e nunca o passa ao cliente (o cliente não tem `--max-turns`) | o número de passos do roteiro |
| `smoke.maxMinutes` | o relógio de parede de uma execução | `15` |
| `smoke.checkTimeoutMs` | o prazo de um check | `60000` |

As flags são sobrescritas de uma execução dessas variáveis, e nada mais: `--quota-floor` sobrescreve `smoke.quotaFloorPct`, `--max-usd` sobrescreve `smoke.maxUsd`, `--max-turns` sobrescreve `smoke.maxTurns`, `--max-minutes` sobrescreve `smoke.maxMinutes` e `--timeout` sobrescreve `smoke.checkTimeoutMs`. Uma flag sem valor toma o valor da variável, e uma variável sem chave em `config.json` toma o seu valor padrão. O runner em processo da seção acima mantém os seus próprios defaults, então as duas camadas nunca derivam uma da outra.

A **pré-checagem de cota** lê a leitura do próprio cliente (`quota/<client>.json`, o arquivo que o `readQuota` do adaptador já lê) *antes* do primeiro passo. Abaixo do piso — `smoke.quotaFloorPct`, o mesmo limiar que a ordem O5 do kit usa — a execução não começa: nada é gasto, nenhum check roda, e a execução responde `2`, porque nada foi verificado. O motivo vai no cabeçalho da execução no relatório, e não como um check, porque nenhum check existe. Uma leitura ausente não é um zero: a execução só prossegue com `--allow-unknown-quota`, que diz em voz alta que ninguém sabe a cota.

O teto é *duro* no sentido de ser a flag do próprio cliente, não uma promessa dentro de um prompt: `--max-budget-usd` faz o cliente parar de gastar, e o evento `result` do próprio cliente diz isso — `terminal_reason: "budget_exhausted"` com `subtype: "error_max_budget_usd"`. Os passos que não rodaram são `skip` com o motivo `budget-exhausted`. Um passo que nunca rodou nunca é um `pass`.

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
| `1` | a execução começou e a instalação **não** foi provada: algum check é `fail`, ou um de `C1`–`C5` não passou | a instalação está quebrada ou sem prova |
| `0` | a execução começou, `C1`–`C5` passaram todos, nada falhou, e todo outro check passou ou foi pulado (o teto de custo, uma config ausente) | a instalação está provada |

`C1`–`C5` são a própria instalação (plugin, skills, handshake do MCP, hooks, daemon), então um deles pulado é tão ruim quanto um deles falhado: o ponto da execução é a instalação, e uma instalação sem prova não é um `0`. Os checks de `C6` em diante são a lógica em uso real, e os que o teto de custo cortou — ou que um `--rehearsal` não pôde rodar, por falta de login — são relatados como pulados, contados no resumo e seguidos de uma linha `PARCIAL`: a execução sai `0` mas diz em voz alta que não verificou tudo.

O motivo é uma palavra fixa, então um leitor conta recusas sem ler prosa: `quota-below-floor`, `quota-unknown`, `budget-exhausted`, `permission-denied`, `client-refused`, `hook-evidence-unavailable`, `config-missing`, `no-login`, `timeout`.

Um `skip` de motivo `config-missing` traz a própria frase no log humano: **a instalação está incompleta**, porque sem um `config.json` não há perfil para escolher. É o único skip que nomeia uma coisa que o usuário tem de consertar, então o relatório diz isso em palavras e não só numa palavra.

### O log entra no log do D19

A execução dentro do cliente escreve **os mesmos dois artefatos, no mesmo lugar, no mesmo formato**: `<state root>/logs/smoke/smoke-<runid>.jsonl` e `smoke-<runid>.log`, o run id no mesmo formato (`20261023T091530Z-4242`), um objeto JSON por linha, o cabeçalho primeiro e um registro por check depois. O registro mantém os campos do registro do D19 — `id`, `name`, `group`, `status`, `durationMs`, `timeoutMs`, `error`, `command`, `environment`, `logTail` — e o grupo de um registro in-client é `C`.

O cabeçalho inclui `kind: "smoke-in-client"`, `client` (`claude-code`) e `scenario` (a versão do roteiro). Quem lê o log do D19 lê o log in-client sem parser novo, e os dois são achados pelo mesmo glob.

O `logTail` de um registro in-client é a tail do arquivo que decidiu o passo: o arquivo de estado, o da execução, o log do daemon ou a saída JSON do próprio cliente. Nada da sessão é guardado: uma execução deixa dois arquivos e uma linha de stdout.

### A instalação real é o padrão

Sem flags offline, o runner usa a instalação, configuração, login e estado reais. `--rehearsal` e `--dry-run` apenas percorrem o cenário: não iniciam cliente, não leem cota nem escrevem estado, e não provam a instalação. O estado resolve por `OKWORK_HOME` ou `~/.okwork`. Só os registros da própria execução são removidos; os artefatos permanecem. `--keep` preserva esses registros.

### Decisões

Seis, tomadas pelo Produtor em 2026-10-23. São decisões, não perguntas: a seção acima já as segue.

1. **O piso de cota é o da ordem.** O piso da execução in-client é o mesmo limiar que a ordem O5 do kit usa — `smoke.quotaFloorPct`, o que a configuração disser que é —, para a execução in-client exatamente como para o kit.
2. **Config ausente é um `skip`, e o relatório diz que a instalação está incompleta.** `profile_pick` precisa de um perfil para a classe pedida, o do catálogo padrão ou o configurado; sem `config.json` a instalação está sem configuração, então `C14` é um `skip` com o motivo `config-missing`, e o log humano diz em palavras que a instalação está incompleta, porque é o único skip que o usuário tem de consertar.
3. **`C4` toma os próprios eventos de hook do cliente.** A prova é o que o cliente relata com `--include-hook-events` (com `stream-json --verbose`); se faltar evidência de hook, o check é um `skip` com o motivo `hook-evidence-unavailable`, então a execução diz que os hooks estão sem prova em vez de dizer que estão quebrados.
4. **A demo narra e relata.** O modo demo narra cada passo com as palavras do cliente *e* imprime no fim o mesmo relatório de uma linha por check dos outros modos: a narração é o que a pessoa assiste, o relatório é o que a pessoa confere.
5. **`--dry-run` existe.** O runner percorre o roteiro e relata o que chamaria, sem chamar o modelo e sem gastar cota — o jeito barato de conferir o próprio roteiro.
6. **O estado é lido dos arquivos.** As ferramentas MCP são o que o roteiro *chama*; os arquivos são o *veredito*. A raiz de estado compartilhada é exatamente a suposição testada, então o runner lê os arquivos direto, que é também o jeito mais rápido.

### Implementação atual

`src/smoke/scenario.js` exporta o cenário como dados; `src/smoke/client.js` resolve referências e executa os drivers, com vereditos em `client-checks.js`. A skill `skills/okit-smoke/SKILL.md` chama o runner existente.

## In-process implementation

`src/smoke/report.js` gera os registros e artefatos. As tabelas ficam em `checks-install.js`, `checks-features.js` e `checks-uninstall.js` sob `src/smoke/`. `src/smoke.js` executa o laço com timeout, lock e limpeza. Testes usam processos injetados; não provam uso real do cliente.

Versão em inglês: [SMOKE.md](SMOKE.md).
