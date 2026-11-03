# D94 — Target output mock-ups

![okit-plugin: Maintainers](../images/banners/maintainers.svg)

**Proposal awaiting Producer approval.** These documents implement no behavior. See the [inventory and P1–P32](OUTPUT-REVIEW.md) and [Português](OUTPUT-MOCKUPS.pt-BR.md).

<a id="contents"></a>
## Contents

- [1. Reading these proposals](#section-1)
- [2. setup](#section-2)
- [3. doctor](#section-3)
- [4. install](#section-4)
- [5. update](#section-5)
- [6. uninstall](#section-6)
- [7. MCP replies](#section-7)
- [8. Decisions for the Producer](#section-8)

<a id="section-1"></a>
## 1. Reading these proposals

Each fenced block is one English output/state. The pt-BR companion has identical section and scenario numbers. Commands use the default executable `okit-plugin`; substitute the configured executable consistently. Names, versions, percentages and counts are illustrative observations, never promised defaults or inferred capacity. `MCP name {JSON}` below means “ask the assistant to call this tool with these arguments”; it is not shell syntax and does not restore CLI commands removed by D99.

CLI locale selection stays unchanged: explicit `--locale`, valid `OKIT_LANGUAGE`, saved language, English default. Technical identifiers in commands remain unchanged. All MCP blocks are proposed **human views**, rendered from data, not replacements for serialized replies; see decision 3. Never translate JSON keys/enums or change `--json`, protocol errors, `isError` or exits here. A missing number is “not recorded”, never zero. Observed capacity comes from slots, not quota percentage.

Questions put their options on separate lines before a short answer prompt. Examples show the prompt and the next output on separate lines, without transcribing terminal input; line breaks/echo handling need implementation-phase validation. Tables hold data only; explanations and next actions follow them. Each distinct hint appears once per run. A healthy state offers an optional exact check, not a mandatory repair.

<a id="section-2"></a>
## 2. setup

### 2.1 First run — model choice and confirmation (P2–P5, P7–P8)

```text
okit-plugin — Setup
Choose models for Codex; nothing is saved until you confirm.

Small tasks — Codex
1. gpt-6.1-sol (recommended)
2. gpt-6-astra
Choose a model [1]:

Model choices
| Work | Model |
| --- | --- |
| Small tasks | gpt-6.1-sol |
| Everyday tasks | gpt-6.1-sol |
| Complex tasks | gpt-6-astra |

These choices apply to future work. You can change them with: okit-plugin setup --again
Save these choices? [y/N]:

Saved 3 model choices for Codex.
Next: okit-plugin doctor --client codex
```

The model picker repeats for each unresolved work class, with that client's actual available models. The three rows illustrate completed choices. Explain a shared fallback once: “The model list could not be read; these choices come from the built-in list.” Show it before the picker/confirmation, only when true. Never claim an unconfirmed model is ready.

### 2.2 Everything ready / nothing detected / cancelled (P5–P6)

```text
okit-plugin — Setup
All model choices are already saved. Nothing changed.
Check the installation: okit-plugin doctor --client codex
Change models: okit-plugin setup --again
```

```text
okit-plugin — Setup
No client with an active model was found. Nothing was saved.
Install or enable a model in your coding client, then run: okit-plugin setup
Check which clients are available: MCP env_report {"locale":"en"}
```

```text
okit-plugin — Setup
Cancelled. Nothing was saved.
Try again when ready: okit-plugin setup
```

### 2.3 Optional service and errors (P7–P8)

Source-dependent continuation, only with an installed payload: “Background service — runs waiting work while your client is closed. Start it with this machine? [y/N]:”. If declined: “Automatic start is off. To enable it later: okit-plugin setup”. If saved: “Automatic start is on. Check it: okit-plugin doctor”. Show the file path once before consent. On failure, title and summary “Automatic start could not be configured.”, one cause, then “Try again after fixing the cause: okit-plugin setup”. Keep model-save and service-save results distinct.

Invalid answer: “Choose 1 or 2.” followed by the same short picker, without accumulating prefixes. Unreadable settings: “Settings could not be read. Inspect them: MCP config_get {}”. Save failure: “Choices could not be saved. Check write permission for the settings folder, then run: okit-plugin setup”. Include the actual folder once. Concurrent values: “Newer choices were kept. Check them: MCP config_get {}”. Quota advice follows §7.2 once per affected client.

<a id="section-3"></a>
## 3. doctor

### 3.1 All checks pass / one failure and its Fix (P9–P12)

```text
okit-plugin — Installation check
Ready. All 8 checks passed.
| Check | Result |
| --- | --- |
| Installation | Ready for Codex |
| Models | 3 choices saved |
| Background service | Running |
Check again when needed: okit-plugin doctor --client codex
```

```text
okit-plugin — Installation check
Needs attention: 1 failed check; other checks passed.
| Check | Result |
| --- | --- |
| Codex connection | Not registered |
Fix: register the plugin in Codex: okit-plugin install --client codex
Then check: okit-plugin doctor --client codex
```

The full all-ok view lists each actual check; the shortened example groups quiet details. If no installation exists: “Nothing is installed for Codex. Install it: okit-plugin install --client codex”. An optional inactive service says “Automatic start is optional. Enable it: okit-plugin setup”. A closed client session says “No client session is open. Open Codex, then run: okit-plugin doctor --client codex”. Explain MCP once if that identifier appears: “MCP is the connection your assistant uses to call plugin tools.” Keep failed exits 1 and warning-only exits 0.

<a id="section-4"></a>
## 4. install

### 4.1 Installed / no client chosen / download failed (P13–P16)

```text
okit-plugin — Install
Installed for Codex. Model choices still need confirmation.
1. Download and verify: complete
2. Install files: complete
3. Connect Codex: complete
Next: okit-plugin setup
Check the installation: okit-plugin doctor --client codex
```

```text
okit-plugin — Install
Choose a coding client before installing.
1. Claude Code (found)
2. Codex (found)
3. OpenCode (found)
Choose a client [1–3, or all]:
```

Without a terminal, replace the question with “Install for Codex: okit-plugin install --client codex” (and list equivalent commands for the other offered clients). Download failure: title, “The release could not be downloaded. Nothing was installed.”, one cause, “Check your connection, then retry: okit-plugin install --client codex”. A preview says “Preview only. Nothing changed.” and gives the same non-preview invocation to apply it. List required actions once; optional kit guidance follows §7.5. Keep existing exit categories and consent defaults. Explain PATH only when relevant: “PATH is the list of folders your terminal searches for commands.”

<a id="section-5"></a>
## 5. update

### 5.1 Updated / already current / no installation (P17–P18)

```text
okit-plugin — Update
Codex is up to date. Nothing changed.
Check the installation: okit-plugin doctor --client codex
```

After a successful update use “Updated Codex from 0.2.0 to 0.3.0.”, followed by completed steps and “Next: restart Codex, then run: okit-plugin doctor --client codex”. If a retained version exists, show “Return to the retained version: okit-plugin update --rollback”. On update failure name the failed step and one cause; show rollback only if it is actually available. With no record: title, “No plugin installation was found. Nothing was updated.”, “Install first: okit-plugin install --client codex”. Preserve current exit 2 for that refusal.

<a id="section-6"></a>
## 6. uninstall

### 6.1 Removed / already absent / shared files kept (P19–P20)

```text
okit-plugin — Uninstall
Removed the plugin from Codex. Your settings were kept.
Install again when needed: okit-plugin install --client codex
```

No record: title, “No plugin installation was found. Nothing was removed.”, “Check the local state: okit-plugin doctor”. Preserve current exit 2. With another client: “Removed Codex integration. The command is kept for Claude Code.”, then “Check the remaining installation: okit-plugin doctor --client claude-code”. Show retained edited files/settings once as a list of actual paths. Purge success says “Settings were also removed.” only when true. On failure give one cause and the retry `okit-plugin uninstall --client codex`; never claim removal completed if it did not.

<a id="section-7"></a>
## 7. MCP replies

### 7.1 Status — recorded readings / no selected client (P21–P23)

```text
okit-plugin — Status
Codex: 2 executor slots available; quota is above the 15% minimum.
| Client | Remaining quota | Renews in | Reading recorded |
| --- | --- | --- | --- |
| Codex | 65% (5-hour period) | 2 hours | 1 minute ago |
| Codex | 80% (week) | 3 days | 1 minute ago |
An executor slot allows one task to run at a time. Slots are measured separately from quota.
See available models: MCP actors_list {"client":"codex","locale":"en"}
```

No selection/detection: “Showing all clients; no client was selected.”, then data for observed clients. Optional next call: `MCP status {"client":"codex","locale":"en"}`. No recognition warning. If no clients are installed, replace the empty table/capacity sentence with “No coding client was found. Install a supported client, then run: okit-plugin install --client codex”. If slots are occupied, say so even with high quota; quota alone never establishes launch capacity. Keep demand data in its own table, translating display labels without changing stored enums.

### 7.2 Quota — unknown / below minimum (P23–P24)

```text
okit-plugin — Quota
Codex has no recorded quota reading.
Quota means the percentage of your subscription allowance that remains.
Read the percentage in your client, then ask the assistant to record that value.
Example only, if 65% remains: MCP quota_set {"client":"codex","pct":65}
Check the recorded value: MCP quota_show {"client":"codex"}
```

Recorded quota uses the two data rows in §7.1 with a short “Reading recorded 1 minute ago” summary. Below minimum: “Codex has 8% remaining, below the 15% minimum. Waiting work cannot start on this subscription. Check renewal later: MCP quota_show {"client":"codex"}”. Never invent a renewal time or suggest lowering the minimum as the default fix. An old/unknown-age reading explicitly says “Reading time unknown; check your client before relying on it.”

### 7.3 Actors — available / empty / blocked (P25)

```text
okit-plugin — Available assistants
Codex: 2 model profiles available; 2 executor slots free.
| Model | Reasoning effort | Work | Can start | Remaining quota |
| --- | --- | --- | --- | --- |
| gpt-6.1-sol | Medium | Everyday tasks | Yes | 65% |
| gpt-6-astra | High | Complex tasks | Yes | 65% |
An actor is a model and its reasoning effort in one coding client.
Reasoning effort is how much thinking the model is asked to do.
Check concurrency: MCP limits_status {}
```

Empty: title, “No model profiles are ready for Codex.”, “Choose models: okit-plugin setup”, “Check again: MCP actors_list {"client":"codex","locale":"en"}”. Busy: “All executor slots are occupied. Wait for running work to finish, then check: MCP limits_status {}”. Low quota: use one shared explanation from §7.2 below the table, not per row. Unknown quota says “Not recorded” rather than a color or percentage.

### 7.4 Slots — available / busy / no running work (P26)

```text
okit-plugin — Executor slots
Codex: 2 free slots out of 3.
| Client | Running | Limit | Available |
| --- | --- | --- | --- |
| Codex | 1 | 3 | 2 |
A slot allows one executor to run at a time; quota is checked separately.
See models that can start: MCP actors_list {"client":"codex","locale":"en"}
```

No running work: “No executors are running. Available slots are shown above. Check again: MCP limits_status {}”. Busy acquisition: “No slot is available for Codex. Wait for work to finish, then retry: MCP acquire_slot {"client":"codex","runId":"review","waitMs":0}”. Success: “Reserved one Codex slot for review. When that run ends: MCP release_slot {"runId":"review"}”. Release: “The slot for review was released. Check available slots: MCP limits_status {}”. Substitute the actual run ID; do not release another live run to make space.

### 7.5 Kit, notices and other empty/error replies (P27–P31)

```text
okit-plugin — Optional orchestration kit
The kit was not found. The plugin's client tools remain available.
The kit coordinates the workflow across assistants and is a separate package.
If you need that workflow, follow INSTALL.md#orchestration-kit.
Check again after installing it: MCP kit_detect {}
```

This supplies an exact verification call. The actual kit install/update command needs its owner's confirmation (decision 4); do not invent one. With no quota-back event: “Quota renewal notice unavailable. Check the current reading: MCP quota_show {}”. With a valid event: “Your Codex quota is available again. Check work that was waiting: MCP inbox_list {}”. A notice is not a fresh numeric quota reading.

Other empty-state human views follow the same title, summary, next-call structure:

- **Inbox:** “No work is listed. Add work when needed: MCP inbox_add {"title":"Review output"}”.
- **Standing instructions:** “No standing instructions are active. Add one when needed: MCP order_add {"text":"Explain results briefly"}”.
- **Task sync:** “No task-sync projects are configured. Inspect project settings: MCP config_get {"key":"todo.projects"}”.
- **Telemetry/export:** “No measurements are saved. See what would be recorded: MCP telemetry_status {}”. Preserve consent and do not enable collection automatically.
- **Trajectory:** “No saved run named review was found. Confirm a saved run name, then retry with that name: MCP trajectory_show {"run":"review"}”. `review` is a syntax example, not an assertion that a saved run exists.
- **Environment:** “Setup is incomplete for Codex. Choose models: okit-plugin setup”. If registration is also absent, add `okit-plugin install --client codex` once before setup.
- **Settings/refusal:** “A setting name is required. Example: MCP config_get {"key":"language"}”. For a missing config_set key: “Choose the setting to change. Example: MCP config_set {"key":"language","value":"en"}”. Keep raw errors in machine diagnostics.
- **Demo preview/classification/profile:** title plus “Preview only; no work started”, “Everyday task”, or “Selected model for everyday work”. Exact next checks: `MCP smoke_demo {"dryRun":true,"locale":"en"}`, `MCP classify {"title":"Review output"}`, `MCP profile_pick {"client":"codex","effort":"normal"}` respectively. Show a demo launch only after existing confirmation requirements are met.
- **Background service:** “Not running. Configure automatic start: okit-plugin setup”. Do not fabricate a person-facing daemon command.

<a id="section-8"></a>
## 8. Decisions for the Producer

1. **Wording:** approve the proposed titles, short summaries, model questions and meanings for actor/slot/quota/service. Recommend these terms, with one shared explanation per view; retain actual client/model names and exact command identifiers.
2. **Table or list:** approve the five-column actors table and four-column status/slots tables; recommend lists for install steps, fixes and empty states. Keep detailed structured observations available to the assistant.
3. **Machine format:** choose assistant rendering of existing objects or changes to serialized display fields. Recommend rendering from unchanged JSON for now; any later `markdown`, `text`, `message`, `capacityLine`, schema or envelope change needs an explicit compatibility decision. No CLI JSON or exit changes are proposed.
4. **Kit and absent states:** approve verification-first kit advice and current exit-2 wording for absent update/uninstall. Recommend the exact `kit_detect {}` check and linked kit guide; the owner must supply an install/update command before a direct kit action is promised.
5. **Interaction and validation:** approve numbered model options and one prompt per work class, with no answer copied into application text. Recommend implementation-phase terminal checks, English/pt-BR golden outputs, unique-hint checks and machine-contract assertions. These documents do not authorize implementation.
