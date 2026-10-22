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
quota/<client>.json       uma leitura de cota por cliente
runs/<runId>.json         um arquivo por execução delegada
locks/<name>.lock/        diretórios de trava criados com mkdir
logs/<date>.jsonl         eventos append-only
```

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

## 7. Limite de concorrência
| Escopo | Padrão | Lido de |
| :- | :- | :- |
| Global, todos os clientes | 4 atores ao mesmo tempo | `config.json` |
| Por cliente | 3 atores ao mesmo tempo | `config.json`, rebaixado quando a cota está baixa |
| Por worktree | 1 ator | nunca mudado |

O núcleo conta execuções vivas em `runs/<runId>.json` (`status: live`) em vez de confiar que o cliente respeita o teto. `spawn` espera até 60 s por uma vaga e então devolve `busy`; nunca inicia uma execução acima do teto. A contagem cai quando `collect` volta, quando um resultado chega e em uma execução mais velha que 30 min. O Codex se limita sozinho com `agents.max_concurrent_threads_per_session`; deixar no mesmo número para os dois concordarem.

## 8. Plano do MVP
1. Claude Code primeiro, Linux e Windows: adaptador, servidor MCP, as quinze ferramentas, o armazenamento JSON.
2. Codex depois no mesmo núcleo: o adaptador lê cota, então o controle de cota fica ligado.
3. opencode por último: o adaptador mais o trabalho de esforço que ainda falta confirmar.

Uma área de teste de ponta a ponta em um repositório descartável, rodada para cada adaptador, com duas demandas: uma `code` e uma fora de código (uma demanda curta de pesquisa ou redação). Cada uma passa por item na caixa, passo classificado, subagente delegado com modelo e esforço escolhidos, voto da crítica contra a própria lista `accept`, resultado consolidado. Afirmar que o resumo de um passo `simple` fica abaixo de 1 kB e que a segunda tentativa é mais curta que a primeira.

## 9. Perguntas em aberto para o mantenedor
- Os níveis de esforço diferem por cliente. Mapear `simple`/`normal`/`hard` em cada cliente, ou manter uma escala interna e deixar o adaptador traduzir?
- `ultra` existe só no Codex. Aceitar um vocabulário de esforço menor para portabilidade?
- O `/usage` do Claude Code mostra barras de plano só na sessão. Aceitar `source: user` ali, ou abrir mão do controle de cota nesse cliente?
- `consolidate` deve rodar como um turno do Diretor ou como uma chamada barata de subagente?
- Tentativas: duas por passo, ou uma tentativa mais uma revisão?
- Manter `runs/` para sempre, ou limpar depois da consolidação?

Versão em inglês: [ARCHITECTURE.md](ARCHITECTURE.md).