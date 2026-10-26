# Pedir ao Diretor

Descreva o resultado desejado para o Diretor planejar, distribuir e revisar o trabalho.

<a id="ask"></a>
## Pedir trabalho

1. Abra seu cliente de IA instalado no projeto que deseja alterar. Pergunte: “Onde você está e quais ajudantes estão disponíveis?” Espere o cliente atual, modelos confirmados, cota restante, vagas livres e informações ausentes. A skill `okit-environment` usa `env_report`; o equivalente no terminal é `okit-plugin env report --locale pt-BR`.
2. Peça: “Atue como Diretor. Adicione uma seção curta de primeiros passos ao README deste projeto. Preserve as instruções existentes e mostre como conferiu o resultado.” Espere um plano, ajudantes escolhidos conforme a capacidade disponível e uma descrição clara do que mudará. A skill instalada `okit-director` orienta o trabalho; siga as instruções de ativação do cliente se ela estiver indisponível.
3. Pergunte: “O que está rodando e o que falta?” Espere títulos legíveis e progresso. No terminal, `okit-plugin status --locale pt-BR` mostra ajudantes rodando, cota e limites; `okit-plugin inbox list --locale pt-BR` lista o trabalho salvo e seu responsável, ou não imprime nada se a lista estiver vazia.
4. Leia as mudanças e verificações finais. Espere resultados observados e limitações declaradas. Peça esclarecimento se um modelo, uma leitura de cota ou um resultado não puder ser confirmado.

O Diretor coordena; Executores fazem o trabalho atribuído e o Crítico confere. As escolhas de modelo e esforço não mudam esses papéis. Use [modelos e cota](models-and-quota.pt-BR.md) para ajustar as escolhas ou [veja uma demonstração](smoke-demo.pt-BR.md) primeiro.

[Guia](README.pt-BR.md) · [English](ask-the-director.md)
