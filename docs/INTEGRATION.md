# Integration design

[Português](INTEGRATION.pt-BR.md) · [Architecture](ARCHITECTURE.md)

## 1. Scope and history

- 2026-10-26: steps 2–4 implemented, including whole-flow integration and bilingual routing.

The plugin should feel part of Claude Code, Codex and opencode. People ask ordinary questions; client instructions route them to the shared facts. “To do” below means proposed behavior, not shipped behavior. This design extends the existing `src/env/`; it does not introduce a second `src/environment` source.

## 2. One environment model

Implemented in steps 2–4: `src/env/snapshot.js` produces one read-only snapshot per request, shared by CLI, MCP, status, actors, quota display, setup diagnostics, PATH notices and smoke preflight. No consumer detects the environment itself. Adapter readers and collectors provide observations to `src/env`; they do not become competing reports. Setup remains responsible for saving approved choices; quota collection and slot acquisition remain explicit operations.

| Field | Meaning and evidence |
| :- | :- |
| Current client | Session markers, or unknown; installation alone never proves a session. |
| Installed clients | Per-client presence, version, evidence and failure reason; absent differs from unknown. |
| Models and actors | Confirmed active models; client + model + effort, supported S/M/L sizes, review eligibility and launch restrictions. Catalog candidates remain separate from confirmed access. |
| Quota per client | Remaining windows, renewal, provider when known, automatic/manual source, sample time, read time and age; unknown remains unknown. Cache age is not sample age. |
| Slots | Per-client total, running, free and limit origin, from the same slot reading; quota percentages never determine concurrency. |
| Paths | Plugin, state and client configuration folders, command location and current PATH availability, with evidence. |
| Configuration | Saved choices, effective profiles and origins, missing clients/models/sizes/setup/PATH, reasons and next actions. |

Environment, filesystem, runners, clock, configuration, quota readers and slot counts are injectable. Reuse observations within a request; invalidate relevant observations after an explicit change. Keep unknown values and errors visible. Formatting translates the same snapshot without rereading the machine; selection and policy consume it without recursive calls back from `src/env` into status or actors.

The snapshot exposes confirmed `models` and `actors`, alongside configured `candidates` with explicit confirmation and launch restrictions. Unknown quota, an explicit expiry or sample age above `staleMinutes` blocks launch. Sample and observation times remain separate. Setup requests model observations without unrelated version/PATH probes; confirmation and writes stay in setup.

## 3. Gap analysis

| Existing file:function | Already answers | Gap / to do |
| :- | :- | :- |
| `src/env/report.js:environmentReadings`, `environmentVersions` | Plugin/state context, PATH observation and executable versions. | Done: env combines version/model evidence and exposes client configuration paths. |
| `src/env/report.js:environmentReport`, `formatEnvironmentReport` | In-use/installed clients, confirmed active models, model+effort actors and sizes, quota row, free slots, configured/missing items and repair commands in both languages. | Done: formats the env snapshot without calling status or actors; quota source/age are translated from the same sample. |
| `src/status.js:detectClient`, `statusTable`, `readingWithAge`, `rowOf`, `setupPendingLine` | Session selection, quota caching/windows/age/status, slot arithmetic and pending setup. | Done: consumes env observations and derivations, preserving session selection and inbox display. |
| `src/actors.js:listActors` (MCP `actors_list`) | Merges configured model+effort pairs, sizes and review class; calculates slots and launch reasons from status. | Done: candidates carry explicit confirmation, shared sizes and launch restrictions; unknown or expired quota blocks launch. |
| `src/cli.js:quotaCommand`; `src/status.js:adapterQuotaReader` | Quota show reads adapters separately; set writes a manual sample. | Done: show consumes env; set writes and refreshes the snapshot, preserving client-specific source precedence. |
| `adapters/claude-code/index.js:readQuota`; `src/quota/statusline-collector.js:collectStatusline` | Reads stored manual/automatic quota; collector records status bar input. | Retain collection at the edge; env owns the normalized observation. |
| `adapters/codex/index.js:readQuota`; `adapters/codex/session-quota.js:readCodexSessionQuota` | Recent local session quota, newer-sample precedence and manual fallback. | Preserve source and sample age through all views. |
| `adapters/opencode/index.js:readQuota`; `adapters/opencode/quota-source.js:readOpencodeSource` | Configured provider command/file readings with manual fallback. | Preserve provider, age and fallback reason in the snapshot; never infer quota from cost. |
| `src/setup/detect.js:detectClients`, `proposeProfiles`; `src/setup/setup.js:runSetup`; `src/profiles.js:configOf`, `setupPending` | Independently discovers clients/models, proposes profiles and saves confirmed configuration. | Done: env owns observations and proposals; setup retains confirmation and writes. Defaults never confirm account access. |
| `src/install/link.js:binInPath`, `activationWarning`; `src/cli.js` | Independently checks current PATH for activation notices. | Done: env owns PATH evidence; notices retain the existing repair guidance. |
| `src/smoke/client.js:runScenario`; `src/smoke/client-checks.js:judge`; `src/smoke/checks-install.js:versionMatches` | Reads quota/age and local context; judges status and installation evidence. | Done: consume env for preflight; retain smoke-specific budgets, expiry and refusal rules. Real scenario currently supports Claude Code only. |
| `src/mcp/tools.js:envReportTool.handler`; role skills | MCP assembles readings/limits; Director, Executor and Critic instructions exist. | Done: snapshot wiring, native role delivery and complete bilingual role answers; no new role tool. |

## 4. Client adapters

One adapter per client, with `capabilities`, `listModels`, `readQuota`, `spawn`, `installSkill`, `installHooks`, configuration-root resolution and the shared `deliverRole`, `installRole`, `removeRole` contract. `src/roles.js` composes role, briefing, applicable orders/limits, readable work titles, actors and unknown facts from the supplied env snapshot. Delivery returns `ready`, `clarification` or `unsupported`; it never substitutes a role. Actor model+effort stays independent.

| Client | Native delivery target | Existing bridge and remaining work |
| :- | :- | :- |
| Claude Code | SessionStart hook and Agent briefing. | Managed settings entry and packaged hook inject bilingual context on startup/resume/clear/compact. `hook session-start` reads core state and one env snapshot. Briefed Agent/process prompts carry Executor/Critic and preserve actor model+effort. Removal matches only the owned hook entry. |
| Codex | Managed AGENTS.md block and native prompt/profile. | Main instructions default to Director; explicit briefed prompts take precedence without changing model+effort or user TOML. Installation/removal changes only the delimited block. A shadowing AGENTS.override.md is explicitly unsupported. Hook installation still refuses. |
| opencode | Native plugin config hook, agents and command. | Config hook supplies Director to primary agents, preserving their prompt, default selection, model and variant; adds the okit-director agent and okit command. Managed command block is removable. Briefed PROCESS prompts carry Executor/Critic; Task delegation remains unsupported. |

Adapter fixtures establish these formats, not real-client smoke acceptance or support for every version. `nativeSupported: false`, malformed managed blocks/settings, shadowed Codex instructions and conflicting opencode agent names return explicit unsupported results. The installer reports Windows native delivery as unsupported; no silent fallback. User instructions survive repeated installation/removal.

## 5. Role layer

Implemented: the main session receives Director by default through native instructions. Briefings must contain one explicit `Role: Executor` / `Role: Critic` (or `Papel:`) header, or a structured `role` field. Missing, conflicting or invalid roles require clarification before work. Model+effort is the actor, not the role. Native delivery supplies the same contract in all clients; skills describe behavior, env supplies environment facts and core supplies work/orders. Questions remain read-only.

| Role | May do | Must not do |
| :- | :- | :- |
| Director | Understand the request, record work and applicable instructions, choose actors within quota/slot limits, delegate and consolidate evidence. | Invent capacity, evade orders or claim unverified success. |
| Executor | Carry out the briefed step within its directory, scope and limits; verify and report evidence. | Expand scope or publish/merge without authorization in the briefing. |
| Critic | Inspect the diff and acceptance evidence; return pass, revise or reject with concrete findings. | Treat an executor's report as proof or silently expand the assignment. |

“What is your role?” answers: current role; allowed and forbidden actions; applicable orders and limits; work in hand by readable title; available actors, quota/slot restrictions and unknown facts. The three role skills compose the answer from delivered context and the shared snapshot, refreshing with `inbox_list`, `order_list`, `actors_list`, `limits_status` and `env_report`. No unified role-answer tool exists or is needed. Missing facts remain explicitly unknown.

User-facing example: “I am the Director. I organize your work, choose available helpers and check their results. I must respect your instructions and cannot publish without authorization. I am preparing the integration guide. I can list the available models and how much room each client has.” Generate actual work, limits and actors from evidence. Use ordinary words and readable work titles; no demand or order identifiers in user-facing usage text. Missing role context is reported, never guessed as a briefed assignment.

## 6. Shared glossary

Implemented in the six skills: use this vocabulary in all six role/environment/setup/smoke skills, tool descriptions in `src/mcp/tools.js` and messages in `src/profiles.js`, status and env. Synonyms help route a question; they do not erase the distinctions below. The Producer is the person requesting and authorizing work.

| Term | Meaning | Producer synonyms (English / Português) |
| :- | :- | :- |
| Actor / ator | Model + effort available in a client, independent of a running job or role. | actor, model, work choice, available executor / ator, modelo, opção de trabalho, executor disponível |
| Executor | A role carrying out a briefing; a running executor occupies a slot. | executor, worker, helper, agent / executor, trabalhador, ajudante, agente |
| Class / classe | Configured work category selecting a profile: simple, normal, hard; review class is configured separately. | class, work category, complexity / classe, categoria de trabalho, complexidade |
| Size / tamanho | Work size S/M/L, mapped by configuration to a class; not a model name or a role. | size, small/medium/large task / tamanho, tarefa pequena/média/grande |
| Slot / vaga | Room for one simultaneous executor, limited per client. | slot, free room, concurrency / vaga, espaço livre, concorrência |
| Profile / perfil | Saved model+effort choice for a client/class, with execution settings where supported. | profile, model choice, preset / perfil, escolha de modelo, predefinição |
| Quota / cota | Remaining allowance reported for a client/window, not slot count, tokens spent or monetary cost. | quota, allowance, usage left, remaining limit / cota, saldo, uso restante, limite restante |
| Source / fonte | Where a fact came from; quota distinguishes automatic/manual and may identify a provider. Age says how old its sample is. | source, origin, reading, sample / fonte, origem, leitura, amostra |

“Which executors do I have?” means available actors unless the person asks who is running; then use status/slots. “How much capacity?” needs both quota and free slots, stated separately. Never translate a percentage into an executor count.

## 7. Question routing

| User question (English / Português) | Skill → existing tool or command | Remaining work |
| :- | :- | :- |
| Where are you? / Onde você está? | `okit-environment` → `env_report` or `okit-plugin env report` | Done: shared read-only snapshot. |
| Which actors/helpers? / Quais atores/ajudantes? | `okit-director` → `actors_list` or `okit-plugin actors`; running work → `status` | Done: shared confirmed/configured facts and Producer synonyms in all six skills. |
| How much quota? / Quanta cota? | `okit-environment` → `env_report`; quota detail → `okit-plugin quota show` or `status` | Done: explicit quota routing and shared source/age. No quota-show MCP tool exists. |
| What is missing? / O que falta? | `okit-environment` → `env_report`; requested configuration → `okit-setup` → `okit-plugin setup` | Done: read-only diagnosis; setup saves only after confirmation. |
| What is your role? / Qual o seu papel? | Delivered `okit-director`, `okit-executor` or `okit-critic` context + `order_list`, `inbox_list`, `actors_list`, `limits_status`, `env_report` | Done in step 3: bilingual composition, readable titles, explicit unknowns and no role tool. |
| Run the demonstration / Rodar a demonstração | `okit-smoke` → `okit-plugin client-smoke --client claude-code --demo` | Real run requires the existing quota-spend confirmation; otherwise `--dry-run`. Other clients' real demonstrations are to do. |

## 8. Steps 2–4 and acceptance

Steps 2–4 are complete. `test/env-flow.test.js` exercises all three adapters with temporary HOME, injected clock/quota/slots and fake clients. `test/skills.test.js` checks the same bilingual routing map and glossary in all six skills.

| Step | Files to change | Acceptance |
| :- | :- | :- |
| 2 — One source | `src/env/report.js`, `src/status.js`, `src/actors.js`, `src/profiles.js`, `src/cli.js`, `src/mcp/tools.js`, `src/setup/detect.js`, `src/setup/setup.js`, `src/install/link.js`, adapter quota readers; `test/env-report.test.js` | Done: env owns observations and derivations; status/actors/quota/setup/PATH consume them. No dependency cycle. For the same injected snapshot, client, models, source/age, slot counts and missing items agree; confirmed access and configured candidates remain explicit. Each external probe runs once per request. |
| 3 — Role delivery (done) | `src/roles.js`, `src/hook-session-start.js`, `src/install/role-block.js`, installer registration/client plugin, release hook wiring; the three adapters and role skills; `test/roles.test.js` and the three adapter tests | Native fixtures prove main-session Director and explicit Executor/Critic, preserved user instructions/configuration, model+effort, bilingual complete answers, clarification/unsupported results and read-only questions. Unsupported formats remain explicit limitations; whole flow is covered in step 4; real-client smoke stays separate. |
| 4 — Whole flow and routing (done) | `test/env-flow.test.js`, `test/env-report.test.js`, `test/docs-consistency.test.js`, `test/docs-links.test.js`, `src/smoke/client.js`, `src/smoke/client-checks.js`, `src/smoke/checks-install.js`, all six `skills/okit-*/SKILL.md` named in this design | Temporary HOME and fake clients exercise discovery → missing setup → confirmed setup → env/status/actors/quota agreement → role answer → offline demonstration. Inject time/quota/slots and isolate client/state paths; no real account, home or network. Routing covers both languages. Fake-client success is not evidence of a real-client smoke pass. |

| Must pass | Must refuse or report unknown |
| :- | :- |
| Recognized session with confirmed models; automatic and manual quota with sample ages; merged actor sizes; separate free slots. | Missing executable, failed listing or catalog-only fallback must not claim confirmed models. |
| Each role receives only its briefing and applicable orders; user files survive installation. | Ambiguous briefed role and unsupported hook/Task delivery must not be silently accepted. |
| Ordinary questions route to read-only facts; explicitly requested setup reaches its own confirmation. | An environment question must not save configuration, launch work or spend quota. |
| Smoke uses the same observed quota as env with its own documented safety thresholds. | Expired/unknown quota must not authorize real smoke without its existing explicit override; low quota follows its refusal rule. |

Step 4 is done: whole-flow routing, smoke preflight and hermetic offline coverage. The minimal C1 demonstration presents injected actors and correctly reports incomplete installation checks when run alone; it is not a full smoke pass. Real-client demonstrations and D55 orchestration remain outside this step. Launch callers provide an explicit role header; ambiguous briefings refuse before spawning.

Native format references: [Claude SessionStart](https://code.claude.com/docs/en/hooks), [Codex instructions](https://learn.chatgpt.com/docs/agent-configuration/agents-md), [opencode agents](https://opencode.ai/docs/agents/) and [plugin config hooks](https://opencode.ai/docs/plugins/).
