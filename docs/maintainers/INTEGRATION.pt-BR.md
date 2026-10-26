# Desenho da integração

Decisões de integração e provas de aceite para fatos de ambiente comuns e papéis nativos.

<a id="contents"></a>
## Índice

- [1. Scope and history](#section-1)
- [2. One environment model](#section-2)
- [3. Gap analysis](#section-3)
- [4. Client adapters](#section-4)
- [5. Role layer](#section-5)
- [6. Shared glossary](#section-6)
- [7. Question routing](#section-7)
- [8. Steps 2–4 and acceptance](#section-8)

[English](INTEGRATION.md) · [Arquitetura](ARCHITECTURE.pt-BR.md)

<a id="section-1"></a>
## 1. Scope and history

- 2026-10-26: passos 2–4 implementados, incluindo integração do fluxo inteiro e encaminhamento bilíngue.

O plugin deve fazer parte do Claude Code, do Codex e do opencode. A pessoa faz perguntas comuns; as instruções do cliente encaminham para os fatos compartilhados. “A fazer” abaixo significa comportamento proposto, ainda não entregue. Este desenho amplia o `src/env/` existente; não cria uma segunda fonte `src/environment`.

<a id="section-2"></a>
## 2. One environment model

Implementado nos passos 2–4: `src/env/snapshot.js` produz um retrato somente leitura por pedido, compartilhado por CLI, MCP, status, atores, exibição de cota, diagnóstico do setup, avisos de PATH e preparação do smoke. Nenhum consumidor detecta o ambiente sozinho. Leitores dos adaptadores e coletores fornecem observações a `src/env`; não viram relatórios concorrentes. O setup continua responsável por salvar escolhas aprovadas; coletar cota e ocupar vaga continuam operações explícitas.

- Cliente em uso — Marcadores da sessão, ou desconhecido; instalação sozinha nunca prova uma sessão.
- Clientes instalados — Presença, versão, evidência e motivo de falha por cliente; ausente difere de desconhecido.

**Fatos de execução**

- Modelos e atores — Modelos ativos confirmados; cliente + modelo + esforço, tamanhos S/M/L atendidos, aptidão para revisão e restrições para iniciar. Candidatos do catálogo ficam separados de acesso confirmado.
- Cota por cliente — Janelas restantes, renovação, provedor quando conhecido, fonte automática/manual, horário da amostra, horário da leitura e idade; desconhecido continua desconhecido. Idade do cache não é idade da amostra.
- Vagas — Total, em execução, livres e origem do limite por cliente, da mesma leitura de vagas; porcentagem de cota nunca determina concorrência.

**Evidências de configuração**

- Caminhos — Pastas do plugin, estado e configuração dos clientes, localização do comando e disponibilidade no PATH atual, com evidência.
- Configuração — Escolhas salvas, perfis efetivos e origens, clientes/modelos/tamanhos/setup/PATH que faltam, motivos e próximos passos.

Ambiente, arquivos, execução de comandos, relógio, configuração, leitores de cota e contagens de vagas são injetáveis. Reutilizar observações no pedido; invalidar as afetadas após mudança explícita. Manter desconhecidos e erros visíveis. A formatação traduz o mesmo retrato sem reler a máquina; seleção e políticas o consomem sem chamadas recursivas de `src/env` para status ou atores.

O retrato expõe `models` e `actors` confirmados, ao lado de `candidates` configurados com confirmação e restrições explícitas. Cota desconhecida, vencimento explícito ou idade da amostra acima de `staleMinutes` bloqueiam o início. Horários da amostra e da observação ficam separados. Setup pede observações de modelos sem consultas extras de versão/PATH; confirmação e escrita continuam no setup.

<a id="section-3"></a>
## 3. Gap analysis

**Snapshot and views / Instantâneo e visões**

- `src/env/report.js:environmentReadings`, `environmentVersions` — Contexto do plugin/estado, observação do PATH e versões dos executáveis. — Feito: env reúne evidências de versão/modelos e expõe pastas de configuração dos clientes.
- `src/env/report.js:environmentReport`, `formatEnvironmentReport` — Clientes em uso/instalados, modelos ativos confirmados, atores modelo+esforço e tamanhos, linha de cota, vagas livres, itens configurados/ausentes e comandos de correção nos dois idiomas. — Feito: formata o retrato de env sem chamar status ou atores; fonte/idade da cota são traduzidas da mesma amostra.
- `src/status.js:detectClient`, `statusTable`, `readingWithAge`, `rowOf`, `setupPendingLine` — Seleção da sessão, cache/janelas/idade/situação da cota, cálculo de vagas e setup pendente. — Feito: consome observações e derivações de env, preservando seleção da sessão e exibição das demandas.
- `src/actors.js:listActors` (MCP `actors_list`) — Agrupa pares configurados modelo+esforço, tamanhos e classe de revisão; calcula vagas e motivos para iniciar a partir de status. — Feito: candidatos têm confirmação explícita, tamanhos e restrições compartilhados; cota desconhecida ou expirada bloqueia o início.

**Quota observations / Observações de cota**

- `src/cli.js:quotaCommand`; `src/status.js:adapterQuotaReader` — Quota show lê adaptadores separadamente; set grava amostra manual. — Feito: show consome env; set grava e atualiza o retrato, preservando precedência das fontes por cliente.
- `adapters/claude-code/index.js:readQuota`; `src/quota/statusline-collector.js:collectStatusline` — Lê cota manual/automática salva; coletor registra entrada da barra de status. — Manter coleta na borda; env cuida da observação normalizada.
- `adapters/codex/index.js:readQuota`; `adapters/codex/session-quota.js:readCodexSessionQuota` — Cota de sessões locais recentes, precedência da amostra mais nova e alternativa manual. — Preservar fonte e idade da amostra em todas as visões.
- `adapters/opencode/index.js:readQuota`; `adapters/opencode/quota-source.js:readOpencodeSource` — Leituras por comando/arquivo do provedor configurado com alternativa manual. — Preservar provedor, idade e motivo da alternativa no retrato; nunca deduzir cota de custo.

**Setup and acceptance / Configuração e aceite**

- `src/setup/detect.js:detectClients`, `proposeProfiles`; `src/setup/setup.js:runSetup`; `src/profiles.js:configOf`, `setupPending` — Descobre clientes/modelos separadamente, propõe perfis e salva configuração confirmada. — Feito: env cuida das observações e propostas; setup mantém confirmação e escritas. Padrões nunca confirmam acesso da conta.
- `src/install/link.js:binInPath`, `activationWarning`; `src/cli.js` — Verifica PATH atual separadamente para avisos de ativação. — Feito: env cuida da evidência do PATH; avisos mantêm a orientação de correção existente.
- `src/smoke/client.js:runScenario`; `src/smoke/client-checks.js:judge`; `src/smoke/checks-install.js:versionMatches` — Lê cota/idade e contexto local; avalia status e evidências de instalação. — Feito: consumir env na preparação; manter orçamento, validade e recusas próprios do smoke. Cenário real hoje atende somente Claude Code.
- `src/mcp/tools.js:envReportTool.handler`; skills de papel — MCP reúne leituras/limites; instruções de Director, Executor e Critic existem. — Feito: ligação ao retrato, entrega nativa de papel e respostas completas bilíngues; sem nova ferramenta de papel.

<a id="section-4"></a>
## 4. Client adapters

Um adaptador por cliente, com `capabilities`, `listModels`, `readQuota`, `spawn`, `installSkill`, `installHooks`, resolução da pasta de configuração e contrato comum `deliverRole`, `installRole`, `removeRole`. `src/roles.js` compõe papel, briefing, ordens/limites aplicáveis, títulos legíveis, atores e fatos desconhecidos pelo instantâneo do env fornecido. A entrega devolve `ready`, `clarification` ou `unsupported`; nunca troca papel. Modelo+esforço do ator continua independente.

Referência operacional: [adapters](../components/adapters.pt-BR.md).

Fixtures dos adaptadores comprovam esses formatos, sem comprovar smoke real nem todas as versões. `nativeSupported: false`, blocos/ajustes malformados, instruções Codex ocultas e conflito de nome de agente opencode devolvem falta de suporte explícita. O instalador relata entrega nativa Windows como não suportada; sem alternativa silenciosa. Instruções do usuário sobrevivem à instalação/remoção repetida.

<a id="section-5"></a>
## 5. Role layer

Implementado: a sessão principal recebe Director por padrão pelas instruções nativas. Briefings devem conter um cabeçalho explícito `Role: Executor` / `Role: Critic` (ou `Papel:`), ou campo estruturado `role`. Papéis ausentes, conflitantes ou inválidos exigem esclarecimento antes do trabalho. Modelo+esforço é o ator, não o papel. A entrega nativa fornece o mesmo contrato; skills descrevem comportamento, env fornece fatos de ambiente e núcleo fornece trabalho/ordens. Perguntas são somente leitura.

Referência operacional: [skills](../components/skills.pt-BR.md).

“Qual o seu papel?” responde: papel atual; ações permitidas e proibidas; ordens e limites aplicáveis; demandas em mãos pelo título legível; atores disponíveis, restrições de cota/vagas e fatos desconhecidos. As três skills compõem a resposta pelo contexto entregue e instantâneo comum, atualizando com `inbox_list`, `order_list`, `actors_list`, `limits_status` e `env_report`. Não existe nem é necessária ferramenta unificada de resposta de papel. Fatos ausentes ficam explicitamente desconhecidos.

Exemplo ao usuário: “Sou o Director. Organizo seu trabalho, escolho ajudantes disponíveis e verifico os resultados. Devo respeitar suas instruções e não posso publicar sem autorização. Estou preparando o guia de integração. Posso listar os modelos disponíveis e quanto espaço cada cliente tem.” Gerar trabalho, limites e atores reais a partir de evidências. Usar palavras comuns e títulos legíveis; sem identificadores de demanda ou ordem no texto de uso ao usuário. Informar contexto de papel ausente, sem adivinhar uma tarefa com briefing.

<a id="section-6"></a>
## 6. Shared glossary

Implementado nas seis skills: usar este vocabulário nas seis skills de papel/ambiente/setup/smoke, descrições de ferramentas em `src/mcp/tools.js` e mensagens em `src/profiles.js`, status e env. Sinônimos ajudam a encaminhar perguntas; não eliminam as distinções abaixo. O Produtor é a pessoa que pede e autoriza o trabalho.

**Work vocabulary / Vocabulário de trabalho**

- Actor / ator — Modelo + esforço disponível em um cliente, independente de tarefa em execução ou papel. — actor, model, work choice, available executor / ator, modelo, opção de trabalho, executor disponível
- Executor — Papel que realiza um briefing; executor em execução ocupa uma vaga. — executor, worker, helper, agent / executor, trabalhador, ajudante, agente
- Class / classe — Categoria configurada de trabalho que seleciona um perfil: simple, normal, hard; classe de revisão configurada à parte. — class, work category, complexity / classe, categoria de trabalho, complexidade
- Size / tamanho — Tamanho S/M/L do trabalho, ligado pela configuração a uma classe; não é nome de modelo nem papel. — size, small/medium/large task / tamanho, tarefa pequena/média/grande

**Capacity vocabulary / Vocabulário de capacidade**

- Slot / vaga — Espaço para um executor simultâneo, limitado por cliente. — slot, free room, concurrency / vaga, espaço livre, concorrência
- Profile / perfil — Escolha salva de modelo+esforço para cliente/classe, com ajustes de execução quando aceitos. — profile, model choice, preset / perfil, escolha de modelo, predefinição
- Quota / cota — Saldo informado para cliente/janela, não contagem de vagas, tokens gastos ou custo monetário. — quota, allowance, usage left, remaining limit / cota, saldo, uso restante, limite restante
- Source / fonte — De onde veio um fato; cota distingue automática/manual e pode identificar provedor. Idade informa há quanto tempo a amostra foi registrada. — source, origin, reading, sample / fonte, origem, leitura, amostra

“Quais executores tenho?” significa atores disponíveis, salvo quando a pessoa pergunta quem está rodando; nesse caso, usar status/vagas. “Quanta capacidade?” exige cota e vagas livres, informadas separadamente. Nunca converter porcentagem em quantidade de executores.

<a id="section-7"></a>
## 7. Question routing

| Pergunta do usuário (English / Português) | Skill → ferramenta ou comando existente | Trabalho restante |
Referência operacional: [skills](../components/skills.pt-BR.md).

<a id="section-8"></a>
## 8. Steps 2–4 and acceptance

Os passos 2–4 estão concluídos. `test/env-flow.test.js` exercita os três adaptadores com HOME temporário, relógio/cota/vagas injetados e clientes falsos. `test/skills.test.js` verifica o mesmo mapa bilíngue e glossário nas seis skills.

| Passo | Arquivos a mudar | Aceite |
| :- | :- | :- |
| 2 — Fonte única | `src/env/report.js`, `src/status.js`, `src/actors.js`, `src/profiles.js`, `src/cli.js`, `src/mcp/tools.js`, `src/setup/detect.js`, `src/setup/setup.js`, `src/install/link.js`, leitores de cota dos adaptadores; `test/env-report.test.js` | Feito: env cuida das observações e derivações; status/atores/cota/setup/PATH as consomem. Sem ciclo de dependências. No mesmo retrato injetado, cliente, modelos, fonte/idade, vagas e pendências concordam; acesso confirmado e candidatos configurados ficam explícitos. Cada consulta externa roda uma vez por pedido. |
| 3 — Entrega de papel (feito) | `src/roles.js`, `src/hook-session-start.js`, `src/install/role-block.js`, registro/plugin do instalador, ligação do hook no release; os três adaptadores e skills de papel; `test/roles.test.js` e os três testes de adaptador | Fixtures nativas comprovam Director principal e Executor/Critic explícitos, instruções/configuração preservadas, modelo+esforço, respostas completas bilíngues, esclarecimento/falta de suporte e perguntas somente leitura. Formatos sem suporte são limitações explícitas; fluxo inteiro coberto no passo 4; smoke real continua separado. |
| 4 — Fluxo inteiro e encaminhamento (feito) | `test/env-flow.test.js`, `test/env-report.test.js`, `test/docs-consistency.test.js`, `test/docs-links.test.js`, `src/smoke/client.js`, `src/smoke/client-checks.js`, `src/smoke/checks-install.js`, as seis `skills/okit-*/SKILL.md` nomeadas neste desenho | HOME temporário e clientes falsos exercitam descoberta → setup ausente → setup confirmado → concordância env/status/atores/cota → resposta de papel → demonstração offline. Injetar relógio/cota/vagas e isolar caminhos dos clientes/estado; sem conta, pasta pessoal ou rede reais. Encaminhamento cobre os dois idiomas. Sucesso com clientes falsos não comprova smoke em cliente real. |

| Deve passar | Deve recusar ou informar desconhecido |
| :- | :- |
| Sessão reconhecida com modelos confirmados; cota automática e manual com idade das amostras; tamanhos dos atores agrupados; vagas livres separadas. | Executável ausente, listagem falha ou alternativa só de catálogo não podem afirmar modelos confirmados. |
| Cada papel recebe somente seu briefing e ordens aplicáveis; arquivos do usuário sobrevivem à instalação. | Papel ambíguo no briefing e entrega sem suporte por hook/Task não podem ser aceitos silenciosamente. |
| Perguntas comuns vão aos fatos somente leitura; setup solicitado explicitamente chega à própria confirmação. | Pergunta de ambiente não pode salvar configuração, iniciar trabalho ou gastar cota. |
| Smoke usa a mesma cota observada de env com seus próprios limiares de segurança documentados. | Cota vencida/desconhecida não autoriza smoke real sem a exceção explícita já existente; cota baixa segue sua regra de recusa. |

Passo 4 feito: encaminhamento do fluxo inteiro, preparação do smoke e cobertura hermética offline. A demonstração mínima C1 apresenta atores injetados e informa corretamente checks de instalação incompletos quando executada sozinha; não equivale a smoke completo aprovado. Demonstrações em clientes reais e orquestração D55 ficam fora deste passo. Chamadores fornecem cabeçalho explícito de papel; briefings ambíguos recusam antes do processo.

Referências de formato nativo: [Claude SessionStart](https://code.claude.com/docs/en/hooks), [instruções Codex](https://learn.chatgpt.com/docs/agent-configuration/agents-md), [agentes opencode](https://opencode.ai/docs/agents/) e [hooks config do plugin](https://opencode.ai/docs/plugins/).
