# D94 — Output inventory

![okit-plugin: Maintainers](../images/banners/maintainers.svg)

Steps 1–2 only: evidence and proposals for Producer review. No implementation or machine-contract approval is implied. See [target mock-ups](OUTPUT-MOCKUPS.md) and [Português](OUTPUT-REVIEW.pt-BR.md).

<a id="contents"></a>
## Contents

- [1. Method and principles](#section-1)
- [2. setup](#section-2)
- [3. doctor](#section-3)
- [4. install](#section-4)
- [5. update](#section-5)
- [6. uninstall](#section-6)
- [7. MCP replies](#section-7)
- [8. Decisions for the Producer](#section-8)

<a id="section-1"></a>
## 1. Method and principles

Reviewed at `54df496` on Linux, Node v22.23.1. Every capture used a new `mktemp -d` HOME, USERPROFILE and OKWORK_HOME; no real home configuration was used. Executables remained discoverable through PATH. Thus an empty HOME does **not** mean no clients are installed.

Reproduce each command with `task_home=$(mktemp -d)` followed by `HOME="$task_home" USERPROFILE="$task_home" XDG_CONFIG_HOME="$task_home/config" OKWORK_HOME="$task_home/state" node src/cli.js <command> --locale en`; repeat with `pt-BR`. Use a fresh directory per invocation. `</dev/null` captures noninteractive refusals. `setup --defaults` captures model proposals; a terminal captures questions and answer echo. `install --client codex --dry-run` attempts release metadata access even in simulation; this environment could not fetch it.

Excerpts below are verbatim, trimmed at line/field boundaries unless explicitly marked as source templates. Volatile paths/timestamps are omitted by choosing excerpts without them. Source-only branches are distinguished from executed states; they are not claimed as reproduced. MCP captures call `callTool(TOOLS, ctx, name, args)` from the real modules with temporary root and `ctx.env={HOME:process.env.HOME,PATH:''}`; transport sockets and external clients are unnecessary. This intentionally tests absent executables, not an invalid client identifier.

Principles: **L** one language, using the CLI locale rule (`--locale`, valid `OKIT_LANGUAGE`, saved language, English default); **S** title and short summary first; **D** tables contain data, advice below; **N** empty/missing states give the exact next command/tool call; **H** each hint/reason once; **W** plain words or a one-line meaning for jargon; **Q** short questions with visible options; **M** preserve JSON, protocol flags and exit codes. A source template is evidence of wording, not a new executable command.

Problems use stable global IDs P1–P32; translated documents use identical sections and IDs. Counts: setup 8, doctor 4, install 4, update 2, uninstall 2, MCP replies 12. D92 improvements (locale, shared presenter, numbered steps, de-duplicated global notes) are retained; only remaining defects are listed for its three commands.

<a id="section-2"></a>
## 2. setup

Writers: `src/cli.js:runSetupCommand` prints `runSetup().messages`; `src/setup/setup.js` owns `SETUP_MESSAGES`, `askModel`, `confirmSetup`, `setupReader` and save/refusal messages. `src/setup/offer.js` owns installation offers (standalone bilingual fallback; presenter path localized). `src/setup/autostart-step.js:setupAutostart` prints the optional final step through `TEXTS` in `src/install/present.js`.

Executed `setup --defaults --locale en` (selected lines; exit 0):

```text
claude-code (simple): use haiku. No model-listing command is configured for claude-code, so the built-in catalog is used.
claude-code (normal): use sonnet. No model-listing command is configured for claude-code, so the built-in catalog is used.
claude-code (hard): use opus. No model-listing command is configured for claude-code, so the built-in catalog is used.
Saved 6 model settings for claude-code, opencode.
```

Executed terminal question (ANSI cursor controls omitted; terminal echoed `gpt-6.1-sol` before the next prompt):

```text
Choose a model for codex: small, straightforward tasks. Options: gpt-6-astra, gpt-6.1-sol, gpt-6.1-terra, gpt-6-sol, gpt-6-luna, gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna, gpt-5.5. Recommended: gpt-6-astra, an available assistant for this work. [gpt-6-astra]
```

Executed EOF/cancel state in both locales (exit 0): `Setup was cancelled and nothing was saved.` / `O setup foi cancelado e nada foi salvo.` These are separate runs, not one bilingual run.

Source-only templates: `Everything was already configured; nothing changed.`; `No client with an active model was found; install or activate one and run the setup again.`; `Configure now? [S/n] Recommended: yes, review the detected choices together.`; `Start the daemon with this machine using {kind}.`; `Install autostart? [y/N]`.

Remaining output families: proposal per client/class; omitted model with `config_set` key; missing quota per saved client; save/count, nothing saved, concurrent newer values kept; invalid model/retry, confirmation/retry, exhausted attempts, unknown client/class, invalid profiles/value, unreadable configuration, failed write with folder/retry; offer pending/declined/failed/unreadable; autostart already installed, explanation/path/consent, declined/later, installed/uninstall, no usable plan, install failure, rollback or prior service retained. All originate in the writers above. Help, locale/flag/config refusals and outer errors pass through `src/cli.js:main`, `enter`, `refuse`, `usageOf` and `localizeReason`.

Setup findings:

- **P1 — L:** historical English-then-Portuguese output remains possible through module defaults `locale='both'` and bilingual reason strings. Explicit CLI locales were single-language; do not describe the historical bilingual CLI paragraph as reproduced.
- **P2 — Q/S:** model question embeds purpose, nine options, recommendation and justification in one long line; confirmation starts with the question before its multiline choices. The demand's buried question is still a scanning problem, although the bilingual paragraph was not reproduced.
- **P3 — H:** the exact catalog reason repeats for simple, normal and hard (three times per client), as captured above.
- **P4 — Q:** readline/terminal echo places the answer on the prompt line, with cursor redraw sequences. Treat rendering separately from application-generated duplicate output.
- **P5 — S:** no title; save summary comes after proposals and quota advice. Ready/cancelled/none are unframed sentences.
- **P6 — N:** no-active-model and cancelled states omit a literal retry command; already-ready state gives no verification command.
- **P7 — W/Q:** class, effort, catalog and daemon/systemd/cron vocabulary lacks a short meaning. The standalone English offer shows Portuguese `[S/n]`.
- **P8 — H/N:** omitted-model and quota remedies repeat per class/client; model repair describes arguments in prose instead of a complete call. Several refusal/autostart-failure states have no exact recovery command.

<a id="section-3"></a>
## 3. doctor

Writer: `src/doctor/command.js:doctorCommand`; check rows and fixes in `src/doctor/diagnose.js:diagnose`; labels, details and summary in `src/install/present.js:TEXTS` (`doctor*`, `selfcheck*`, `control*`). Captured `doctor --locale en` with empty HOME (exit 1), selected lines:

```text
okit-plugin doctor: the state of the installation
      Installation                failed   no installation record was found
      Configuration               ok       not created yet
      Session                     warn     no okit server is running: it starts with a client session; this is normal when no client is open
      Daemon                      warn     not running
                                  failed   1 failed, 2 to look at
```

Captured pt-BR ending: `falhou   1 falharam, 2 para olhar`. The missing-installation Fix names the current Node executable and this checkout's `src/cli.js install`; it does not select a client. Other source-only row families: Node minimum unknown/old; valid/missing/unreadable installation records; registration absent/foreign/broken/disabled/wrong executable/missing executable or server; readable/absent/invalid/unreadable configuration, inbox and orders; session ok/none/connection failure; autostart ok/missing/extra/optional/unknown script; daemon running/down; installed self-check version/command/PATH/hook/status bar/quota/MCP/control failures. `--verbose` includes quiet rows; each failed/warned row with a `fix` prints it immediately underneath. All-ok summary template: `everything looks right ({count} checks)`.

- **P9 — S:** summary is the last padded row, so the reader must scan the whole diagnosis before knowing severity.
- **P10 — D/N:** missing configuration, inbox and orders say `ok not created yet` without the action to create/use each; warnings such as daemon down can lack a Fix. Advice is interleaved with data rows.
- **P11 — W:** MCP, daemon, hook, PATH and JSON/entry details have no short meaning; implementation details dominate several fixes.
- **P12 — W/N:** `1 falharam` is ungrammatical; `2 to look at` is vague. Missing-install Fix omits `--client`, yielding a second question or a noninteractive refusal.

<a id="section-4"></a>
## 4. install

Writers for install/update/uninstall: `src/cli.js:installerCommand` delegates to the installer; `src/install/present.js:createPresenter`, `TEXTS`, `localizeReason`, `finishLink`, `summary`, `failure` are the shared presentation boundary. `src/profiles.js:CONFIG_MESSAGES` supplies setting refusals. `src/setup/offer.js` and autostart/status-bar/model consent use this presenter. Embedded copies in `install.sh`/`install.ps1` are generated by `src/release/install-scripts.js`; no edits are proposed to generated files here.

Executed plain install in each locale (exit 2), trimmed:

```text
Which client do you want to install for?
  1. claude-code (found)
  2. codex (found)
  3. opencode (found)
Refused: Without a terminal to ask in, choose a client with --client.
      Next: check the options and try again
```

Executed `install --client codex --dry-run --locale en`, trimmed: `Failed at Download and verify: Release/download request failed: https://api.github.com/repos/asantos43/okit-plugin/releases/latest: fetch failed`; `Next: check the options and try again`; `Dry run: nothing was changed.` This is a failed network-dependent preview, not evidence of a successful installation.

Source-only complete family map: header/package/client/system; client picker/all/non-TTY; download/local source/checksum/pre-release; backup/files/register/link/quota/self-check and rollback step marks; registration missing/module/manual/foreign/ambiguous/repaired/failure; PATH conflicts/manual/profile/shim warnings; model and quota-recording offers; PowerShell policy explanation/consent/undo/group policy/failure; kit present/absent/broken/ignored; dry-run completion; success next-terminal/restart/status; refusals, step failures and retained-version retry. Quiet details require `--verbose`. Shared setting errors cover language, limits, todo, smoke, quota source/readings, status bar, client folders, shell, install rules and inbox integers; template `Invalid install.{key}: {rule}` is localized but technical. Source templates: `Done. Next: ...`; `kit: absent. {hint}`; `not found. {hint}`; `MCP server registered in {client}`.

- **P13 — S:** header identifies package/platform but no short outcome/plan line; refusals can start without a title. Success next steps form one long numbered line.
- **P14 — N:** generic `Next: check the options and try again` omits a concrete invocation, especially for no client and download failure.
- **P15 — W/D:** PATH, SHA-256, MCP, hook, module/skills and service names need concise meanings. Long recovery prose is placed in aligned step/detail columns.
- **P16 — N/H:** optional kit absence points at documentation rather than a concrete safe next action; missing command/registration has prose-dependent recovery. Models/quota/startup advice can recur in separate stages despite D92 global-note deduplication.

<a id="section-5"></a>
## 5. update

Same shared writers as §4. Executed `update --locale en` and `pt-BR` with separate empty homes, exit 2:

```text
Refused: No installation record found
      Next: check the options and try again
```

Portuguese capture: `Recusado: Nenhuma instalação encontrada` / `O que fazer: confira as opções e tente de novo`. Source-only states: `Up to date`, `New version available`, download/checksum/backup/install/register/self-check, retained-version rollback (`Restore previous version`), daemon stop/restart, model/quota/PATH/kit notes and common failure/refusal/simulation/success (§4). No successful remote update is claimed.

- **P17 — S/N:** missing-install refusal has no title/summary or exact install command; “try again” cannot create the missing record.
- **P18 — W/D:** up-to-date/new-version and rollback reuse technical step rows; distinguish the result from optional follow-up advice below the data. D92 locale and steps already work; do not redesign their machine behavior.

<a id="section-6"></a>
## 6. uninstall

Same shared writers as §4. Executed `uninstall --locale en` and `pt-BR` with separate empty homes, exit 2: the exact refusal and next line are identical to §5 in each language. Source-only states: stop process, restore quota recording settings, unregister client/MCP (removed/kept/manual/failed), unlink command/PATH (removed/shared/foreign), remove files (keep settings/purge), edited module/skill kept, autostart rollback/kept/error, simulation and common errors. Templates: `{path} (your settings are kept)`; `{command} kept for the other client`.

- **P19 — S/N:** already-absent case says refused and gives a retry with no useful command. Keep current exit 2; wording must distinguish “nothing removed” from a failed removal.
- **P20 — W/N:** retained settings, edited files and command shared with another client need a clear post-removal summary and an exact verification/reinstall command. Existing step details do not give one consistent ending.

<a id="section-7"></a>
## 7. MCP replies

Boundary: `src/mcp/tools.js:TOOLS` (5 explicit tools) plus `src/mcp/registry-tools.js:toolsFromRegistry` and `src/core/operations.js` (24 registry tools): **29 published names**. Each handler JSON-stringifies its result; `src/mcp/call-tool.js:callTool` returns `{text,isError}` and passes thrown messages through. `src/mcp/server.js:toolResult` wraps it as MCP text content. Rendered prose/Markdown lives inside JSON fields; replacing the whole reply with a mock-up would change a machine contract.

### 7.1 Main views — executed excerpts

`status {}` → `markdown` (selected lines) and `capacityLine`, with no client argument or session marker:

```text
| Subscription | 5h remaining | Week remaining | Resets in | Status | Source (age) |
| claude-code | - | - | - | not installed (optional) | - |
Client not recognized. Showing all clients; pass the `client` argument to choose one.
Slots show running executors; actors lists available model + effort profiles, even when nothing is running.
executors that can launch now: ; quota floor 15%
```

`actors_list {}` → `markdown` (selected lines):

```text
| Client | Model | Effort | Sizes / role | Free slots | Quota | Can launch | Reason / remedy |
| --- | --- | --- | --- | --- | --- | --- | --- |
Client not recognized. Showing all clients; pass the `client` argument to choose one.
claude-code: not installed (optional).
```

Both were also executed with saved `language=pt-BR`: translated headings/notes, same false notice and empty capacity phrase. Existing demand status values such as `pending` stay wire enums inside the table. Sources: `src/status.js:statusTable`, `src/env/quota.js:LABELS,rowOf`, `src/actors.js:listActors`, `src/profiles.js:actors.messages`, `src/core/status-operations.js`.

### 7.2 Complete tool coverage

Executed calls use `{}` unless specified. Fragments are exact JSON fields or literal error text; runtime IDs, times and paths are trimmed. Success/missing/refused families not executed are marked **source**. All share P28/P31/P32 at the boundary; more specific findings follow the table.

| Tool | Current output excerpt / output families | Handler source |
| --- | --- | --- |
| `status` | §7.1; quota/demand tables, capacity, warnings, missing models; optional `showBefore` | `src/core/status-operations.js:statusOperation` |
| `actors_list` | §7.1; rows/notes/gaps/missing remedies, low quota/busy/nearest alternative (**source**) | `src/core/status-operations.js:actorsListOperation` |
| `quota_show` | `"reading":{"source":"manual"}`; per-client readings and `now`, unknown client refusal | `src/core/quota.js:quotaShow` |
| `quota_set` | `quota_set: client must be a non-empty string`; saved pct/value/snapshot (**source**) | `src/core/quota.js:quotaSet` |
| `quota_notice` | `"available":false,"released":false`; unavailable text below; released subscription notice (**source**) | `src/quota/released.js:quotaReleasedNotice` |
| `limits_status` | `"live":0,"byClient":{}`; caps/default source/warnings | `src/core/limits-operations.js:limitsStatusOperation` |
| `acquire_slot` | `{client:"codex",runId:"review"}` → `{"ok":true,"runId":"review","client":"codex"}`; busy caps (**source**); no args: `acquire_slot: runId must be a non-empty string` | `src/core/limits-operations.js:acquireSlotOperation` |
| `release_slot` | `{runId:"review"}` → `{"ok":true,"runId":"review"}`; no args: `release_slot: runId must be a non-empty string` | `src/core/limits-operations.js:releaseSlotOperation` |
| `env_report` | `Command available in PATH: no.`; `Configured: none confirmed.`; folders/collector/models/install advice | `src/core/status-operations.js:envReportOperation` |
| `kit_detect` | `{"state":"absent","path":null,"version":null,"message":"kit: absent. See INSTALL.md#orchestration-kit for kit installation instructions."}`; present/broken (**source**) | `src/core/kit.js:kitDetect` |
| `daemon` | `{action:"status"}` → `{"running":false,"pid":null,"startedAt":null,"paused":false,"lastTick":null}`; pause/resume/tick (**source**) | `src/core/daemon.js:daemonOperation` |
| `config_get` | `"path":"language","value":"en","origin":"default"`; bilingual descriptions; unknown key (**source**) | `src/core/config.js:configGet` |
| `config_set` | `config_set: key must be a non-empty string`; `{key:"language",value:"pt-BR"}` → `"removedAliases":[]`; previous/after/origin/description; removal/refusals (**source**) | `src/core/config.js:configSet` |
| `classify` | `{title:"Review output"}` → `{"effort":"normal","reasons":["default: no rule matched, so normal"]}`; matched-rule reasons (**source**) | `src/core/profile-operations.js:classifyOperation` |
| `profile_pick` | `{client:"codex",effort:"normal"}` → `{"model":"gpt-5-codex","effort":"medium","maxTurns":40}`; low-quota fallback/refusal (**source**) | `src/core/profile-operations.js:profilePickOperation` |
| `inbox_add` | `inbox_add: title must be a non-empty string`; `{title:"Output review"}` → `"status":"pending","stepIds":[]` | `src/core/inbox-operations.js:inboxAddOperation` |
| `inbox_list` | `[]`; populated items/hold descriptions/filter/limit (**source**) | `src/core/inbox-operations.js:inboxListOperation` |
| `inbox_claim` | `inbox_claim: client must be a non-empty string`; owned/conflict/stale/missing (**source**) | `src/core/inbox-operations.js:inboxClaimOperation` |
| `inbox_release` | `inbox_release: client must be a non-empty string`; released/not owned/missing (**source**) | `src/core/inbox-operations.js:inboxReleaseOperation` |
| `inbox_set_status` | `inbox_set_status: id must be a non-empty string`; transitions/ownership refusal/missing (**source**) | `src/core/inbox-operations.js:inboxSetStatusOperation` |
| `order_add` | `order_add: text must be a non-empty string`; `{text:"Review outputs"}` → `"scope":"all","origin":"maintainer"` | `src/core/orders-operations.js:orderAddOperation` |
| `order_list` | `[]`; active instructions/expiry/project filtering (**source**) | `src/core/orders-operations.js:orderListOperation` |
| `order_remove` | `order_remove: id must be a non-empty string`; revoked/missing (**source**) | `src/core/orders-operations.js:orderRemoveOperation` |
| `trajectory_show` | `{run:"missing"}` → `ENOENT: no such file or directory, stat` (prefix); saved run steps (**source**) | `src/mcp/tools.js` → `src/trajectory/index.js:show` |
| `telemetry_status` | `"enabled":false,"network":false`; `what` bilingual, folder/size/last export | `src/mcp/tools.js` → `src/telemetry/index.js:telemetryStatus` |
| `telemetry_export` | `{"count":0,"resourceMetrics":[],"network":{"count":0,"statusCode":null}}`; since/export/network consent (**source**) | `src/mcp/tools.js` → `src/telemetry/index.js:exportTelemetry` |
| `todo_check` | `{"reports":[]}`; tasks without demands and demands without tasks (**source**) | `src/core/todo.js:todoCheck` |
| `todo_sync` | `{"reports":[],"dryRun":false,"check":false}`; preview/confirmed links/sync errors (**source**) | `src/mcp/tools.js` → `src/todo/index.js:todoRun` |
| `smoke_demo` | `{dryRun:true}` → `"status":"preview","exitCode":0,"confirmed":false`; bilingual plan/scenario; confirmation/run/budget/errors (**source**) | `src/mcp/tools.js` → `src/smoke/demo/entry.js:smokeDemo` |

Executed `quota_notice {}` text: `The quota-back notice is not available yet. Update the kit to get it; until then, ask for the quota table whenever you want to check.` Executed telemetry `what` starts `Records only counts, durations, states, role, model and app names, effort settings and an anonymous project reference; no messages, files or work text. Sending requires separate consent. / Registra somente contagens, durações, estados, nomes de papel, modelo e aplicativo, ajustes de esforço e uma referência anônima ao projeto; sem mensagens, arquivos ou textos de trabalho. O envio exige uma escolha separada.`

All invalid-argument paths use core argument helpers (required text/number/choice/type/extra key), with raw English messages unless a handler explicitly localizes. `callTool` does not add recovery instructions. Unknown tool names throw `unknown tool ${name}` outside its catch; the server returns protocol `Invalid params: ...`. Server parse/invalid-request/method-not-found errors and startup stderr (`okit mcp server: ...`) are transport diagnostics, not human view mock-ups. `src/mcp/control*.js` expose connection/authorization/timeouts; `selfcheck-probe.js` emits a machine JSON result (codes mapped by the presenter), not another user command. Registry-tool descriptions join English and Portuguese; actor English description in `src/profiles.js` itself contains both languages.

### 7.3 Problems

- **P21 — W/N:** `status {}` and `actors_list {}` falsely say “Client not recognized” when none was supplied/detected. Say that all clients are shown, with a concrete optional selection call.
- **P22 — S/W:** cryptic capacity line mixes running/limit/available/source/floor; with no installed clients it becomes an empty phrase. Explain slots and quota threshold separately; do not infer executor availability from percentages.
- **P23 — D/H:** `rowOf` puts a full quota-recording instruction in the Status cell; low-quota orders also become table text. Shared view hints always print. Move advice below data, once per distinct action.
- **P24 — N/W:** `quota_show` missing readings are source-only objects with no percentage/meaning/recovery; timestamps/reset durations and unknown freshness need plain labels. A missing reading is not zero quota.
- **P25 — S/W/D:** actors table is eight columns wide, lacks title/summary and compresses quota into `green; ...; age ...`. Explain actor = model plus reasoning effort in a client; move remedies out of cells.
- **P26 — S/N/W:** `limits_status`, acquire/release success/busy replies expose cap/run objects without a user summary; explain slot = one simultaneous executor, and give a safe next call for busy/empty.
- **P27 — N/W:** `kit: absent` offers a document anchor, no immediate command; quota notice says “update the kit” without an exact command. Kit and plugin are different packages; do not invent a kit installer or substitute plugin update.
- **P28 — L:** telemetry `what`, config descriptions, demo plan and tool descriptions are bilingual/English regardless of the human-view locale; demand status enums and classify reasons also surface English in pt-BR. Preserve data values while selecting/translating the human view.
- **P29 — N/S:** `[]`, empty reports/metrics, absent daemon and missing trajectory lack a titled explanation and usable next call. Raw ENOENT/path is a technical error, not recovery advice.
- **P30 — N/H/W:** environment report is a list of internal observations and scattered “Missing” instructions (including hard-coded default-client repair). It needs a summary and one action per real cause.
- **P31 — L/N:** English argument exceptions pass through `callTool` without localization or a valid example. Some core refusals return objects rather than `isError:true`; preserve that distinction.
- **P32 — M:** JSON text includes both structured data and display fields (`markdown`, `capacityLine`, `text`, `message`, descriptions). Changing text, adding fields, or replacing JSON affects consumers; human mock-ups cannot silently authorize wire changes.

<a id="section-8"></a>
## 8. Decisions for the Producer

1. **Wording and vocabulary:** approve titles, “Ready / Needs attention”, “reasoning effort”, “background service” and neutral no-client wording. Recommend short terms with a one-line meaning; preserve exact identifiers in calls.
2. **Table or list:** approve tables for status/quota/actors/slots data; lists for fixes, prompts, empty states and install steps. Recommend the five-column actors view in the mock-ups; retain full detail for assistant data consumers.
3. **Machine format:** approve whether prose is rendered by the assistant from unchanged objects or added/changed in tool text fields. Recommend unchanged JSON/exit codes/protocol flags now; schedule explicit compatibility review before any serialized-text change. No format changes approved here.
4. **Empty and optional states:** approve safe retry/check commands, no-install exit-2 wording and kit guidance. Recommend `doctor`/`kit_detect {}` for verification and a linked kit guide; exact kit installation/update command remains unresolved until the kit owner supplies it.
5. **Historical complaints and verification:** approve retaining P1/P4 as conditional/terminal findings, not claims of a current bilingual CLI regression. Recommend later golden captures in both languages, per-view hint checks (not a ban on legitimate repeated data), no false client notice, and unchanged JSON/exit-code assertions. Tests belong to the implementation phase.
