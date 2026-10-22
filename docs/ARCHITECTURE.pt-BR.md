# Arquitetura

Status: fase de design (pré-alfa). Estende [DESIGN.md](DESIGN.md); responde às perguntas em aberto. Um núcleo em Node (>=20, sem dependências), três adaptadores finos, um servidor MCP sobre o núcleo.

## 1. Subconjunto: o contrato mínimo
| Registro | Campos |
| :- | :- |
| Item da caixa | `id`, `title`, `body`, `kind` (texto livre: `research`, `writing`, `documents`, `data`, `analysis`, `planning`, `review`, `files`, `code`, ...), `accept` (lista de verificações em palavras simples, cada uma opcionalmente um comando), `effort` (simple\|normal\|hard), `client`, `appliesTo` (id ou caminho de um projeto, uma lista deles, ou ausente para todos), `status` (pending\|delegated\|criticised\|consolidated\|failed), `stepIds`, `ext.<kind>` (extras tipados opcionais), `createdAt` |
| Ordem permanente | `id`, `text`, `scope` (all\|effort:simple\|effort:normal\|effort:hard), `appliesTo` (id ou caminho de um projeto, uma lista deles, ou ausente para todos), `active` |
| Classe de esforço | `simple`, `normal`, `hard`; classificada por padrão a partir de `title`, `body` e `kind`; o mantenedor pode sobrescrever no item |
| Perfil do ator | `client`, `agentId`, `model`, `effort`, `maxTurns`, `worktree` |
| Leitura de cota | `client`, `source` (api\|user\|off), `remainingPct`, `windowMinutes`, `readAt` |
| Resumo do passo | `stepId`, `itemId`, `title`, `goal`, `accept`, `contextRefs`, `terseLevel`, `outLevel` |
| Voto da crítica | `stepId`, `verdict` (pass\|revise\|reject), `findings`, `attempt` (1\|2) |

Regras: uma demanda é qualquer unidade de trabalho delegável, não só código: pesquisa, redação, documentos, limpeza de dados, análise, planejamento, revisões, operações de arquivos e conteúdo. `kind` é texto livre, então um novo tipo não exige mudar o núcleo. Detalhes só de código (branch, PR, comando de teste) ficam em `ext.<kind>` como extras tipados opcionais, nunca campos obrigatórios. Existe uma caixa global e um conjunto global de ordens permanentes, então é o `appliesTo` que separa o que é de cada projeto: uma demanda ou ordem que nomeia projetos pertence a eles, uma sem o campo vale para todos, e `'global'` é o padrão que nunca é gravado. O `accept` de um passo é uma fatia da lista do item. O resumo carrega só o que muda; o contexto repetido é referenciado por `contextRefs`, nunca reenviado. `terseLevel` sobe em uma tentativa repetida, `outLevel` cai a cada ida e volta. O núcleo nunca inventa um modelo, um nível de esforço ou um número de cota que o cliente não informou.

## 2. API do núcleo e as mesmas como ferramentas MCP
Uma função Node por ferramenta, com o mesmo nome no MCP.

| Ferramenta | Entrada | Saída | Uma linha |
| :- | :- | :- | :- |
| `inboxAdd` / `inboxList` / `inboxSetStatus` | `title`, `body`, `kind?`, `accept?`, `effort?`, `client?`, `appliesTo?` / `status?`, `client?`, `appliesTo?`, `limit?` / `id`, `status` | `item` / `items[]` / `item` | Adiciona uma demanda e a classifica quando `effort` falta; lista, por projeto com `appliesTo`; move uma. |
| `orderAdd` / `orderRemove` / `orderList` | `text`, `scope?`, `appliesTo?` / `id` / `appliesTo?` | `order` / `removed` / `orders[]` | Adiciona, remove e lista ordens permanentes, por projeto com `appliesTo`. |
| `classify` | `title`, `body`, `kind?` | `effort`, `reasons[]` | Devolve simple, normal ou hard e o porquê. |
| `planStep` | `itemId`, `count?` | `steps[]` | Divide uma demanda em passos, cada um com uma classe e sua fatia de `accept`. |
| `profilePick` | `client`, `effort`, `quota?` | `actor` | Escolhe modelo, nível de esforço e `maxTurns`. |
| `brief` | `stepId`, `terseLevel?`, `outLevel?` | `briefing` | Monta o resumo do passo. |
| `quotaRead` / `quotaSet` | `client` / `client`, `remainingPct`, `windowMinutes` | `quota` | Pergunta ao adaptador, ou guarda o número que o usuário deu uma vez. |
| `spawn` / `collect` | `stepId`, `actor?` / `runId` | `runId`, `pid?` / `result`, `tokens?` | Lança o subagente; espera e devolve o resultado. |
| `criticise` | `stepId`, `result` | `verdict` | Confere o passo contra o `accept` da própria demanda: um comando, uma lista de verificação ou uma leitura crítica. |
| `consolidate` | `itemId` | `summary`, `findings[]` | Junta os resultados dos passos em uma resposta. |

Regras do classificador, modelos de texto curto, o armazenamento JSON e a trava ficam internos.

## 3. Estado em disco
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

Arquivos do lado do projeto ficam ao lado do projeto, não nesta raiz: `<projectRoot>/.okwork/orders.json` para a camada de projeto das ordens permanentes (`projectOrdersPath`), mais o `CLAUDE.md` do próprio projeto (Claude Code) ou `AGENTS.md` (Codex, opencode).

- Escrita: serializar para `<file>.<pid>.<random>.tmp`, depois `fs.rename` sobre o destino, para que nenhum leitor veja arquivo pela metade. Em `EPERM` ou `EBUSY` (Windows), tentar o rename de novo algumas vezes antes de falhar.
- Trava: `fs.mkdir` na pasta `<name>.lock`, que guarda `owner.json` `{pid, startedAt}`; `EEXIST` significa ocupado; liberar com `rmdir`.
- Trava velha: uma trava é velha quando passa de `staleMs` (padrão 30 s) **e** seu pid está morto; sem `owner.json` legível, usa-se o `mtime` da pasta e não há checagem de pid. A tomada renomeia a pasta para `<name>.lock.stale.<random>` de forma atômica e depois a remove, para que dois concorrentes não vençam os dois.
- Um escritor por arquivo: caixa, ordens e execuções são arquivos separados, para que dois passos do mesmo item não se bloqueiem.

## 4. Interface do adaptador
Cada adaptador fornece exatamente estas cinco funções. O núcleo importa um adaptador, nunca um cliente.

| Função | Entrada | Saída |
| :- | :- | :- |
| `spawn(actor, briefing, opts)` | perfil do ator, resumo | `{ runId, pid }`, ou `{ runId }` para execução no processo |
| `readQuota()` | nenhuma | `{ source, remainingPct?, windowMinutes? }` |
| `capabilities()` | nenhuma | `{ models[], efforts[], skills, hooks, mcp, desktop, windows }` |
| `installSkill(name, files)` | pasta da skill | `{ path }` |
| `installHooks(files)` | configuração de hook | `{ path }` |

### 4.1 Claude Code
| Alegação | Valor | Fonte (verificada em 2026-10-22) |
| :- | :- | :- |
| Empacotamento | diretório de plugin com `.claude-plugin/plugin.json` opcional; padrão `skills/`, `agents/`, `hooks/hooks.json`, `.mcp.json`, `bin/` | https://code.claude.com/docs/en/plugins/manifest-reference |
| Instalação | `/plugin install <nome>@<marketplace>`; no shell `claude plugin marketplace add` e depois `claude plugin install`, `--scope project\|local`; `--plugin-dir` por uma sessão | https://code.claude.com/docs/en/plugins/install |
| Skills, hooks e MCP | os três sim: `skills/<name>/SKILL.md`, `hooks/hooks.json` (a forma exec evita aspas de shell), `.mcp.json` ou `mcpServers` no manifesto com `${CLAUDE_PLUGIN_ROOT}` em `command`, `args`, `env` | https://code.claude.com/docs/en/plugins/manifest-reference |
| Modelo e esforço do subagente | frontmatter `model` (`sonnet`, `opus`, `haiku`, `fable`, um id completo, `inherit`) e `effort` (`low`, `medium`, `high`, `xhigh`, `max`, os níveis dependem do modelo); a ferramenta Agent também aceita `model` por chamada, e `effort` por chamada exige v2.1.292 | https://code.claude.com/docs/en/sub-agents |
| Limites de subagente de plugin | `hooks`, `mcpServers` e `permissionMode` são ignorados em subagentes de plugin; envie-os no plugin | https://code.claude.com/docs/en/sub-agents |
| App de desktop | navegador de plugins no botão `+`, com escopo de usuário, projeto ou local; sem plugins em sessões de nuvem ou WSL; hooks e skills das configurações valem também no desktop; o app lê os mesmos arquivos de configuração que a CLI | https://code.claude.com/docs/en/desktop |
| MCP e subagentes no desktop | `~/.claude.json` e `.mcp.json` funcionam nos dois, o desktop acrescenta `claude_desktop_config.json` que a CLI não lê; um painel de subagentes e um painel de tarefas de segundo plano listam os subagentes em execução | https://code.claude.com/docs/en/desktop |
| Windows | Windows 10 1809+ ou Server 2019+ nativos; instaladores para PowerShell e CMD; Git for Windows opcional; sem sandbox nativo, com sandbox no WSL 2; os caminhos de plugin substituídos usam barra direta | https://code.claude.com/docs/en/setup |
| Cota | `/usage` é apenas na sessão e mostra barras de plano; não há endpoint documentado e legível por máquina de plano por usuário. As APIs de analítica exigem chave de administrador | https://code.claude.com/docs/en/costs |

Decisão do adaptador: lançar pela chamada da ferramenta Agent com `model` e `effort`; manter `maxTurns` no frontmatter do agente. Não ler número de cota; perguntar ao usuário uma vez.

### 4.2 Codex
| Alegação | Valor | Fonte (verificada em 2026-10-22) |
| :- | :- | :- |
| Empacotamento e instalação | plugin com `plugin.json`; um marketplace é `.agents/plugins/marketplace.json` (do repositório) ou `~/.agents/plugins/marketplace.json` (pessoal); `codex plugin add`, `codex plugin marketplace add`, navegador `/plugins` | https://developers.openai.com/codex/plugins |
| Skills | sim, `SKILL.md`; carregadas de `.agents/skills`, `$REPO_ROOT/.agents/skills`, `~/.agents/skills`, `/etc/codex/skills` | https://developers.openai.com/codex/build-skills |
| Hooks | sim, `hooks.json` ou `[hooks]` em `config.toml`; os eventos incluem `SubagentStart` e `SubagentStop`; plugins usam `hooks/hooks.json`, com `PLUGIN_ROOT` e `PLUGIN_DATA` | https://developers.openai.com/codex/hooks |
| MCP | sim, `[mcp_servers.<nome>]` em `config.toml`; stdio e Streamable HTTP; `codex mcp add`, `codex mcp list` | https://developers.openai.com/codex/extend/mcp |
| Modelo e esforço do subagente | arquivo por agente `.codex/agents/<nome>.toml` com `model` e `model_reasoning_effort`; `agents.default_subagent_model` e `agents.default_subagent_reasoning_effort`; valores `low`, `medium`, `high`, `xhigh`, `max`, `ultra`, com disponibilidade dependente do modelo | https://developers.openai.com/codex/agent-configuration/subagents |
| Lançamento | `spawn_agent`, `send_input`, `resume_agent`, `wait_agent`, `close_agent` sob `features.multi_agent`; `/subagents` lista; `agents.max_concurrent_threads_per_session` limita | https://developers.openai.com/codex/agent-configuration/subagents |
| App de desktop | Codex é a superfície Code do app de desktop do ChatGPT; macOS, Windows e Linux; MCP e skills suportados; plugins no app de desktop e na CLI, não na extensão de IDE | https://developers.openai.com/codex/app |
| Hooks no desktop | `UNVERIFIED`: confirmar se `[features] hooks` dispara no app de desktop antes de depender disso. Conferir https://developers.openai.com/codex/hooks para o comportamento no desktop | |
| Windows | app nativo do Windows; `winget install --id 9PLM9XGG6VKS -s msstore`; WSL opcional, WSL 1 removido no Codex 0.115; handlers de hook recebem `command_windows` | https://developers.openai.com/codex/windows/windows-app |
| Cota | o JSON-RPC do `codex app-server` tem `account/rateLimits/read` (`usedPercent`, `windowDurationMins`, `rateLimits`) e `account/usage/read` | https://developers.openai.com/codex/app-server |

Decisão do adaptador: o único cliente com cota documentada e legível por máquina. Ler, e cair em perguntar ao usuário quando a chamada falhar.

### 4.3 opencode
| Alegação | Valor | Fonte (verificada em 2026-10-22) |
| :- | :- | :- |
| Empacotamento e instalação | um plugin é um módulo JS ou TS em `.opencode/plugins/` do projeto ou `~/.config/opencode/plugins/` global, ou um pacote npm no array `plugin` de `opencode.json`; `opencode plugin <módulo>`, com `--global` e `--force`; configuração global em `~/.config/opencode/opencode.json` | https://opencode.ai/docs/plugins/ |
| Skills | sim, `SKILL.md` em `.opencode/skills/<nome>/`, `~/.config/opencode/skills/<nome>/`, `.claude/skills/<nome>/` ou `.agents/skills/<nome>/` | https://opencode.ai/docs/skills/ |
| Hooks | `UNVERIFIED`: não existe chave `hooks` no esquema publicado; eventos de ciclo de vida são apenas chaves de evento de plugin. Conferir https://opencode.ai/config.json para uma chave `hooks` antes de planejar em cima dela | |
| MCP | sim, o objeto `mcp` com `type: local` (`command`, `cwd`, `environment`, `timeout`) ou `type: remote` (`url`, `headers`, `oauth`) | https://opencode.ai/docs/mcp-servers/ |
| Modelo e esforço do subagente | `agent.<nome>.model` como `provider/model-id` e `agent.<nome>.variant`, mais opções de passagem como `reasoningEffort`; agentes markdown em `.opencode/agents/<nome>.md` | https://opencode.ai/docs/agents/ |
| Valores de esforço | variantes por provedor: Anthropic `high` e `max`; OpenAI `none`, `minimal`, `low`, `medium`, `high`, `xhigh`; Google `low` e `high` | https://opencode.ai/docs/models/ |
| Lançamento | um subagente roda pela ferramenta Task ou por menção `@agent-name`; `mode` é `primary`, `subagent` ou `all`; embutidos `general`, `explore`, `scout`; `subagent_depth` limita o aninhamento (padrão 1, 0 desliga subagentes) | https://opencode.ai/docs/agents/ |
| Windows | suporte nativo: choco, scoop, `npm install -g opencode-ai` ou binários das Releases do GitHub; WSL é o caminho recomendado; Bun no Windows em andamento | https://opencode.ai/docs/windows-wsl |
| Cota | `UNVERIFIED`: nenhum comando de cota, nenhum `--json` documentado em `opencode stats`, nenhuma rota de uso na API de servidor. Conferir `opencode stats --help` e a API de conta do provedor | |

Decisão do adaptador: ler modelos de `opencode models`; tratar a cota como desligada a menos que o usuário forneça um número.

### 4.4 O adaptador do Claude Code no repositório
`adapters/claude-code/index.js` são as cinco funções desta seção para um cliente, e é o adaptador que o núcleo importa em vez da CLI. `spawn` devolve `{mode: 'NATIVE', runId, agentCall: {model, effort, prompt}}` sem iniciar processo, e em `PROCESS` reaproveita `makeSpawner` de `src/spawn-process.js`. `readQuota` responde `{source: 'user'}` e só acrescenta `remainingPct`/`windowMinutes` a partir de `quota/claude-code.json`. `installSkill` copia para `<root>/skills/<name>/` por `installSkillFiles`, `installHooks` combina `<root>/hooks/hooks.json` sem descartar entrada alguma do usuário, e a raiz é `opts.root`, depois `CLAUDE_CONFIG_DIR`, depois `~/.claude`. Os adaptadores de Codex e de opencode ainda estão por vir.

## 5. Cota
- `source: api` — o adaptador devolveu um número nesta sessão (Codex hoje). Use-o.
- `source: user` — sem número; perguntar uma vez, guardar em `quota/<client>.json`,velho depois de `windowMinutes`.
- `source: off` — o usuário recusou, ou o cliente não tem canal; a escolha de classe ignora a cota.

Nunca estimar, interpolar nem trazer um número de outro cliente. Uma leitura velha ou ilegível rebaixa uma classe `hard` para a última classe que o cliente ainda aceitou, nunca o contrário. `quotaRead` devolve `source: off` em vez de falhar, para o Diretor continuar trabalhando.

## 6. Regras para Windows
- Construir todo caminho com `node:path`, nunca concatenando separadores; guardar com barra direta, a forma que o Claude Code substitui, para que o que escrevemos corresponda ao que o cliente lê.
- Sem shell: `child_process.spawn` com array de argumentos. Comandos de hook na forma shell são preocupação do cliente, não nossa.
- Escrever só `\n`, com codificação explícita e sem padrão de plataforma, para que um arquivo escrito no Windows seja lido igual no Linux.
- Travas com `fs.mkdir` se comportam igual de forma nativa e no WSL; sem `flock`, sem `setsid`.
- Uma instalação nativa do Claude Code não tem sandbox: assumir que um subagente pode tocar a worktree inteira, então usar `worktree: true` como padrão no Windows.
- Passagem manual antes de uma versão: instalar o plugin, adicionar um item na caixa, delegar um passo, ler o voto da crítica, consolidar, reiniciar o cliente, confirmar que o estado sobreviveu.

O modo `PROCESS` inicia os clientes sem shell; no Windows os shims `.cmd` exigem resolver antes o executável de verdade (item em aberto da passagem do Windows).

## 7. Limite de concorrência
| Escopo | Padrão | Lido de |
| :- | :- | :- |
| Global, todos os clientes | 4 atores ao mesmo tempo | `config.json` |
| Por cliente | 3 atores ao mesmo tempo | `config.json`, rebaixado quando a cota está baixa |
| Por worktree | 1 ator | nunca mudado |

O núcleo conta execuções vivas em `runs/<runId>.json` (`status: live`) em vez de confiar que o cliente respeita o teto. `spawn` espera até 60 s por uma vaga e então devolve `busy`; nunca inicia uma execução acima do teto. A contagem cai quando `collect` volta, quando um resultado chega e em uma execução mais velha que 30 min. O Codex se limita sozinho com `agents.max_concurrent_threads_per_session`; deixar no mesmo número para os dois concordarem.

## 8. Agendamentos e recorrência
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

## 9. Modelos recorrentes
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

## 10. Ordens permanentes
Uma ordem é uma linha que o mantenedor escreve uma vez e o Diretor lê a cada demanda. O JSON continua sendo a fonte; `orderRender` é só uma visão.

| Função | Efeito |
| :- | :- |
| `orderAdd(root, { text, scope, layer, until, origin, appliesTo }, { projectRoot })` | Adiciona uma ordem ativa; `until` precisa ser uma data no futuro. |
| `orderRemove(root, id, { reason })` | Revoga: `active: false` com `revokedAt` e `revokedReason`. Nada é apagado, então o histórico sobrevive. Uma segunda revogação é recusada. |
| `orderStatus(order, now)` | O status derivado de uma ordem: `revoked`, `expired` ou `active`. |
| `orderList(root, { activeOnly, appliesTo, now }, { projectRoot })` | As duas camadas fundidas, a global primeiro; o mesmo texto em um projeto substitui o global no lugar. `activeOnly` descarta revogadas e vencidas. Cada ordem volta com o `status` derivado e, quando inativa, a data `purgeAfter`. |
| `orderLint(root, { projectRoot, now })` | O que quem lê os arquivos tropeçaria: texto vazio, escopo desconhecido, data ilegível, id repetido, ordem ativa com `until` passado, duas ordens vivas com o mesmo texto. |
| `purgeAfter(order, retentionDays, now)` | O instante em que uma ordem inativa pode ser expurgada, ou `undefined` para uma ativa. |
| `orderPurge(root, { now, retentionDays }, { projectRoot })` | Remove para sempre, nas duas camadas, toda ordem inativa cuja retenção acabou, e anexa `{ at, purged: [ids] }` a `logs/<date>.jsonl`. |
| `orderRender(orders)` | Markdown para leitura humana. |

O status é computado a partir da linha e nunca é gravado no arquivo, então quem lê o JSON vê só o que foi escrito:

| Status | Como é derivado |
| :- | :- |
| `revoked` | `active` não é `true`: a ordem foi revogada, e o motivo está em `revokedReason`. |
| `expired` | `until` é uma data que não está no futuro. No instante exato de `until` a ordem já está vencida. |
| `active` | Qualquer outra coisa: nunca revogada e ainda dentro do seu `until`. |

Revogar marca, não apaga: a linha continua com `active: false`, `revokedAt` e `revokedReason`. Adicionar de novo o mesmo texto depois cria uma ordem nova com id novo, e uma segunda revogação do mesmo id é recusada para que o primeiro motivo sobreviva. Uma ordem inativa é então expurgada para sempre quando a retenção acaba, e a expurgo fica registrado: `purgeAfter` é `revokedAt` para uma ordem revogada e `until` para uma vencida, mais `orders.retentionDays` (padrão 90) no `config.json`; `orderPurge` remove a linha das duas camadas só quando essa data chega, e escreve `{ at, purged: [ids] }` em `logs/<date>.jsonl` para que o rastro do que saiu sobreviva à remoção. Um `orders.retentionDays` quebrado volta ao padrão em vez de travar quem lê.

Duas camadas: `global` (padrão) em `orders.json` na raiz do estado, e `project` em `<projectRoot>/.okwork/orders.json`; a camada é escolhida por `projectRoot` quando `layer` está ausente. Os ids são `G000001` na camada global e `O000001` na de projeto. `scope` é `all` ou `effort:simple`, `effort:normal`, `effort:hard`; `origin` é texto livre, com padrão `maintainer`, e um modelo escreve `template:<name>`. A ordem de um modelo é criada junto com o registro, movida em uma renomeação e revogada com motivo na remoção, então a ordem que permitia a execução deixa de permitir.

## 11. O daemon
O daemon é a metade sem tela: ninguém assiste, então todo limite que ele respeita é técnico. O núcleo não inicia nada por conta própria — `spawn` é injetado, então um teste o conduz e um adaptador o conduz de verdade.

A ordem de uma passagem, `tick`:

| # | Passo | Regra |
| :- | :- | :- |
| 1 | Pausa | `daemon.paused` existe: o registro diz `paused`, nada é aberto e nada é iniciado. O laço continua rodando. |
| 2 | Chave de parada | `daemon.stop` existe: o registro diz `stopped: kill switch`, e `daemonRun` sai do laço. |
| 3 | Piso de cota | Todos os clientes das demandas pendentes abaixo de `daemon.minQuotaPct` param a passagem. Um cliente sem leitura não está abaixo do piso, então um cliente não medido nunca paralisa o daemon. |
| 4 | Retenção | `orderPurge` tira das duas camadas toda ordem inativa cujo `orders.retentionDays` já acabou e anexa `{ at, purged: [ids] }` a `logs/<date>.jsonl`. Um daemon pausado ou parado não expurga nada. |
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

## 12. Modos de início
Dois modos por adaptador, e o `spawn()` do adaptador devolve o modo que usou. Planejado: só o adaptador do Claude Code (seção 4.4) foi escrito.

| Modo | Quando | Como |
| :- | :- | :- |
| `NATIVE` | padrão em uma sessão interativa | o subagente do próprio cliente: a chamada da ferramenta Agent no Claude Code, `spawn_agent` no Codex, a ferramenta Task no opencode |
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
| `acquire_slot` | `runId`, `client`, `waitMs?` | `acquireSlot` | Reserva uma vaga, ou responde `ok: false` com o teto que recusou. |
| `release_slot` | `runId` | `releaseSlot` | Libera a vaga de uma execução. |
| `limits_status` | nenhum | `limitsStatus` | Os tetos e as execuções vivas por cliente. |
| `classify` | `title`, `body?`, `kind?` | `classify` | `simple`, `normal` ou `hard`, mais o porquê. |
| `profile_pick` | `client`, `effort`, `quota?` | `profilePick` | Modelo, esforço de raciocínio e `maxTurns` vindos do `config.json`. |
| `inbox_add` | `title`, `body?`, `kind?`, `accept?`, `effort?`, `client?`, `appliesTo?` | `inboxAdd` | Adiciona uma demanda e devolve o item guardado. |
| `inbox_list` | `status?`, `client?`, `appliesTo?`, `limit?` | `inboxList` | Lista as demandas, das mais novas às mais antigas. |
| `inbox_set_status` | `id`, `status` | `inboxSetStatus` | Move uma demanda ao longo da sequência. |
| `order_add` | `text`, `scope?`, `until?`, `appliesTo?` | `orderAdd` | Adiciona uma ordem permanente. |
| `order_list` | `appliesTo?` | `orderList` | Lista as ordens ativas agora. |
| `order_remove` | `id`, `reason?` | `orderRemove` | Revoga uma ordem; o motivo tem um padrão da própria ferramenta. |

Métodos: `initialize`, `notifications/initialized`, `ping`, `tools/list` e `tools/call`. Toda ferramenta responde `{content: [{type: 'text', text}], isError}`, onde `text` é o JSON do que o núcleo devolveu, então uma recusa (`ok: false`, um teto cheio) e um resultado se leem do mesmo jeito. Um método desconhecido é `-32601`, uma ferramenta desconhecida `-32602`, uma linha que não é JSON `-32700` com id nulo; em todos os casos o laço continua lendo.

## 13. Autonomia
Autonomia máxima é o padrão. O plugin não traz nenhuma lista fixa de ações proibidas: uma recusa vem de algo que o usuário escreveu ou de um limite técnico, nunca de uma regra que os mantenedores adivinharam.
- As restrições são ordens permanentes. O usuário adiciona uma ("nunca dar push para `main`") e `orderRemove` a retira; nada mais pode adicionar restrição.
- Os limites técnicos continuam configuráveis: o teto de concorrência (`limits.global`, `limits.perClient`, `staleMinutes`), o piso de cota (`daemon.minQuotaPct`, `lowQuotaPct`), a chave de parada (`daemon.stop`) e o arquivo de pausa.
- O núcleo nunca inventa um modelo, um valor de esforço ou um número de cota que o cliente não informou, e nunca aumenta um teto por conta própria.

## 14. Estado global e `appliesTo`
Uma caixa, um conjunto de ordens permanentes, um armazenamento de modelos, em uma pasta (`OKWORK_HOME`, padrão `~/.okwork`), compartilhada por todos os projetos. O que pertence a um projeto fica nos arquivos do próprio projeto e o registro apenas o referencia, então um armazenamento compartilhado nunca precisa ser dividido.

| Função | Efeito |
| :- | :- |
| `validateAppliesTo(value)` | Apara e tira duplicatas, mantém a forma recebida e nunca guarda o padrão: um registro sem o campo vale para todo projeto. |
| `validateAppliesToFilter(value)` | O filtro de uma listagem: um projeto, ou só os registros compartilhados. Uma lista de projetos é recusada, porque a união seria ambígua. |
| `inScope(record, wanted)` | Se um registro aparece para um projeto. |
| `stateRoot(env)` / `paths(root)` / `projectOrdersPath(projectRoot)` | Onde o estado mora, com a sobrescrita do ambiente primeiro. |

Então: ausente significa todos os projetos, um nome significa aquele projeto, uma lista significa cada um deles, e `global` junto com outro projeto é recusado porque não diz nada preciso. `inboxList`, `orderList` e `templateList` filtram por projeto e sempre incluem os registros compartilhados; `templateSet` com `appliesTo: 'global'` apaga o campo, então o modelo volta a ser compartilhado.

## 15. Plano do MVP
1. Claude Code primeiro, Linux e Windows: adaptador, servidor MCP, as quinze ferramentas, o armazenamento JSON.
2. Codex depois no mesmo núcleo: o adaptador lê cota, então o controle de cota fica ligado.
3. opencode por último: o adaptador mais o trabalho de esforço que ainda falta confirmar.

Uma área de teste de ponta a ponta em um repositório descartável, rodada para cada adaptador, com duas demandas: uma `code` e uma fora de código (uma demanda curta de pesquisa ou redação). Cada uma passa por item na caixa, passo classificado, subagente delegado com modelo e esforço escolhidos, voto da crítica contra a própria lista `accept`, resultado consolidado. Afirmar que o resumo de um passo `simple` fica abaixo de 1 kB e que a segunda tentativa é mais curta que a primeira.

## 16. Perguntas em aberto para o mantenedor
- Os níveis de esforço diferem por cliente. Mapear `simple`/`normal`/`hard` em cada cliente, ou manter uma escala interna e deixar o adaptador traduzir?
- `ultra` existe só no Codex. Aceitar um vocabulário de esforço menor para portabilidade?
- O `/usage` do Claude Code mostra barras de plano só na sessão. Aceitar `source: user` ali, ou abrir mão do controle de cota nesse cliente?
- `consolidate` deve rodar como um turno do Diretor ou como uma chamada barata de subagente?
- Tentativas: duas por passo, ou uma tentativa mais uma revisão?
- Manter `runs/` para sempre, ou limpar depois da consolidação?

Versão em inglês: [ARCHITECTURE.md](ARCHITECTURE.md).