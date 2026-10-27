# Ver uma demonstração

![okit-plugin: Guia do usuário](../images/banners/guide.svg)

Veja o trabalho proposto e a cota antes de decidir se aprova uma demonstração.

<a id="preview"></a>
## Ver a prévia

1. Execute `okit-plugin smoke-demo --dry-run --locale pt-BR`. Espere trabalho proposto, ajudantes, cota e limites de custo/tempo/chamadas. A prévia não inicia modelos nem gasta cota. Na conversa, peça “Mostre uma demonstração”; a skill `okit-smoke` usa a mesma prévia por `smoke_demo`.
2. Leia a prévia antes de aprovar. Após aprovação explícita, execute `okit-plugin smoke-demo --locale pt-BR --confirm HASH`, trocando `HASH` pelo `planHash` retornado e mantendo cliente e idioma. Se escolheu um cliente, mantenha essa seleção. Mudanças no trabalho, ajudantes, ajustes ou cota exigem nova prévia e aprovação. Atualmente espere uma recusa com código 2: faltam medição de uso e teto de custo comprovados para execução paga. Nenhum modelo é iniciado.
3. Para conferir a instalação local, execute `okit-plugin smoke`. Espere um resultado por verificação, totais e caminhos dos relatórios. Uma execução sem falhas termina com `passed: 32 failed: 0 skipped: 0`; código 0 indica sucesso, 1 uma falha e 2 uma chamada recusada. Essas verificações isoladas não comprovam execução no cliente real.

Para verificações existentes do cliente, `okit-plugin client-smoke --client claude-code --dry-run` imprime os comandos propostos sem executar modelos. O driver real suporta Claude Code; os demais estão pendentes. O `client-smoke` tem 23 verificações de cenário. Veja [provas e orçamentos do smoke](../maintainers/SMOKE.pt-BR.md) antes das verificações reais e [desenho da demonstração](../maintainers/DEMO.pt-BR.md) para detalhes dos relatórios.

[Guia](README.pt-BR.md) · [English](smoke-demo.md)
