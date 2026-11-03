# Resolver um problema

![okit-plugin: Guia do usuário](../images/banners/guide.svg)

Use o relatório do ambiente para encontrar o item ausente e a instrução de correção.

<a id="diagnose"></a>
## Diagnosticar

1. Peça ao seu assistente: “Onde você está?” (ele chama `env_report`). Espere clientes instalados, modelos confirmados, cota, vagas livres e pastas. Leia o comando de correção de cada item ausente; informações não confirmadas continuam desconhecidas. A skill `okit-environment` responde com o mesmo relatório.
2. Se o comando não for encontrado, abra um terminal novo e reinicie o cliente de IA. Use o comando de ativação impresso na instalação se disponível. O relatório do ambiente diz se o comando está no PATH; seu assistente o lê para você. Veja [instalação](install.pt-BR.md).
3. Se a configuração de modelos estiver pendente, execute `okit-plugin setup`. Espere escolhas detectadas e confirmação; sem modelo ativo, nada é salvo. Se a configuração não puder ser lida, peça ao seu assistente para chamar `config_get`; espere os ajustes ou um erro identificando o problema. Corrija o acesso ao arquivo ou JSON inválido antes de repetir; o plugin preserva ajustes ilegíveis.
4. Se a cota estiver desconhecida ou antiga, peça ao seu assistente: “Quanta cota resta?” (ele chama `quota_show`). Espere origem e idade. Registre a leitura atual verdadeira usando [modelos e cota](models-and-quota.pt-BR.md) e tente novamente. A cota de outro cliente não pode autorizar sua execução.
5. Se os ajudantes não puderem começar, peça ao seu assistente: “Quais atores estão disponíveis?” (ele chama `actors_list`). Espere modelos, vagas disponíveis e motivos com soluções. O status mostra as vagas ocupadas. Um modelo disponível e um ajudante rodando são coisas diferentes.
6. Se uma demonstração for recusada, use [o guia da prévia](smoke-demo.pt-BR.md). Confirme o hash atual e atualize a evidência de cota; clientes sem custo em dinheiro também exigem `smoke.maxTokens` inteiro positivo. Confirmar executa trabalho real e gasta cota. Para falhas nas verificações, guarde os caminhos dos relatórios impressos e siga [provas do smoke](../maintainers/SMOKE.pt-BR.md).

<a id="doctor"></a>
## Rode o doctor primeiro

1. Execute `okit-plugin doctor --locale pt-BR`. Leia primeiro o resumo “Pronto” ou “Precisa de atenção” e depois a tabela de verificações. Abaixo da tabela, linhas `Correção:` indicam reparos e um comando exato verifica a instalação novamente. O doctor só lê: não grava arquivo nem remove registro. Ele responde 0 quando nenhuma linha falhou, 1 quando alguma falhou, e um aviso nunca faz a execução falhar. Veja [a referência do CLI](../components/cli.pt-BR.md#commands).

[Guia](README.pt-BR.md) · [English](troubleshooting.md)
