# Assistente de instalação — D144

![okit-plugin: Manutenção](../images/banners/maintainers.svg)

Somente design; as rotas e opções abaixo são propostas, ainda não implementadas.

Texto equivalente: [English](INSTALL-WIZARD.md). Módulos atuais: [ARCHITECTURE](ARCHITECTURE.pt-BR.md).

<a id="contents"></a>
## Índice

- [1. Entradas e bootstrap](#section-1)
- [2. Arquitetura de execução compartilhada](#section-2)
- [3. Estados, telas e reexecuções](#section-3)
- [4. Segurança e ciclo de vida](#section-4)
- [5. Sem navegador, acessibilidade e idioma](#section-5)
- [6. Aceitação e testes das fatias de implementação](#section-6)
- [7. Demandas de implementação com merge independente](#section-7)
- [8. Riscos e decisões do proprietário](#section-8)

<a id="section-1"></a>
## 1. Entradas e bootstrap

O instalador principal é o fluxo inicial de `okit-plugin config ui`: um servidor Node,
página, token, catálogo de rótulos e telas de modelos/esforço/contas. Sem aplicativo desktop.
As regras de instalação ficam em `src/install`; o navegador envia escolhas e mostra resultados.

| Entrada | Comportamento decidido |
| --- | --- |
| Download Linux/macOS | Execute `sh install.sh`; padrão: verificar/baixar pacote, conferir requisitos, abrir assistente. |
| Instalador shell alternativo | `sh install.sh --terminal`; mesmo instalador Node e presenter de terminal testado. |
| Forçar navegador | `sh install.sh --ui`; nunca trocar silenciosamente para terminal. |
| Lançador Windows (fatia 5, implementada) | O código-fonte compartilhado `src/install/bootstrap.js` marca o que é de um só destino com linhas `//#if unix|windows` ... `//#endif`; `selectTarget()` em `src/release/install-scripts.js` mantém o bloco só no seu destino: a saída Unix é o fonte de antes e a do Windows não tem pergunta de cliente, readline, abridor nem rota de terminal. O Windows escolhe o cliente sem perguntar (`--client`, `OKIT_CLIENT`, o registro, senão o primeiro instalado na ordem configurada; nenhum: saída 2 citando `claude`, `codex`, `opencode`), confere que as pastas temporária e de destino aceitam gravação, verifica o SHA-256 e executa `install --ui` (`--headless` com `--headless`; sem `--auto`: se o navegador não abre, imprime a URL e continua sem navegador). `--terminal`, `--yes`, `--autostart`, `--set-execution-policy` e `--no-execution-policy` em `install` são recusados (saída 2, texto `route.windows`: o Windows usa o assistente no navegador), nunca viram abertura de navegador. `update` e `uninstall` mantêm suas opções. A execução manual no Windows PowerShell 5.1 e 7 (roteiro abaixo) é a evidência do Diretor e está pendente. |
| Roteamento (fatia 4, implementada) | Sem opção, `install.sh` escolhe o cliente sem perguntar (`--client`, `OKIT_CLIENT`, registro instalado, senão o primeiro cliente instalado na ordem configurada), decide a rota antes de baixar (`src/install/route.js`, função pura `chooseRoute`), imprime o motivo e executa `install --ui --auto` ou o instalador de terminal. `--auto` é interno: se o abridor não inicia, o servidor fecha (nenhum job rodou) e o instalador de terminal roda com os mesmos argumentos. `--yes`, `--autostart` e as opções de política de execução levam a rota automática ao terminal (nunca são consentimento do navegador). Sem terminal e sem `--client`/`OKIT_CLIENT`, a rota de terminal sai com 2 antes de baixar. |
| Download Windows | Execute `powershell.exe -NoProfile -File .\install.ps1`; somente bootstrap e assistente web, sem assistente de terminal. |
| Pacote extraído e verificado | `node src/cli.js install --ui --from .`; execute na pasta do pacote extraído. |
| Comando instalado | `okit-plugin install --ui`; `okit-plugin config ui` mostra o fluxo inicial quando instalação/setup estiver incompleto. |
| Automação CLI existente | Preservar opções/comportamento de terminal atuais; não transformar execução não assistida em abertura de navegador. |

`--ui` e `--terminal` são mutuamente exclusivos. `--headless` significa `--ui` sem
abrir navegador; conflita com `--terminal`. Scripts encaminham idioma e destino.

- O mínimo atual é **Node 20**, derivado de `pkg.engines.node` por `scriptDefaults()` em `src/release/install-scripts.js`; manter essa fonte única.
- Sem Node: `Node.js é necessário: https://nodejs.org/`, localizado, saída 2, sem download/servidor/escritas de instalação. Node antigo: versões necessária/atual, saída 2. Instalar Node e repetir; sem instalação automática do runtime.
- Exigir pelo menos um executável entre `claude`, `codex`, `opencode` (ID interno do Claude: `claude-code`). Nenhum encontrado: instruções de instalação, saída 2, sem mudanças no plugin. Detecção não implica login nem modelos disponíveis.
- Conferir sistema/arquitetura suportados e permissão de escrita no temporário/destino. Aquisição Unix atual precisa de curl/wget e tar; Windows usa download PowerShell e `Expand-Archive`. Ambos verificam SHA-256 no Node embutido com `createHash`; não exigem utilitário externo de hash. Informar ferramenta ausente antes do download.
- Baixar pacote e manifesto de checksums da release; exigir uma entrada SHA-256 inequívoca e correspondente antes de extrair/executar. SHA-256 detecta bytes alterados; não autentica o publicador.
- Pacotes extraídos offline dispensam ferramentas de rede. Pacote local `--from` é confiado pelo usuário; não chamá-lo de verificado por checksum sem evidência do manifesto.
- `renderInstallScripts()` / `writeInstallScripts()` geram ambos os scripts. Wrappers mantêm aquisição, integridade, requisitos e abertura; Node mantém registro, PATH, setup, painel e autoverificação.
- O bootstrap Node embutido atual pergunta o cliente: remover essas perguntas do Windows e do bootstrap Unix com UI. Escolher deterministicamente um cliente detectado para o artefato inicial específico por cliente (`--client` explícito, senão ordem configurada); baixar/verificar outros artefatos selecionados antes de Aplicar. Auditar presença da UI compartilhada na fatia 1.
- Manter arquivos extraídos do bootstrap até encerrar a sessão servidor/config; limpar downloads temporários em falha e saída. Sem elevação ou desvio da política de execução pelo wrapper.

<a id="section-2"></a>
## 2. Arquitetura de execução compartilhada

| Superfície atual | Reuso / extensão necessária |
| --- | --- |
| `src/install/index.js: installerCommand(command, args, ctx, io)` | Manter orquestração; injetar `io.ui`, `read`/`ask`, adaptadores de arquivos/processos. Extrair limites comuns de plano/aplicação para os dois presenters; não interpretar texto do terminal. |
| `src/install/present.js` | Reusar `planSteps`, `finish`, `finishLink`, `resolveLocale`, `localizeReason`, `redact`. Presenter estruturado implementa `sequence`, linhas, perguntas e resultados; manter `createPresenter` para terminal. |
| Chamadas atuais da instalação | Preservar aquisição, colocação/backup, propriedade de registros/MCP/barra de status, `verifyInstall`, prova smoke da atualização e classificação de saída. Emitir avisos tipados e orientação de recuperação. |
| `src/install/link.js` | Reusar `chooseLinkDirectory`, `linkPlan`, `applyLink`, `managePath`, `activationMessage`; estender plano com blocos exatos dos perfis e PATH de usuário Windows antes/depois. Dry-run textual sozinho é insuficiente. |
| `src/setup/setup.js` | Reusar `runSetup`, `initializeDetectedConfig`, validação, gravação com trava e `setup.done.profiles`. Separar observação/proposta das escritas automáticas antes de integrar o navegador. |
| `src/setup/detect.js`, `src/setup/offer.js` | Reusar `detectClients`/`proposeProfiles` e semântica de pendência/oferta; respostas do navegador substituem `ask`, não regras de modelos. |
| `src/setup/autostart-step.js: setupAutostart` | Opcional; mostrar registro no sistema/arquivos e pedir consentimento; nunca implícito. |
| `src/install/panel.js` | Reusar elegibilidade de `offerPanel` e `panelCommand`; oferta opcional explícita somente para Claude após registro bem-sucedido. |
| `src/install/index.js: kitRow`, `kitLine` | Manter `detectKit` somente leitura, informar instalado/ausente/quebrado e sobreposição; nunca instalar/atualizar kit. Expor linha estruturada sem duplicar detecção. |

Estender `startConfigServer` em `src/config-ui/server.js`, `renderPage` em `page.js`,
`clientMain` em `client.js`, `buildState` em `state.js` e `labels` em `labels.js`.
Reusar `openConfigSession` em `session.js`; seu mapa atual por raiz cobre um processo MCP,
não processos CLI separados. Adicionar trava de instalação por raiz de estado entre processos.

Escolher **polling**, não SSE: fetch autenticado atual aceita `x-okit-token`;
EventSource nativo incentivaria tokens em mais URLs. Nenhuma dependência necessária.

| Rota proposta | Contrato |
| --- | --- |
| `POST /api/install/plan` | Operação/cliente/conta/opções tipados; retorna dry-run somente leitura, `planId`, impressões dos dados de entrada e mudanças propostas. Nunca aceitar comandos shell ou conteúdo arbitrário de arquivos. |
| `POST /api/install/apply` | Recebe `planId`, consentimento explícito e chave de idempotência. Revalidar entradas sob trava; plano desatualizado = 409/revisar novamente. Mesma chave retorna mesmo job; job concorrente = 409. |
| `GET /api/install/job?after=N` | Consultar a cada segundo enquanto ativo; estado, eventos ordenados `{seq, stage, client, status, messageKey, params}`, pergunta tipada pendente e resultado final. Histórico limitado; cursor antigo recebe retrato completo. |
| `POST /api/install/answer` | IDs de job/pergunta mais resposta validada por schema; respostas antigas/duplicadas não aplicam duas vezes. Pergunta com escrita traz sua própria prévia e consentimento. |
| `POST /api/install/cancel` | Solicita parar entre etapas seguras; nunca interromper escrita atômica/registro no meio. Retorna etapas concluídas/restantes; cancelar não é rollback. |

Usar o mesmo plano Node no `--dry-run` de terminal e na revisão web. Enumerar
destino/substituição do pacote, backups, comandos de registro do cliente, MCP/barra de status,
shims, blocos de perfil/PATH de usuário, chaves de configuração, política/autostart e conflitos de propriedade.
Mostrar caminhos, diferenças antes/depois com segredos ocultos, decisões de sobrescrever/pular e limites de recuperação.
Registrar impressões das entradas afetadas e release/checksum selecionados; alterações exigem nova
prévia. Download/extração podem usar staging descartável antes do consentimento; instalação,
perfis e configuração não podem mudar. Não afirmar que o dry-run atual já fornece isso.

<a id="section-3"></a>
## 3. Estados, telas e reexecuções

`detectar → requisitos → revisão → aplicando → modelos → painel → contas → recarregar → resultado → config`
Qualquer mudança de escolha antes de aplicar invalida a revisão. Aplicação pode falhar/ser cancelada;
voltar à detecção/revisão para tentar novamente, nunca repetir escritas ao carregar a página.

| Tela/estado | Contrato visível ao usuário |
| --- | --- |
| Escolha de clientes | Clientes detectados, executável/versão, contas selecionadas; permitir vários clientes instalados. Cliente selecionado ausente bloqueia Aplicar. |
| Requisitos | Node/sistema/ferramentas/permissões, falhas bloqueantes e correção exata. Detecção somente leitura; listagem de modelos mantém prazo padrão atual de 5 segundos do servidor. |
| Revisão | Checklist de dry-run e mudanças exatas; escolhas opcionais de PATH/barra de status/política/autostart; Aplicar explícito, sem consentimento padrão. |
| Progresso | Etapas por cliente, avisos, pergunta atual, cancelamento seguro; autoverificação e prova smoke da atualização. Saída do processo sozinha não significa setup completo. |
| Modelos e esforço | Controles atuais de config e regras de modelos confirmados; propostas da detecção de setup. `runSetup` mantém responsabilidade por gravação/confirmação; adicionar entrada tipada de proposta/esforço ao fluxo comum. Mostrar prévia e confirmar uma vez antes da gravação sob trava. |
| Painel opcional | Somente Claude, após registro; mostrar comando/escopo do plugin antes de `panelCommand`. Pular preserva sucesso da instalação base. |
| Contas | Reusar telas/rotas atuais, unicidade das pastas e lançador de login. Mostrar prévia de adicionar/remover/renomear/registrar; login abre cliente nativo, nunca coleta credenciais na página. |
| PATH/recarregar | Mudanças aplicadas/recusadas, `activationMessage`, instruções para novo terminal e reinício do cliente. Navegador não altera ambiente do terminal pai. |
| Resultado e próximos passos | Sucesso/aviso/falha por cliente, setup pendente, autoverificação, linha do kit, comandos de recuperação; Continuar abre abas normais de config na mesma sessão. |

- Hoje `installerCommand` oferece painel dentro de `runClient`, antes do setup. Orquestração comum deve adiar oferta e escritas automáticas de `initializeDetectedConfig` para as telas revisadas acima; terminal mantém consentimento e comportamento equivalentes.
- Não persistir token nem rascunho do navegador. Recarregar com token válido reconecta ao job/retrato em memória; manter mesma instância ativa da página para o job. Segunda aba oferece assumir essa visualização, sem iniciar outra instalação.
- Reinício do servidor/processo: redetectar registros e `setup.done.profiles`; sem continuação automática de escritas incompletas. Reconstruir plano e pedir consentimento. Etapas concluídas são verificadas/idempotentes; registro incompleto recebe orientação de reparo.
- Já instalado: **Atualizar** usa `installerCommand('update', ...)`, preservando backup/smoke/orientação de rollback; **Reparar** repete install da versão registrada/atual por `--from` ou artefato verificado fixado; **Mudar modelos** chama `runSetup` compartilhado com `again: true`, sem reinstalar pacote.
- Falha em um cliente preserva clientes concluídos e informa sucesso parcial. Setup/painel pulado ou falho fica explícito; sucesso da instalação nunca fabrica `setup.done`.

<a id="section-4"></a>
## 4. Segurança e ciclo de vida

| Contrato atual de config UI | Decisão para o assistente |
| --- | --- |
| `listen(0, '127.0.0.1')`; 32 bytes aleatórios, token hexadecimal | Reusar porta aleatória/token em loopback. Sem bind público configurável ou acesso LAN. |
| `authorize()` verifica Host exato `127.0.0.1:porta` / `localhost:porta` e Origin permitido correspondente | Reusar em toda rota, inclusive progresso. Sem CORS curinga; recusar origens externas/`null` e hosts de DNS rebinding. |
| Token na URL do GET raiz ou `x-okit-token`; comparação em tempo constante | Manter token na URL somente na página inicial, cabeçalho em todas as APIs. Sem token = 403. Sem autenticação por cookie. |
| Não-GET exige Origin; JSON limitado a 64 KiB | Reusar limite CSRF, lista de métodos e limites de corpo; GET nunca altera estado. Adicionar schemas tipados do assistente. |
| Nonce CSP, `connect-src 'self'`, no-store, no-referrer, nosniff, bloqueio de frames | Reusar cabeçalhos e renderização escapada; saída de processo vira texto, nunca HTML. Fontes/scripts/estilos locais; sem analytics/CDN/rede da página para hosts externos. |
| Ocultação/rejeição de segredos; conflito `expectedMtime` nas escritas de config | Reusar `state.js: redact/sensitive`, ocultação do instalador e validação de config. Estender proteção contra conflito a cada arquivo/perfil aprovado. |
| Timeout ocioso de 10 minutos; SIGINT/fechar cancela observações e conexões | Manter timeout sem operação ativa. Durante aplicação, polling/resposta autenticados contam como atividade; ao expirar/SIGINT/fechar, solicitar cancelamento seguro, terminar etapa atômica atual, finalizar resultado, parar filhos/servidor e liberar travas. |
| Instância de página + tolerância de fechamento de 3 segundos e keepalive | Preservar comportamento ocioso de config. Com job ativo, sair/desconectar somente desanexa a visualização; não interrompe escrita. Reconectar dentro do prazo. |

- Uma sessão/job por raiz: reusar sessão no mesmo processo, adicionar trava entre processos; segundo processo recusa com orientação sem revelar token da outra sessão. Só uma instância ativa da página pode responder/confirmar.
- Token aparece uma vez na URL privada de abertura do terminal inicial para uso manual. Nunca em logs persistentes, eventos, erros, telemetria ou argumentos de filhos, exceto na chamada do SO para abrir o navegador. Ocultar query da URL e cabeçalho de token explicitamente; ocultação genérica atual não é prova. Limpar query com `history.replaceState` após iniciar; manter token só na memória da página.
- Página não pode executar comandos arbitrários, navegar/ler arquivos arbitrários, enviar scripts, editar perfis brutos, instalar Node/clientes, elevar privilégios nem receber segredos de contas. Toda escrita é operação tipada derivada pelo Node do plano aprovado.
- Mutações de config/contas também mostram prévias antes das requisições; estender interações atuais de gravação direta quando necessário. Login externo continua ação explícita do cliente nativo; Node pode fazer requisições necessárias de release/cliente, a página não.

<a id="section-5"></a>
## 5. Sem navegador, acessibilidade e idioma

- Modo automático Unix: SSH (`SSH_CONNECTION`/`SSH_TTY`), contêiner sem sessão gráfica utilizável, Linux sem DISPLAY/WAYLAND_DISPLAY, abridor ausente ou falho ⇒ explicar motivo concreto e executar instalador Node de terminal. No macOS usar disponibilidade de sessão/abridor, não somente DISPLAY.
- Exemplo: “Nenhuma sessão gráfica detectada (SSH); usando o instalador de terminal. Use --ui --headless para uma sessão de navegador por túnel.” Equivalente em inglês. Sucesso do abridor significa somente abertura aceita: manter URL visível e oferecer nova tentativa explícita por terminal se nenhum navegador conectar; nunca executar terminal junto com job web ativo.
- `--ui` impede fallback automático: sem abridor, imprimir URL e permanecer headless. `--headless` inicia UI sem abrir navegador, inclusive Windows; Windows nunca recorre a assistente de terminal.
- Exemplo remoto: servidor imprime porta P e URL privada com token; na estação executar `ssh -N -L P:127.0.0.1:P user@host`, depois abrir URL impressa localmente. Usar mesma porta local para manter verificações Host/Origin. Nunca bind em `0.0.0.0`.
- Fallback Unix sem TTY exige cliente/opções explícitos e flags de consentimento aceitos pelo instalador Node atual; senão saída 2 com instruções, sem pergunta travada. `--yes` nunca vale como consentimento da revisão web.
- Estender `src/config-ui/labels.js: labels` (`en`, `pt-BR`), escolhido pela resolução de idioma existente; sem sistema de tradução separado. Traduzir etapas, erros, fallback e próximos passos; preservar caminhos/comandos como dados.
- Controles nativos, rótulos e foco visíveis, ordem Tab lógica, ações Enter/Espaço, abas de teclado atuais, foco no título da nova tela/resumo de erros, status `aria-live="polite"`, texto junto da cor. Polling não rouba foco. Suportar zoom/refluxo, movimento reduzido e revisão/cancelamento só por teclado.
- Modelos/contas não salvos continuam visíveis em erro; troca de idioma preserva escolhas digitadas e exige nova revisão se plano mudar. Nenhuma requisição externa da página, inclusive fontes e descoberta de modelos.

<a id="section-6"></a>
## 6. Aceitação e testes das fatias de implementação

Esta demanda executa somente revisão de design; estes são critérios para implementação futura.
Usar `node:test` e adaptadores injetados de arquivos/processos/navegador/relógio; sem novas dependências de runtime.

| Deve passar | Deve recusar / preservar |
| --- | --- |
| Token + Host + Origin válidos; fluxo inicial e config no mesmo servidor | Host/Origin externo, token ausente, POST entre sites, token na query da API, método errado, JSON inválido/grande demais |
| Plano lista cada arquivo/perfil/comando sem escritas de instalação/config | Escritas ocultas de inicialização; entrada editada após revisão → 409 e zero escritas de aplicação |
| Reconexão por polling, mesma chave Apply, um job/raiz, cancelamento seguro | Escritas duplicadas, segundo job/processo, resposta/plano antigo, cancelamento no meio de escrita atômica |
| Modelos/esforço, marcadores pendentes, pular painel, contas/login, PATH e linha do kit | Modelos desconhecidos sem confirmação explícita, credenciais/comandos brutos, sobrescrita de blocos gerenciados alheios |
| Ambos os idiomas; erros e saída de filhos com segredos ocultos | Token em logs/eventos/erros de URL; saída de processo interpretada como HTML |
| Unix padrão gráfico, fallback SSH/contêiner, terminal/UI/headless forçados | Node ausente/antigo, nenhum agente, checksum incorreto, par não suportado; assistente de terminal Windows |
| Atualizar/reparar/recarregar/reiniciar e sucesso parcial | Repetição automática após reinício do processo ou sucesso fabricado após falha de autoverificação |

- Adicionar contratos de servidor junto dos testes existentes de config UI; exercitar autorização sem bind quando sandbox proibir loopback. Depois rodar contratos HTTP reais em ambiente que permita `127.0.0.1`.
- Recomendação de navegador: um cenário de aceitação com Playwright usando runner/navegador já disponível, sem dependência no pacote. Custo: manter um cenário e provisionar navegador no verificador; se indisponível localmente, manter testes DOM/contrato e aceitação pelo Diretor até aprovar runner CI. Cobrir prévia/aplicação por teclado, reconexão, idioma, transição e rejeição de requisições externas da página.
- **Cenário de navegador (D151):** `node scripts/acceptance/install-wizard.playwright.mjs` inicia `install --headless` em um HOME descartável e conduz a URL impressa com um Playwright já instalado (`PLAYWRIGHT_MODULE` indica um; sem dependência no repositório). Verifica revisão e Apply só pelo teclado, recarga que reconecta o job, troca de idioma e que qualquer requisição a host não loopback derruba a execução. Sem runner ou navegador imprime `not run: ...` e sai com 0. Fica fora de `test/`, então `node --test` nunca o coleta; o Diretor o executa.
- Aceitação do instalador em contêiner: manter a **execução Podman de instaladores do projeto**, com HOME/estado isolados, shims de clientes e fixtures offline de release. Exercitar fallback Unix padrão/sem display, `--terminal`, `--ui --headless`, recusas de requisitos/checksum, reparo repetido e ausência de escritas antes do consentimento. Não publicar porta do host nos casos de terminal.
- O comando/imagem exatos do harness Podman existente não foram identificados no conjunto de fontes permitido; o Diretor deve anexar a invocação do projeto e resultados antes de aceitar fatias de bootstrap. Não substituir por harness inventado nem alegar prova Windows com contêiner Linux.

### Roteiro manual Windows (Diretor; VM descartável limpa)

Usar `install.ps1` gerado candidato em Downloads; executar casos separadamente no Windows
PowerShell 5.1 e PowerShell 7 (`pwsh`), como usuário comum. Manter transcrição privada/sem segredos.

1. Criar snapshot sem Node nem clientes. Executar `powershell.exe -NoProfile -File .\install.ps1 --locale en`. Esperar `Node required: https://nodejs.org/`, `$LASTEXITCODE` = 2, sem navegador/arquivos de instalação. Repetir `--locale pt-BR`: equivalente em português.
2. Instalar Node 18 para caso negativo; repetir. Esperar recusa Node >=20/versão atual, saída 2, sem download/instalação. Substituir por Node suportado (mínimo da release candidata).
3. Sem clientes, repetir. Esperar “Instale pelo menos um entre claude, codex, opencode” (localizado), saída 2, sem alterações de registro/PATH. Instalar um cliente suportado e autenticar pelo próprio cliente.
4. Executar `powershell.exe -NoProfile -File .\install.ps1 --locale en`. Esperar requisitos + sucesso SHA-256 + URL loopback + navegador; sem perguntas de cliente/modelo/painel no terminal. Deixar revisão aberta: destino/config/PATH/registros permanecem intactos, exceto staging descartável do bootstrap.
5. Usar usuário/pasta home Windows com espaços. Selecionar cliente detectado, conferir caminhos exatos, prévia de perfis/PATH/config e Aplicar. Esperar progresso ordenado e autoverificação, painel Claude opcional, confirmação de modelos/esforço e contas; sem elevação nem mudança automática de política.
6. Recusar painel/PATH opcionais uma vez; concluir. Esperar linhas explícitas de etapa pulada e instruções exatas de novo terminal/ativação manual. Em segunda execução aprovar PATH; abrir novo PowerShell e executar `okit-plugin --help`. Esperar resolução correta do comando. Terminal anterior recebe instruções de recarga.
7. Mudar modelos, adicionar conta, cancelar revisão pendente e recarregar durante progresso. Esperar um job, progresso ativo preservado, nenhuma escrita da revisão cancelada; reabrir após encerrar processo e esperar redetecção/revisão. Repetir instalação: escolhas atualizar/reparar/mudar modelos, sem blocos PATH ou registros duplicados.
8. Executar `.\install.ps1 --headless --locale pt-BR`. Esperar URL privada, sem navegador, página portuguesa ao abrir manualmente. Repetir com abertura do navegador desabilitada: URL e instruções, sem assistente de terminal. Fechar/aguardar ociosidade: servidor para e temporários são limpos após limites seguros.
9. Com fixture de release controlada pelo verificador, alterar bytes do arquivo após gerar manifesto e rodar bootstrap candidato contra ela. Esperar `SHA-256 mismatch: package refused`, saída 1, sem extração/execução/registro. Testar Host/Origin externo com runner de contrato do servidor; esperar 403.
10. Executar `.\install.ps1 --terminal` e `.\install.ps1 --yes`. Esperar recusa simples dizendo que o Windows usa o assistente no navegador, `$LASTEXITCODE` = 2, sem download e sem navegador. Executar com `--dest` somente leitura: esperar "Não é possível gravar em ...", saída 2, sem download.

<a id="section-7"></a>
## 7. Demandas de implementação com merge independente

Tamanhos usam classes S/M/L do projeto; dependências são números das fatias. Cada fatia
inclui testes focados e documentação afetada bilíngue, mantendo caminhos publicados utilizáveis.

| Fatia | Tamanho / depende | Mudança e prova | Remoção nos wrappers |
| --- | --- | --- | --- |
| 1. Contrato comum de plano | L / nenhuma | Plano tipado somente leitura, impressões de entradas, inventário de mutações, presenter estruturado; extrair limites de setup/painel e auditar artefatos por cliente. Dry-run do terminal corresponde ao plano; prévia não escreve. | Nenhuma; regenerar só se fonte embutida comum mudar. |
| 2. Serviço autorizado de jobs | M / 1 | Mesmo servidor/sessão, polling, travas, idempotência, respostas/cancelamento tipados, ocultação/timeout. Contratos de segurança e concorrência passam. | Nenhuma. |
| 3. Telas iniciais | L / 2 | Detecção → revisão → progresso → modelos/painel/contas/recarga/resultado → config; reusar controles, consentimento por escrita, teclado/i18n e aceitação em navegador. `install --ui` opt-in/comando do pacote extraído funciona. | Nenhuma; preservar padrões publicados até aceitar UI. |
| 4. Bootstrap/padrão Unix | M / 3 | Aquisição verificada, bootstrap com cliente detectado, roteamento gráfico/SSH/contêiner, opções forçadas/headless e limpeza. Execução Podman existente de instaladores e contrato do abridor gráfico passam. | Remover perguntas de cliente/apresentação de terminal do bootstrap UI padrão; manter rota de terminal e presenter Node testado no fallback automático/`--terminal`. |
| 5. Lançador simples Windows | M / 3 | PowerShell gerado só com requisitos/aquisição/abertura; roteiro Windows manual passa em 5.1/7. | Remover seleção/setup/menus de terminal embutidos e opções exclusivas de terminal da geração/saída Windows; manter preâmbulo Node, integridade/requisitos/abertura. |
| 6. Reexecução e aceitação de release (feita, D154) | M / 4, 5 | Recuperação após reinício, atualizar/reparar/só modelos, falha parcial, limpeza temporária e docs. Diretor fornece evidências Podman, navegador real e Windows. | Remover ramos obsoletos de interação do bootstrap após auditoria de compatibilidade; manter testes do fallback Unix permanentemente. |

Não editar scripts gerados à mão: atualizar `src/release/install-scripts.js` e sua
fonte de bootstrap embutida, depois regenerar ambas as saídas juntas. Mudanças comuns
não podem restaurar acidentalmente interação de terminal no lançador Windows.

### Status da fatia 6 (D154)

- **Reexecuções.** `wizardState` lê de novo, a cada início, os registros de instalação e `setup.done.profiles`. A
  primeira tela, com um cliente instalado, oferece Atualizar (`installerCommand('update')`, com backup, smoke e
  orientação de rollback), Reparar (a instalação executada de novo) e Mudar modelos (sem payload). Cada uma só
  começa uma revisão; Aplicar exige o consentimento como antes. Atualizar e Reparar terminam no resultado; Mudar
  modelos vai à tela de modelos.
- **Reinício.** O job não é persistido: um servidor reiniciado não tem job nem plano, encontra os registros de novo
  e pede consentimento numa nova revisão. Uma gravação pela metade nunca é repetida. Uma revisão abandonada não
  grava nada (o plano é somente leitura). Recarregar durante um job reconecta ao mesmo job (assumir a vista).
- **Falha parcial.** O resultado lista cada cliente (ok, falhou, pulado, cancelado); os clientes que deram certo
  ficam; setup e painel dizem se rodaram ou foram pulados. Não há rollback de todos os clientes.
- **Limpeza.** O servidor para o listener, solta a trava e cancela num passo seguro ao fechar, no tempo ocioso
  (10 minutos) e no SIGINT. O bootstrap remove sua pasta temporária em sucesso e falha, numa interrupção antes de o
  programa extraído começar (saída 130), e fica vivo durante o programa para o `finally` sempre rodar.
- **Windows.** Nenhuma rota de reexecução cai no terminal; se o navegador não abrir, só o endereço privado é
  impresso. Uma opção só de terminal é recusada com palavras que dizem que a função não existe no Windows e dão os
  comandos exatos (`powershell.exe -NoProfile -File .\install.ps1`; instalado: `okit-plugin install --ui`, depois
  `okit-plugin config ui`).
- **Auditoria.** Nada foi removido. A pergunta de cliente do bootstrap Unix (`//#if unix`, depois da escolha
  automática) só é alcançável com `platform === 'win32'`, que não é um modo suportado de rodar `install.sh`;
  `test/install-windows-launcher.test.js` a fixa em `install.sh`, então a remoção fica como candidata para o dono.
  O fallback de terminal Unix e seus testes ficam.

<a id="section-8"></a>
## 8. Riscos e decisões do proprietário

| Risco | Mitigação / decisão |
| --- | --- |
| Dry-run atual omite escritas exatas; inicialização de setup escreve antecipadamente | Fatia 1 é pré-requisito, com inventário e contratos de ausência de escrita; nunca publicar consentimento sobre plano incompleto. |
| Diferenças de arquivos/versões entre artefatos por cliente | Auditar conteúdo; fixar pacote/checksum no plano e baixar artefatos selecionados antes de aplicar. Recusar divergência em vez de atualizar silenciosamente versão aprovada. |
| Abridor aceita mas não há janela utilizável; desconexão durante instalação | URL privada visível, opção headless, cancelamento seguro, resultados parciais explícitos; nunca iniciar outro instalador automaticamente enquanto web aplica. |
| Processo local hostil lê token; fonte de checksum comprometida | Limite de capacidade local ao usuário, vida curta/logs sem segredos, sem servidor público; SHA-256 só garante integridade. Assinaturas do publicador ficam para trabalho futuro separado. |
| Operações em vários clientes não são uma transação atômica | Preservar backup/recuperação atuais por cliente e mostrar resultados parciais; nunca prometer rollback conjunto. |

### Decisões do proprietário (2026-11-08)

1. **Aliases:** os aliases `update` e `uninstall` encaminham diretamente ao Node, sem menus; anunciar depreciação antes de qualquer remoção, sobretudo no Windows.
2. **Aceitação em navegador:** reusar runner Playwright disponível, sem nova dependência no repositório; o Diretor assume a aceitação em navegador até a aprovação de um runner de CI.
3. **Bootstrap comum:** manter os artefatos verificados por cliente; avaliar bootstrap comum somente se a auditoria da fatia 1 provar necessário.

### Contrato compartilhado do backend da fatia 3

O núcleo é revisável com código de saída zero, sem conflitos de propriedade e sem
efeitos do núcleo não declarados. `deferred` distingue itens com consentimento
próprio `followup: true` (setup, política, coletores de contas, painel) de observações
com `resolvedAtApply: true`, comando/argv exatos e regra de decisão (propriedade MCP,
listagem de plugins, PATH de usuário Windows). Nenhum bloqueia a revisão do núcleo.
Um `requiresObservation` sem classificação continua bloqueando. Fingerprints ainda
detectam mudanças nas entradas. Apply usa `deferFollowups` e nunca executa essas
gravações com consentimento próprio.

`POST /api/install/followup-plan` recebe `{jobId, kind, client}`. Setup exige ainda
`expectedMtime` (número/null) e `profiles: [{class, model, effort, confirm?}]`;
classes são simple/normal/hard. Retorna `{followupId, jobId, preview}`. Modelos
desconhecidos exigem `confirm: true` literal; esforços usam as regras do cliente.
`POST /api/install/followup` recebe `{jobId, kind, followupId, consent: true,
idempotencyKey}`. Escolhas ficam vinculadas à prévia, sem reenvio no Apply.

Kinds formam lista fechada: setup, panel, policy. Só um cliente `ok` do job atual
é elegível. Painel exige ainda instalação Claude registrada e usa `panelCommand`;
política Windows usa a etapa CurrentUser existente e preserva política de grupo.
Setup usa o gravador de configuração em lote travado com `expectedMtime`, sem mudar
`setup.done`; a evidência de conclusão continua sob responsabilidade de `runSetup`.
Contas/login mantêm suas rotas; execução do followup account-collector não é exposta.
A fatia 6 acrescenta as operações de núcleo `repair` (a instalação executada de novo para um
cliente com registro de instalação: sem registro é `409 not-installed`; `destination`, `noLink`
e `prerelease` são recusados) e `models` (sem comando de payload e sem opções; só clientes com
registro; as configurações são mudadas depois pelo followup de setup, com consentimento próprio,
que nunca grava `setup.done`). O schema do plano de núcleo aceita install, update, repair e models.

Ambas as rotas usam autorização, limites JSON e redação existentes. Planos mantêm
limites de TTL/quantidade; execução reconfere a proposta sob a trava da raiz.
Só um followup roda por vez. Mesma chave/prévia retorna a mesma operação; prévias
alteradas, expiradas, consumidas ou de job anterior são recusadas. Cancelar espera
um checkpoint, preserva gravações concluídas e nunca as reverte. Poll retorna
`followups` limitados com estado/resultado/completed/remaining; o resultado do núcleo
inclui `clients: [{client, state, reason?}]` (ok/failed/skipped/cancelled). A execução
do núcleo ainda para na primeira falha; sucessos anteriores permanecem visíveis.
`test/config-ui-install-wizard.test.js` exercita o backend com adaptadores injetados.
Telas iniciais, opções de CLI e aceitação em navegador ficam para a próxima rodada.

### Auditoria dos artefatos

`payloadEntries()` inclui `src` compartilhado e adaptadores compartilhados em cada artefato;
a UI de configuração e o instalador já acompanham cada pacote verificado.
Manter artefatos por cliente: um bootstrap comum não acrescenta código necessário.
Selecionar um cliente inicial deterministicamente e fixar/verificar cada artefato adicional.
O plano não baixa pacotes nem manifestos: payloads remotos são árvores, com checksum
pendente até aplicar; fontes locais confiadas pelo usuário são percorridas e hashadas.
`install-scripts.js` embute apresentador e bootstrap; mudanças no apresentador exigem
regenerar ambos os wrappers, preservando aquisição e comportamento de lançamento.
