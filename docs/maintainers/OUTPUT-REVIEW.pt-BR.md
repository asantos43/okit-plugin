# D94 — Inventário de saídas

![okit-plugin: Manutenção](../images/banners/maintainers.svg)

Evidências e propostas para revisão do Producer. Não implica implementação nem aprovação de contrato de máquina. Veja os [mock-ups](OUTPUT-MOCKUPS.pt-BR.md) e a [versão em inglês](OUTPUT-REVIEW.md).

<a id="contents"></a>
## Índice

- [1. Método e princípios](#section-1)
- [2. setup](#section-2)
- [3. doctor](#section-3)
- [4. install](#section-4)
- [5. update](#section-5)
- [6. uninstall](#section-6)
- [7. Respostas MCP](#section-7)
- [8. Decisões para o Producer](#section-8)

<a id="section-1"></a>
## 1. Método e princípios

Revisão em `54df496`, Linux, Node v22.23.1. Cada captura usou novos HOME, USERPROFILE e OKWORK_HOME criados com `mktemp -d`; nenhuma configuração do HOME real foi usada. Os executáveis continuaram visíveis pelo PATH. Portanto, HOME vazio **não** significa ausência de clientes instalados.

Reproduza cada comando com `task_home=$(mktemp -d)` seguido de `HOME="$task_home" USERPROFILE="$task_home" XDG_CONFIG_HOME="$task_home/config" OKWORK_HOME="$task_home/state" node src/cli.js <comando> --locale en`; repita com `pt-BR`. Use diretório novo por execução. `</dev/null` captura recusas sem interação. `setup --defaults` captura propostas de modelos; um terminal captura perguntas e eco da resposta. `install --client codex --dry-run` tenta acessar metadados da versão mesmo na simulação; este ambiente não conseguiu buscá-los.

Os trechos são literais, cortados entre linhas/campos, salvo indicação de molde do código. Caminhos e horários variáveis foram omitidos escolhendo trechos sem eles. Ramos lidos no código são separados dos estados executados; não são apresentados como reproduzidos. As capturas MCP chamam `callTool(TOOLS, ctx, name, args)` dos módulos reais, com raiz temporária e `ctx.env={HOME:process.env.HOME,PATH:''}`; dispensam sockets e clientes externos. Isso testa ausência de executáveis, não identificador de cliente inválido.

Princípios, citados pela letra nas linhas de problema abaixo:

- **L, um idioma:** seguir a regra de idioma da CLI (`--locale`, `OKIT_LANGUAGE` válido, idioma salvo, inglês padrão).
- **S, resumo primeiro:** título e resumo curto vêm primeiro.
- **D, dados separados da orientação:** tabelas contêm dados; a orientação vem abaixo.
- **N, próximo passo:** estados vazios ou ausentes dão o próximo comando ou chamada exata.
- **H, dica uma vez:** cada dica ou motivo aparece uma vez.
- **W, palavras simples:** palavras simples, ou o significado do jargão em uma linha.
- **Q, perguntas curtas:** perguntas curtas com opções visíveis.
- **M, contrato de máquina:** JSON, sinalizadores de protocolo e códigos de saída ficam como estão.

Um molde do código evidencia a redação; não cria comando executável.

Problemas têm IDs globais estáveis P1–P32; as traduções usam as mesmas seções e IDs. Contagens: setup 8, doctor 4, install 4, update 2, uninstall 2, respostas MCP 12. As melhorias do D92 (idioma, apresentador comum, passos numerados e notas globais sem repetição) são preservadas; só os defeitos restantes são listados nos três comandos.

<a id="section-2"></a>
## 2. setup

Emissores: `src/cli.js:runSetupCommand` imprime `runSetup().messages`; `src/setup/setup.js` contém `SETUP_MESSAGES`, `askModel`, `confirmSetup`, `setupReader` e mensagens de gravação/recusa. `src/setup/offer.js` contém ofertas na instalação (alternativa bilíngue avulsa; caminho com apresentador localizado). `src/setup/autostart-step.js:setupAutostart` imprime o passo opcional final usando `TEXTS` em `src/install/present.js`.

Execução `setup --defaults --locale en` (linhas selecionadas; saída 0):

```text
claude-code (simple): use haiku. No model-listing command is configured for claude-code, so the built-in catalog is used.
claude-code (normal): use sonnet. No model-listing command is configured for claude-code, so the built-in catalog is used.
claude-code (hard): use opus. No model-listing command is configured for claude-code, so the built-in catalog is used.
Saved 6 model settings for claude-code, opencode.
```

Pergunta executada em terminal (controles ANSI omitidos; o terminal ecoou `gpt-6.1-sol` antes da próxima pergunta):

```text
Choose a model for codex: small, straightforward tasks. Options: gpt-6-astra, gpt-6.1-sol, gpt-6.1-terra, gpt-6-sol, gpt-6-luna, gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna, gpt-5.5. Recommended: gpt-6-astra, an available assistant for this work. [gpt-6-astra]
```

EOF/cancelamento executado nos dois idiomas (saída 0): `Setup was cancelled and nothing was saved.` / `O setup foi cancelado e nada foi salvo.` São execuções separadas, não uma execução bilíngue.

Moldes somente do código: `Everything was already configured; nothing changed.`; `No client with an active model was found; install or activate one and run the setup again.`; `Configure now? [S/n] Recommended: yes, review the detected choices together.`; `Start the daemon with this machine using {kind}.`; `Install autostart? [y/N]`.

Demais famílias: proposta por cliente/classe; modelo omitido com chave de `config_set`; cota ausente por cliente salvo; gravação/contagem, nada salvo, valores concorrentes mais novos mantidos; modelo inválido/repetição, confirmação/repetição, tentativas esgotadas, cliente/classe desconhecido, perfis/valor inválidos, configuração ilegível, falha de gravação com pasta/comando; oferta pendente/recusada/falha/ilegível; início automático já instalado, explicação/caminho/consentimento, recusa/depois, instalado/desinstalação, plano ausente, falha, reversão ou serviço anterior mantido. Todos vêm dos emissores acima. Ajuda, recusas de idioma/opção/configuração e erros externos passam por `src/cli.js:main`, `enter`, `refuse`, `usageOf` e `localizeReason`.

Problemas de setup:

- **P1 — L:** a saída histórica inglês-depois-português ainda é possível pelos padrões de módulo `locale='both'` e motivos bilíngues. Idiomas explícitos na CLI produziram um idioma só; o parágrafo bilíngue histórico da CLI não foi reproduzido.
- **P2 — Q/S:** a pergunta de modelo inclui finalidade, nove opções, recomendação e justificativa em linha longa; a confirmação começa com a pergunta antes das escolhas em várias linhas. A pergunta escondida da demanda continua difícil de localizar, embora o parágrafo bilíngue não tenha sido reproduzido.
- **P3 — H:** o mesmo motivo do catálogo se repete para simple, normal e hard (três vezes por cliente), conforme a captura acima.
- **P4 — Q:** o eco do readline/terminal coloca a resposta na linha da pergunta, com sequências de redesenho do cursor. Separar renderização de duplicação produzida pela aplicação.
- **P5 — S:** falta título; o resumo de gravação vem depois das propostas e orientações de cota. Pronto/cancelado/nada são frases sem contexto.
- **P6 — N:** ausência de modelo ativo e cancelamento omitem comando literal para tentar novamente; tudo pronto não dá comando de verificação.
- **P7 — W/Q:** classe, esforço, catálogo e daemon/systemd/cron não têm significado curto. A oferta avulsa em inglês exibe `[S/n]` em português.
- **P8 — H/N:** soluções de modelo omitido e cota se repetem por classe/cliente; correção de modelo descreve argumentos em prosa, sem chamada completa. Algumas recusas/falhas de início automático não dão comando exato de recuperação.

<a id="section-3"></a>
## 3. doctor

Emissor: `src/doctor/command.js:doctorCommand`; verificações e correções em `src/doctor/diagnose.js:diagnose`; rótulos, detalhes e resumo em `src/install/present.js:TEXTS` (`doctor*`, `selfcheck*`, `control*`). Captura de `doctor --locale en` com HOME vazio (saída 1), linhas selecionadas:

```text
okit-plugin doctor: the state of the installation
      Installation                failed   no installation record was found
      Configuration               ok       not created yet
      Session                     warn     no okit server is running: it starts with a client session; this is normal when no client is open
      Daemon                      warn     not running
                                  failed   1 failed, 2 to look at
```

Final capturado em pt-BR: `falhou   1 falharam, 2 para olhar`. A Correção para instalação ausente cita o Node atual e `src/cli.js install` deste checkout; não escolhe cliente. Demais famílias do código: Node mínimo desconhecido/antigo; registros válidos/ausentes/ilegíveis; registro no cliente ausente/alheio/quebrado/desativado/executável errado/ausente ou servidor ausente; configuração, caixa de entrada e ordens legíveis/ausentes/inválidas/ilegíveis; sessão ok/ausente/falha de conexão; início automático ok/ausente/extra/opcional/script desconhecido; daemon ativo/parado; autoverificação instalada de versão/comando/PATH/hook/barra/cota/MCP/controle. `--verbose` inclui linhas silenciosas; cada falha/aviso com `fix` imprime a correção logo abaixo. Molde do resumo sem problemas: `everything looks right ({count} checks)`.

- **P9 — S:** resumo na última linha alinhada; é preciso percorrer o diagnóstico inteiro para saber a gravidade.
- **P10 — D/N:** configuração, caixa de entrada e ordens ausentes dizem `ok not created yet` sem ação para criar/usar cada uma; avisos como daemon parado podem vir sem Correção. Orientações se misturam às linhas de dados.
- **P11 — W:** MCP, daemon, hook, PATH e detalhes de JSON/entrada não têm significado curto; detalhes internos dominam algumas correções.
- **P12 — W/N:** `1 falharam` tem erro de concordância; `2 para olhar` é vago. A Correção de instalação ausente omite `--client`, gerando outra pergunta ou recusa sem terminal.

<a id="section-4"></a>
## 4. install

Emissores de install/update/uninstall: `src/cli.js:installerCommand` delega ao instalador; `src/install/present.js:createPresenter`, `TEXTS`, `localizeReason`, `finishLink`, `summary`, `failure` são a fronteira de apresentação comum. `src/profiles.js:CONFIG_MESSAGES` fornece recusas de ajustes. `src/setup/offer.js` e consentimentos de início automático/barra/modelos usam o apresentador. Cópias em `install.sh`/`install.ps1` vêm de `src/release/install-scripts.js`; não são propostas edições nos arquivos gerados aqui.

Instalação simples executada nos dois idiomas (saída 2), trecho:

```text
Which client do you want to install for?
  1. claude-code (found)
  2. codex (found)
  3. opencode (found)
Refused: Without a terminal to ask in, choose a client with --client.
      Next: check the options and try again
```

Execução `install --client codex --dry-run --locale en`, trecho: `Failed at Download and verify: Release/download request failed: https://api.github.com/repos/asantos43/okit-plugin/releases/latest: fetch failed`; `Next: check the options and try again`; `Dry run: nothing was changed.` É uma prévia com falha de rede, não evidência de instalação bem-sucedida.

Mapa completo de famílias do código: cabeçalho/pacote/cliente/sistema; seleção de cliente/todos/sem terminal; download/fonte local/checksum/pré-versão; cópia/arquivos/registro/comando/cota/autoverificação e reversão; registro ausente/módulo/manual/alheio/ambíguo/reparado/falha; conflitos de PATH/manual/perfil/shim; ofertas de modelos e registro de cota; política PowerShell/consentimento/desfazer/política de grupo/falha; kit presente/ausente/quebrado/ignorado; fim da simulação; sucesso/novo terminal/reabrir/status; recusas, falhas por etapa e versão anterior. Detalhes silenciosos exigem `--verbose`. Erros comuns de ajustes cobrem idioma, limites, todo, smoke, fontes/leituras de cota, barra, pastas de cliente, shell, regras de instalação e inteiros da caixa de entrada; o molde `Invalid install.{key}: {rule}` é localizado, porém técnico. Moldes do código: `Done. Next: ...`; `kit: absent. {hint}`; `not found. {hint}`; `MCP server registered in {client}`.

- **P13 — S:** cabeçalho identifica pacote/plataforma, sem resumo curto do resultado/plano; recusas podem vir sem título. Próximos passos do sucesso ficam em uma linha longa numerada.
- **P14 — N:** `Next: check the options and try again` omite chamada concreta, especialmente sem cliente e em falha de download.
- **P15 — W/D:** PATH, SHA-256, MCP, hook, módulo/skills e nomes de serviço precisam de significado curto. Recuperações longas ficam nas colunas alinhadas de etapa/detalhe.
- **P16 — N/H:** kit opcional ausente aponta para documentação, sem ação concreta segura; recuperação de comando/registro ausente depende da prosa. Orientações de modelos/cota/início podem reaparecer em etapas distintas apesar da deduplicação global do D92.

<a id="section-5"></a>
## 5. update

Mesmos emissores comuns da §4. `update --locale en` e `pt-BR` executados com HOME vazio separado, saída 2:

```text
Refused: No installation record found
      Next: check the options and try again
```

Captura em português: `Recusado: Nenhuma instalação encontrada` / `O que fazer: confira as opções e tente de novo`. Estados somente do código: `Up to date`, `New version available`, download/checksum/cópia/instalação/registro/autoverificação, reversão para versão guardada (`Restore previous version`), parada/reinício do daemon, notas de modelos/cota/PATH/kit e falha/recusa/simulação/sucesso comuns (§4). Não se afirma atualização remota bem-sucedida.

- **P17 — S/N:** recusa por instalação ausente sem título/resumo nem comando exato de instalação; tentar novamente não cria o registro ausente.
- **P18 — W/D:** em dia/nova versão e reversão reutilizam linhas técnicas de etapas; separar resultado de orientação opcional abaixo dos dados. Idioma e etapas do D92 já funcionam; preservar comportamento de máquina.

<a id="section-6"></a>
## 6. uninstall

Mesmos emissores comuns da §4. `uninstall --locale en` e `pt-BR` executados com HOME vazio separado, saída 2: recusa e próxima linha idênticas às da §5 em cada idioma. Estados somente do código: parar processo, restaurar ajustes de cota, remover registro de cliente/MCP (removido/mantido/manual/falha), remover comando/PATH (removido/compartilhado/alheio), remover arquivos (manter ajustes/purgar), módulo/skill editado mantido, início automático revertido/mantido/erro, simulação e erros comuns. Moldes: `{path} (your settings are kept)`; `{command} kept for the other client`.

- **P19 — S/N:** já ausente diz recusado e sugere tentar novamente, sem comando útil. Preservar saída 2; a redação deve separar nada removido de falha na remoção.
- **P20 — W/N:** ajustes mantidos, arquivos editados e comando compartilhado precisam de resumo claro após remoção e comando exato de verificação/reinstalação. Os detalhes atuais não dão um encerramento consistente.

<a id="section-7"></a>
## 7. Respostas MCP

Fronteira: `src/mcp/tools.js:TOOLS` (5 ferramentas explícitas), `src/mcp/registry-tools.js:toolsFromRegistry` e `src/core/operations.js` (24 ferramentas do registro): **29 nomes publicados**. Cada manipulador serializa seu resultado em JSON; `src/mcp/call-tool.js:callTool` retorna `{text,isError}` e repassa mensagens de exceção. `src/mcp/server.js:toolResult` envolve isso em conteúdo textual MCP. Prosa/Markdown renderizado fica dentro de campos JSON; substituir a resposta inteira por um mock-up mudaria contrato de máquina.

### 7.1 Visões principais — trechos executados

`status {}` → `markdown` (linhas selecionadas) e `capacityLine`, sem argumento de cliente nem marcador de sessão:

```text
| Subscription | 5h remaining | Week remaining | Resets in | Status | Source (age) |
| claude-code | - | - | - | not installed (optional) | - |
Client not recognized. Showing all clients; pass the `client` argument to choose one.
Slots show running executors; actors lists available model + effort profiles, even when nothing is running.
executors that can launch now: ; quota floor 15%
```

`actors_list {}` → `markdown` (linhas selecionadas):

```text
| Client | Model | Effort | Sizes / role | Free slots | Quota | Can launch | Reason / remedy |
| --- | --- | --- | --- | --- | --- | --- | --- |
Client not recognized. Showing all clients; pass the `client` argument to choose one.
claude-code: not installed (optional).
```

Ambas também executadas com `language=pt-BR` salvo: títulos/notas traduzidos, mesmo aviso falso e frase de capacidade vazia. Valores de situação da demanda como `pending` continuam como enums do protocolo na tabela. Fontes: `src/status.js:statusTable`, `src/env/quota.js:LABELS,rowOf`, `src/actors.js:listActors`, `src/profiles.js:actors.messages`, `src/core/status-operations.js`.

### 7.2 Cobertura completa das ferramentas

Chamadas executadas usam `{}` salvo indicação. Fragmentos são campos JSON exatos ou texto literal de erro; IDs, horários e caminhos variáveis foram cortados. Famílias de sucesso/ausência/recusa não executadas têm marca **código**. Todas compartilham P28/P31/P32 na fronteira; problemas específicos vêm após a tabela.

| Ferramenta | Trecho atual / famílias de saída | Fonte do manipulador |
| --- | --- | --- |
| `status` | §7.1; tabelas de cota/demanda, capacidade, avisos, modelos ausentes; `showBefore` opcional | `src/core/status-operations.js:statusOperation` |
| `actors_list` | §7.1; linhas/notas/lacunas/soluções ausentes, cota baixa/ocupado/alternativa próxima (**código**) | `src/core/status-operations.js:actorsListOperation` |
| `quota_show` | `"reading":{"source":"manual"}`; leituras por cliente e `now`, recusa de cliente desconhecido | `src/core/quota.js:quotaShow` |
| `quota_set` | `quota_set: client must be a non-empty string`; pct/value/snapshot salvos (**código**) | `src/core/quota.js:quotaSet` |
| `quota_notice` | `"available":false,"released":false`; texto indisponível abaixo; aviso de cota liberada (**código**) | `src/quota/released.js:quotaReleasedNotice` |
| `limits_status` | `"live":0,"byClient":{}`; limites/origem padrão/avisos | `src/core/limits-operations.js:limitsStatusOperation` |
| `acquire_slot` | `{client:"codex",runId:"review"}` → `{"ok":true,"runId":"review","client":"codex"}`; limites ocupados (**código**); sem argumentos: `acquire_slot: runId must be a non-empty string` | `src/core/limits-operations.js:acquireSlotOperation` |
| `release_slot` | `{runId:"review"}` → `{"ok":true,"runId":"review"}`; sem argumentos: `release_slot: runId must be a non-empty string` | `src/core/limits-operations.js:releaseSlotOperation` |
| `env_report` | `Command available in PATH: no.`; `Configured: none confirmed.`; pastas/coletor/modelos/instalação | `src/core/status-operations.js:envReportOperation` |
| `kit_detect` | `{"state":"absent","path":null,"version":null,"message":"kit: absent. See INSTALL.md#orchestration-kit for kit installation instructions."}`; presente/quebrado (**código**) | `src/core/kit.js:kitDetect` |
| `daemon` | `{action:"status"}` → `{"running":false,"pid":null,"startedAt":null,"paused":false,"lastTick":null}`; pausar/retomar/ciclo (**código**) | `src/core/daemon.js:daemonOperation` |
| `config_get` | `"path":"language","value":"en","origin":"default"`; descrições bilíngues; chave desconhecida (**código**) | `src/core/config.js:configGet` |
| `config_set` | `config_set: key must be a non-empty string`; `{key:"language",value:"pt-BR"}` → `"removedAliases":[]`; anterior/depois/origem/descrição; remoção/recusas (**código**) | `src/core/config.js:configSet` |
| `classify` | `{title:"Review output"}` → `{"effort":"normal","reasons":["default: no rule matched, so normal"]}`; motivos de regras correspondentes (**código**) | `src/core/profile-operations.js:classifyOperation` |
| `profile_pick` | `{client:"codex",effort:"normal"}` → `{"model":"gpt-5-codex","effort":"medium","maxTurns":40}`; alternativa por cota baixa/recusa (**código**) | `src/core/profile-operations.js:profilePickOperation` |
| `inbox_add` | `inbox_add: title must be a non-empty string`; `{title:"Output review"}` → `"status":"pending","stepIds":[]` | `src/core/inbox-operations.js:inboxAddOperation` |
| `inbox_list` | `[]`; itens/descrição de posse/filtro/limite (**código**) | `src/core/inbox-operations.js:inboxListOperation` |
| `inbox_claim` | `inbox_claim: client must be a non-empty string`; posse/conflito/obsoleto/ausente (**código**) | `src/core/inbox-operations.js:inboxClaimOperation` |
| `inbox_release` | `inbox_release: client must be a non-empty string`; liberado/sem posse/ausente (**código**) | `src/core/inbox-operations.js:inboxReleaseOperation` |
| `inbox_set_status` | `inbox_set_status: id must be a non-empty string`; transição/recusa por posse/ausente (**código**) | `src/core/inbox-operations.js:inboxSetStatusOperation` |
| `order_add` | `order_add: text must be a non-empty string`; `{text:"Review outputs"}` → `"scope":"all","origin":"maintainer"` | `src/core/orders-operations.js:orderAddOperation` |
| `order_list` | `[]`; instruções ativas/validade/filtro de projeto (**código**) | `src/core/orders-operations.js:orderListOperation` |
| `order_remove` | `order_remove: id must be a non-empty string`; revogada/ausente (**código**) | `src/core/orders-operations.js:orderRemoveOperation` |
| `trajectory_show` | `{run:"missing"}` → `ENOENT: no such file or directory, stat` (prefixo); passos salvos (**código**) | `src/mcp/tools.js` → `src/trajectory/index.js:show` |
| `telemetry_status` | `"enabled":false,"network":false`; `what` bilíngue, pasta/tamanho/última exportação | `src/mcp/tools.js` → `src/telemetry/index.js:telemetryStatus` |
| `telemetry_export` | `{"count":0,"resourceMetrics":[],"network":{"count":0,"statusCode":null}}`; data/exportação/consentimento de rede (**código**) | `src/mcp/tools.js` → `src/telemetry/index.js:exportTelemetry` |
| `todo_check` | `{"reports":[]}`; tarefas sem demandas e demandas sem tarefas (**código**) | `src/core/todo.js:todoCheck` |
| `todo_sync` | `{"reports":[],"dryRun":false,"check":false}`; prévia/vínculos confirmados/erros (**código**) | `src/mcp/tools.js` → `src/todo/index.js:todoRun` |
| `smoke_demo` | `{dryRun:true}` → `"status":"preview","exitCode":0,"confirmed":false`; plano/cenário bilíngue; confirmação/execução/orçamento/erros (**código**) | `src/mcp/tools.js` → `src/smoke/demo/entry.js:smokeDemo` |

Texto executado de `quota_notice {}`: `The quota-back notice is not available yet. Update the kit to get it; until then, ask for the quota table whenever you want to check.` O `what` da telemetria executada começa com `Records only counts, durations, states, role, model and app names, effort settings and an anonymous project reference; no messages, files or work text. Sending requires separate consent. / Registra somente contagens, durações, estados, nomes de papel, modelo e aplicativo, ajustes de esforço e uma referência anônima ao projeto; sem mensagens, arquivos ou textos de trabalho. O envio exige uma escolha separada.`

Todos os caminhos de argumentos inválidos usam auxiliares do núcleo (texto/número/opção/tipo/chave extra), com mensagens em inglês bruto salvo localização explícita. `callTool` não acrescenta recuperação. Nome desconhecido lança `unknown tool ${name}` fora do catch; o servidor retorna `Invalid params: ...` no protocolo. Erros de análise/requisição/método e stderr inicial (`okit mcp server: ...`) são diagnósticos de transporte, não mock-ups humanos. `src/mcp/control*.js` expõem conexão/autorização/tempo esgotado; `selfcheck-probe.js` emite JSON de máquina (códigos mapeados pelo apresentador), não outro comando de usuário. Descrições do registro juntam inglês e português; a descrição inglesa de atores em `src/profiles.js` já contém os dois idiomas.

### 7.3 Problemas

- **P21 — W/N:** `status {}` e `actors_list {}` dizem falsamente “Cliente não reconhecido” quando nenhum foi informado/detectado. Informar que todos são exibidos e dar chamada concreta opcional de seleção.
- **P22 — S/W:** linha críptica mistura execução/limite/disponibilidade/origem/piso; sem clientes instalados vira frase vazia. Explicar vagas e limite de cota separadamente; não inferir executores disponíveis de porcentagens.
- **P23 — D/H:** `rowOf` coloca instrução completa de registro de cota na célula Situação; ordens de cota baixa também viram texto na tabela. Dicas de visões sempre aparecem. Mover orientação para baixo, uma vez por ação distinta.
- **P24 — N/W:** leituras ausentes de `quota_show` viram objetos só com origem, sem porcentagem/significado/recuperação; horários/renovação/idade desconhecida precisam de rótulos claros. Leitura ausente não é cota zero.
- **P25 — S/W/D:** tabela de atores tem oito colunas, sem título/resumo, e comprime cota em `verde; ...; idade ...`. Explicar ator = modelo com esforço de raciocínio em um cliente; tirar soluções das células.
- **P26 — S/N/W:** `limits_status` e sucesso/ocupação de aquisição/liberação expõem objetos de limite/execução sem resumo; explicar vaga = um executor simultâneo e dar próxima chamada segura quando vazio/ocupado.
- **P27 — N/W:** `kit: absent` dá âncora documental, sem comando imediato; aviso de cota manda atualizar o kit sem comando exato. Kit e plugin são pacotes distintos; não inventar instalador do kit nem substituir por update do plugin.
- **P28 — L:** `what` da telemetria, descrições de configuração, plano de demonstração e descrições de ferramentas são bilíngues/inglês independentemente do idioma humano; enums de situação e motivos de classificação também aparecem em inglês no pt-BR. Preservar dados, selecionando/traduzindo a visão humana.
- **P29 — N/S:** `[]`, relatórios/métricas vazios, daemon ausente e trajetória ausente não têm explicação com título nem próxima chamada útil. ENOENT/caminho bruto é erro técnico, não recuperação.
- **P30 — N/H/W:** ambiente lista observações internas e instruções “Missing” dispersas (inclusive reparo com cliente padrão fixo). Precisa de resumo e uma ação por causa real.
- **P31 — L/N:** exceções de argumentos em inglês passam por `callTool` sem localização ou exemplo válido. Algumas recusas do núcleo retornam objetos em vez de `isError:true`; preservar a distinção.
- **P32 — M:** texto JSON mistura dados e campos de apresentação (`markdown`, `capacityLine`, `text`, `message`, descrições). Mudar textos, acrescentar campos ou substituir JSON afeta consumidores; mock-ups humanos não autorizam mudanças silenciosas no protocolo.

<a id="section-8"></a>
## 8. Decisões para o Producer

1. **Redação e vocabulário:** aprovar títulos, “Pronto / Precisa de atenção”, “esforço de raciocínio”, “serviço em segundo plano” e texto neutro sem cliente. Recomendo termos curtos com significado em uma linha; preservar identificadores nas chamadas.
2. **Tabela ou lista:** aprovar tabelas para dados de status/cota/atores/vagas; listas para correções, perguntas, vazios e passos de instalação. Recomendo atores com cinco colunas dos mock-ups; manter detalhes completos para consumidores de dados.
3. **Formato de máquina:** aprovar se o assistente renderiza prosa dos objetos preservados ou se campos textuais mudam. Recomendo preservar JSON/códigos de saída/sinalizadores agora; revisar compatibilidade antes de mudar texto serializado. Nenhuma mudança de formato aprovada aqui.
4. **Vazios e opcionais:** aprovar comandos seguros de repetição/verificação, redação sem instalação com saída 2 e orientação de kit. Recomendo `doctor`/`kit_detect {}` e guia do kit; comando exato de instalação/atualização do kit segue aberto até ser fornecido pelo responsável.
5. **Queixas históricas e verificação:** aprovar P1/P4 como constatações condicionais/de terminal, sem afirmar regressão bilíngue atual na CLI. Recomendo capturas futuras nos dois idiomas, verificação de dicas por visão (sem proibir dados repetidos legítimos), ausência do falso aviso e asserções de JSON/saída preservados. Testes pertencem à implementação.
