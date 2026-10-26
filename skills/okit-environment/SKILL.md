---
name: okit-environment
description: Use when the user asks where you are, what you have here, which environment, or invokes /okit-environment. Use quando perguntar onde você está, o que você tem aqui ou qual ambiente.
---

# Environment / Ambiente

Run `okit-plugin env report` or the MCP tool `env_report`, using the user's language (`--locale en` or `--locale pt-BR`; MCP `locale`). Use optional `--client <name>` (MCP `client`) only when the user asks about one client.

If the command is not found, run `node "${CLAUDE_PLUGIN_ROOT}/src/cli.js" env report` with the same arguments.

Explain the returned facts in plain words: which client is in use, what is installed, confirmed active models, available work choices, quota, free slots and plugin/state folders. Keep unknown readings unknown. Name each missing item and quote the reported command that fixes it. Do not run a repair or change settings just to answer an environment question.

Rode `okit-plugin env report` ou a ferramenta MCP `env_report`, no idioma do usuário (`--locale en` ou `--locale pt-BR`; `locale` no MCP). Use `--client <nome>` (`client` no MCP) somente quando a pergunta for sobre um cliente.

Se o comando não for encontrado, rode `node "${CLAUDE_PLUGIN_ROOT}/src/cli.js" env report` com os mesmos argumentos.

Explique os fatos retornados em palavras simples: cliente em uso, o que está instalado, modelos ativos confirmados, opções de trabalho, cota, vagas livres e pastas do plugin e de estado. Mantenha como desconhecido o que não foi confirmado. Cite cada item que falta e o comando informado para corrigir. Não execute correções nem altere configurações só para responder sobre o ambiente.
