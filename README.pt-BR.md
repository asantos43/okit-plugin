# okit-plugin

Um plugin para clientes de IA (Claude Code, Codex, opencode) que ajuda um agente
Diretor a distribuir o trabalho delegável pelos próprios subagentes do cliente.

O Diretor classifica cada demanda por esforço (simples, normal, difícil),
escolhe o modelo e o esforço de raciocínio do subagente pela classe e pela cota
restante do cliente, e mantém uma pequena caixa de entrada e ordens
permanentes. O Diretor delega, critica e consolida. Sem painel, sem trabalho
entre clientes.

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

## Licença

MIT. Veja [LICENSE](LICENSE).

Versão em inglês deste arquivo: [README.md](README.md).