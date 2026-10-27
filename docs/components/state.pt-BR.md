# Estado em disco

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
| `quota/<client>.json` | Percentual restante, origem, instante e janelas conhecidas; o leitor escolhe entre automático e manual |
| `runs/<runId>.json` | Estado da vaga, cliente e início/fim; lançamentos de processos também registram PID e resultado |
| `runs/<runId>.out` | Stdout/stderr do lançador de processos quando não há outra pasta de logs |
| `locks/config.lock/owner.json`, `inbox.json.lock/owner.json`, `orders.json.lock/owner.json`, `templates.json.lock/owner.json`, `runs.lock/owner.json` | Dono do lock de escrita, PID e instante; arquivos claim temporários coordenam recuperação |
| `daemon.lock/owner.json` | Lock exclusivo do loop do daemon |
| `daemon.pid.json`, `daemon.paused`, `daemon.stop` | Dono do loop e controles persistidos de pausa/parada |
| `logs/<date>.jsonl` | Decisões do daemon e remoções por retenção |
| `logs/smoke/smoke-<runId>.jsonl`, `logs/smoke/smoke-<runId>.log` | Eventos e relatório legível do cenário no cliente |
| `claude-statusline.original` | Backup da barra antes do registro consentido |
| `autostart/okit-daemon.cron`, `logs/daemon.out` | Plano cron e saída do daemon nesse plano |

<a id="installation"></a>
## Fora da raiz de estado

O destino padrão dos payloads é XDG_DATA_HOME/okit-plugin ou ~/.local/share/okit-plugin no Linux; ~/Library/Application Support/okit-plugin no macOS; LOCALAPPDATA/okit-plugin ou ~/AppData/Local/okit-plugin no Windows. install.destination substitui esse destino.
Nele, install.<client>.json guarda payload atual, checksum, anterior, link, autostart e barra; install.json é o registro legado. <version>-<client>/ guarda o código; managed-path.json registra somente alterações de PATH gerenciadas. O link padrão fica em ~/.local/bin ou ~/AppData/Local/bin no Windows; configuração pode substituir a pasta. Hooks, skills e blocos de papel ficam nas [raízes dos clientes](adapters.pt-BR.md).
Autostart também registra ~/.config/systemd/user/okit-daemon.service, ~/Library/LaunchAgents/com.okit.daemon.plist ou uma tarefa Windows, conforme plataforma e plano.

<a id="integrity"></a>
## Integridade e remoção

Escritas JSON usam arquivo temporário, sincronização e rename; locks usam diretórios com dono e recuperação de processo morto. Arquivo ausente admite fallback, JSON inválido não vira configuração vazia silenciosamente. Não remova locks de um processo ativo. Consulte `okit-plugin env report` para localizar o estado efetivo e `okit-plugin config show` para ler ajustes.
Update conserva estado. Uninstall conserva estado por padrão; --purge --yes exige ausência de outros clientes e apaga a raiz. Faça cópia antes de apagar histórico.

<a id="measurements"></a>
## Medições opcionais de uso

Use telemetry on/off para gravar, rede on/off para enviar, export [--since ISO] para exportar, check para conferir e status para ver pasta, tamanho e última exportação. Nada é registrado por padrão. Somente contagens, durações, estados, nomes de ajudantes e resumo irreversível do projeto ficam em arquivos OTLP/JSON gravados de forma indivisível; prompts, conteúdo de arquivos, texto de demandas e caminhos são descartados. Arquivos são removidos por idade e tamanho total. Com kit configurado, destino local e retenção são reaproveitados salvo ajuste próprio. O envio ocorre somente ao exportar com ativação separada, inclui somente contagens agrupadas e exige HTTPS (HTTP somente para localhost). Endereços e cabeçalhos nunca aparecem nos registros.

[Visão geral](README.pt-BR.md) · [Configuração](configuration.pt-BR.md) · [English](state.md)
