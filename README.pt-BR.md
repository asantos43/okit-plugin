# okit-plugin

Um plugin para clientes de IA (Claude Code, Codex, opencode) que ajuda o Diretor
a distribuir demandas pelos próprios subagentes do cliente. Núcleo Node.js >=20,
sem dependências, com estado em JSON.

## Install — Instalar

Use o [install.sh](install.sh) da release no Linux/macOS ou
[install.ps1](install.ps1) no PowerShell do Windows. Leia os scripts e siga
[INSTALL.pt-BR.md](INSTALL.pt-BR.md) para requisitos, flags, downloads verificados e atualizações.
Depois, use `okit update --check`, `okit update` ou `okit update --rollback`.
A matriz tem nove pares cliente × sistema; existir um pacote não comprova
uso real. Veja as [provas por par](docs/RELEASING.pt-BR.md#proof-per-pair).

## Usage — Uso

```text
okit install [--from <dir>] [--client <c>] [--prerelease] [--repo <o/r>] [--dest <dir>] [--no-link] [--autostart] [--dry-run] [--yes]
okit update [--check] [--rollback] [--dry-run]
okit uninstall [--purge] [--yes] [--dry-run]
okit daemon start|stop|status|pause|resume|run-once
okit daemon status [--table [--locale en|pt-BR]]
okit autostart install|uninstall|show [--kind systemd|cron|launchd|schtasks]
okit status [--locale en|pt-BR]
okit kit [--require]
okit hook post-compact
okit smoke [--real] [--keep] [--only <ids>] [--timeout <ms>]
okit client-smoke [--client claude-code] [--headless|--demo|--dry-run|--rehearsal]
  [--only <C ids>] [--keep] [--allow-unknown-quota]
  [--max-usd [n]] [--max-turns [n]] [--max-minutes [n]] [--quota-floor [pct]] [--timeout [ms]]
```

`okit kit` imprime uma linha em inglês: instalado (caminho e versão), ausente
(dica de instalação) ou quebrado. Executa somente o comando de versão configurado.
`--require` retorna 1 se não estiver instalado; sem ele, a consulta é informativa.
Os resumos de install/update (inclusive dry-run) e `okit status` incluem `kit: …`.
Quando ambos estão presentes, a linha aponta para as
[regras de sobreposição D1](docs/ARCHITECTURE.md#kit-and-plugin-overlap-d1).
Veja a [configuração do kit](INSTALL.pt-BR.md#kit-de-orquestração).

O servidor MCP por stdio expõe 14 ferramentas: `acquire_slot`, `release_slot`,
`limits_status`, `status`, `classify`, `profile_pick`, `inbox_add`, `inbox_list`,
`inbox_set_status`, `inbox_claim`, `inbox_release`, `order_add`, `order_list`, `order_remove`.

`okit inbox list [--locale en|pt-BR]` e MCP `inbox_list` mostram o dono de cada demanda.
`okit inbox take <id> --client codex --session <s> --worktree <path>` toma posse atomicamente;
outro cliente/sessão ativo é recusado. `okit inbox release <id> --client codex --session <s>` libera a posse.
Só a CLI humana permite `okit inbox take <id> --producer-takeover [--client <c>] [--yes]`:
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
usuário em `quota/<client>.json`. `postCompact` vem habilitado, `timeoutSec: 5`,
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

Revise com `okit uninstall --dry-run` e execute `okit uninstall` para parar o
daemon, remover o registro do cliente, as versões registradas e o link de comando.
Estado/configuração ficam; `okit uninstall --purge --yes` apaga a raiz de estado.
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
