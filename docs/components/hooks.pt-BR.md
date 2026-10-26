# Hooks

Os hooks restauram contexto e coletam cota nos eventos do cliente.

<a id="events"></a>
## Eventos e efeitos

| Entrada | Quando dispara | Saída e gravação | Remoção |
| :- | :- | :- | :- |
| `hook-session-start.js` | SessionStart do Claude: startup, resume, clear e compact | JSON additionalContext com papel, trabalho, ordens, atores e limites; não persiste contexto (a consulta de limites ignora registros obsoletos) | uninstall remove o comando exato de settings.json; update retira o comando do caminho anterior |
| `hook-post-compact.js` | SessionStart com matcher compact no Claude; evento session.compacted pela ponte opencode | Resumo por projeto da fila e ordens no stdout, com limite de linhas/tempo; não grava estado e falha silenciosamente | postCompact.enabled=false desativa; retire só a entrada correspondente de hooks/hooks.json ou remova o plugin; opencode remove só o wrapper pertencente à instalação |
| `statusline-collector.js` | Cada atualização da barra do Claude, após registro consentido | Atualiza quota/claude-code.json atomicamente quando há cota válida; executa a barra anterior com a mesma entrada e preserva sua saída | uninstall restaura a barra original; --no-statusline recusa o registro durante instalação/atualização |

<a id="ownership"></a>
## Registro e preservação

A instalação registra SessionStart em settings.json. O payload Claude inclui hooks/hooks.json para pós-compactação; o instalador opencode escreve um wrapper em plugins/okit-plugin.js. Codex não recebe hooks pelo adaptador.
O coletor requer --statusline ou confirmação em terminal. Sem terminal e sem flag, o registro é pulado. O backup fica no estado do plugin; desinstalar restaura bytes originais se intactos, ou somente o campo anterior se outros ajustes mudaram.
A execução direta de `okit-plugin statusline-collector` não registra a barra. Entrada sem cota mantém a amostra anterior; falhas do comando anterior não interrompem o cliente.

<a id="try"></a>
## Conferir

Passe JSON com cwd no stdin de `okit-plugin hook post-compact`: espere resumo só se houver trabalho/ordens aplicáveis. `okit-plugin hook session-start` aceita o mesmo JSON e devolve contexto de papel ou diagnóstico. São entradas internas usadas pelo cliente.

[Visão geral](README.pt-BR.md) · [Adaptadores](adapters.pt-BR.md) · [English](hooks.md)
