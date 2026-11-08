---
name: okit-smoke
description: Use for /okit-smoke, show a demonstration, run a real test, or to narrate the plugin's smoke checks and report.
---

# Smoke

## Question routing

| Question | Skill → tool |
| :- | :- |
| Where are you? | `okit-environment` → `env_report` |
| Open settings | `okit-config` → `config_ui_open` |
| Which actors/helpers? | `okit-director` → `actors_list`; running executors → `status` |
| How much quota? | `okit-environment` → `env_report`; detail → `quota_show` or `status` |
| What is missing? | `okit-environment` → `env_report`; explicitly requested setup → `okit-setup` → ask the user to run `okit-plugin setup`, with its own confirmation |
| What is your role? | Delivered `okit-director`, `okit-executor`, `okit-critic` + `order_list`, `inbox_list`, `actors_list`, `limits_status`, `env_report` |
| Run smoke/demonstration | `okit-smoke` → `smoke_demo`; explicit allowance consent |

Actor = model + effort; executor = briefed role; class = work category; size = S/M/L; slot = room for simultaneous executors; profile = saved choice; quota = remaining allowance; source = origin and sample age.
Producer synonyms: available executor, worker, helper, agent, model, work choice; complexity; small/medium/large task; preset; usage left, remaining limit; reading, sample. Capacity = quota and free slots separately.
Environment questions are read-only: never save configuration, launch work or spend quota. Use readable titles, never demand/order ids in answers.


Drive the existing runner; do not reimplement the scenario or judge success from model prose.

For “show a demonstration” or “run a real test”, use this flow in every client:
1. Call `smoke_demo` with `dryRun: true`. Use the saved `language` (default: `en`); set Portuguese once with `config_set`, the key `language` and the value `pt-BR`. Pass `locale` only for a one-call change. Show titles, chosen helpers, current allowance/source/age, total/per-task cost ceilings, corrections and time/call limits. This preview spends no allowance.
2. Ask “This practice run uses your allowance, up to the displayed total. May I start?” Wait for an explicit answer; a demo request alone is not spending consent.
3. Only after approval, pass the preview's `planHash` as `confirm` to `smoke_demo`, preserving client and language. Never approve automatically. Changed work, helpers, settings or allowance require a new preview and confirmation.
4. Narrate the returned events in order: preparation, choice of helpers, available places, work, checks, correction, stop and cleanup. Use ordinary sentences and work titles; hide identifiers, tool names and internal codes.
5. Finish with what the files actually proved, skipped work and its reason, cleanup and the exit code. A preview proves no execution. Without measured usage and an enforceable cost ceiling, report refusal; never substitute a model launch.

The demo runs inside the kit: the tool answers with the events, the helpers it chose and the measurements it took. You never run a command of your own, and the checks of the installation are the person's work: ask the user to run `okit-plugin doctor`.
