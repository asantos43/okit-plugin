# D94 — Mock-ups das saídas desejadas

![okit-plugin: Manutenção](../images/banners/maintainers.svg)

**Proposta aguardando aprovação do Producer.** Estes documentos não implementam comportamento. Veja o [inventário e P1–P32](OUTPUT-REVIEW.pt-BR.md) e a [versão em inglês](OUTPUT-MOCKUPS.md).

<a id="contents"></a>
## Índice

- [1. Como ler as propostas](#section-1)
- [2. setup](#section-2)
- [3. doctor](#section-3)
- [4. install](#section-4)
- [5. update](#section-5)
- [6. uninstall](#section-6)
- [7. Respostas MCP](#section-7)
- [8. Decisões para o Producer](#section-8)

<a id="section-1"></a>
## 1. Como ler as propostas

Cada bloco é uma saída/estado em português brasileiro. A versão inglesa tem as mesmas seções e números de cenários. Os comandos usam o executável padrão `okit-plugin`; substituir pelo configurado de forma consistente. Nomes, versões, porcentagens e contagens são observações ilustrativas, nunca padrões prometidos nem capacidade inferida. `MCP nome {JSON}` significa “peça ao assistente para chamar a ferramenta com estes argumentos”; não é sintaxe de shell nem restaura comandos removidos pelo D99.

A seleção de idioma da CLI continua: `--locale` explícito, `OKIT_LANGUAGE` válido, idioma salvo, inglês padrão. Identificadores técnicos nos comandos continuam iguais. Todos os blocos MCP são **visões humanas** propostas, renderizadas dos dados, não substitutos das respostas serializadas; veja decisão 3. Não traduzir chaves/enums JSON nem mudar `--json`, erros de protocolo, `isError` ou saídas aqui. Número ausente é “não registrado”, nunca zero. Capacidade observada vem das vagas, não da porcentagem de cota.

Perguntas colocam opções em linhas separadas antes do pedido curto de resposta. Exemplos mostram pergunta e saída seguinte em linhas separadas, sem transcrever entrada do terminal; quebras/eco precisam de verificação na implementação. Tabelas contêm somente dados; explicações e próximas ações ficam abaixo. Cada dica distinta aparece uma vez por execução. Estado saudável oferece verificação exata opcional, não reparo obrigatório.

<a id="section-2"></a>
## 2. setup

### 2.1 Primeira execução — escolha e confirmação (P2–P5, P7–P8)

```text
okit-plugin — Configuração
Escolha modelos para Codex; nada é salvo até sua confirmação.

Tarefas pequenas — Codex
1. gpt-6.1-sol (recomendado)
2. gpt-6-astra
Escolha um modelo [1]:

Escolhas de modelos
| Trabalho | Modelo |
| --- | --- |
| Tarefas pequenas | gpt-6.1-sol |
| Tarefas do dia a dia | gpt-6.1-sol |
| Tarefas complexas | gpt-6-astra |

As escolhas valem para trabalhos futuros. Para alterá-las: okit-plugin setup --again
Salvar estas escolhas? [s/N]:

3 escolhas de modelos salvas para Codex.
Próximo: okit-plugin doctor --client codex
```

A seleção se repete para cada classe sem modelo, com modelos disponíveis naquele cliente. As três linhas ilustram escolhas concluídas. Explicar alternativa comum uma vez: “Não foi possível ler a lista de modelos; estas opções vêm da lista incluída no plugin.” Mostrar antes da seleção/confirmação, somente quando verdadeiro. Não dizer que modelo não confirmado está pronto.

### 2.2 Tudo pronto / nada detectado / cancelado (P5–P6)

```text
okit-plugin — Configuração
Todas as escolhas de modelos já estão salvas. Nada mudou.
Verifique a instalação: okit-plugin doctor --client codex
Altere os modelos: okit-plugin setup --again
```

```text
okit-plugin — Configuração
Nenhum cliente com modelo ativo foi encontrado. Nada foi salvo.
Instale ou ative um modelo no seu cliente de programação e rode: okit-plugin setup
Confira os clientes disponíveis: MCP env_report {"locale":"pt-BR"}
```

```text
okit-plugin — Configuração
Cancelado. Nada foi salvo.
Tente novamente quando quiser: okit-plugin setup
```

### 2.3 Serviço opcional e erros (P7–P8)

Continuação conforme o estado, apenas com plugin instalado: “Serviço em segundo plano — executa trabalhos em espera enquanto o cliente está fechado. Iniciar com esta máquina? [s/N]:”. Se recusado: “Início automático desligado. Para ativar depois: okit-plugin setup”. Se salvo: “Início automático ligado. Verifique: okit-plugin doctor”. Mostrar o caminho uma vez antes do consentimento. Em falha, título e resumo “Não foi possível configurar o início automático.”, uma causa e “Tente de novo após corrigir a causa: okit-plugin setup”. Separar resultado de gravação de modelos e serviço.

Resposta inválida: “Escolha 1 ou 2.” seguida da mesma pergunta curta, sem acumular prefixos. Ajustes ilegíveis: “Não foi possível ler os ajustes. Confira: MCP config_get {}”. Falha de gravação: “Não foi possível salvar as escolhas. Confira a permissão de gravação da pasta de ajustes e rode: okit-plugin setup”. Incluir a pasta real uma vez. Valores concorrentes: “As escolhas mais novas foram mantidas. Confira: MCP config_get {}”. Orientação de cota segue §7.2 uma vez por cliente afetado.

<a id="section-3"></a>
## 3. doctor

### 3.1 Tudo certo / uma falha e sua Correção (P9–P12)

```text
okit-plugin — Verificação da instalação
Pronto. As 8 verificações passaram.
| Verificação | Resultado |
| --- | --- |
| Instalação | Pronta para Codex |
| Modelos | 3 escolhas salvas |
| Serviço em segundo plano | Ativo |
Verifique novamente quando precisar: okit-plugin doctor --client codex
```

```text
okit-plugin — Verificação da instalação
Precisa de atenção: 1 verificação falhou; as demais passaram.
| Verificação | Resultado |
| --- | --- |
| Conexão com Codex | Sem registro |
Correção: registre o plugin no Codex: okit-plugin install --client codex
Depois confira: okit-plugin doctor --client codex
```

A visão completa lista cada verificação real; o exemplo abreviado agrupa detalhes silenciosos. Sem instalação: “Nada instalado para Codex. Instale: okit-plugin install --client codex”. Serviço opcional inativo: “Início automático é opcional. Ative: okit-plugin setup”. Sessão fechada: “Nenhuma sessão de cliente aberta. Abra Codex e rode: okit-plugin doctor --client codex”. Se MCP aparecer, explicar uma vez: “MCP é a conexão usada pelo assistente para chamar ferramentas do plugin.” Preservar saída 1 para falhas e 0 para somente avisos.

<a id="section-4"></a>
## 4. install

### 4.1 Instalado / cliente não escolhido / falha no download (P13–P16)

```text
okit-plugin — Instalação
Instalado para Codex. Falta confirmar os modelos.
1. Baixar e verificar: concluído
2. Instalar arquivos: concluído
3. Conectar Codex: concluído
Próximo: okit-plugin setup
Verifique a instalação: okit-plugin doctor --client codex
```

```text
okit-plugin — Instalação
Escolha um cliente de programação antes de instalar.
1. Claude Code (encontrado)
2. Codex (encontrado)
3. OpenCode (encontrado)
Escolha um cliente [1–3, ou all]:
```

Sem terminal, substituir a pergunta por “Instale para Codex: okit-plugin install --client codex” (e listar comandos equivalentes dos outros clientes oferecidos). Falha no download: título, “Não foi possível baixar a versão. Nada foi instalado.”, uma causa, “Confira sua conexão e tente: okit-plugin install --client codex”. Simulação diz “Somente prévia. Nada mudou.” e dá a mesma chamada sem simulação para aplicar. Listar ações necessárias uma vez; kit opcional segue §7.5. Preservar categorias de saída e padrões de consentimento. Se necessário, explicar PATH: “PATH é a lista de pastas onde o terminal procura comandos.”

<a id="section-5"></a>
## 5. update

### 5.1 Atualizado / já em dia / sem instalação (P17–P18)

```text
okit-plugin — Atualização
Codex está em dia. Nada mudou.
Verifique a instalação: okit-plugin doctor --client codex
```

Após atualização bem-sucedida usar “Codex atualizado de 0.2.0 para 0.3.0.”, passos concluídos e “Próximo: reinicie Codex e rode: okit-plugin doctor --client codex”. Se houver versão guardada, mostrar “Volte à versão guardada: okit-plugin update --rollback”. Em falha, citar passo e uma causa; oferecer reversão somente quando disponível. Sem registro: título, “Nenhuma instalação do plugin encontrada. Nada foi atualizado.”, “Instale primeiro: okit-plugin install --client codex”. Preservar saída 2 dessa recusa.

<a id="section-6"></a>
## 6. uninstall

### 6.1 Removido / já ausente / arquivos compartilhados mantidos (P19–P20)

```text
okit-plugin — Desinstalação
Plugin removido do Codex. Seus ajustes foram mantidos.
Instale novamente quando precisar: okit-plugin install --client codex
```

Sem registro: título, “Nenhuma instalação do plugin encontrada. Nada foi removido.”, “Confira o estado local: okit-plugin doctor”. Preservar saída 2. Com outro cliente: “Integração do Codex removida. O comando foi mantido para Claude Code.” e “Verifique a instalação restante: okit-plugin doctor --client claude-code”. Listar arquivos editados/ajustes mantidos uma vez, com caminhos reais. Remoção completa diz “Os ajustes também foram removidos.” somente quando verdadeiro. Em falha, uma causa e repetição `okit-plugin uninstall --client codex`; nunca afirmar conclusão sem remoção completa.

<a id="section-7"></a>
## 7. Respostas MCP

### 7.1 Status — leituras registradas / sem cliente selecionado (P21–P23)

```text
okit-plugin — Situação
Codex: 2 vagas de executor disponíveis; cota acima do mínimo de 15%.
| Cliente | Cota restante | Renova em | Leitura registrada |
| --- | --- | --- | --- |
| Codex | 65% (período de 5 horas) | 2 horas | há 1 minuto |
| Codex | 80% (semana) | 3 dias | há 1 minuto |
Uma vaga permite executar uma tarefa por vez. Vagas são medidas separadamente da cota.
Veja os modelos disponíveis: MCP actors_list {"client":"codex","locale":"pt-BR"}
```

Sem seleção/detecção: “Mostrando todos os clientes; nenhum cliente foi selecionado.”, seguido dos dados observados. Próxima chamada opcional: `MCP status {"client":"codex","locale":"pt-BR"}`. Sem aviso de reconhecimento. Sem clientes instalados, substituir tabela/frase de capacidade vazia por “Nenhum cliente de programação encontrado. Instale um cliente compatível e rode: okit-plugin install --client codex”. Se vagas estiverem ocupadas, informar mesmo com cota alta; cota sozinha não determina capacidade. Manter demandas em tabela própria, traduzindo rótulos de exibição sem mudar enums salvos.

### 7.2 Cota — desconhecida / abaixo do mínimo (P23–P24)

```text
okit-plugin — Cota
Codex não tem leitura de cota registrada.
Cota é a porcentagem do limite da assinatura que ainda resta.
Confira a porcentagem no cliente e peça ao assistente para registrar o valor observado.
Somente exemplo, se restarem 65%: MCP quota_set {"client":"codex","pct":65}
Confira o valor registrado: MCP quota_show {"client":"codex"}
```

Cota registrada usa as duas linhas de dados da §7.1 com resumo “Leitura registrada há 1 minuto”. Abaixo do mínimo: “Codex tem 8% restantes, abaixo do mínimo de 15%. Trabalhos em espera não podem iniciar nesta assinatura. Confira a renovação depois: MCP quota_show {"client":"codex"}”. Não inventar horário nem sugerir reduzir o mínimo como correção padrão. Leitura antiga/sem idade diz “Horário da leitura desconhecido; confira no cliente antes de confiar nela.”

### 7.3 Atores — disponíveis / vazios / bloqueados (P25)

```text
okit-plugin — Assistentes disponíveis
Codex: 2 perfis de modelo disponíveis; 2 vagas de executor livres.
| Modelo | Esforço de raciocínio | Trabalho | Pode iniciar | Cota restante |
| --- | --- | --- | --- | --- |
| gpt-6.1-sol | Médio | Tarefas do dia a dia | Sim | 65% |
| gpt-6-astra | Alto | Tarefas complexas | Sim | 65% |
Ator é um modelo com seu esforço de raciocínio em um cliente de programação.
Esforço de raciocínio é quanto se pede ao modelo para pensar.
Confira a execução simultânea: MCP limits_status {}
```

Vazio: título, “Nenhum perfil de modelo pronto para Codex.”, “Escolha modelos: okit-plugin setup”, “Confira novamente: MCP actors_list {"client":"codex","locale":"pt-BR"}”. Ocupado: “Todas as vagas estão ocupadas. Aguarde um trabalho terminar e confira: MCP limits_status {}”. Cota baixa: usar explicação comum da §7.2 abaixo da tabela, não por linha. Cota desconhecida diz “Não registrada”, sem cor nem porcentagem.

### 7.4 Vagas — disponíveis / ocupadas / sem trabalho ativo (P26)

```text
okit-plugin — Vagas de executor
Codex: 2 vagas livres de um limite de 3.
| Cliente | Em execução | Limite | Disponíveis |
| --- | --- | --- | --- |
| Codex | 1 | 3 | 2 |
Uma vaga permite um executor por vez; a cota é verificada separadamente.
Veja modelos que podem iniciar: MCP actors_list {"client":"codex","locale":"pt-BR"}
```

Sem trabalho ativo: “Nenhum executor em execução. As vagas disponíveis estão acima. Confira novamente: MCP limits_status {}”. Aquisição ocupada: “Nenhuma vaga disponível para Codex. Aguarde um trabalho terminar e tente: MCP acquire_slot {"client":"codex","runId":"review","waitMs":0}”. Sucesso: “Uma vaga do Codex reservada para review. Ao terminar essa execução: MCP release_slot {"runId":"review"}”. Liberação: “A vaga de review foi liberada. Confira as vagas disponíveis: MCP limits_status {}”. Substituir pelo ID real; não liberar outra execução ativa para abrir espaço.

### 7.5 Kit, avisos e outros vazios/erros (P27–P31)

```text
okit-plugin — Kit opcional de orquestração
Kit não encontrado. As ferramentas do plugin nos clientes continuam disponíveis.
O kit coordena o fluxo entre assistentes e é um pacote separado.
Se precisar desse fluxo, siga INSTALL.pt-BR.md#kit-de-orquestração.
Confira novamente após instalar: MCP kit_detect {}
```

Isso dá chamada exata de verificação. O comando real de instalação/atualização do kit precisa de confirmação do responsável (decisão 4); não inventar. Sem evento de renovação: “Aviso de renovação da cota indisponível. Confira a leitura atual: MCP quota_show {}”. Com evento válido: “A cota do Codex está disponível novamente. Confira os trabalhos em espera: MCP inbox_list {}”. Aviso não é leitura numérica nova.

Demais visões vazias seguem título, resumo e próxima chamada:

- **Caixa de entrada:** “Nenhum trabalho listado. Quando precisar, adicione: MCP inbox_add {"title":"Revisar saída"}”.
- **Instruções permanentes:** “Nenhuma instrução permanente ativa. Quando precisar, adicione: MCP order_add {"text":"Explique os resultados brevemente"}”.
- **Sincronização de tarefas:** “Nenhum projeto configurado para sincronizar tarefas. Confira os ajustes: MCP config_get {"key":"todo.projects"}”.
- **Telemetria/exportação:** “Nenhuma medição salva. Veja o que seria registrado: MCP telemetry_status {}”. Preservar consentimento e não ativar coleta automaticamente.
- **Trajetória:** “Nenhuma execução salva com nome review. Confirme um nome salvo e tente com ele: MCP trajectory_show {"run":"review"}”. `review` exemplifica sintaxe, sem afirmar existência de execução salva.
- **Ambiente:** “Configuração incompleta para Codex. Escolha modelos: okit-plugin setup”. Se registro também faltar, acrescentar `okit-plugin install --client codex` uma vez antes de setup.
- **Ajustes/recusa:** “É preciso informar o nome do ajuste. Exemplo: MCP config_get {"key":"language"}”. Sem chave em config_set: “Escolha o ajuste para alterar. Exemplo: MCP config_set {"key":"language","value":"pt-BR"}”. Erros brutos ficam nos diagnósticos de máquina.
- **Prévia/classificação/perfil:** título e “Somente prévia; nenhum trabalho iniciado”, “Tarefa do dia a dia” ou “Modelo selecionado para trabalho do dia a dia”. Próximas verificações exatas: `MCP smoke_demo {"dryRun":true,"locale":"pt-BR"}`, `MCP classify {"title":"Revisar saída"}`, `MCP profile_pick {"client":"codex","effort":"normal"}`, respectivamente. Mostrar início da demonstração somente após confirmação já exigida.
- **Serviço em segundo plano:** “Não está rodando. Configure o início automático: okit-plugin setup”. Não criar comando de daemon para a pessoa.

<a id="section-8"></a>
## 8. Decisões para o Producer

1. **Redação:** aprovar títulos, resumos curtos, perguntas de modelo e significados de ator/vaga/cota/serviço. Recomendo estes termos, com explicação comum uma vez por visão; preservar nomes reais e identificadores dos comandos.
2. **Tabela ou lista:** aprovar atores com cinco colunas e status/vagas com quatro; recomendo listas para passos de instalação, correções e vazios. Preservar observações estruturadas detalhadas para o assistente.
3. **Formato de máquina:** escolher renderização pelo assistente dos objetos existentes ou alteração de campos de apresentação serializados. Recomendo renderizar JSON preservado por enquanto; mudar `markdown`, `text`, `message`, `capacityLine`, esquema ou envelope exige decisão explícita de compatibilidade. Não se propõem mudanças de JSON da CLI nem saídas.
4. **Kit e ausências:** aprovar orientação de verificar o kit primeiro e redação com saída 2 atual em update/uninstall ausentes. Recomendo chamada exata `kit_detect {}` e guia do kit; o responsável deve fornecer comando de instalação/atualização antes de prometer ação direta.
5. **Interação e verificação:** aprovar opções numeradas de modelos e pergunta por classe, sem copiar resposta no texto da aplicação. Recomendo verificação de terminal, capturas nos dois idiomas, dicas sem repetição e asserções de contratos na implementação. Estes documentos não autorizam implementação.
