# Teste de fumaça

Estado: design. Estende [ARCHITECTURE.md](ARCHITECTURE.md) e [DESIGN.md](DESIGN.md). Um comando prova que o plugin está instalado e que cada recurso funciona de ponta a ponta, sobre um home descartável, em Windows, macOS e Linux, e deixa um log que uma pessoa manda para depurar (D17 foi encontrado por uma execução de `node --test` no Windows).

## Comandos

`npm run smoke` roda o runner deste checkout e `okit smoke` o mesmo runner pelo binário instalado; os dois usam um home descartável.

| Flag | Significado |
| :- | :- |
| `--real` | agir sobre a instalação real: a raiz do plugin que o cliente carrega, o `~/.okwork` real, o `~/.claude` real |
| `--keep` | deixar o home descartável em disco e imprimir o caminho |
| `--only <id>` | rodar só estes ids de check; separados por vírgula, repetível, um id desconhecido é recusado |
| `--timeout <ms>` | timeout padrão por check, `60000`; um check com timeout menor mantém o seu |

Código de saída, os três que `src/cli.js` já usa: `0` quando todo check selecionado passou, `1` quando um falhou ou estourou o tempo, `2` para flag desconhecida, id desconhecido de `--only`, ou um `OKWORK_HOME` no ambiente sem `--real`.

## Regra do home descartável

Cada execução cria `<scratch>/home`, `<scratch>/project` e `<scratch>/tmp` sob `os.tmpdir()` e roda todo filho com `HOME`/`USERPROFILE`, `OKWORK_HOME=<scratch>/home/.okwork`, `CLAUDE_CONFIG_DIR=<scratch>/home/.claude`, `XDG_CONFIG_HOME` e `TMPDIR`/`TEMP`/`TMP` dentro dele. O home real só é lido sob `--real`. O runner recebe a raiz descartável, o ambiente e o relógio como parâmetros, então `test/smoke-runner.test.js` o dirige com `mkdtemp(join(tmpdir(), 'smoke-'))` exatamente como `test/cli.test.js` faz hoje.

## Checks

Cada check tem id, nome, timeout e corpo. `status` é `pass`, `fail`, `timeout` ou `skip`, e só `pass` conta como sucesso.

**A. Instalação (`I`)** — id, nome, o que faz, timeout.

| id | nome | o que faz | timeout |
| :- | :- | :- | :- |
| `I1` | `files.placed` | `src/cli.js` (o bin `okit`), `src/mcp/server.js`, `adapters/claude-code/index.js` e `skills/okit-{director,executor,critic}/SKILL.md` são legíveis | 5 s |
| `I2` | `commands.registered` | `main()` aceita `daemon`, `autostart`, `status`; cada uma sai com `0`, um grupo desconhecido sai com `2` | 15 s |
| `I3` | `mcp.registered` | `initialize` e `tools/list` por `handleLine` nomeiam as 12 ferramentas de `TOOL_NAMES` | 15 s |
| `I4` | `skills.installed` | `installSkill('okit-director')` escreve `skills/okit-director/SKILL.md` na raiz de configuração descartável; a segunda chamada reporta `identical` | 10 s |
| `I5` | `hooks.merged` | `installHooks` escreve `hooks/hooks.json`; sobre um arquivo editado pelo usuário mantém a entrada dele e reporta `written: false` | 10 s |
| `I6` | `permissions.readable` | a entrada `bin` e cada `SKILL.md` são arquivos legíveis; o modo é verificado fora do Windows | 5 s |
| `I7` | `version.matches` | `serverVersion()` é igual ao `version` de `package.json`, e `okit status` imprime a tabela | 10 s |

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

## Checkout contra o plugin instalado

| | padrão | `--real` |
| :- | :- | :- |
| raiz do plugin | o checkout (`process.cwd()`, com `skills/` e `adapters/` ao lado) | o que o cliente carrega, de `CLAUDE_PLUGIN_ROOT` ou do caminho real do bin `okit` |
| raiz de estado | `<scratch>/home/.okwork` | `OKWORK_HOME`, senão o `~/.okwork` real |
| raiz de configuração | `<scratch>/home/.claude` | `CLAUDE_CONFIG_DIR`, senão o `~/.claude` real |

`--real` é o único modo que toca nos arquivos do usuário, e ainda assim escreve seus artefatos em `<state root>/logs/smoke/`, nunca no repositório.

## Registro de resultado

Um objeto por check, e os mesmos campos no log humano: `id`, `name`, `group` (`E7`, `state.locks`, `E`); `status`, um entre `pass`, `fail`, `timeout`, `skip`, e só `pass` conta; `durationMs` e o `timeoutMs` em que rodou; `error`, a mensagem mais o primeiro quadro da pilha quando o corpo lançou; `command`, o argv que rodou como filho ou `''` quando o check ficou no processo; `environment`, com `os` (plataforma, release, arquitetura), `node`, `cwd`, `pluginRoot`, `stateRoot`, `configRoot`, `okitHome` e `pid`; e `logTail`, as últimas 20 linhas do arquivo que decidiu o check (`logs/<date>.jsonl`, `runs/<runId>.out` ou o stderr do filho).

## Saída

O stdout é um fato por linha, a forma que `report()` de `src/cli.js` já imprime: `okit smoke`, `run: <runid>`, uma linha `pass E7 state.locks 120ms` por check, depois `passed: 31 failed: 0 skipped: 0`, os caminhos dos artefatos e, com `--keep`, o caminho do scratch.

Dois arquivos caem em `<state root>/logs/smoke/`: `smoke-<runid>.jsonl`, um objeto JSON por linha (o cabeçalho da execução e um registro por check, na ordem de execução), e `smoke-<runid>.log`, o texto humano com o bloco de ambiente inteiro no topo e cada tail na linha. Ambos são UTF-8 só com `\n`, então o arquivo do Windows cola numa issue sem mudança. O run id é o instante UTC mais o pid (`20261023T091530Z-4242`), o que separa duas execuções e as ordena.

## Segurança

- **Tempo limitado**: todo check tem timeout e a execução tem teto de 10 minutos, então um check que trava vira um registro `timeout` e a execução ainda termina.
- **Sem rede**: nada no runner abre socket e nenhum CLI de cliente (`claude`, `codex`, `opencode`) é iniciado, já que todo spawn é injetado.
- **Repetível**: um home descartável novo por execução, uma ordem fixa de checks, nenhuma aleatoriedade no resultado além do run id.
- **Contido**: o runner escreve só sob sua própria raiz de estado e a pasta do `--keep`, toma o lock `smoke` dessa raiz e nunca toca na árvore de trabalho do repositório.
- **Interrupção segura**: `Ctrl-C` escreve o que já tem, remove o lock e sai com `1`.

## Plano de implementação

Quatro passos, três arquivos cada, cada um mergeado sozinho e cada um terminando com um `node --test` verde. Nenhuma dependência nova: só `node:test` e `node:fs`.

**Passo 1 — o registro e os artefatos.** Novo `src/smoke/report.js` com `environmentOf`, `recordOf` e `writeArtifacts`. Novo `test/smoke-runner.test.js` afirma o conjunto de campos de um registro, uma linha por check no jsonl e o bloco de ambiente no log.

**Passo 2 — as tabelas de check.** Novos `src/smoke/checks-install.js`, `src/smoke/checks-features.js` e `src/smoke/checks-uninstall.js`: as tabelas `I`, `E` e `U` acima como `{ id, name, group, timeoutMs, run }`, com `deps` para raiz, ambiente, relógio e o `spawn`/`run` injetados. Novo `test/smoke-checks.test.js` afirma ids únicos, timeout positivo em cada um, os ids deste arquivo, e todo check passando sobre uma raiz descartável (um corpo com falha injetado relatando `fail`).

**Passo 3 — o runner e o CLI.** Novo `src/smoke.js`: a regra do home descartável, o laço com o timeout por check e o teto da execução, `--only`, `--keep`, o lock `smoke`, e `runSmoke(argv, io)` devolvendo `{ code, records, artifacts }` com `io` na forma que `main()` de `src/cli.js` já recebe. Edição de `src/cli.js` para o grupo `smoke`, o `USAGE` e a recusa de `--real`. `test/smoke-runner.test.js` passa então a cobrir os casos de D18: uma fumaça que passa sai com `0` e escreve os dois artefatos; um check com falha injetada sai com `1` e tem `id`, `error`, `command` e `environment` no registro.

**Passo 4 — o script, os códigos e o changelog.** Edição de `package.json` para `"smoke": "node src/cli.js smoke"`. Edição de `test/cli.test.js` para os códigos do grupo novo (`0`, `1` numa falha, `2` numa flag ou id de `--only` desconhecido) e para a recusa de `OKWORK_HOME` sem `--real`. Linha em `CHANGELOG.md` sob `[Unreleased]`.

Versão em inglês: [SMOKE.md](SMOKE.md).