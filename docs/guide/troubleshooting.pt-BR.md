# Resolver um problema

![okit-plugin: Guia do usuário](../images/banners/guide.svg)

Use o relatório do ambiente para encontrar o item ausente e a instrução de correção.

<a id="diagnose"></a>
## Diagnosticar

1. Execute `okit-plugin env report --locale pt-BR`. Espere clientes instalados, modelos confirmados, cota, vagas livres e pastas. Leia o comando de correção de cada item ausente; informações não confirmadas continuam desconhecidas. A skill `okit-environment` responde “Onde você está?” com o mesmo relatório por `env_report`.
2. Se o comando não for encontrado, abra um terminal novo e reinicie o cliente de IA. Use o comando de ativação impresso na instalação se disponível. Se necessário, execute `node src/cli.js status` na pasta do pacote instalado; espere o status e uma dica de correção do PATH enquanto a pasta bin estiver ausente do PATH atual. Veja [instalação](install.pt-BR.md).
3. Se a configuração de modelos estiver pendente, execute `okit-plugin setup`. Espere escolhas detectadas e confirmação; sem modelo ativo, nada é salvo. Se a configuração não puder ser lida, execute `okit-plugin config show`; espere valores ou um erro identificando o problema. Corrija o acesso ao arquivo ou JSON inválido antes de repetir; o plugin preserva ajustes ilegíveis.
4. Se a cota estiver desconhecida ou antiga, execute `okit-plugin quota show`. Espere origem e idade. Registre a leitura atual verdadeira usando [modelos e cota](models-and-quota.pt-BR.md) e tente novamente. A cota de outro cliente não pode autorizar sua execução.
5. Se os ajudantes não puderem começar, execute `okit-plugin actors --all --locale pt-BR`. Espere modelos, vagas disponíveis e motivos com soluções. Execute `okit-plugin status --all --locale pt-BR` para ver vagas ocupadas. Um modelo disponível e um ajudante rodando são coisas diferentes.
6. Se uma demonstração for recusada, use [o guia da prévia](smoke-demo.pt-BR.md). Confirme o hash atual e atualize a evidência de cota; clientes sem custo em dinheiro também exigem `smoke.maxTokens` inteiro positivo. Confirmar executa trabalho real e gasta cota. Para falhas nas verificações, guarde os caminhos dos relatórios impressos e siga [provas do smoke](../maintainers/SMOKE.pt-BR.md).

[Guia](README.pt-BR.md) · [English](troubleshooting.md)
