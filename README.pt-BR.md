# okit-plugin

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
