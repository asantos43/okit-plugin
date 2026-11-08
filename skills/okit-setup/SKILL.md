---
name: okit-setup
description: Use when the user invokes /okit-setup or asks to configure the plugin's models through a conversation, showing what will be written before anything is saved.
---

# Setup

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


Run the setup the plugin already has. Never choose a model by hand, never edit the configuration file and never write an individual setting yourself.

- Detect and ask first: ask the user to run `okit-plugin setup` once and read what it reports — the installed clients, the model it proposes for each work class and why. It shows the complete proposal and writes nothing until the final confirmation, so a refused run changes nothing. You never run it yourself: the setup is the person's step.
- Explain the proposal in plain words: which client, which work class, which model and why that one.
- Ask only what was not detected. A detected model is a fact: report it, do not ask about it.
- When the user wants a model of their own, give that model as the answer to the setup's own model question; `setup` has no option that takes a model as an argument. Never write a setting yourself with `config_set`: the setup writes the whole set at once.
- Save only through the setup's final confirmation, after the user has seen and accepted the complete proposal. The setup writes the complete set once; a refusal leaves everything unchanged.
- When the setup says the configuration file is not readable, tell the user that and read the settings with `config_get` to see what is wrong. Write nothing yourself and do not ask for models: the setup cannot run until the configuration is readable.
- Finish by saying what was written: the client, the work class and the model of every saved choice, and that the setup is done. If the user refused, say that nothing was changed.
