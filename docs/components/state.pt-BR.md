# Estado em disco

![okit-plugin: Componentes](../images/banners/components.svg)

O plugin guarda configuração, trabalho e observações na pasta de estado da pessoa.

<a id="root"></a>
## Raiz e arquivos

A raiz padrão é ~/.okwork; OKWORK_HOME substitui a pasta inteira (não acrescenta .okwork). Caminhos relativos abaixo partem dessa raiz, salvo indicação. A instalação tem uma pasta separada de payloads.

| Caminho | Conteúdo |
| :- | :- |
| `config.json` | Sobrescritas dos padrões, perfis e registro de setup concluído |
| `project.json` | Nome/caminho do projeto usados nas referências |
| `inbox.json` | Versão, sequência e itens de trabalho, estado, posse/histórico e metadados |
| `orders.json` | Instruções globais/por projeto, validade, revogação e histórico até a retenção |
| `templates.json` | Demandas recorrentes, agendas, regras e última execução |
| `quota/<client>.json` | Percentual restante, origem, instante e janelas conhecidas; o leitor escolhe entre automático e manual; JSON válido de outro tipo não é leitura, e um arquivo que não é JSON faz o status falhar |
| `quota/claude-code-statusline.json` | O JSON da barra de status do cliente como ele veio, com o instante em que chegou; o coletor grava e o núcleo deduz dele a leitura de cota |
| `runs/<runId>.json` | Estado da vaga, cliente e início/fim; lançamentos de processos também registram PID e resultado |
| `runs/<runId>.out` | Stdout/stderr do lançador de processos quando não há outra pasta de logs |
| `locks/config.lock/owner.json`, `inbox.json.lock/owner.json`, `orders.json.lock/owner.json`, `templates.json.lock/owner.json`, `runs.lock/owner.json` | Dono do lock de escrita, PID e instante; arquivos claim temporários coordenam recuperação |
| `control/<pid>.json`, `control/<pid>.sock` | Registro e socket da [API de controle](control-api.pt-BR.md) de um servidor MCP em execução; privados do usuário |
| `daemon.lock/owner.json` | Lock exclusivo do loop do daemon |
| `daemon.pid.json`, `daemon.paused`, `daemon.stop` | Dono do loop e controles persistidos de pausa/parada |
| `logs/<date>.jsonl` | Decisões do daemon e remoções por retenção |
| `logs/smoke/smoke-<runId>.jsonl`, `logs/smoke/smoke-<runId>.log` | Eventos e relatório legível do cenário no cliente |
| `claude-statusline.original` | Backup da barra antes do registro consentido |
| `autostart/okit-daemon.cron`, `logs/daemon.out` | Plano cron e saída do daemon nesse plano |

<a id="installation"></a>
## Fora da raiz de estado

O destino padrão dos payloads é XDG_DATA_HOME/okit-plugin ou ~/.local/share/okit-plugin no Linux; ~/Library/Application Support/okit-plugin no macOS; LOCALAPPDATA/okit-plugin ou ~/AppData/Local/okit-plugin no Windows. install.destination substitui esse destino.
Nele, install.<client>.json guarda payload atual, checksum, anterior, link, autostart e barra; install.json é o registro legado. <version>-<client>/ guarda o código; managed-path.json registra somente alterações de PATH gerenciadas. Um registro ou estado do PATH com campo de tipo errado é recusado (saída 2) com a saída: remover o arquivo e rodar `okit-plugin install`. O link padrão fica em ~/.local/bin ou ~/AppData/Local/bin no Windows; configuração pode substituir a pasta. Hooks, skills e blocos de papel ficam nas [raízes dos clientes](adapters.pt-BR.md).
Autostart também registra ~/.config/systemd/user/okit-daemon.service, ~/Library/LaunchAgents/com.okit.daemon.plist ou uma tarefa Windows, conforme plataforma e plano.

<a id="integrity"></a>
## Integridade e remoção

Escritas JSON usam arquivo temporário, sincronização e rename; locks usam diretórios com dono e recuperação de processo morto. Arquivo ausente admite fallback, JSON inválido não vira configuração vazia silenciosamente. Não remova locks de um processo ativo. Peça ao seu assistente para localizar o estado efetivo (`env_report`) e para ler os ajustes (`config_get`). O diagnóstico só lê: abre `config.json`, `inbox.json`, `orders.json`, os registros da pasta de controle, `daemon.pid.json` com o log do daemon, o arquivo do plano de início automático e o `package.json` do plugin (a versão mínima do Node); nunca grava, nunca remove o registro de um processo morto e nunca muda a instalação.
Update conserva estado. Uninstall conserva estado por padrão; --purge --yes exige ausência de outros clientes e apaga a raiz. Faça cópia antes de apagar histórico.

<a id="measurements"></a>
## Medições opcionais de uso

Peça ao seu assistente sobre as medições salvas: `telemetry_status` mostra o que está salvo e onde, e `telemetry_export` exporta a partir de uma data que você indicar. Gravação e envio começam desligados e exigem pedidos separados. Nada é registrado por padrão. Somente contagens, durações, estados, nomes de ajudantes e resumo irreversível do projeto ficam em arquivos OTLP/JSON gravados de forma indivisível; prompts, conteúdo de arquivos, texto de demandas e caminhos são descartados. Arquivos são removidos por idade e tamanho total. Com kit configurado, destino local e retenção são reaproveitados salvo ajuste próprio. O envio ocorre somente ao exportar com ativação separada, inclui somente contagens agrupadas e exige HTTPS (HTTP somente para localhost). Endereços e cabeçalhos nunca aparecem nos registros.

<a id="trajectories"></a>
## Gravações opcionais de execuções

A gravação está desligada por padrão, sem criar arquivos de gravação; o consentimento é o ajuste `trajectory.enabled` do `config.json`. Quando ela está ligada, mensagens, raciocínio disponível, entradas/resultados de ferramentas e uso ficam somente neste computador, e desligá-la interrompe novas gravações e conserva arquivos existentes. O encerramento de processos e tentativas de ajudantes/críticos da demonstração registram conteúdo disponível, modelo, esforço e papel; cada crítico carrega a referência da tentativa avaliada. A delegação nativa registra a entrega; conteúdo final só fica disponível quando fornecido como transcrição ao adaptador. Metadados desconhecidos são null; uso indisponível é omitido, nunca estimado. O uso por passo só é somado onde informado; ausência não vira zero. `trajectory_show` mostra uma execução salva passo a passo, com as ferramentas que falharam e os tokens de cada passo; o arquivo fica neste computador e nada é enviado a lugar nenhum.
Arquivos em trajectory/ usam gravação indivisível, trava compartilhada, retenção por idade/tamanho e marcadores visíveis de redução. Leitores descartam registros JSONL vazios antes do parse, não criam passo para linha sem texto, chamadas, resultados, uso ou outros dados, e removem um BOM UTF-8 inicial, inclusive na captura de arquivo. Leitores e ocultação PEM percorrem repetições em tempo linear; o corte guarda tamanhos de passos sem serializar passos inteiros. Padrões nunca recebem strings maiores que o limite do arquivo. Chaves JSON como `__proto__` sobrevivem como propriedades próprias; campos desconhecidos vão para `extra` onde suportado. IDs de chamadas são resolvidos no próprio passo e podem se repetir entre passos. A profundidade JSON é limitada a 100 níveis de objetos/arrays; conteúdo mais profundo vira `[truncated: too deep]`. Soma excedida conserva passos separados e deixa o total null. Padrões configurados ocultam segredos; revise gravações antes de compartilhar. Saída em runs/ fica separada. A gravação usa `ATIF-v1.4`; leitores aceitam `ATIF-v1.0` até `ATIF-v1.7`, incluindo arquivos antigos. O Director verifica Harbor **0.22.0** fora dos testes Node. A captura atualiza o total após adicionar passos e conta o uso adicionado uma vez. Arquivos reduzidos conservam totais disponíveis e informam passos mantidos. O fuzz cobre registros vazios, chaves de protótipo, repetições, datas hostis, PEM incompleto e adições; datas acima de 64 caracteres são reparadas.
Entradas estritas do Harbor conservam versão, nulls, campos ausentes, coleções e passos vazios, metadados, vetores de tokens e subagentes. Campos numéricos e booleanos exigem números e booleanos JSON; strings numéricas e inteiros fora do intervalo seguro do JavaScript são reparados. O diferencial conta literais inteiros inseguros no texto bruto e dispensa apenas sua verificação de identidade estrita. Totais de passos mudam apenas pelo número de passos adicionados/removidos na normalização. Argumentos são objetos. Referências inválidas de resultados vão ao passo da chamada ou viram null. Falhas usam `step.extra.failed_calls` ou índices órfãos em `step.extra.failed_results`; `content.is_error` antigo continua legível. Uso fora de agentes é somado a um agente anterior que permita métricas, ou o passo vira agente. Imagens locais ausentes viram `[image: caminho]` ao salvar; caminhos com `://` continuam imagens. A normalização pura conserva caminhos. O visualizador mostra texto, imagens e referências `→` a subagentes; mensagens vazias mostram “não disponível”. Datas inválidas conservam `extra.original_timestamp`; campos desconhecidos vão para `extra` onde suportado. Com o Python do Harbor, emita fixtures usando `scripts/check-atif.py --emit <pasta>` ou mute com `--mutate <pasta> --n 2000 --seed 1` (repita sementes 2 e 3). Execute `node scripts/check-atif.mjs --diff <pasta>`, depois `scripts/check-atif.py <pasta>/out` com Harbor. Veredictos registram aceitação laxa/estrita; diferencial e fuzz compartilham o oracle de conservação: uso seguro não negativo move uma vez, metadados ficam no passo, excedentes ficam separados e totais somam passos salvo totais armazenados preservados por identidade/redução. Mutações cobrem strings numéricas, inteiros enormes, opcionais null/ausentes, passos vazios, totais e caminhos de imagens. Amostras usam `node scripts/check-atif.mjs <pasta>`; testes de produção com semente usam `--fuzz <pasta> --n 300`. Harbor roda separado dos testes Node.

[Visão geral](README.pt-BR.md) · [Configuração](configuration.pt-BR.md) · [English](state.md)
