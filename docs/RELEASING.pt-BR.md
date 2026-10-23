# Desenho do release

Status: desenho D26; esta mudança não cria script de build nem comando de publicação.
Estende [ARCHITECTURE.md](ARCHITECTURE.md) e [SMOKE.md](SMOKE.md), incluindo o cenário D25 no cliente real. Inglês: [RELEASING.md](RELEASING.md).

## What a release is

Um candidato tem nove artefatos identificados separadamente por cliente × sistema, com a mesma revisão e versão do pacote. São pacotes de fontes Node, não executáveis autônomos: o Node deve atender a `package.json.engines.node`. O pacote é ESM, sem dependências e privado; publicar no registro npm não é a estratégia de instalação.

Inspeção do repositório: `package.json.bin` identifica a CLI; `src/` e `skills/` contêm a carga comum. Só `adapters/claude-code/index.js` está implementado; Codex e opencode têm diretórios reservados. Nenhum manifesto de cliente ou entrada de marketplace é versionado. O runner dentro do cliente continua como desenho em [SMOKE.md](SMOKE.md), não como pré-requisito de release já entregue e executável.

| Cliente | Formato de instalação conferido; artefato pretendido | Ainda não resolvido |
| :- | :- | :- |
| Claude Code | Diretório de plugin com skills, configuração MCP e hooks; metadados em `.claude-plugin/plugin.json`. Também precisa de entrada em `.claude-plugin/marketplace.json` apontando para a carga correspondente. [Manifesto](https://code.claude.com/docs/en/plugins-reference), [marketplace](https://code.claude.com/docs/en/plugin-marketplaces). | Hospedagem do marketplace e seleção da fonte por sistema (Q1). Copiar skills/hooks não comprova registro do plugin. |
| Codex | A documentação atual descreve `plugin.json` e `mcp.json` na raiz; `.codex-plugin/plugin.json` é alternativa de compatibilidade. O artefato pretendido reúne o formato escolhido, skills e adaptador. A CLI tem navegador de marketplaces em `/plugins`. [Empacotamento](https://developers.openai.com/plugins/build/plugins), [instalação](https://learn.chatgpt.com/docs/plugins). | Versões aceitas do cliente, escolha do manifesto, roteamento do marketplace e atualização (Q2). |
| opencode | Módulos de plugin JS/TS locais carregam de `.opencode/plugins/` no projeto ou `~/.config/opencode/plugins/` global; plugins npm usam o array `plugin` da configuração. O artefato pretendido é um módulo local com a carga comum. [Plugins](https://opencode.ai/docs/plugins/). Skills e MCP têm configuração separada: [skills](https://opencode.ai/docs/skills/), [MCP](https://opencode.ai/docs/mcp-servers/). | Exportação/ponte do módulo e prova de hooks, escopo de instalação e atualização (Q3); a CLI do núcleo não é um plugin opencode. |

Fontes conferidas em 2026-10-23. Os nomes de arquivos de esquema acima são exigências dos formatos, não constantes do projeto. Identidades, versões, destinos e pontos de entrada do projeto devem vir dos metadados do pacote e da configuração. Este desenho não promete capacidades de plataforma ou cliente não verificadas.

## Per system

A tabela é requisito de empacotamento/prova, não afirmação de que todos os adaptadores funcionam. Os destinos vêm do escopo escolhido, configuração do cliente e home real; o estado vem de `OKWORK_HOME`/`stateRoot`. Nunca embutir o home do autor do build no artefato.

| Cliente | Linux | Windows | macOS |
| :- | :- | :- | :- |
| Claude Code | Raiz do plugin configurada; raiz do adaptador por opção explícita, `CLAUDE_CONFIG_DIR`, depois home. systemd do usuário ou cron explícito; LF, arquivos legíveis e CLI executável; link do bin configurado no PATH. | Mesma precedência de raiz com home nativo; schtasks no logon; preservar LF e caminhos substituídos com barras normais, arquivos legíveis e shim de comando configurado no PATH. Prova nativa pelo Produtor. | Mesma precedência de raiz com home nativo; agente launchd; LF, arquivos legíveis e CLI executável; link do bin configurado no PATH. Prova pelo Produtor. |
| Codex | Fonte de marketplace escolhida resolve raiz do plugin (Q2); systemd do usuário ou cron explícito; LF, arquivos legíveis e CLI executável; link do bin configurado no PATH. Adaptador/prova pendentes. | Fonte de marketplace escolhida e home nativo (Q2); schtasks; LF, escape de caminhos, arquivos legíveis e shim configurado no PATH. Adaptador pendente; Produtor prova par nativo. | Fonte de marketplace escolhida e home nativo (Q2); launchd; LF, arquivos legíveis e CLI executável; link do bin configurado no PATH. Adaptador pendente; Produtor prova par. |
| opencode | Destinos de plugins e skills de projeto/globais configurados (Q3); systemd do usuário ou cron explícito; LF, arquivos legíveis e CLI executável; link do bin configurado no PATH. Adaptador/prova pendentes. | Resolver destinos de projeto/globais no Windows nativo (Q3); schtasks; LF, escape de caminhos, arquivos legíveis e shim configurado no PATH. Adaptador pendente; Produtor prova par nativo. | Resolver destinos de projeto/globais no macOS nativo (Q3); launchd; LF, arquivos legíveis e CLI executável; link do bin configurado no PATH. Adaptador pendente; Produtor prova par. |

`src/autostart.js` seleciona hoje systemd no Linux, schtasks no Windows e launchd no macOS. Cron é alternativa explícita, não fallback automático do systemd; o plano atual substitui o crontab do usuário e sua desinstalação o remove. O Produtor precisa resolver esse tratamento antes de oferecer esse caminho (Q4).

Preservar UTF-8/LF na carga e nos logs em todos os sistemas. Conferir bits de execução POSIX após extração; no Windows conferir leitura por ACL e o shim no shell pretendido. Derivar nome e destino do comando de `package.json.bin` (hoje `okit`) e configurar o destino do link/shim (Q4). Descoberta de plugin pelo cliente não estabelece PATH. Autostart deve resolver explicitamente caminhos do Node e da CLI instalados; o PATH do shell de login é insuficiente. Refazer o plano se a atualização mover a instalação.

## Artifacts

Os nomes abaixo são modelos a implementar, não arquivos gerados por D26. `P` é uma codificação segura para arquivos de `package.json.name`, `V` é sua `version`, e `C`/`S` são identificadores de cliente/sistema da configuração de release. Diretório de saída, formato/extensão `E`, codificação do nome e arquiteturas aceitas são escolhas configuráveis (Q5); nunca rotular uma arquitetura como se cobrisse todas.

| Saída | Nome derivado | Conteúdo |
| :- | :- | :- |
| Carga por par (nove) | `<P>-<V>-<C>-<S>.<E>` | Metadados do pacote, licença, `src/` necessário, skills e adaptador selecionado, manifestos/configuração do cliente e instruções de instalação. Preservar caminhos relativos referenciados; excluir estado, credenciais e material só de desenvolvimento. |
| Manifesto de hashes | `<P>-<V>-checksums.sha256` | SHA-256 e nome exato de cada carga e metadados de marketplace, notas e checklist acompanhantes; exclui a si mesmo. Calcular sobre bytes finais após empacotar. |
| Notas | `<P>-<V>-release-notes.md` | Mudanças dessa versão no histórico da raiz, pré-requisitos, nomes por par, instalação/atualização, estado das provas e lacunas conhecidas. |
| Checklist de provas | `<P>-<V>-release-checklist.md` | Nove registros com revisão, hash, ambiente, comandos, códigos de saída e links das evidências. |

Nomes de arquivos de esquema de marketplace seguem os clientes, sob raízes de saída configuradas. As entradas devem resolver a carga/versão exata por par; seleção automática de sistema é **não verificada**, não presumida (Q1–Q2). Identidades e metadados de saída devem coincidir com `package.json`, incluindo `license`, `repository`, `bin` e `engines`; sem constante duplicada de versão. Nova versão é decisão do Produtor, não deste documento.

As notas vêm do histórico de mudanças da raiz, mantido à mão em `CHANGELOG.md`, na seção `[Unreleased]`. A futura etapa de notas extrai dessa seção as mudanças da versão escolhida e preserva referências; não criar outro histórico.

Fluxo do usuário: obter par e manifesto de hashes do local aprovado pelo Produtor, verificar SHA-256 antes de extrair, conferir Node contra engines do pacote, extrair no destino configurado e seguir instruções do par. Configurar link/shim do bin, MCP, skills e autostart conforme aplicável; depois provar instalação. SHA-256 detecta bytes alterados; não autentica a origem do download (Q5).

Para Claude Code, registrar marketplace aprovado com `claude plugin marketplace add <source>`, instalar com `claude plugin install <entry>@<marketplace>` e atualizar com `claude plugin update <entry>@<marketplace>`, usando identidades geradas. [Instalação/atualização](https://code.claude.com/docs/en/discover-plugins). Para Codex, registrar fonte escolhida com `codex plugin marketplace add <source>` e instalar por `/plugins`; instruções exatas de atualização com versão fixada ficam em Q2. [Autoria](https://developers.openai.com/plugins/build/plugins). Para opencode, o fluxo local pretendido coloca módulo e carga referenciada no escopo configurado e registra skills/MCP separadamente; substituição/atualização ficam em Q3.

Antes de atualizar, parar daemon anterior, guardar backup do estado configurado e skills/hooks editados, verificar nova carga, trocar referências do cliente e registro no PATH, regenerar caminhos de autostart movidos, reiniciar e repetir provas. Instaladores atuais recusam skills divergentes e preservam entradas de hooks do usuário: não prometer sobrescrita na atualização. Garantias de migração/rollback ficam em Q6.

## Proof per pair

Cada marca significa **ambas** as camadas no candidato instalado daquele par: `okit smoke` (em processo, home temporário) e cenário D25 dentro do cliente real indicado, carregando a instalação real com login/estado reais. `--dry-run`, ensaio e spawns simulados não provam uso real. A interface planejada `okit client-smoke` está em [SMOKE.md](SMOKE.md#in-client-smoke-real); não está implementada neste checkout. Até existirem driver, adaptador e registro da execução, manter o par desmarcado.

| Checklist por par | Quem executa e assina ambas as camadas |
| :- | :- |
| [ ] Claude Code × Linux | Verificador Linux indicado pelo Produtor (Q7) |
| [ ] Claude Code × Windows | Produtor na máquina Windows nativa |
| [ ] Claude Code × macOS | Produtor na máquina macOS |
| [ ] Codex × Linux | Verificador Linux indicado pelo Produtor (Q7) |
| [ ] Codex × Windows | Produtor na máquina Windows nativa |
| [ ] Codex × macOS | Produtor na máquina macOS |
| [ ] opencode × Linux | Verificador Linux indicado pelo Produtor (Q7) |
| [ ] opencode × Windows | Produtor na máquina Windows nativa |
| [ ] opencode × macOS | Produtor na máquina macOS |

Registrar por linha: responsável/data; revisão; versão do pacote; arquivo e SHA-256; sistema/versão/arquitetura; versões de Node/cliente; escopo; caminhos resolvidos de plugin/configuração/estado/bin; passos de instalação e atualização do candidato anterior; verificações de PATH e permissões; resultado de autostart show/install/reinício; ambos os comandos smoke, saídas, totais e motivos; locais de JSONL/log e revisão do cenário D25. Anexar arquivos ou links duráveis, não só “funcionou”. Nunca publicar credenciais. Instalação nova e atualização devem preservar configuração e estado do usuário, inclusive após reiniciar cliente.

Prova em processo exige saída 0 e todos os checks selecionados passando; no release usar conjunto completo. D25 exige C1–C5 passando, nenhuma falha e registro explícito de cada check posterior. Sua saída 0 ainda pode significar `PARCIAL`; falta de prova de hook impede passar o gate de instalação. Configuração ausente significa instalação incompleta. Manter linha com skip/parcial não resolvido desmarcada até decisão do Produtor em Q7; resultado sintético ou ausente não preenche outro par.

## Decisions

1. Release separado para Claude Code, Codex e opencode, em Linux, Windows e macOS: os nove pares continuam no escopo.
2. Build local. GitHub Actions não executa o release sozinho.
3. Cortar tag ou publicar só quando o Produtor pedir explicitamente; preparar candidatos é separado de cortar release.
4. Derivar versões, nomes e caminhos de `package.json` e configuração; sem constantes fixas do projeto no desenho ou na futura implementação.
5. D26 é só documentação: sem código, script, dependência, tag, publicação ou alteração de `SMOKE.md`.

## Open questions

1. **Distribuição Claude Code:** qual proprietário/fonte do marketplace, escopo de instalação e mapeamento de entradas/fontes por sistema? Seleção automática de sistema pelo cliente não foi estabelecida.
2. **Distribuição Codex:** quais versões/superfícies do cliente, manifesto portátil ou de compatibilidade, escopo/mapeamento de fontes e rota exata de instalação/atualização versionada? Validar no cliente real escolhido; o repositório ainda não tem adaptador.
3. **Integração opencode:** qual exportação/ponte do módulo local, destinos de projeto/globais e sequência de atualização? Como eventos do plugin comprovam o check de hooks D25 sem presumir formato Claude? Ainda não há adaptador.
4. **Integração na máquina:** quais destinos configuráveis do bin/shim e shells Windows, identidades de autostart e opções de caminhos? Como preservar crontabs existentes? Autostart atual embute identidades de serviço/tarefa; remover essas constantes é implementação futura, não mudança de código D26.
5. **Configuração de saída:** qual formato de arquivo, raiz de saída, codificação de nomes, arquiteturas por sistema, hospedagem de download e mecanismo de autenticidade? Como nomear cargas por arquitetura dentro de cada par?
6. **Ciclo de vida:** qual primeira versão de release, política de migração de estado/configuração, tratamento de skills editadas e garantias de rollback? Manter pacote privado salvo decisão separada; não presumir publicação npm.
7. **Evidência:** quem verifica Linux, onde guardar registros duráveis e algum skip/parcial de lógica D25 pode ser aceito explicitamente? Sem decisão, linhas incompletas continuam sem prova; Windows/macOS cabem ao Produtor.

## Implementation plan

Pré-requisitos: Produtor responde às perguntas aplicáveis; adaptadores/manifestos ausentes e drivers D25 entram em trabalhos próprios. Não substituir evidência de instalação por placeholders. Cada passo abaixo é um PR separado com sua própria linha no histórico de mudanças da raiz e `node --test` verde; nenhum autoriza tag ou publicação.

| PR | Entrega pequena | Aceite |
| :- | :- | :- |
| 1 — Build local | Adicionar script local em `scripts/`, com entrada em `package.json`; consumir metadados e configuração de pares/saída, preservar caminhos comuns e gerar metadados de cliente escolhidos. | Executar localmente em revisão conferida; nove cargas identificadas; inspecionar conteúdo, identidade, LF, permissões e resolução de caminhos. Cliente/sistema desconhecido ou adaptador ausente recusa; sem efeito de publicação. |
| 2 — Checksums | Adicionar geração/verificação de manifesto SHA-256 dos bytes finais usando módulos nativos do Node. | Cada arquivo listado confere; arquivo alterado/ausente recusa; sem hash de si mesmo. |
| 3 — Notas | Gerar notas da versão a partir da seção `[Unreleased]` do histórico da raiz mantido à mão e metadados dos pares. | Versão e nomes coincidem com pacote/build; histórico ausente recusa; aparecem lacunas e instruções de instalação/atualização. |
| 4 — Checklist | Gerar modelo de nove registros e documentar coleta das evidências do candidato instalado. | Ambas as camadas por par, Produtor assina Windows/macOS; skips e drivers ausentes ficam visíveis. Calcular hashes de notas/checklist só após finalizar registros. |

Após esses PRs, obter do Produtor a versão do candidato, montar localmente e coletar provas nas máquinas reais. O pedido explícito posterior do Produtor é o gatilho separado para confirmar essa versão, extrair suas mudanças do histórico da raiz, finalizar notas/checksums/checklist, criar tag e publicar artefatos comprovados. Alterar versão ou carga invalida seu hash e exige nova prova.
