# Arquitetura

A CLI usa `install.command` (padrão `okit-plugin`) e o `bin` do pacote. Links antigos do plugin migram ao instalar/atualizar; links do kit são preservados. O detector rejeita executáveis do plugin, inclusive links antigos `okit`. A identidade MCP e `~/.okwork` permanecem iguais.

Estende [DESIGN.md](DESIGN.md); responde às perguntas em aberto. Um núcleo em Node (>=20, sem dependências), três adaptadores finos, um servidor MCP sobre o núcleo.

## 1. Core contract

O inbox guarda demandas com `id`, `title`, `body`, `kind`, `accept`, `effort`, `client`, `appliesTo`, `status`, `stepIds`, `ext`, `createdAt`. `kind` é texto livre. Ordens ficam em um único arquivo, filtradas por `appliesTo`. Briefing, crítica e consolidação são instruções das skills e não APIs adicionais do núcleo.

## 2. MCP tools

O núcleo expõe 15 ferramentas MCP em `src/mcp/tools.js`: `acquire_slot`, `release_slot`, `limits_status`, `status`, `actors_list`, `classify`, `profile_pick`, `inbox_add`, `inbox_list`, `inbox_claim`, `inbox_release`, `inbox_set_status`, `order_add`, `order_list`, `order_remove`. Planejamento, briefing, crítica e consolidação são orientações das skills; não são ferramentas MCP.

Itens podem ter `hold: {client, session, worktree, takenAt, via}`;
`via` vale `claim` ou `producer`. `heldBefore` guarda donos anteriores com
`releasedAt` e `reason` (incluindo `stale` e `producer takeover`). Itens antigos sem
posse continuam válidos. Toda mutação usa a trava da inbox e escrita atômica.
A identidade é cliente mais sessão. O mesmo dono repete idempotentemente; outro dono
ativo é recusado. A obsolescência usa `inbox.holdStaleMinutes` (padrão 120, inteiro >= 1).
Liberação pelo dono ou obsoleta e `consolidated`/`failed` limpam a posse. Delegação aceita
`holder` opcional; quando fornecido, deve corresponder ao dono existente. Chamadas antigas o omitem.
Listagem MCP e status mostram a posse em inglês ou português. Só `okit-plugin inbox take`
com `--producer-takeover` força transferência, após mostrar a situação (incluindo Git
com `inbox.gitTimeoutMs`, padrão 5000) e confirmação TTY ou `--yes`.
O dono confirmado é comparado novamente sob a trava para recusar mudanças intervenientes.

## 3. State on disk

Raiz: `node:path.join(os.homedir(), '.okwork')`, sobrescrevível com `OKWORK_HOME`. Nunca dentro do diretório de um plugin de cliente: a raiz do plugin se move a cada atualização.

```
config.json               limites por cliente, regras de texto curto, caminhos dos adaptadores
inbox.json                itens da caixa
orders.json               ordens permanentes
templates.json            modelos recorrentes
quota/<client>.json       uma leitura de cota por cliente
runs/<runId>.json         um arquivo por execução delegada
locks/<name>.lock/        diretórios de trava criados com mkdir
logs/<date>.jsonl         eventos append-only, um registro de decisão por passagem do daemon
daemon.pid.json           pid e hora de início do daemon em execução
daemon.paused             arquivo de pausa, escrito por daemonPause
daemon.stop               chave de parada, lida pelo daemon
```

Arquivos do lado do projeto ficam ao lado do projeto, não nesta raiz: o `CLAUDE.md` do próprio projeto (Claude Code) ou `AGENTS.md` (Codex, opencode). As ordens permanentes não são um deles — todas moram em `orders.json` aqui, ligadas a um projeto pelo `appliesTo`.

- Escrita: serializar para `<file>.<pid>.<random>.tmp`, depois `fs.rename` sobre o destino, para que nenhum leitor veja arquivo pela metade. Em `EPERM` ou `EBUSY` (Windows), tentar o rename de novo algumas vezes antes de falhar.
- Trava: `fs.mkdir` na pasta `<name>.lock`, que guarda `owner.json` `{pid, startedAt}`; `EEXIST` significa ocupado; liberar com `rmdir`, que espera `EPERM`/`EBUSY` como toda outra chamada: o arquivo removido foi escrito e fechado há um instante, e uma trava deixada para trás por essa recusa guarda o dono de um processo que já saiu e é mais nova que `staleMs`, ou seja, que nenhum concorrente consegue tomar. Uma liberação respondida por `ENOTEMPTY` (esvaziada, mas um concorrente escreveu uma entrada de volta antes do `rmdir`) ou por `ENOENT` (outro concorrente já removeu) conta como liberada: a entrada que respondeu é a única evidência que todo concorrente lê, de modo que tentar de novo tiraria a trava de um dono vivo.
- Trava velha: uma trava é velha quando passa de `staleMs` (padrão 30 s) **e** seu pid está morto; sem `owner.json` legível, usa-se o `mtime` da pasta e não há checagem de pid. A tomada reivindica a pasta do dono morto no lugar: renomeia o `owner.json` do dono morto para fora da pasta (só um rename pode vencer) e depois cria o seu próprio `owner.json` de forma exclusiva (`wx`), para que dois concorrentes não vençam os dois. A pasta nunca é movida para o lado. Uma recusa do Windows que dure mais que as tentativas de qualquer passo dessa reivindicação abandona a tentativa e deixa a pasta como foi encontrada, para que o laço de espera a julgue de novo em vez de a aquisição terminar num código cru.
- Um escritor por arquivo: caixa, ordens e execuções são arquivos separados, para que dois passos do mesmo item não se bloqueiem.

## 4. Adapter interface
Cada adaptador fornece estas cinco operações, além dos auxiliares documentados. O núcleo importa um adaptador, nunca um cliente.

| Função | Entrada | Saída |
| :- | :- | :- |
| `spawn(actor, briefing, opts)` | perfil do ator, resumo | `{ runId, pid }`, ou `{ runId }` para execução no processo |
| `readQuota()` | nenhuma | `{ source, remainingPct?, windowMinutes? }` |
| `capabilities()` | nenhuma | `{ models[], efforts[], skills, hooks, mcp, desktop, windows }` |
| `installSkill(name, files)` | pasta da skill | `{ path }` |
| `installHooks(files)` | configuração do cliente ou caminho do módulo | `{ path }` |

### 4.1 Os adaptadores incluídos

| Adaptador | Modos | Instalação de hooks |
| :- | :- | :- |
| Claude Code | Descritor NATIVE; PROCESS | Mescla entradas JSON |
| Codex | Descritor NATIVE; PROCESS | Recusa explícita, sem I/O |
| opencode | PROCESS | Copia um módulo JS global |

`adapters/claude-code/index.js` são as cinco funções desta seção para um cliente, e é o adaptador que o núcleo importa em vez da CLI. `spawn` devolve `{mode: 'NATIVE', runId, agentCall: {model, effort, prompt}}` sem iniciar processo, e em `PROCESS` reaproveita `makeSpawner` de `src/spawn-process.js`. `readQuota` responde `{source: 'user'}` e só acrescenta `remainingPct`/`windowMinutes` a partir de `quota/claude-code.json`. `installSkill` copia para `<root>/skills/<name>/` por `installSkillFiles`, `installHooks` combina `<root>/hooks/hooks.json` sem descartar entrada alguma do usuário, e a raiz é `opts.root`, depois `CLAUDE_CONFIG_DIR`, depois `~/.claude`. Codex também implementa descritores nativos e processos; opencode suporta só PROCESS. A instalação de hooks do Codex recusa; opencode instala um módulo JS.

## 5. Quota
- `source: api` — leitura de API injetada; nenhum adaptador incluído consulta API de cota.
- `source: user` — sem número; perguntar uma vez, guardar em `quota/<client>.json`,velho depois de `windowMinutes`.
- `source: off` — o usuário recusou, ou o cliente não tem canal; a escolha de classe ignora a cota.

Não estimar cota. `profilePick` rebaixa uma classe quando `remainingPct < lowQuotaPct`; `source: off` e leitura ausente não rebaixam. Os adaptadores devolvem `source: user`, com números apenas quando armazenados.

### 5.1 A tabela de cota

A coluna Cota dos atores mostra o estado traduzido, o menor percentual restante e a idade da leitura, sem texto de ordens em Markdown ou JSON. Um cliente sem atores configurados recebe apenas a nota de configuração. Um `--client` inválido na CLI imprime o uso e sai com código 2, como em `status`. Locales extras em `actors.messages` se limitam aos aceitos pela CLI e pelo MCP (`LABELS`/`LOCALES`).

`actors_list` / `okit-plugin actors [--client <nome>|--all] [--json] [--locale en|pt-BR]` é somente leitura. Ator é um par modelo + esforço disponível em um cliente, com tamanhos derivados do mapa configurado `actors.sizeClasses` (padrão S→simple, M→normal, L→hard); `actors.criticClass` aparece à parte. `src/actors.js` compartilha seleção de cliente/cota do status e lê `limitsStatus` sem adquirir/liberar vagas. Status descreve executores rodando; actors lista perfis mesmo sem nada rodando. Pares iguais combinam tamanhos. Tamanhos ausentes indicam o vizinho disponível mais próximo; empates favorecem o anterior no mapa. Cota baixa e vagas ocupadas incluem motivos e soluções; cota desconhecida não bloqueia. Um comando guiado para configurar modelos está a caminho; até lá, peça à pessoa que mantém o okit.

`src/status.js` é a visão dessas leituras, não uma segunda fonte delas: `statusTable(root, deps)` formata as leituras, o relógio, as contagens do limite e as ordens permanentes fornecidos em `deps`, usando os `LABELS` fixos do idioma, e devolve `{markdown, capacityLine, rows}`. A tabela termina com uma frase fixa, traduzida, dizendo que vagas são executores em execução e `actors` lista os perfis modelo + esforço disponíveis. Essa frase é um rótulo, não uma leitura de entrada em `deps`. As colunas são `Subscription | 5h remaining | Week remaining | Resets in | Status | Source (age)`; um array `windows` preenche as duas colunas e, sem ele, o `remainingPct` único vai para a coluna de 5h quando `windowMinutes <= 360` e para a da semana caso contrário, inclusive quando `windowMinutes` está ausente.

`okit-plugin status [--all] [--client <nome>] [--locale en|pt-BR]` mostra apenas o cliente detectado por padrão. `--all` mostra todos os clientes configurados (os três conhecidos quando não há perfis); `--client claude-code|codex|opencode` escolhe um e tem prioridade sobre `--all`. Se a detecção falhar, todos aparecem com uma nota explicando `--client`. O `status` do MCP aceita `all` e `client` opcionais com a mesma regra. As contagens de executores em uso e disponíveis incluem apenas os clientes mostrados.

`detectClient(deps.env)` usa a tabela nomeada `CLIENT_ENV_MARKERS`: `CLAUDECODE` para Claude Code, `CODEX_THREAD_ID` ou `CODEX_CI` para Codex, `OPENCODE` ou `OPENCODE_PID` para opencode. Valores vazios ou `0` não identificam uma sessão; pastas de configuração não identificam um cliente em uso. CLI e MCP passam `ctx.env` (o ambiente real do processo quando não injetado); a tabela em si lê apenas o ambiente injetado.

A coluna Situação é uma palavra, nunca ANSI: `verde` com 15 pontos ou mais acima de `lowQuotaPct`, `amarelo` do piso até essa marca e `vermelho` abaixo do piso. A palavra vem da janela mais apertada; uma linha vermelha cita a ordem sobre o piso, recorrendo a `lowQuotaPct` quando não existe uma. Sem leitura, diz “Nenhum valor de cota registrado” e informa o comando que registra: `okit-plugin quota set <cliente> <pct>`. Nenhum percentual é estimado e não há coleta automática. O valor registrado mostra a idade desde `recordedAt`, inclusive após renovar o cache; leituras antigas sem data usam a hora da primeira leitura. Abaixo da tabela, cada cliente mostrado tem vivas/teto, origem própria/padrão e vagas disponíveis com mínimo zero, além do piso. Toda palavra vive em `LABELS` com `en` e `pt-BR`, escolhida por `deps.locale`.

As leituras ficam em cache por cliente durante `ttlMs` (60 s por padrão) medido em `deps.now`, então duas chamadas seguidas custam uma leitura. `shouldShowStatus({size, slices, executors})` é verdadeiro para tamanho `L`, `slices >= 2` ou `executors > 1`, e é quando o Diretor mostra a tabela. `okit-plugin daemon status --table [--locale en|pt-BR]` imprime a mesma tabela embaixo das linhas do daemon, e uma passagem do daemon nunca lê cota por ela: `daemonStatus(root, { table })` só monta a tabela quando essas dependências são entregues.

## 6. Windows rules
- Construir todo caminho com `node:path`, nunca concatenando separadores; guardar com barra direta, a forma que o Claude Code substitui, para que o que escrevemos corresponda ao que o cliente lê.
- Sem shell: `child_process.spawn` com array de argumentos. Comandos de hook na forma shell são preocupação do cliente, não nossa.
- Escrever só `\n`, com codificação explícita e sem padrão de plataforma, para que um arquivo escrito no Windows seja lido igual no Linux.
- Travas com `fs.mkdir` se comportam igual de forma nativa e no WSL; sem `flock`, sem `setsid`.
- Passagem manual antes de uma versão: instalar o plugin, adicionar um item na caixa, delegar um passo, ler o voto da crítica, consolidar, reiniciar o cliente, confirmar que o estado sobreviveu.

O modo `PROCESS` inicia os clientes sem shell; no Windows os shims `.cmd` exigem resolver antes o executável de verdade (item em aberto da passagem do Windows).

## 7. Concurrency limit
| Escopo | Padrão | Lido de |
| :- | :- | :- |
| Padrão para cada cliente | 3 atores ao mesmo tempo | `limits.global` em `config.json` |
| Configuração própria | Suplanta o padrão | `limits.clients.<client>`; cota não altera o teto |

Não há teto somado entre clientes. Por exemplo, `clients: {"claude-code": 100}`
permite 100 execuções vivas nesse cliente independentemente de `global`.
Inteiros positivos são validados na leitura; clientes desconhecidos geram aviso.
O antigo `perClient` é apelido obsoleto que suplanta `global`, com aviso no status;
`global` não significa mais um total compartilhado. Cada verificação relê a configuração sem reiniciar.

O núcleo conta execuções vivas em `runs/<runId>.json` (`status: live`) em vez de confiar que o cliente respeita o teto. `acquireSlot` usa `waitMs: 0` por padrão e retorna `ok: false` sem vaga; o chamador pode pedir espera. `releaseSlot` encerra a reserva; a contagem ignora execuções mais velhas que `staleMinutes` (30 por padrão). O Codex se limita sozinho com `agents.max_concurrent_threads_per_session`; deixar no mesmo número para os dois concordarem.

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

## 9. Recurring templates
| Função | Efeito |
| :- | :- |
| `templateAdd(root, input, { now })` | Guarda um modelo e a ordem permanente que deixa ele rodar sem ninguém assistindo; o nome precisa estar livre. |
| `templateList(root, { name })` | Ordem de criação; um nome desconhecido lança erro. |
| `templateSet(root, name, patch)` | Edita um campo, pausa, retoma ou renomeia; uma renomeação retagueia os filhos abertos e revoga a ordem antiga. |
| `templateRemove(root, name)` | Remove o registro e revoga sua ordem permanente com um motivo. |
| `due(root, nowMs, ctx)` | Decide todos os modelos neste instante e não escreve nada. |
| `plan(root, nowMs, ctx)` | O ensaio geral: as decisões mais as demandas que seriam criadas. |
| `openDue(root, nowMs, ctx)` | Abre um filho por modelo vencido, uma vez por período; a checagem e a escrita dividem uma trava, então uma segunda chamada no mesmo período e dois chamadores em corrida não criam nada a mais. |

Campos obrigatórios: `name`, `schedule` e `demand` (`title`, mais `kind`, `body`, `accept`, `ext` opcionais). Guardas opcionais: `window`, `timeZone`, `minQuotaPct`, `onlyWhenIdle` (padrão falso), `skipIfOpen` (padrão verdadeiro), `catchup` (`run` ou `skip`), `maxRunsPerPeriod`, `paused` e `appliesTo`. Cada filho carrega `ext.template` e `ext.period` e herda o `appliesTo` do modelo, para que um armazenamento global de modelos ainda saiba a qual caixa cada execução pertence.

## 10. Standing orders
Uma ordem é uma linha que o mantenedor escreve uma vez e o Diretor lê a cada demanda. O JSON continua sendo a fonte; `orderRender` é só uma visão.

| Função | Efeito |
| :- | :- |
| `orderAdd(root, { text, scope, until, origin, appliesTo }, { projectRoot })` | Adiciona uma ordem ativa no armazenamento único; `until` precisa ser uma data no futuro. Um `layer` é recusado com `layer is gone: use appliesTo`. |
| `orderRemove(root, id, { reason })` | Revoga: `active: false` com `revokedAt` e `revokedReason`. Nada é apagado, então o histórico sobrevive. Uma segunda revogação é recusada. |
| `orderStatus(order, now)` | O status derivado de uma ordem: `revoked`, `expired` ou `active`. |
| `orderList(root, { activeOnly, appliesTo, now }, { projectRoot })` | Lista o armazenamento único. `activeOnly` descarta revogadas e vencidas. Cada ordem volta com o `status` derivado e, quando inativa, a data `purgeAfter`. |
| `orderMigrateProjects(root, projectRoots)` | Migração única do arquivo antigo do lado do projeto para o armazenamento; devolve `{ moved, skipped }`. |
| `orderLint(root, { now })` | O que quem lê o arquivo tropeçaria: texto vazio, escopo desconhecido, data ilegível, id repetido, ordem ativa com `until` passado, duas ordens vivas com o mesmo texto. |
| `purgeAfter(order, retentionDays, now)` | O instante em que uma ordem inativa pode ser expurgada, ou `undefined` para uma ativa. |
| `orderPurge(root, { now, retentionDays })` | Remove para sempre toda ordem inativa cuja retenção acabou, e anexa `{ at, purged: [ids] }` a `logs/<date>.jsonl`. |
| `orderRender(orders)` | Markdown para leitura humana. |

O status é computado a partir da linha e nunca é gravado no arquivo, então quem lê o JSON vê só o que foi escrito:

| Status | Como é derivado |
| :- | :- |
| `revoked` | `active` não é `true`: a ordem foi revogada, e o motivo está em `revokedReason`. |
| `expired` | `until` é uma data que não está no futuro. No instante exato de `until` a ordem já está vencida. |
| `active` | Qualquer outra coisa: nunca revogada e ainda dentro do seu `until`. |

Revogar marca, não apaga: a linha continua com `active: false`, `revokedAt` e `revokedReason`. Adicionar de novo o mesmo texto depois cria uma ordem nova com id novo, e uma segunda revogação do mesmo id é recusada para que o primeiro motivo sobreviva. Uma ordem inativa é então expurgada para sempre quando a retenção acaba, e a expurgo fica registrado: `purgeAfter` é `revokedAt` para uma ordem revogada e `until` para uma vencida, mais `orders.retentionDays` (padrão 90) no `config.json`; `orderPurge` remove a linha do armazenamento único só quando essa data chega, e escreve `{ at, purged: [ids] }` em `logs/<date>.jsonl` para que o rastro do que saiu sobreviva à remoção. Um `orders.retentionDays` quebrado volta ao padrão em vez de travar quem lê.

Um armazenamento: toda ordem vive em `orders.json` na raiz do estado e o id é `G000001`. Não existe mais a camada de projeto — o projeto é escolhido pelo `appliesTo`, que nomeia os ids ou caminhos aos quais a ordem se liga, e uma ordem sem ele vale para todos. `orderAdd` com `layer` é recusado com `layer is gone: use appliesTo`. A migração única `orderMigrateProjects(root, projectRoots)` copia cada `<projectRoot>/.okwork/orders.json` do layout antigo para o armazenamento com `appliesTo` apontando para aquele projeto, `origin` `migrated:project` e um id `G` novo, preservando texto, escopo, `until`, `active` e os campos de revogação; uma linha já copiada é pulada (mesmo texto mais `appliesTo`), a cópia acontece antes de o arquivo antigo ser renomeado para `orders.json.migrated` e ele nunca é apagado. Ela roda de forma preguiçosa em `orderList`/`orderAdd` quando um `projectRoot` é passado, que é o único uso que resta de `projectRoot`. `scope` é `all` ou `effort:simple`, `effort:normal`, `effort:hard`; `origin` é texto livre, com padrão `maintainer`, e um modelo escreve `template:<name>`. A ordem de um modelo é criada junto com o registro, movida em uma renomeação e revogada com motivo na remoção, então a ordem que permitia a execução deixa de permitir.

## 11. The daemon
O daemon é a metade sem tela: ninguém assiste, então todo limite que ele respeita é técnico. O núcleo não inicia nada por conta própria — `spawn` é injetado, então um teste o conduz e um adaptador o conduz de verdade.

A ordem de uma passagem, `tick`:

| # | Passo | Regra |
| :- | :- | :- |
| 1 | Pausa | `daemon.paused` existe: o registro diz `paused`, nada é aberto e nada é iniciado. O laço continua rodando. |
| 2 | Chave de parada | `daemon.stop` existe: o registro diz `stopped: kill switch`, e `daemonRun` sai do laço. |
| 3 | Piso de cota | Todos os clientes das demandas pendentes abaixo de `daemon.minQuotaPct` param a passagem. Um cliente sem leitura não está abaixo do piso, então um cliente não medido nunca paralisa o daemon. |
| 4 | Retenção | `orderPurge` tira do armazenamento único toda ordem inativa cujo `orders.retentionDays` já acabou e anexa `{ at, purged: [ids] }` a `logs/<date>.jsonl`. Um daemon pausado ou parado não expurga nada. |
| 5 | Modelos vencidos | `openDue` com a pior leitura da passagem: a cota mais baixa e a menor ociosidade dos clientes que ele conhece. |
| 6 | Demandas pendentes, mais antiga primeiro | A caixa lista das mais novas para as mais antigas, então a fila é invertida e uma demanda que espera atrás de outras nunca passa fome. Um período atende uma execução por vez: enquanto um irmão do mesmo `ext.template` e `ext.period` está `delegated` ou `criticised`, os outros esperam. |
| 7 | Teto | Por demanda: `classify` quando o item não tem `effort`, `profilePick`, depois `acquireSlot` antes de o iniciador rodar e `releaseSlot` se ele recusar, então uma recusa não custa nada. |
| 8 | Uma linha de decisão | `{ at, opened, spawned, skipped, purged, stopped?, paused? }` anexada como uma única linha JSON em `logs/<date>.jsonl`, para quem lê o fim do arquivo ver sempre uma passagem inteira. |

O daemon nunca recusa uma demanda por conta própria: uma demanda é pulada apenas por um limite técnico (pausa, chave de parada, piso de cota, teto de concorrência) ou por falha do iniciador, e cada pulo diz qual foi.

| Função | Efeito |
| :- | :- |
| `tick(root, deps)` | Uma passagem; devolve o registro de decisão e o anexa. |
| `daemonRun(root, deps, { signal, sleep })` | O laço: toma a trava do daemon, escreve `daemon.pid.json`, dá uma passagem a cada `daemon.intervalSeconds`, roda a rotação dos logs uma vez por dia, sai na chave de parada ou em `signal.abort()`, e remove o arquivo de pid na saída. |
| `daemonStatus(root, { now })` | Diz se está rodando, seu pid, quando começou, se está pausado e o último registro de decisão. |
| `daemonPause(root)` / `daemonResume(root)` | Escrevem e removem o arquivo de pausa. |
| `rotateLogs(root, keepDays, now)` | Remove `logs/*.jsonl` mais velhos que `daemon.logKeepDays` por hora de modificação e devolve os nomes removidos. |

O iniciador é injetado: `deps` traz `now()`, `quota(client)`, `idle(client)` e `spawn(demand, { client, profile, limits, maxTurns, maxMinutes, runId })`. O `runId` que ele recebe é a vaga já reservada para a execução, então devolver o mesmo id é o caminho barato; devolver outro move a vaga para esse id, e quando esse id não pode ser tomado o original é tomado de novo.

Ritmo: o intervalo é marcado por um relógio monotônico, então um salto do relógio de parede para frente ou para trás não muda nem o número de passagens nem a idempotência por período. Um daemon por raiz: `daemonRun` segura a trava `daemon` e lança erro quando outro já a segura. `daemonStatus` exige um pid vivo e um arquivo de pid que não esteja velho, então um daemon que morreu lido como parado mesmo com o arquivo de pid ainda em disco. Os padrões vivem em `daemon` no `config.json`: `intervalSeconds` 60, `minQuotaPct` 10, `logKeepDays` 14; um valor quebrado nunca para o laço. A retenção das ordens permanentes mora ao lado, em `orders`: `retentionDays` 90, os dias inteiros que uma ordem inativa é guardada antes de ser expurgada, onde um valor quebrado volta ao padrão.

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

| Ferramenta | Entrada | Embrulha | Uma linha |
| :- | :- | :- | :- |
| `actors_list` | `locale?`, `all?`, `client?` | `listActors` | Atores configurados, tamanhos, cota, vagas, motivos e alternativas; somente leitura. |
| `acquire_slot` | `runId`, `client`, `waitMs?` | `acquireSlot` | Reserva uma vaga, ou responde `ok: false` com o teto que recusou. |
| `release_slot` | `runId` | `releaseSlot` | Libera a vaga de uma execução. |
| `limits_status` | nenhum | `limitsStatus` | Os tetos e as execuções vivas por cliente. |
| `status` | `locale?`, `all?`, `client?`, `size?`, `slices?`, `executors?` | `statusTable` / `shouldShowStatus` | Cota e capacidade do cliente detectado/escolhido; `all` mostra todos; com os fatos da tarefa, também `showBefore`. |
| `classify` | `title`, `body?`, `kind?` | `classify` | `simple`, `normal` ou `hard`, mais o porquê. |
| `profile_pick` | `client`, `effort`, `quota?` | `profilePick` | Modelo, esforço de raciocínio e `maxTurns` vindos do `config.json`. |
| `inbox_add` | `title`, `body?`, `kind?`, `accept?`, `effort?`, `client?`, `appliesTo?` | `inboxAdd` | Adiciona uma demanda e devolve o item guardado. |
| `inbox_list` | `status?`, `client?`, `appliesTo?`, `limit?`, `locale?` | `inboxList` | Lista as demandas e seus donos, das mais novas às mais antigas. |
| `inbox_claim` | `id`, `client`, `session?`, `worktree?` | `inboxClaim` | Assume demanda sem dono ou obsoleta. |
| `inbox_release` | `id`, `client`, `session?` | `inboxRelease` | Libera posse própria ou obsoleta. |
| `inbox_set_status` | `id`, `status`, `holder?` | `inboxSetStatus` | Move uma demanda ao longo da sequência. |
| `order_add` | `text`, `scope?`, `until?`, `appliesTo?` | `orderAdd` | Adiciona uma ordem permanente. |
| `order_list` | `appliesTo?` | `orderList` | Lista as ordens ativas agora. |
| `order_remove` | `id`, `reason?` | `orderRemove` | Revoga uma ordem; o motivo tem um padrão da própria ferramenta. |

Métodos: `initialize`, `notifications/initialized`, `ping`, `tools/list` e `tools/call`. Toda ferramenta responde `{content: [{type: 'text', text}], isError}`, onde `text` é o JSON do que o núcleo devolveu, então uma recusa (`ok: false`, um teto cheio) e um resultado se leem do mesmo jeito. Um método desconhecido é `-32601`, uma ferramenta desconhecida `-32602`, uma linha que não é JSON `-32700` com id nulo; em todos os casos o laço continua lendo.

## 13. Autonomy
Autonomia máxima é o padrão. O plugin não traz nenhuma lista fixa de ações proibidas: uma recusa vem de algo que o usuário escreveu ou de um limite técnico, nunca de uma regra que os mantenedores adivinharam.
- As restrições são ordens permanentes. O usuário adiciona uma ("nunca dar push para `main`") e `orderRemove` a retira; nada mais pode adicionar restrição.
- Os limites técnicos continuam configuráveis: o teto de concorrência (`limits.global`, `limits.clients`, `staleMinutes`), o piso de cota (`daemon.minQuotaPct`, `lowQuotaPct`), a chave de parada (`daemon.stop`) e o arquivo de pausa.
- O núcleo nunca inventa um modelo, um valor de esforço ou um número de cota que o cliente não informou, e nunca aumenta um teto por conta própria.

## 14. Global state and `appliesTo`
Uma caixa, um conjunto de ordens permanentes, um armazenamento de modelos, em uma pasta (`OKWORK_HOME`, padrão `~/.okwork`), compartilhada por todos os projetos. O que pertence a um projeto fica nos arquivos do próprio projeto e o registro apenas o referencia, então um armazenamento compartilhado nunca precisa ser dividido.

| Função | Efeito |
| :- | :- |
| `validateAppliesTo(value)` | Apara e tira duplicatas, mantém a forma recebida e nunca guarda o padrão: um registro sem o campo vale para todo projeto. |
| `validateAppliesToFilter(value)` | O filtro de uma listagem: um projeto, ou só os registros compartilhados. Uma lista de projetos é recusada, porque a união seria ambígua. |
| `inScope(record, wanted)` | Se um registro aparece para um projeto. |
| `stateRoot(env)` / `paths(root)` | Onde o estado mora, com a sobrescrita do ambiente primeiro. |

Então: ausente significa todos os projetos, um nome significa aquele projeto, uma lista significa cada um deles, e `global` junto com outro projeto é recusado porque não diz nada preciso. `inboxList`, `orderList` e `templateList` filtram por projeto e sempre incluem os registros compartilhados; `templateSet` com `appliesTo: 'global'` apaga o campo, então o modelo volta a ser compartilhado.

## 15. Implementation and limits

Os três adaptadores, estado JSON, daemon, agendamento, instalador, release e servidor MCP estão implementados. O runner real de `client-smoke` atende Claude Code; os demais drivers e as provas Windows/macOS continuam pendentes. Veja [RELEASING.pt-BR.md](RELEASING.pt-BR.md#proof-per-pair).
