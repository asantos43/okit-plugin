---
name: okit-config
description: Use for /okit-config, open the configuration page, or settings page.
---

# Configuration page

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

Call `config_ui_open` in Claude Code, Codex or opencode. Pass `locale` only for a one-call language choice (en or pt-BR). The default `open: true` asks the OS to open a browser; use `open: false` when only a link is wanted. Return the URL to the Producer even when browser opening cannot be confirmed.

The token URL is a secret: show it only in this session; never write it to a file or the inbox. An existing page is reused. It closes on idle (the returned idleMinutes), with the session, or via Close. Opening the page does not save settings.

In Claude Code invoke `/okit-plugin:okit-config`; Codex and opencode use `/okit-config`. If the tool is unavailable on an older install, ask the Producer to run `okit-plugin config ui` in a terminal; never run that foreground command through the agent shell.

- Actors: enable actors and choose model, effort and turn limits.
- Accounts: manage account labels, folders and login guidance.
- Limits and quota: adjust concurrency and allowance settings.
- Language: choose the saved interface language.
- Profiles: review client profile settings.
- Telemetry: review optional local measurements and sending settings.
- Task list: configure task synchronization.
- Other: settings groups added by future versions.
