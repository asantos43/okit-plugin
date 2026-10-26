# okit-plugin

Migração: use `okit-plugin` para o plugin; `okit`/`kit` pertencem ao kit de orquestração. Instalar/atualizar substituem apenas links antigos do plugin; comandos alheios do kit e registros da 0.2.0 são preservados. Veja [instalação](INSTALL.pt-BR.md).

Um plugin para clientes de IA (Claude Code, Codex, opencode) que ajuda o Diretor
a distribuir demandas pelos próprios subagentes do cliente. Núcleo Node.js >=20,
sem dependências, com estado em JSON.

## Install — Instalar

Use o [install.sh](install.sh) da release no Linux/macOS ou
[install.ps1](install.ps1) no PowerShell do Windows. Leia os scripts e siga
[INSTALL.pt-BR.md](INSTALL.pt-BR.md) para requisitos, flags, downloads verificados e atualizações.
Depois, use `okit-plugin update --check`, `okit-plugin update` ou `okit-plugin update --rollback`.

Install/update disponibilizam o comando nas novas shells por um candidato gravável já no PATH ou pelos perfis gerenciados (Windows: PATH do usuário). Reinicie o cliente de IA após atualizar o PATH. `--no-path` recusa edições do PATH; uninstall remove só a adição do instalador. Configuração e instrução alternativa: [INSTALL](INSTALL.pt-BR.md).

Se o PATH do terminal atual não contém o diretório bin, install/update e `okit-plugin status` mostram uma dica bilíngue com um comando manual de `install.path.activate`: `. '<perfil>'` para bash/zsh, `source '<perfil>'` para fish ou `$env:Path = '<bin>' + ';' + $env:Path` para PowerShell/Windows. Rode o comando informado ou abra um terminal novo; shells desconhecidas ou perfis gerenciados ausentes recebem a dica do terminal novo. A dica desaparece quando bin está no PATH.
A matriz tem nove pares cliente × sistema; existir um pacote não comprova
uso real. Veja as [provas por par](docs/RELEASING.pt-BR.md#proof-per-pair).
Cada pacote inclui todos os adaptadores de execução por padrão (`release.sharedAdapters: null`
herda `release.adapters`), além dos metadados de instalação do cliente selecionado.

## Usage — Uso

```text
okit-plugin install [--from <dir>] [--client <c>] [--prerelease] [--repo <o/r>] [--dest <dir>] [--no-link] [--no-path] [--autostart] [--dry-run] [--yes]
okit-plugin update [--check] [--rollback] [--dry-run] [--no-path]
okit-plugin uninstall [--purge] [--yes] [--dry-run]
okit-plugin setup [--defaults] [--again]
okit-plugin daemon start|stop|status|pause|resume|run-once
okit-plugin daemon status [--table [--locale en|pt-BR]]
okit-plugin autostart install|uninstall|show [--kind systemd|cron|launchd|schtasks]
okit-plugin status [--locale en|pt-BR]
okit-plugin env report [--client <nome>] [--locale en|pt-BR]
okit-plugin actors [--client <nome>|--all] [--json] [--locale en|pt-BR]
okit-plugin config show
okit-plugin config get <key>
okit-plugin config set <key> <value>
okit-plugin config unset <key>
okit-plugin kit [--require]
okit-plugin hook post-compact
okit-plugin smoke [--real] [--keep] [--only <ids>] [--timeout <ms>]
okit-plugin client-smoke [--client claude-code] [--headless|--demo|--dry-run|--rehearsal]
  [--only <C ids>] [--keep] [--allow-unknown-quota]
  [--max-usd [n]] [--max-turns [n]] [--max-minutes [n]] [--quota-floor [pct]] [--timeout [ms]]
```

`okit-plugin kit` imprime uma linha em inglês: instalado (caminho e versão), ausente
(dica de instalação) ou quebrado. Executa somente o comando de versão configurado.
`--require` retorna 1 se não estiver instalado; sem ele, a consulta é informativa.
Os resumos de install/update (inclusive dry-run) e `okit-plugin status` incluem `kit: …`.
Quando ambos estão presentes, a linha aponta para as
[regras de sobreposição D1](docs/ARCHITECTURE.md#kit-and-plugin-overlap-d1).
Veja a [configuração do kit](INSTALL.pt-BR.md#kit-de-orquestração).

O servidor MCP por stdio expõe 16 ferramentas: `acquire_slot`, `release_slot`,
`limits_status`, `status`, `actors_list`, `env_report`, `classify`, `profile_pick`, `inbox_add`, `inbox_list`,
`inbox_set_status`, `inbox_claim`, `inbox_release`, `order_add`, `order_list`, `order_remove`.

Um **ator** é um par modelo + esforço configurado, disponível em um cliente. Consulte “quais atores/executores podem rodar?” com `actors` ou MCP `actors_list` antes de dimensionar e escolher. Lista perfis mesmo sem executores rodando; status/vagas é a visão de executores em execução. A seleção segue status: cliente detectado por padrão, `--all` para os configurados (os três quando vazio), `--client` tem prioridade. JSON inclui atores, cota, vagas livres, motivos/soluções e alternativas para tamanhos sem ator.

`actors.sizeClasses` em `DEFAULT_CONFIG` mapeia S→simple, M→normal, L→hard; configure esse mapa nomeado para mudar tamanhos. `actors.criticClass` identifica o crítico à parte. Pares modelo + esforço iguais combinam tamanhos. Um tamanho ausente indica o vizinho disponível mais próximo; cota abaixo do piso ou vagas ocupadas explicam a solução. Cota desconhecida não bloqueia. A tabela mostra o estado da cota, o menor percentual restante e a idade da leitura; `status` mostra o comando para registrar uma cota. Use `okit-plugin config set profiles.<cliente>.<classe>.model <valor>` para mudar o modelo de um cliente e uma classe de trabalho.

A detecção de modelos considera apenas modelos ativos como candidatos: estar listado não basta para propor um perfil. A substituição vem da mesma família: o mesmo provedor, com `setup.detect.<cliente>.family.separator` separando o provedor do nome e `family.minimumPrefix` o tamanho que o prefixo comum precisa alcançar. Um nome que não contém o separador configurado não tem provedor e é comparado inteiro; portanto o separador deve ser o que o cliente usa nos nomes (ex.: `/` para `provedor/modelo`), e um separador que não aparece em nenhum nome deixa todos os nomes sem provedor. Um separador vazio, ou que não é texto, desliga a troca automática: um modelo configurado que está ativo permanece (`source: 'listing'`), e uma classe cujo modelo configurado não está ativo é omitida com `okit-plugin config set profiles.<cliente>.<classe>.model <valor>`. Um cliente que responde sem nenhum modelo ativo não propõe nada e pede uma escolha manual com `okit-plugin config set profiles.<cliente>.<classe>.model <valor>`.

### Setup

`okit-plugin setup` detecta os clientes instalados, mostra o modelo que será usado em cada classe de trabalho e explica o motivo. Ele pergunta apenas quando nenhum modelo ativo serve; Enter aceita o modelo recomendado, e uma resposta inválida é perguntada novamente até `setup.maxAttempts` vezes. Todas as perguntas usam a mesma sessão de entrada, então nenhuma resposta se perde; o fim da entrada cancela sem gravar, e uma entrada que já havia terminado cancela do mesmo jeito. Um nome de cliente ou classe fora do esquema da configuração é recusado antes de o arquivo mudar. Um arquivo de configuração que não pode ser lido, ou cuja raiz não é um objeto, é recusado com uma frase simples nas duas línguas: nada é gravado e o arquivo fica como está. Um `profiles` que não é um objeto, ou um cliente dentro dele que não é um objeto, é recusado do mesmo jeito. Quando nenhum cliente com modelo ativo é encontrado, o setup diz isso com uma frase simples nas duas línguas, não grava nada, e a configuração continua pendente. `--defaults` não pergunta nada, aceita as escolhas detectadas e mantém sem alteração as classes sem correspondência, para você escolher depois com `okit-plugin config set profiles.<cliente>.<classe>.model <valor>`. O resultado fica registrado em `config.json`; executar o setup novamente mantém as configurações ativas, enquanto `--again` repete o setup.

Enquanto o setup não foi feito, `okit-plugin status` mostra uma linha que nomeia o passo que falta, o fim de uma instalação ou de uma atualização oferece o setup, e a skill `okit-setup` conduz o mesmo setup em uma conversa. A skill deixa o setup pedir cada escolha de modelo e grava o conjunto completo uma única vez, somente depois da confirmação final.

`okit-plugin inbox list [--locale en|pt-BR]` e MCP `inbox_list` mostram o dono de cada demanda.
`okit-plugin inbox take <id> --client codex --session <s> --worktree <path>` toma posse atomicamente;
outro cliente/sessão ativo é recusado. `okit-plugin inbox release <id> --client codex --session <s>` libera a posse.
Só a CLI humana permite `okit-plugin inbox take <id> --producer-takeover [--client <c>] [--yes]`:
mostra dono, sessão, worktree, data, obsolescência e mudanças Git não commitadas antes
da confirmação TTY (ou `--yes`). A transferência guarda `heldBefore` com motivo `producer takeover`.
`inbox.holdStaleMinutes` tem padrão 120 (inteiro >= 1); posses obsoletas guardam motivo `stale`.
`inbox.gitTimeoutMs` tem padrão 5000 (inteiro >= 1). Estados finais limpam a posse.
As skills Director, Executor, Critic, Smoke, Setup e Environment orientam delegação, verificação e configuração.

Pergunte “onde você está?”, “o que você tem aqui?” ou “qual ambiente?” para usar a skill instalada `okit-environment`. Ela roda `okit-plugin env report` (ou MCP `env_report`) e explica o cliente em uso, clientes instalados, modelos ativos confirmados, cota, vagas livres e pastas. Cada item que falta inclui o comando para corrigir; leituras não confirmadas ficam desconhecidas. Escolha um cliente com `--client` e o idioma com `--locale en|pt-BR`. O MCP aceita `client` e `locale` opcionais e devolve o mesmo objeto do relatório junto com seu `text` formatado.
`smoke` roda 31 checks isolados; `client-smoke` tem 23 checks de cenário e seu
driver real suporta Claude Code. Dry-run e rehearsal são percursos offline.
Veja [SMOKE.pt-BR.md](docs/SMOKE.pt-BR.md) para orçamento e provas exigidas.

## Configuration — Configuração

O estado fica em `~/.okwork`; `OKWORK_HOME` substitui essa raiz. Gerencie as
configurações editáveis com `okit-plugin config`; não é preciso editar o
`config.json` à mão. Os padrões em [src/profiles.js](src/profiles.js) incluem
`lowQuotaPct: 15`, `limits: {global: 3, clients: {}}`, `staleMinutes: 30`
e o catálogo padrão de perfis.

`okit-plugin config show` lista toda chave editável com o valor efetivo, a
origem (`default` ou `user`) e uma explicação simples do efeito.
`okit-plugin config get <chave>` mostra um valor efetivo e sua origem.
`okit-plugin config set <chave> <valor>` valida tipo, faixa e cliente ou
classe conhecidos e então muda só a chave pedida, de forma atômica, preservando
o resto do arquivo. O comando imprime o valor anterior e o novo. Um valor
inválido ou chave desconhecida é recusado sem gravação. Nomes de cliente e
classe em caminhos pontilhados só podem conter letras, dígitos, `-` ou `_`;
`__proto__`, `constructor` e `prototype` são reservados e recusados.
`okit-plugin config unset <chave>` volta a chave ao padrão, e os grupos que a
remoção deixa vazios somem também, de modo que o arquivo se lê como se lia
antes de o valor ser posto.
O catálogo padrão dá a cada cliente (`claude-code`, `codex`, `opencode`) um
perfil por classe (`simple`, `normal`, `hard`), cada um com `model`, `effort`
(`low`, `medium`, `high`) e `maxTurns` (`20`, `40`, `80`), então uma instalação
limpa responde `profile_pick` e `actors_list` para cada cliente e classe sem
nenhuma entrada `profiles`. Mude um campo do perfil com
`okit-plugin config set profiles.<cliente>.<classe>.model|effort|maxTurns <valor>`;
o seu valor substitui a classe que ele nomeia, classe por classe, e as outras
classes mantêm o padrão. Um cliente fora do catálogo não tem perfil:
`profile_pick` responde com um erro curto bilíngue que nomeia os clientes
conhecidos. Para atualizar o catálogo em si, edite
`DEFAULT_CONFIG.profiles` em [src/profiles.js](src/profiles.js).
Uma classe com `null` está desligada: `okit-plugin config set profiles.<cliente>.<classe> null`
desliga, `okit-plugin config unset profiles.<cliente>.<classe>` religa e um `set`
de um campo sob uma classe desligada é recusado sem gravação; um grupo de
cliente vazio (`{}`) é a ausência de um cliente, não uma inscrição de um.
Todos os adaptadores leem a cota do usuário em `quota/<client>.json`.
Registre o percentual restante mostrado em `/usage` do cliente com
`okit-plugin quota set claude-code 80 [--window-minutes n]`; os clientes são os que
a raiz configura (`claude-code`, `codex` e `opencode` quando ela não configura nenhum),
e o percentual deve ser numérico, entre 0 e 100.
Consulte com `okit-plugin quota show [client]`. O comando grava atomicamente
`remainingPct`, `windowMinutes` opcional e `recordedAt` sob `OKWORK_HOME`.
O smoke avisa após `smoke.quotaMaxAgeMinutes` (padrão 30) e considera a cota
desconhecida após `smoke.quotaExpireMinutes` (padrão 120), configuráveis em
`config.json`. Registros sem `recordedAt` continuam válidos. Em `quota-unknown`,
informe uma leitura atual e repita; use `--allow-unknown-quota` só por pedido explícito.
`postCompact` vem habilitado, `timeoutSec: 5`,
`maxLines: 20`, todas as seções habilitadas. Padrões de `smoke`:
`quotaFloorPct: 20`, `maxUsd: 1`, `maxTurns: null` (cenário completo),
`maxMinutes: 15`, `checkTimeoutMs: 60000`.

Defina `limits.global` e `limits.clients.<client>` com o comando; por exemplo,
`okit-plugin config set limits.global 3` e
`okit-plugin config set limits.clients.claude-code 100`. O teto próprio
suplanta o padrão; cada cliente sem entrada usa `global`. Não há teto somado
entre clientes.
Os valores devem ser inteiros positivos; valores inválidos recusam a leitura,
e nomes de clientes desconhecidos geram aviso no status. O antigo `perClient`
suplanta `global` como apelido obsoleto, com aviso no status. O comando remove
esse apelido legado da configuração do usuário ao gravar ou apagar
`limits.global`. O significado anterior de `global` como total foi removido.
As verificações releem a configuração sem reiniciar; o status mostra
vivas/teto, vagas e origem própria/padrão.
A tabela de status termina com uma frase fixa, traduzida: vagas são executores
em execução, e `actors` lista os perfis modelo + esforço disponíveis.

## Uninstall — Desinstalar

Revise com `okit-plugin uninstall --dry-run` e execute `okit-plugin uninstall` para parar o
daemon, remover o registro do cliente, as versões registradas e o link de comando.
Estado/configuração ficam; `okit-plugin uninstall --purge --yes` apaga a raiz de estado.
Use o destino e a raiz de estado do registro da instalação.
Estes são passos documentados; não existe script separado de desinstalação.

## Development — Desenvolvimento

Rode `node --test test/docs-consistency.test.js` para verificar a documentação e
`node --test` para a suíte completa. Os comandos de release estão no guia
referenciado abaixo.

Pull requests são bem-vindos. Leia [CONTRIBUTING.md](CONTRIBUTING.md) antes.

Relatos de segurança não são issues públicas, veja [SECURITY.md](SECURITY.md).
As notas de design estão em [docs/DESIGN.pt-BR.md](docs/DESIGN.pt-BR.md).
O desenho do release está em [docs/RELEASING.pt-BR.md](docs/RELEASING.pt-BR.md)
([English](docs/RELEASING.md)).

## License — Licença

MIT. Veja [LICENSE](LICENSE).

Versão em inglês deste arquivo: [README.md](README.md).
