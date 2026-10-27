# Design

![okit-plugin: Manutenção](../images/banners/maintainers.svg)

Objetivos, limites e decisões originais de desenho do núcleo compartilhado do plugin.

<a id="contents"></a>
## Índice

- [Goals](#section-1)
- [Non-goals](#section-2)
- [The three pieces](#section-3)
- [Per-client adapters](#section-4)
- [Windows rules](#section-5)
- [Open questions](#section-6)

Implementação: veja os módulos atuais em [ARCHITECTURE.pt-BR.md](ARCHITECTURE.pt-BR.md).

<a id="section-1"></a>
## Goals

- Distribuir o trabalho pelos subagentes que o cliente de IA já tem.
- Aceitar qualquer unidade de trabalho delegável, não só código: pesquisa, redação, documentos, limpeza de dados, análise, planejamento, revisões, operações de arquivos.
- Classificar cada demanda por esforço para que o subagente certo a receba.
- Escolher o modelo e o esforço de raciocínio do subagente por classe e por
  cota.
- Manter uma pequena caixa de entrada e ordens permanentes para o Diretor.
- Rodar em Linux, macOS e Windows com o mesmo núcleo.
- Sem dependências, estado em arquivos JSON simples.

<a id="section-2"></a>
## Non-goals

- Sem painel.
- Sem trabalho entre clientes.
- Sem banco de dados; registros em JSON e logs de eventos em JSONL.

<a id="section-3"></a>
## The three pieces

### 1. Classificação de esforço

Cada demanda é classificada como simples, normal ou difícil. A classe é derivada
por padrão e o mantenedor pode sobrescrevê-la. A classe guia o passo seguinte e é
o que os testes fixam.

### 2. Escolha do subagente por classe e cota

A classe define um modelo base e um esforço de raciocínio; a cota restante do
cliente pode rebaixar a escolha final em uma classe. O Diretor nunca inventa um modelo que o
cliente não exponha.

### 3. Caixa de entrada e ordens permanentes

Uma pequena caixa de entrada guarda demandas pendentes; ordens permanentes
guardam instruções que valem para toda demanda até serem removidas. Ambos vivem
em arquivos JSON.

A posse atômica identifica cliente/sessão, worktree e data. Outro dono ativo é
recusado; a idade vem de `inbox.holdStaleMinutes`.
Claim/release e estados finais preservam donos anteriores em `heldBefore`.
Só a CLI humana permite tomada pelo Produtor, mostrando a situação e exigindo
`--producer-takeover` mais confirmação TTY ou `--yes`; o MCP não força a tomada.

O Diretor delega o trabalho, critica a saída do subagente e consolida os
resultados.

<a id="section-4"></a>
## Per-client adapters

Um núcleo em Node, três adaptadores finos:

- `adapters/claude-code/` para o Claude Code.
- `adapters/codex/` para o Codex.
- `adapters/opencode/` para o opencode.

Cada adaptador mapeia os conceitos de modelo, raciocínio e subagente do núcleo
para o que o cliente expõe. A lógica do núcleo nunca importa um cliente
diretamente.

<a id="section-5"></a>
## Windows rules

- Construir todo caminho com `node:path`; nunca concatenar separadores à mão.
- Não depender de shell; executar comandos diretamente.
- Escritas atômicas: escrever em arquivo temporário e então `rename` sobre o
  destino.
- Travas: criar um diretório com `mkdir` e removê-lo ao final; exclusivo em
  todas as plataformas suportadas.

<a id="section-6"></a>
## Open questions

- A cota automática usa a barra do Claude Code, sessões locais do Codex e fontes
  `opencodeQuota.sources` configuradas. A leitura manual continua disponível; sem leitura, a cota é desconhecida.
- Os aplicativos de terminal e de desktop de cada cliente suportam plugins,
  hooks e servidores MCP? Ainda é preciso verificar.

Versão em inglês: [DESIGN.md](DESIGN.md).

Nota de arquitetura: [ARCHITECTURE.pt-BR.md](ARCHITECTURE.pt-BR.md) (português) e
[ARCHITECTURE.md](ARCHITECTURE.md) (inglês).
