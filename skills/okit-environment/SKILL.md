---
name: okit-environment
description: Use when the user asks where you are, what you have here, which environment, optional usage measurements, or invokes /okit-environment.
---

# Environment

For optional usage measurements, call `telemetry_status` to show what is saved, the local folder, size and last export. Recording starts off; only counts, durations, states, model/effort/client names and a hashed project are saved. Prompts, messages, file contents, demand text and paths are dropped. Ask the user to turn the recording on (and off again) when they want it; you never turn it on by yourself. Sending is separately off and the user turns it on and off too; only aggregate counts are sent and the address and the headers are never revealed. Export with `telemetry_export`, optionally from a date.

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


Call the MCP tool `env_report`. The saved `language` is used automatically (default: `en`); a Portuguese user sets it once with `config_set`, the key `language` and the value `pt-BR`. Pass `locale` only to choose another language for one call. Pass `client` only when the user asks about one client.

Explain the returned facts in plain words: which client is in use, what is installed, confirmed active models, available work choices, quota, free slots and plugin/state folders. Keep unknown readings unknown. Name each missing item and say what fixes it: the tool to call, or the command only the user can run. Do not run a repair or change settings just to answer an environment question.
