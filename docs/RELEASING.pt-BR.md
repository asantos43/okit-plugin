# Desenho do release

Status: desenho D26; esta mudança não cria script de build nem comando de publicação.
Estende [ARCHITECTURE.md](ARCHITECTURE.md) e [SMOKE.md](SMOKE.md), incluindo o cenário D25 no cliente real. Inglês: [RELEASING.md](RELEASING.md).

## What a release is

Um candidato tem nove artefatos identificados separadamente por cliente × sistema, com a mesma revisão e versão do pacote. São pacotes de fontes Node, não executáveis autônomos: o Node deve atender a `package.json.engines.node`. O pacote é ESM, sem dependências e privado; publicar no registro npm não é a estratégia de instalação.

Inspeção do repositório: `package.json.bin` identifica a CLI; `src/` e `skills/` contêm a carga comum. Só `adapters/claude-code/index.js` está implementado; Codex e opencode têm diretórios reservados. Nenhum manifesto de cliente ou entrada de marketplace é versionado. O runner dentro do cliente continua como desenho em [SMOKE.md](SMOKE.md), não como pré-requisito de release já entregue e executável.

| Cliente | Formato de instalação conferido; artefato pretendido | Decisão / implementação pendente |
| :- | :- | :- |
| Claude Code | Diretório de plugin com skills, configuração MCP e hooks; metadados em `.claude-plugin/plugin.json`. Também precisa de entrada em `.claude-plugin/marketplace.json` apontando para a carga correspondente. [Manifesto](https://code.claude.com/docs/en/plugins-reference), [marketplace](https://code.claude.com/docs/en/plugin-marketplaces). | Marketplace do projeto no GitHub, escopo de usuário e uma entrada por sistema ([D-Q1](#decisions)). Copiar skills/hooks não comprova registro do plugin. |
| Codex | A documentação atual descreve `plugin.json` e `mcp.json` na raiz; `.codex-plugin/plugin.json` é alternativa de compatibilidade. O artefato pretendido reúne o formato escolhido, skills e adaptador. A CLI tem navegador de marketplaces em `/plugins`. [Empacotamento](https://developers.openai.com/plugins/build/plugins), [instalação](https://learn.chatgpt.com/docs/plugins). | Manifesto portátil na raiz, marketplace/versão compartilhados e validação no cliente real instalado ([D-Q2](#decisions)). |
| opencode | Módulos de plugin JS/TS locais carregam de `.opencode/plugins/` no projeto ou `~/.config/opencode/plugins/` global; plugins npm usam o array `plugin` da configuração. O artefato pretendido é um módulo local com a carga comum. [Plugins](https://opencode.ai/docs/plugins/). Skills e MCP têm configuração separada: [skills](https://opencode.ai/docs/skills/), [MCP](https://opencode.ai/docs/mcp-servers/). | Módulo JS global e prova de hook por eventos nativos; ponte do módulo e implementação da atualização pendentes ([D-Q3](#decisions)); a CLI do núcleo não é um plugin opencode. |

Fontes conferidas em 2026-10-23. Os nomes de arquivos de esquema acima são exigências dos formatos, não constantes do projeto. Identidades, versões, destinos e pontos de entrada do projeto devem vir dos metadados do pacote e da configuração. Este desenho não promete capacidades de plataforma ou cliente não verificadas.

## Per system

A tabela é requisito de empacotamento/prova, não afirmação de que todos os adaptadores funcionam. Os destinos vêm do escopo escolhido, configuração do cliente e home real; o estado vem de `OKWORK_HOME`/`stateRoot`. Nunca embutir o home do autor do build no artefato.

| Cliente | Linux | Windows | macOS |
| :- | :- | :- | :- |
| Claude Code | Raiz do plugin configurada; raiz do adaptador por opção explícita, `CLAUDE_CONFIG_DIR`, depois home. systemd do usuário ou cron explícito; LF, arquivos legíveis e CLI executável; link do bin configurado no PATH. | Mesma precedência de raiz com home nativo; schtasks no logon; preservar LF e caminhos substituídos com barras normais, arquivos legíveis e shim de comando configurado no PATH. Prova nativa pelo Produtor. | Mesma precedência de raiz com home nativo; agente launchd; LF, arquivos legíveis e CLI executável; link do bin configurado no PATH. Prova pelo Produtor. |
| Codex | Fonte de marketplace escolhida resolve raiz do plugin ([D-Q2](#decisions)); systemd do usuário ou cron explícito; LF, arquivos legíveis e CLI executável; link do bin configurado no PATH. Adaptador/prova pendentes. | Fonte de marketplace escolhida e home nativo ([D-Q2](#decisions)); schtasks; LF, escape de caminhos, arquivos legíveis e shim configurado no PATH. Adaptador pendente; Produtor prova par nativo. | Fonte de marketplace escolhida e home nativo ([D-Q2](#decisions)); launchd; LF, arquivos legíveis e CLI executável; link do bin configurado no PATH. Adaptador pendente; Produtor prova par. |
| opencode | Destinos globais de plugins e skills configurados ([D-Q3](#decisions)); systemd do usuário ou cron explícito; LF, arquivos legíveis e CLI executável; link do bin configurado no PATH. Adaptador/prova pendentes. | Resolver destinos globais no Windows nativo ([D-Q3](#decisions)); schtasks; LF, escape de caminhos, arquivos legíveis e shim configurado no PATH. Adaptador pendente; Produtor prova par nativo. | Resolver destinos globais no macOS nativo ([D-Q3](#decisions)); launchd; LF, arquivos legíveis e CLI executável; link do bin configurado no PATH. Adaptador pendente; Produtor prova par. |

`src/autostart.js` seleciona hoje systemd no Linux, schtasks no Windows e launchd no macOS. Cron é alternativa explícita, não fallback automático do systemd; o plano atual substitui o crontab do usuário e sua desinstalação o remove. Preservar linhas existentes do cron é requisito antes de oferecer esse caminho ([D-Q4](#decisions)).

Preservar UTF-8/LF na carga e nos logs em todos os sistemas. Conferir bits de execução POSIX após extração; no Windows conferir leitura por ACL e o shim no shell pretendido. Derivar nome e destino do comando de `package.json.bin` (hoje `okit`) e configurar o destino do link/shim ([D-Q4](#decisions)). Descoberta de plugin pelo cliente não estabelece PATH. Autostart deve resolver explicitamente caminhos do Node e da CLI instalados; o PATH do shell de login é insuficiente. Refazer o plano se a atualização mover a instalação.

## Artifacts

Os nomes abaixo são modelos a implementar, não arquivos gerados por D26. `P` é uma codificação segura para arquivos de `package.json.name`, `V` é sua `version`, e `C`/`S` são identificadores de cliente/sistema da configuração de release. Diretório de saída, formato/extensão `E`, codificação do nome e arquiteturas aceitas vêm da configuração conforme [D-Q5](#decisions); nunca rotular uma arquitetura como se cobrisse todas.

| Saída | Nome derivado | Conteúdo |
| :- | :- | :- |
| Carga por par (nove) | `<P>-<V>-<C>-<S>.<E>` | Metadados do pacote, licença, `src/` necessário, skills e adaptador selecionado, manifestos/configuração do cliente e instruções de instalação. Preservar caminhos relativos referenciados; excluir estado, credenciais e material só de desenvolvimento. |
| Manifesto de hashes | `<P>-<V>-checksums.sha256` | SHA-256 e nome exato de cada carga e metadados de marketplace, notas e checklist acompanhantes; exclui a si mesmo. Calcular sobre bytes finais após empacotar. |
| Notas | `<P>-<V>-release-notes.md` | Mudanças dessa versão no histórico da raiz, pré-requisitos, nomes por par, instalação/atualização, estado das provas e lacunas conhecidas. |
| Checklist de provas | `<P>-<V>-release-checklist.md` | Nove registros com revisão, hash, ambiente, comandos, códigos de saída e links das evidências. |

Nomes de arquivos de esquema de marketplace seguem os clientes, sob raízes de saída configuradas. As entradas devem resolver a carga/versão exata por par; seleção automática de sistema é **não verificada**, não presumida ([D-Q1 / D-Q2](#decisions)). Identidades e metadados de saída devem coincidir com `package.json`, incluindo `license`, `repository`, `bin` e `engines`; sem constante duplicada de versão. Nova versão é decisão do Produtor, não deste documento.

As notas vêm do histórico de mudanças da raiz, mantido à mão em `CHANGELOG.md`, na seção `[Unreleased]`. A futura etapa de notas extrai dessa seção as mudanças da versão escolhida e preserva referências; não criar outro histórico.

Fluxo do usuário: obter par e manifesto de hashes da página de releases do GitHub ([D-Q5](#decisions)), verificar SHA-256 antes de extrair, conferir Node contra engines do pacote, extrair no destino configurado e seguir instruções do par. Configurar link/shim do bin, MCP, skills e autostart conforme aplicável; depois provar instalação. SHA-256 detecta bytes alterados; não autentica a origem do download ([D-Q5](#decisions)).

Para Claude Code, registrar marketplace aprovado com `claude plugin marketplace add <source>`, instalar com `claude plugin install <entry>@<marketplace>` e atualizar com `claude plugin update <entry>@<marketplace>`, usando identidades geradas. [Instalação/atualização](https://code.claude.com/docs/en/discover-plugins). Para Codex, registrar fonte escolhida com `codex plugin marketplace add <source>` e instalar por `/plugins`; usar marketplace/versão compartilhados e validar a rota de atualização no cliente instalado ([D-Q2](#decisions)). [Autoria](https://developers.openai.com/plugins/build/plugins). Para opencode, o fluxo local pretendido coloca módulo e carga referenciada no escopo configurado e registra skills/MCP separadamente; usar módulo global e prova por eventos nativos ([D-Q3](#decisions)); implementação de substituição/atualização continua pendente.

Antes de atualizar, parar daemon anterior, guardar backup do estado configurado e skills/hooks editados, verificar nova carga, trocar referências do cliente e registro no PATH, regenerar caminhos de autostart movidos, reiniciar e repetir provas. Instaladores atuais recusam skills divergentes e preservam entradas de hooks do usuário: não prometer sobrescrita na atualização. Fazer backup do estado e dos skills editados pelo usuário e permitir volta à versão anterior ([D-Q6](#decisions)).

## Proof per pair

Cada marca significa **ambas** as camadas no candidato instalado daquele par: `okit smoke` (em processo, home temporário) e cenário D25 dentro do cliente real indicado, carregando a instalação real com login/estado reais. `--dry-run`, ensaio e spawns simulados não provam uso real. A interface planejada `okit client-smoke` está em [SMOKE.md](SMOKE.md#in-client-smoke-real); não está implementada neste checkout. Até existirem driver, adaptador e registro da execução, manter o par desmarcado.

| Checklist por par | Quem executa e assina ambas as camadas |
| :- | :- |
| [ ] Claude Code × Linux | Máquina Linux do Diretor ([D-Q7](#decisions)) |
| [ ] Claude Code × Windows | Produtor na máquina Windows nativa |
| [ ] Claude Code × macOS | Produtor na máquina macOS |
| [ ] Codex × Linux | Máquina Linux do Diretor ([D-Q7](#decisions)) |
| [ ] Codex × Windows | Produtor na máquina Windows nativa |
| [ ] Codex × macOS | Produtor na máquina macOS |
| [ ] opencode × Linux | Máquina Linux do Diretor ([D-Q7](#decisions)) |
| [ ] opencode × Windows | Produtor na máquina Windows nativa |
| [ ] opencode × macOS | Produtor na máquina macOS |

Registrar por linha: responsável/data; revisão; versão do pacote; arquivo e SHA-256; sistema/versão/arquitetura; versões de Node/cliente; escopo; caminhos resolvidos de plugin/configuração/estado/bin; passos de instalação e atualização do candidato anterior; verificações de PATH e permissões; resultado de autostart show/install/reinício; ambos os comandos smoke, saídas, totais e motivos; locais de JSONL/log e revisão do cenário D25. Anexar arquivos ou links duráveis, não só “funcionou”. Nunca publicar credenciais. Instalação nova e atualização devem preservar configuração e estado do usuário, inclusive após reiniciar cliente.

Prova em processo exige saída 0 e todos os checks selecionados passando; no release usar conjunto completo. D25 exige C1–C5 passando, nenhuma falha e registro explícito de cada check posterior. Sua saída 0 ainda pode significar `PARCIAL`; falta de prova de hook impede passar o gate de instalação. Configuração ausente significa instalação incompleta. Manter linha com skip/parcial não resolvido desmarcada até aceite escrito do Produtor ([D-Q7](#decisions)); resultado sintético ou ausente não preenche outro par.

## Decisions

1. Release separado para Claude Code, Codex e opencode, em Linux, Windows e macOS: os nove pares continuam no escopo.
2. Build local. GitHub Actions não executa o release sozinho.
3. Cortar tag ou publicar só quando o Produtor pedir explicitamente; preparar candidatos é separado de cortar release.
4. Derivar versões, nomes e caminhos de `package.json` e configuração; sem constantes fixas do projeto no desenho ou na futura implementação.
5. D26 é só documentação: sem código, script, dependência, tag, publicação ou alteração de `SMOKE.md`.
6. **D-Q1 — Claude Code:** usar o marketplace do projeto no GitHub (`asantos43/okit-plugin`), escopo de usuário e uma entrada por sistema.
7. **D-Q2 — Codex:** usar o manifesto portátil (`plugin.json` na raiz), no mesmo marketplace e na mesma versão do Claude Code; validar contra o Codex real instalado.
8. **D-Q3 — opencode:** instalar módulo JS global em `~/.config/opencode/plugins/`; provar o hook do D25 pelos eventos do próprio opencode, sem supor o formato de hook do Claude.
9. **D-Q4 — Integração na máquina:** obter destinos do bin/shim e identidades do autostart da configuração, sem constantes no código; o cron preserva as linhas existentes.
10. **D-Q5 — Saída:** usar `.tar.gz` no Linux e no macOS, `.zip` no Windows, uma carga por arquitetura, com nome `<P>-<V>-<C>-<S>.<E>` e manifesto SHA-256; baixar da página de releases do GitHub.
11. **D-Q6 — Ciclo de vida:** começar em `0.1.0`, manter o pacote privado (sem npm); antes de atualizar, fazer backup do estado e dos skills editados pelo usuário, com volta atrás para a versão anterior.
12. **D-Q7 — Provas:** o Produtor verifica Windows e macOS; o Linux fica com a máquina do Diretor. Guardar os registros de prova em `docs/` deste repositório; um pulo parcial do smoke exige aceite escrito do Produtor.

## Open questions

Não há perguntas em aberto: Q1 a Q7 foram respondidas pelo Produtor em 2026-10-23.

## Implementation plan

Pré-requisitos: Produtor responde às perguntas aplicáveis; adaptadores/manifestos ausentes e drivers D25 entram em trabalhos próprios. Não substituir evidência de instalação por placeholders. Cada passo abaixo é um PR separado com sua própria linha no histórico de mudanças da raiz e `node --test` verde; nenhum autoriza tag ou publicação.

| PR | Entrega pequena | Aceite |
| :- | :- | :- |
| 1 — Build local | Adicionar script local em `scripts/`, com entrada em `package.json`; consumir metadados e configuração de pares/saída, preservar caminhos comuns e gerar metadados de cliente escolhidos. | Executar localmente em revisão conferida; nove cargas identificadas; inspecionar conteúdo, identidade, LF, permissões e resolução de caminhos. Cliente/sistema desconhecido ou adaptador ausente recusa; sem efeito de publicação. |
| 2 — Checksums | Adicionar geração/verificação de manifesto SHA-256 dos bytes finais usando módulos nativos do Node. | Cada arquivo listado confere; arquivo alterado/ausente recusa; sem hash de si mesmo. |
| 3 — Notas | Gerar notas da versão a partir da seção `[Unreleased]` do histórico da raiz mantido à mão e metadados dos pares. | Versão e nomes coincidem com pacote/build; histórico ausente recusa; aparecem lacunas e instruções de instalação/atualização. |
| 4 — Checklist | Gerar modelo de nove registros e documentar coleta das evidências do candidato instalado. | Ambas as camadas por par, Produtor assina Windows/macOS; skips e drivers ausentes ficam visíveis. Calcular hashes de notas/checklist só após finalizar registros. |

Após esses PRs, obter do Produtor a versão do candidato, montar localmente e coletar provas nas máquinas reais. O pedido explícito posterior do Produtor é o gatilho separado para confirmar essa versão, extrair suas mudanças do histórico da raiz, finalizar notas/checksums/checklist, criar tag e publicar artefatos comprovados. Alterar versão ou carga invalida seu hash e exige nova prova.
