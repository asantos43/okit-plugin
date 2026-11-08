# Pedir ao Diretor

![okit-plugin: Guia do usuário](../images/banners/guide.svg)

Descreva o resultado desejado para o Diretor planejar, distribuir e revisar o trabalho.

<a id="ask"></a>
## Pedir trabalho

1. Abra seu cliente de IA instalado no projeto que deseja alterar. Pergunte: “Onde você está e quais ajudantes estão disponíveis?” Espere o cliente atual, modelos confirmados, cota restante, vagas livres e informações ausentes. A skill `okit-environment` responde isso com `env_report`.
2. Peça: “Atue como Diretor. Adicione uma seção curta de primeiros passos ao README deste projeto. Preserve as instruções existentes e mostre como conferiu o resultado.” Espere um plano, ajudantes escolhidos conforme a capacidade disponível e uma descrição clara do que mudará. A skill instalada `okit-director` orienta o trabalho; siga as instruções de ativação do cliente se ela estiver indisponível.
3. Pergunte: “O que está rodando e o que falta?” Espere títulos legíveis e progresso. A mesma pergunta chama `status`, que mostra ajudantes rodando, cota e limites, e `inbox_list`, que lista o trabalho salvo e seu responsável, ou não mostra nada se a lista estiver vazia.
4. Leia as mudanças e verificações finais. Espere resultados observados e limitações declaradas. Peça esclarecimento se um modelo, uma leitura de cota ou um resultado não puder ser confirmado.

O Diretor coordena; Executores fazem o trabalho atribuído e o Crítico confere. As escolhas de modelo e esforço não mudam esses papéis. Use [modelos e cota](models-and-quota.pt-BR.md) para ajustar as escolhas ou [veja uma demonstração](smoke-demo.pt-BR.md) primeiro.

O Diretor trabalha e delega apenas no próprio cliente e não executa agentes de outros clientes. Outros clientes na tabela são informativos, não destinos de execução; o Diretor nunca oferece iniciar os atores deles. Para usar atores de outro cliente, o Produtor abre uma sessão no próprio cliente desejado. Vagas e limites são compartilhados entre clientes.

Para manter a lista de um projeto em dia, configure só esse projeto: peça ao seu assistente para chamar `config_set` com a chave `todo.projects` e o valor `{"/projects/example":{"enabled":true,"file":"TODO.md","areaDir":"","section":"## Inbox","checkbox":{"open":" ","progress":"-","done":"x"}}}`. Troque o exemplo pela pasta completa do projeto. Arquivo e seção devem existir; veja [configuração](../components/configuration.pt-BR.md). Com arquivos por área, ajuste areaDir; tarefas novas entram na seção configurada do arquivo principal ou de um único arquivo de área correspondente.
Peça “Mantenha a lista de tarefas deste projeto em dia e mostre as mudanças propostas.” O assistente chama `todo_sync` com `dryRun` para mostrar as mudanças sem gravar. `todo_check` lista trabalhos sem tarefa e tarefas sem trabalho salvo. O Diretor pergunta antes de usar uma sugestão próxima. Tomar marca andamento, concluir registra conclusão e data, e liberar ou abandonar restaura a tarefa original. Arquivos alterados ou caminhos externos são recusados; o trabalho permanece salvo e o Diretor explica o que conferir. Funciona igual nos três clientes.

[Guia](README.pt-BR.md) · [English](ask-the-director.md)
