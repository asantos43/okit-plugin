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

Install/update disponibilizam o comando nas novas shells por um candidato gravável já no PATH ou pelos perfis gerenciados (Windows: PATH do usuário). Abra um terminal novo ou carregue o perfil informado com source, depois reinicie o cliente de IA. `--no-path` recusa edições do PATH; uninstall remove só a adição do instalador. Configuração e instrução alternativa: [INSTALL](INSTALL.pt-BR.md).
A matriz tem nove pares cliente × sistema; existir um pacote não comprova
uso real. Veja as [provas por par](docs/RELEASING.pt-BR.md#proof-per-pair).
Cada pacote inclui todos os adaptadores de execução por padrão (`release.sharedAdapters: null`
herda `release.adapters`), além dos metadados de instalação do cliente selecionado.

## Usage — Uso

```text
okit-plugin install [--from <dir>] [--client <c>] [--prerelease] [--repo <o/r>] [--dest <dir>] [--no-link] [--no-path] [--autostart] [--dry-run] [--yes]
okit-plugin update [--check] [--rollback] [--dry-run] [--no-path]
okit-plugin uninstall [--purge] [--yes] [--dry-run]
okit-plugin daemon start|stop|status|pause|resume|run-once
okit-plugin daemon status [--table [--locale en|pt-BR]]
okit-plugin autostart install|uninstall|show [--kind systemd|cron|launchd|schtasks]
okit-plugin status [--locale en|pt-BR]
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

O servidor MCP por stdio expõe 14 ferramentas: `acquire_slot`, `release_slot`,
`limits_status`, `status`, `classify`, `profile_pick`, `inbox_add`, `inbox_list`,
`inbox_set_status`, `inbox_claim`, `inbox_release`, `order_add`, `order_list`, `order_remove`.

`okit-plugin inbox list [--locale en|pt-BR]` e MCP `inbox_list` mostram o dono de cada demanda.
`okit-plugin inbox take <id> --client codex --session <s> --worktree <path>` toma posse atomicamente;
outro cliente/sessão ativo é recusado. `okit-plugin inbox release <id> --client codex --session <s>` libera a posse.
Só a CLI humana permite `okit-plugin inbox take <id> --producer-takeover [--client <c>] [--yes]`:
mostra dono, sessão, worktree, data, obsolescência e mudanças Git não commitadas antes
da confirmação TTY (ou `--yes`). A transferência guarda `heldBefore` com motivo `producer takeover`.
`inbox.holdStaleMinutes` tem padrão 120 (inteiro >= 1); posses obsoletas guardam motivo `stale`.
`inbox.gitTimeoutMs` tem padrão 5000 (inteiro >= 1). Estados finais limpam a posse.
As skills Director, Executor, Critic e Smoke orientam delegação e verificação.
`smoke` roda 31 checks isolados; `client-smoke` tem 23 checks de cenário e seu
driver real suporta Claude Code. Dry-run e rehearsal são percursos offline.
Veja [SMOKE.pt-BR.md](docs/SMOKE.pt-BR.md) para orçamento e provas exigidas.

## Configuration — Configuração

O estado fica em `~/.okwork`; `OKWORK_HOME` substitui essa raiz. Edite ali o
`config.json`. Os padrões em [src/profiles.js](src/profiles.js) incluem
`lowQuotaPct: 15`, `limits: {global: 3, clients: {}}`, `staleMinutes: 30`
e `profiles` vazio. Preencha `profiles.<client>.simple|normal|hard` com `model`,
`effort`, `maxTurns`; não há modelo padrão. Todos os adaptadores leem a cota do
usuário em `quota/<client>.json`.
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

Defina `limits.global` e `limits.clients.<client>` nesse arquivo; não há comando
de configuração. Exemplo: `"limits": {"global": 3, "clients":
{"claude-code": 100, "codex": 2}}`. O teto próprio suplanta o padrão; cada
cliente sem entrada usa `global`. Não há teto somado entre clientes.
Os valores devem ser inteiros positivos; valores inválidos recusam a leitura,
e nomes de clientes desconhecidos geram aviso no status. O antigo `perClient`
suplanta `global` como apelido obsoleto, com aviso no status. O significado
anterior de `global` como total foi removido. As verificações releem a
configuração sem reiniciar; o status mostra vivas/teto, vagas e origem própria/padrão.

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
