# Ver uma demonstração

![okit-plugin: Guia do usuário](../images/banners/guide.svg)

Veja o trabalho proposto e a cota antes de decidir se aprova uma demonstração.

<a id="preview"></a>
## Ver a prévia

1. Execute `okit-plugin smoke-demo --dry-run --locale pt-BR`. Espere trabalho proposto, ajudantes, cota e limites de custo/tempo/chamadas. A prévia não inicia modelos nem gasta cota. Na conversa, peça “Mostre uma demonstração”; a skill `okit-smoke` usa a mesma prévia por `smoke_demo`.
2. Leia a prévia antes de aprovar. Após aprovação explícita, execute `okit-plugin smoke-demo --locale pt-BR --confirm HASH`, trocando `HASH` pelo `planHash` retornado e mantendo cliente e idioma. Se escolheu um cliente, mantenha essa seleção. Mudanças no trabalho, ajudantes, ajustes ou cota exigem nova prévia e aprovação. A confirmação inicia os cinco trabalhos com o cliente real escolhido e gasta sua cota. MCP `smoke_demo` aceita o mesmo hash em `confirm`. O relatório inclui o uso final medido; saída 0 indica sucesso, 2 recusa antes de iniciar e 1 falha/parcial.
3. Para conferir a instalação local, execute `okit-plugin smoke`. Espere um resultado por verificação, totais e caminhos dos relatórios. Uma execução sem falhas termina com `passed: 32 failed: 0 skipped: 0`; código 0 indica sucesso, 1 uma falha e 2 uma chamada recusada. Essas verificações isoladas não comprovam execução no cliente real.

Escolha Claude Code, Codex ou OpenCode com `--client claude-code`, `--client codex` ou `--client opencode`. Por exemplo, `okit-plugin smoke-demo --dry-run --client codex --locale pt-BR` mostra o ajudante escolhido e os limites configurados sem gastar cota. Mantenha essa escolha ao confirmar a prévia. Cliente sem custo em dinheiro exige `smoke.maxTokens` inteiro positivo; sem ele a confirmação recusa antes de iniciar. A prova paga cabe ao dono; testes offline não gastam cota.

Para conferir o cliente, use `okit-plugin smoke --client codex --dry-run` (ou `client-smoke`). Instale o comando do cliente escolhido (`claude`, `codex` ou `opencode`), entre na sua conta e configure o plugin nesse cliente primeiro. Retirar `--dry-run` inicia trabalho real e gasta cota. Codex e OpenCode não mostram os detalhes do plugin e dos hooks que Claude Code informa; essas verificações são puladas e explicadas, enquanto as verificações das ferramentas continuam. Uma execução real do Codex exige um valor positivo em `smoke.maxTokens` no `config.json`; sem ele, a execução é recusada antes de chamar o modelo. Veja [provas e orçamentos do smoke](../maintainers/SMOKE.pt-BR.md) antes das verificações reais.

O `client-smoke` tem 23 verificações de cenário.

A demonstração compartilha `smoke.maxUsd` entre execução, revisão e correções e limita cada trabalho com `smoke.demoDemandMaxUsd` (padrão: total dividido por cinco). Entre chamadas, novos trabalhos param quando o saldo disponível acaba. Um teto em dinheiro dentro de uma única chamada existe só no Claude Code: o OpenCode não tem como recebê-lo e o Codex não informa dinheiro. No OpenCode o teto vale entre chamadas e, se uma chamada gastar mais do que foi reservado, o custo total aparece como desconhecido. Também valem `smoke.demoMaxReworkRounds`, `smoke.maxTurns`, `smoke.maxMinutes` e `smoke.checkTimeoutMs`. Tetos esgotados ou uso não medido impedem novos trabalhos e geram relatório parcial. A demonstração pelo MCP não pode ser cancelada no meio; ela termina pelos limites (`smoke.maxMinutes` e tetos de custo).

A prévia explica os limites do ajudante escolhido. Claude Code e OpenCode somam o custo informado e interrompem novos trabalhos ao atingir o teto em dinheiro; a falta dessa informação também interrompe novos trabalhos. O Codex informa quanto texto lê e escreve. Ele pode continuar por vários passos, dentro dos limites de tempo e passos, e também exige o teto positivo `smoke.maxTokens` no `config.json` antes de uma execução real. Adicione `"maxTokens": 50000` dentro de `"smoke"` no `config.json` (escolha um limite adequado); o padrão `null` não tem teto de texto, então a execução real do Codex é recusada. O limite é conferido após cada resposta, que pode ultrapassá-lo. O Codex não tem teto em dinheiro garantido, e o OpenCode não pode garantir esse teto dentro de uma única chamada. A prévia não gasta cota.

A demonstração real roda numa pasta de exemplo isolada e **não** herda a sessão de login do cliente. Antes de confirmar, exporte a chave ou o token do cliente: Claude Code usa `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` ou `CLAUDE_CODE_OAUTH_TOKEN`; Codex usa `OPENAI_API_KEY`; OpenCode ainda não tem variável aceita, então a demonstração real não autentica. Sem isso a chamada falha sem gastar nada. Um `PATH` ausente ou vazio no ambiente recusa a confirmação antes de iniciar.

[Guia](README.pt-BR.md) · [English](smoke-demo.md)
