# okit-plugin

## Restaurar contexto após compactação (Claude Code)

`okit hook post-compact` lê o JSON do hook (`cwd`) pela entrada padrão e exibe
itens abertos/em andamento do projeto e globais, títulos de ordens permanentes
ativas e uma linha de contagens. Usa `title` da ordem quando presente, senão a
primeira linha de `text`; corpos e variáveis de ambiente ficam fora da saída.
Estado ausente/inválido, entrada inválida, erro ou prazo esgotado: saída vazia,
código 0.

No `config.json` da raiz de estado (`OKWORK_HOME`), configure `postCompact`:
`enabled` (padrão `true`), `timeoutSec` (`5`), `maxLines` (`20`), `sections`
(`inbox`, `orders`, `status`, todas `true`), `inboxStatuses` e `text`. Os padrões
ficam em `src/profiles.js`; sobrescritas parciais de seções/textos são mescladas.
`postCompact.enabled=false` desliga a saída. A leitura inicial usa o prazo padrão
até conhecer o configurado, contado desde o início do hook.

Sem instalador geral por enquanto: importe `installPostCompactHook` de
`adapters/claude-code/index.js` e chame com `{ root: raizDoCliente,
config: configuracaoDoPlugin }`. `command` é opcional (padrão
`okit hook post-compact`, com `okit` no PATH). A função mescla `SessionStart`,
matcher `compact`, com o prazo configurado em `hooks/hooks.json`, preserva
entradas do usuário e não grava novamente na segunda instalação idêntica.

Um plugin para clientes de IA (Claude Code, Codex, opencode) que ajuda um agente
Diretor a distribuir o trabalho delegável pelos próprios subagentes do cliente.

O Diretor classifica cada demanda por esforço (simples, normal, difícil),
escolhe o modelo e o esforço de raciocínio do subagente pela classe e pela cota
restante do cliente, e mantém uma pequena caixa de entrada e ordens
permanentes. O Diretor delega, critica e consolida. Sem painel, sem trabalho
entre clientes.

Nas mensagens ao Produtor, o Diretor identifica demandas como `D25 (okit-plugin)` para distinguir projetos. Itens exibidos no inbox/status acrescentam `ref`; o `id` JSON, comandos, corpos de PR, campos do inbox e `critic-waiver Dn` mantêm o id puro. O registro opcional `project.json` na raiz de estado fornece `name`, com fallback para o nome do repositório em `path`; um único projeto em `appliesTo` da demanda tem precedência. Sem nome, `ref` é o id puro. Decisões do daemon acrescentam `ref` às entradas de demandas e `openedRefs` ao lado dos ids inalterados em `opened`.

Uma demanda é qualquer unidade de trabalho delegável, não só código: pesquisa,
redação, documentos, limpeza de dados, análise, planejamento, revisões e
operações de arquivos.

**Status: fase de design (pré-alfa).** Este repositório contém apenas a
estrutura e os documentos. Ainda não há código funcional.

## Funcionalidades planejadas

- Classificação de esforço de cada demanda recebida.
- Escolha do subagente por classe de esforço e por cota restante do cliente.
- Uma pequena caixa de entrada e ordens permanentes mantidas pelo Diretor.
- Um ciclo de delegação, crítica e consolidação.

## Clientes e plataformas suportados

- Clientes: Claude Code, Codex, opencode.
- Plataformas: Linux, macOS e Windows.
- Núcleo: Node.js >= 20, sem dependências, estado em arquivos JSON simples.

## Contribuição

Pull requests são bem-vindos. Leia [CONTRIBUTING.md](CONTRIBUTING.md) antes.

Relatos de segurança não são issues públicas, veja [SECURITY.md](SECURITY.md).
As notas de design estão em [docs/DESIGN.pt-BR.md](docs/DESIGN.pt-BR.md).
O desenho do release está em [docs/RELEASING.pt-BR.md](docs/RELEASING.pt-BR.md)
([English](docs/RELEASING.md)).

## Licença

MIT. Veja [LICENSE](LICENSE).

Versão em inglês deste arquivo: [README.md](README.md).
