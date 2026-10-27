# Ver uma demonstração

![okit-plugin: Guia do usuário](../images/banners/guide.svg)

Veja o trabalho proposto e a cota antes de decidir se aprova uma demonstração.

<a id="preview"></a>
## Ver a prévia

1. Execute `okit-plugin smoke-demo --dry-run --locale pt-BR`. Espere trabalho proposto, ajudantes, cota e limites de custo/tempo/chamadas. A prévia não inicia modelos nem gasta cota. Na conversa, peça “Mostre uma demonstração”; a skill `okit-smoke` usa a mesma prévia por `smoke_demo`.
2. Leia a prévia antes de aprovar. Após aprovação explícita, execute `okit-plugin smoke-demo --locale pt-BR --confirm HASH`, trocando `HASH` pelo `planHash` retornado e mantendo cliente e idioma. Se escolheu um cliente, mantenha essa seleção. Mudanças no trabalho, ajudantes, ajustes ou cota exigem nova prévia e aprovação. Atualmente espere uma recusa com código 2: faltam medição de uso e teto de custo comprovados para execução paga. Nenhum modelo é iniciado.
3. Para conferir a instalação local, execute `okit-plugin smoke`. Espere um resultado por verificação, totais e caminhos dos relatórios. Uma execução sem falhas termina com `passed: 32 failed: 0 skipped: 0`; código 0 indica sucesso, 1 uma falha e 2 uma chamada recusada. Essas verificações isoladas não comprovam execução no cliente real.

Escolha Claude Code, Codex ou OpenCode com `--client claude-code`, `--client codex` ou `--client opencode`. Por exemplo, `okit-plugin smoke-demo --dry-run --client codex --locale pt-BR` mostra o ajudante escolhido e os limites configurados sem gastar cota. Mantenha essa escolha ao confirmar a prévia. A demonstração paga ainda recusa começar até que a medição de consumo e o teto de custo estejam comprovados.

Para conferir o cliente, use `okit-plugin smoke --client codex --dry-run` (ou `client-smoke`). Instale o comando do cliente escolhido (`claude`, `codex` ou `opencode`), entre na sua conta e configure o plugin nesse cliente primeiro. Retirar `--dry-run` inicia trabalho real e gasta cota. Codex e OpenCode não mostram os detalhes do plugin e dos hooks que Claude Code informa; essas verificações são puladas e explicadas, enquanto as verificações das ferramentas continuam. Uma execução real do Codex exige um valor positivo em `smoke.maxTokens` no `config.json`; sem ele, a execução é recusada antes de chamar o modelo. Veja [provas e orçamentos do smoke](../maintainers/SMOKE.pt-BR.md) antes das verificações reais.

O `client-smoke` tem 23 verificações de cenário.

A prévia explica os limites do ajudante escolhido. Claude Code e OpenCode somam o custo informado e interrompem novos trabalhos ao atingir o teto em dinheiro; a falta dessa informação também interrompe novos trabalhos. O Codex informa quanto texto lê e escreve. Ele pode continuar por vários passos, dentro dos limites de tempo e passos, e também exige o teto positivo `smoke.maxTokens` no `config.json` antes de uma execução real. Adicione `"maxTokens": 50000` dentro de `"smoke"` no `config.json` (escolha um limite adequado); o padrão `null` não tem teto de texto, então a execução real do Codex é recusada. O limite é conferido após cada resposta, que pode ultrapassá-lo. O Codex não tem teto em dinheiro garantido, e o OpenCode não pode garantir esse teto dentro de uma única chamada. A prévia não gasta cota.

[Guia](README.pt-BR.md) · [English](smoke-demo.md)
