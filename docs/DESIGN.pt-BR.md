# Design

Status: fase de design (pré-alfa).

## Objetivos

- Distribuir o trabalho pelos subagentes que o cliente de programação com IA já
  tem.
- Classificar cada tarefa por esforço para que o subagente certo a receba.
- Escolher o modelo e o esforço de raciocínio do subagente por classe e por
  cota.
- Manter uma pequena caixa de entrada e ordens permanentes para o Diretor.
- Rodar em Linux, macOS e Windows com o mesmo núcleo.
- Sem dependências, estado em arquivos JSON simples.

## Não objetivos

- Sem painel.
- Sem trabalho entre clientes.
- Sem estado fora de arquivos JSON simples.

## As três partes

### 1. Classificação de esforço

Cada tarefa é classificada como simples, normal ou difícil. A classe guia o
passo seguinte e é o que os testes fixam.

### 2. Escolha do subagente por classe e cota

A classe define um modelo base e um esforço de raciocínio; a cota restante do
cliente sobe ou desce a escolha final. O Diretor nunca inventa um modelo que o
cliente não exponha.

### 3. Caixa de entrada e ordens permanentes

Uma pequena caixa de entrada guarda tarefas pendentes; ordens permanentes
guardam instruções que valem para toda tarefa até serem removidas. Ambos vivem
em arquivos JSON.

O Diretor delega o trabalho, critica a saída do subagente e consolida os
resultados.

## Adaptadores por cliente

Um núcleo em Node, três adaptadores finos:

- `adapters/claude-code/` para o Claude Code.
- `adapters/codex/` para o Codex.
- `adapters/opencode/` para o opencode.

Cada adaptador mapeia os conceitos de modelo, raciocínio e subagente do núcleo
para o que o cliente expõe. A lógica do núcleo nunca importa um cliente
diretamente.

## Regras para Windows

- Construir todo caminho com `node:path`; nunca concatenar separadores à mão.
- Não depender de shell; executar comandos diretamente.
- Escritas atômicas: escrever em arquivo temporário e então `rename` sobre o
  destino.
- Travas: criar um diretório com `mkdir` e removê-lo ao final; exclusivo em
  todas as plataformas suportadas.

## Perguntas em aberto

- Como cada cliente expõe a cota restante?
- Os aplicativos de terminal e de desktop de cada cliente suportam plugins,
  hooks e servidores MCP? Ainda é preciso verificar.

Versão em inglês: [DESIGN.md](DESIGN.md).