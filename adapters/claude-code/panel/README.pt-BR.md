# Painel opcional do Claude Code

[English](README.md)

O mod desenha o schema 1 de `okit-plugin panel-state --json --client claude`.
A entrada é o export nomeado `register` em `register.js`. Depois de carregado
pelo host de mods, o painel **okit plugin** abre automaticamente ao iniciar a sessão.
Defina `panel.autoOpen` como `false` no `config.json` da raiz de estado para desligar;
`/okit-panel` continua abrindo ou fechando. O ajuste vem do campo `panel.autoOpen`
do mesmo comando `panel-state`.
A instalação é opcional e não foi ligada ao instalador padrão; D120 cuida do
empacotamento. O núcleo funciona sem esta pasta.

O cabeçalho mostra `okit plugin · claude · N accounts · ready: yes|no`, com prontidão
do comando. Os blocos são **ACCOUNTS**, **RUNNING**, **RECENT**, **LAUNCHABLE NOW**
e **Readiness**, com a linha e os avisos existentes ao final. Contas mostram só
aliases, marcador running/idle, barras de sessão (5 h) e semana, percentual restante,
reset local em 24 h e tempo até ele (`4h35m` ou `1d 21h`).
Colunas alinham entre contas; resets a mais de 24 h incluem o dia da semana.
`!` marca menos de 20% restante. `null` aparece como `unknown`; zero como `0% left`.
Execuções live não antigas mostram conta, demanda quando salva, modelo, esforço,
duração e último progresso. Recent inclui concluídas, falhas, antigas e status
desconhecidos, com duração e motivo de erro quando salvo. Contas sem cadastro
aparecem como `unknown account`; suas execuções não pertencem a outra conta.
Launchable lista aliases para simple/normal/hard/critic pelas classes de `launchable[]`.
Documentos antigos sem classes não identificam quais classes podem ser lançadas.
Etapa, aprovação e término por cota não existem nos registros e são omitidos.
Comando ausente, saída não zero, JSON inválido ou schema
desconhecido produzem mensagens. O desenho usa somente o cache.

RUNNING e RECENT mostram cada um 20 execuções mais recentes e a contagem restante.
Execuções ilegíveis são puladas com uma contagem; textos opcionais inválidos
viram `unknown` ou `-`. Prontidão, avisos e progresso ocupam até três linhas
pela largura em células, com reticências no corte. Percentuais são arredondados
e limitados a 0–100.

Only non-object runs are skipped. Any string status is preserved, including
future statuses; null or non-string statuses display as `unknown`.

O relógio usa 3 segundos, com mínimo de 2 segundos e sem leituras simultâneas
na mesma geração. Cada leitura tem timeout próprio de 15 segundos; resultados
atrasados são ignorados e o próximo tick pode tentar novamente. Reabrir inicia
uma leitura imediatamente e mostra `Loading state…` enquanto aguarda.
O comando de fechamento cancela o timer; fechamento manual é detectado no
próximo tick, antes de iniciar outro processo. Resultados pendentes são
descartados ao fechar ou reiniciar a sessão. O comando recebe argumentos em
array, timeout de 5 segundos e limite de 1 MiB; a saída UTF-8 também é conferida
depois da leitura. O mod não usa shell, rede, arquivos ou credenciais.

## Origem e compatibilidade da API

Origem: **orchestration-kit, commit `3451493`**, referência somente para leitura
em `.delegate/reference/task-board/`. Foram adaptados `hooks/frame.ts`
(largura, corte, molduras), `hooks/panel.ts` (parser e falhas), `hooks/panels.tsx`
(cache, registro, proteção contra sobreposição), `hooks/logic.ts` (`elapsed`,
`formatHm`, escala de barras) e o esqueleto de registro, relógio cancelável e
consulta de painéis de `hooks/register.tsx`. Nenhuma lógica específica do kit
foi copiada. A referência ignorada não faz parte do produto.

**Versão testada da API de mods do Claude Code: indisponível / não verificada.**
O README e `types/index.d.ts` fornecidos não registram versão numérica do host
ou da API; os tipos apenas ampliam o estado do kit. O `types.d.ts` local define
o contrato sintético dos testes, não os tipos oficiais.
Registration captures each handler's `$` in closures. A temporary host probe
confirmed global `h` in JavaScript and Box/Text from `$.ui.resolve(e)` with
`surface: 'terminal'`; the runner exited without a test report. Director verification
of `process.run` with `maxOutputBytes` remains pending.
A conferência após a leitura não garante sozinha um limite de memória no host.

## Verificações focadas

Nenhuma dependência foi adicionada. JavaScript com JSDoc roda diretamente em
`node --test`. `tsc -p adapters/claude-code/panel/tsconfig.json` verifica somente
o mod com um executável TypeScript disponível; o repositório não tem essa
dependência de desenvolvimento. Os testes são `test/panel-mod.test.js` e
`test/panel-isolation.test.js`. Foram portados casos genéricos de formatadores,
molduras, parser, falhas de comando, registro e desenho com cache dos três
arquivos de testes da referência. Casos específicos do kit foram omitidos.
Uma sessão real do mod no Claude Code e sua API continuam sem verificação.
