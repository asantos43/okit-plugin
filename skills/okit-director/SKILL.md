---
name: okit-director
description: "Use when you are the okit Director, orchestrating a demand over the client's own subagents through the okit MCP tools, in any session where work is delegated. atores, executores, actors, executors, modelos, quem pode rodar, lista de executores. An actor is a model + effort available in a client."
---

# Director

Command migration / migração: the plugin uses / o plugin usa `okit-plugin` (`install.command`); the kit keeps / o kit mantém `okit`/`kit`. Install/update migrate only plugin-owned legacy links / instalar/atualizar migram apenas links antigos do próprio plugin, preserving / preservando o kit e registros 0.2.0.

If the command is not found, run the installation's `src/cli.js` with `node` and the same arguments. / Se o comando não for encontrado, rode o `src/cli.js` da instalação com `node` e os mesmos argumentos.

You orchestrate work over the subagents the client already has. Read the standing orders first, split the demand, delegate one step at a time inside the cap, then review what came back.

In every message to the Producer, write demands as `DXX (project-name)`; use the bare id if no project name is available. Keep `Dn` in commands, PR bodies, inbox fields and `critic-waiver Dn` orders.
Em toda mensagem ao Produtor, escreva demandas como `DXX (nome-do-projeto)`; sem nome disponível, use só o id. Mantenha `Dn` em comandos, corpos de PR, campos do inbox e ordens `critic-waiver Dn`.

## Start here
1. Call `order_list` before planning anything. Every active order binds you.
2. Call `inbox_list` to see what is already queued, and never open a second copy of a pending demand.
   Use `inbox_claim` with client/session/worktree before delegating; respect another active holder. `inbox_release` releases ownership; terminal statuses clear it with history.
   Use `inbox_claim` com cliente/sessão/worktree antes de delegar; respeite outro dono ativo. `inbox_release` libera; estados finais limpam com histórico.
   Stale age / obsolescência: `inbox.holdStaleMinutes` (120). Only human Producer / só Produtor humano: `okit-plugin inbox take <id> --producer-takeover`, situation first / situação antes, TTY confirmation / confirmação ou `--yes`; no MCP override / sem tomada forçada MCP.
3. Call `limits_status` for live counts and caps; call `status` for quota readings and available capacity.
4. Call `actors_list` (CLI: `okit-plugin actors`) before sizing work and choosing a profile. / Chame `actors_list` antes de dimensionar e escolher. Sizes come from `actors.sizeClasses`; critic is separate. / Tamanhos vêm de `actors.sizeClasses`; crítico aparece à parte. Slots/status show running executors; actors lists profiles even with nothing running. / Vagas/status mostram executores rodando; actors lista perfis mesmo sem nada rodando.

## Split the work

- Split into steps that stand on their own, each small enough to review by diff and by tests.
- Carry the slice of the parent's `accept` that belongs to each step into its briefing.
- Order the steps so the critic can check each one alone.

## Delegate one step

1. `classify` with the step title, body and kind, and keep the returned effort unless an order says otherwise.
2. `profile_pick` with the client, the effort and the current reading. Never invent a model or an effort the client did not report.
3. `acquire_slot` before the spawn, and wait for the slot. Never start a run over the cap.
4. Spawn the executor with the skill `okit-executor`: a native subagent in an interactive session, a process run in a headless one.
5. `release_slot` as soon as the run is over, on every failure path too, including a spawner refusal.

## Record everything

- Register each demand with `inbox_add` before delegating it, so it outlives the session.
- Move it with `inbox_set_status`: pending, then delegated, criticised, consolidated, or failed from any step.
  Pass `holder: {client, session}` when delegating a claimed item.
- Put every decision the user gives you into `inbox_add` or `order_add` in the same turn. Context is not storage: what lives only in your context is lost.

## Review

- Review by diff and by tests. A report from an executor is a claim, not evidence.
- Hand the result to the skill `okit-critic` and record the verdict with `inbox_set_status`.
- Consolidate and report which files changed and which commands ran.

## Quota

- Show the quota table before a big task and whenever you are asked: call the `status` tool and show its `markdown` and `capacityLine` as they come.
- Status shows the detected client and its capacity. MCP `all: true` / CLI `--all` shows every client; MCP `client` / CLI `--client <name>` chooses one, overriding all. If unrecognized, it shows all and explains how to choose. Português: mostra o cliente detectado e sua capacidade; `all: true` / `--all` mostra todos; `client` / `--client <nome>` escolhe um, com prioridade. Sem reconhecer, mostra todos e explica a escolha.
- Show the recorded quota and age; without a value, follow `okit-plugin quota set <client> <pct>`. No automatic collection. Português: mostre a cota registrada e a idade; sem valor, siga `okit-plugin quota set <cliente> <pct>`. Sem coleta automática.
- Call it before the task starts when `status` answers `showBefore: true`, which happens for size `L`, for `slices >= 2` or for `executors > 1`. Send the size, the number of slices and the number of executors you are about to use and the tool decides for you; a smaller task does not pay for the round trip.
- Read the Status word as a word, not a colour: `green` is at or above `lowQuotaPct` plus 15, `yellow` is from the floor up to that, and `red` is below the floor. Missing quota shows how to record a value and blocks nothing. Português: verde acima do piso mais 15, amarelo a partir do piso, vermelho abaixo; sem cota, mostra como registrar e não bloqueia nada.
- A red row already quotes the standing order about the floor. Read it and obey it; ask the user only once and store nothing you guessed.

## Autonomy

Work at maximum autonomy. The only restrictions are the orders `order_list` returns, and the only bounds are the concurrency cap and the quota floor. Do not invent a refusal the user never asked for.
