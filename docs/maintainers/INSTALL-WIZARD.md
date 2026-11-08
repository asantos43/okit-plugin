# Installation wizard — D144

![okit-plugin: Maintainers](../images/banners/maintainers.svg)

Design only; the routes and flags below are proposed, not shipped behavior.

Equivalent text: [Português](INSTALL-WIZARD.pt-BR.md). Current modules: [ARCHITECTURE](ARCHITECTURE.md).

<a id="contents"></a>
## Contents

- [1. Entry points and bootstrap](#section-1)
- [2. Shared execution architecture](#section-2)
- [3. States, screens and reruns](#section-3)
- [4. Security and lifecycle](#section-4)
- [5. No-browser operation, accessibility and language](#section-5)
- [6. Acceptance and tests for implementation slices](#section-6)
- [7. Independently mergeable implementation demands](#section-7)
- [8. Risks and owner decisions](#section-8)

<a id="section-1"></a>
## 1. Entry points and bootstrap

The main installer is the first-run flow of `okit-plugin config ui`: one Node server,
page, token, label catalog and models/effort/accounts screens. No desktop wrapper.
Installation rules remain in `src/install`; the browser submits choices and renders results.

| Entry | Decided behavior |
| --- | --- |
| Linux/macOS download | Run `sh install.sh`; default: verify/download package, check requirements, open wizard. |
| Alternative shell installer | `sh install.sh --terminal`; same Node installer and tested terminal presenter. |
| Force browser | `sh install.sh --ui`; never silently switch to terminal. |
| Windows download | Run `powershell.exe -NoProfile -File .\install.ps1`; only bootstrap and wizard, no terminal wizard. |
| Extracted, verified package | `node src/cli.js install --ui --from .`; run from the extracted package directory. |
| Installed command | `okit-plugin install --ui`; `okit-plugin config ui` exposes first-run when installation/setup is incomplete. |
| Existing CLI automation | Preserve current install flags/terminal behavior; do not turn unattended invocations into a browser launch. |

`--ui` and `--terminal` are mutually exclusive. `--headless` means `--ui` without
opening a browser; it conflicts with `--terminal`. Scripts forward locale and destination.

- Node minimum is currently **20**, derived from `pkg.engines.node` by `scriptDefaults()` in `src/release/install-scripts.js`; retain that source of truth.
- Missing Node: localized `Node required: https://nodejs.org/`, exit 2, no download/listener/install writes. Old Node: required/actual versions, exit 2. Install Node and rerun; no automatic runtime installation.
- Require at least one executable among `claude`, `codex`, `opencode` (Claude's internal ID is `claude-code`). None found: installation guidance, exit 2, no plugin changes. Detection does not imply login or model availability.
- Check supported OS/architecture and writable temporary/destination directories. Current Unix acquisition needs curl/wget and tar; Windows uses PowerShell download and `Expand-Archive`. Both verify SHA-256 in embedded Node with `createHash`; no external hash utility is required. Report missing tools before download.
- Download package plus release checksum manifest; require one unambiguous SHA-256 entry and a match before extraction/execution. SHA-256 detects altered bytes; it does not authenticate the publisher.
- Offline extracted packages skip network tools. A local `--from` package is user-trusted; do not label it checksum-verified without manifest evidence.
- `renderInstallScripts()` / `writeInstallScripts()` generate both scripts. Wrappers retain acquisition, integrity, preflight and launch; Node retains registration, PATH, setup, panel and self-check.
- Current embedded Node bootstrap asks for a client: remove those questions from Windows and Unix UI bootstrap. Select a detected client deterministically for the client-specific bootstrap asset (explicit `--client`, otherwise configured client order); fetch/verify additional selected assets before Apply. Audit shared UI availability in slice 1.
- Hold extracted bootstrap files until the server/config session closes; clean temporary downloads on failure and exit. No wrapper elevation or execution-policy bypass.

<a id="section-2"></a>
## 2. Shared execution architecture

| Current surface | Reuse / required extension |
| --- | --- |
| `src/install/index.js: installerCommand(command, args, ctx, io)` | Keep orchestration; inject `io.ui`, `read`/`ask`, filesystem/process adapters. Extract common plan/apply boundaries for both presenters; do not scrape terminal text. |
| `src/install/present.js` | Reuse `planSteps`, `finish`, `finishLink`, `resolveLocale`, `localizeReason`, `redact`. Structured presenter implements `sequence`, rows, questions and outcomes; keep `createPresenter` for terminal. |
| Existing install calls | Preserve acquisition, placement/backup, registration/MCP/status bar ownership, `verifyInstall`, update smoke proof and exit classification. Emit typed warnings and recovery guidance. |
| `src/install/link.js` | Reuse `chooseLinkDirectory`, `linkPlan`, `applyLink`, `managePath`, `activationMessage`; extend plan with exact profile blocks and Windows user PATH before/after. Textual dry-run alone is insufficient. |
| `src/setup/setup.js` | Reuse `runSetup`, `initializeDetectedConfig`, validation, locked save and `setup.done.profiles`. Separate observation/proposal from automatic writes before browser integration. |
| `src/setup/detect.js`, `src/setup/offer.js` | Reuse `detectClients`/`proposeProfiles` and pending/offer semantics; browser answers replace `ask`, not model rules. |
| `src/setup/autostart-step.js: setupAutostart` | Optional; preview OS registration/files and request consent; never implicit. |
| `src/install/panel.js` | Reuse `offerPanel` eligibility and `panelCommand`; explicit optional Claude-only offer after successful registration. |
| `src/install/index.js: kitRow`, `kitLine` | Keep `detectKit` read-only, report installed/absent/broken and overlap; never install/update kit. Expose structured row without duplicating detection. |

Extend `startConfigServer` in `src/config-ui/server.js`, `renderPage` in `page.js`,
`clientMain` in `client.js`, `buildState` in `state.js`, and `labels` in `labels.js`.
Reuse `openConfigSession` in `session.js`; its current root map covers one MCP process,
not separate CLI processes. Add a per-state-root install lock across processes.

Choose **polling**, not SSE: existing authenticated fetch supports `x-okit-token`;
native EventSource would encourage putting tokens into more URLs. No dependency needed.

| Proposed route | Contract |
| --- | --- |
| `POST /api/install/plan` | Typed operation/client/account/options; return read-only dry-run, `planId`, input fingerprints and proposed changes. Never accept shell commands or arbitrary file bodies. |
| `POST /api/install/apply` | Accept `planId`, explicit consent and idempotency key. Recheck fingerprints under lock; stale plan = 409/review again. Same key returns same job; competing job = 409. |
| `GET /api/install/job?after=N` | Poll each second while active; job state, ordered events `{seq, stage, client, status, messageKey, params}`, pending typed question and final result. Bound history; old cursor gets a full snapshot. |
| `POST /api/install/answer` | Job/question ID plus schema-validated answer; stale/duplicate answers cannot apply twice. A write question carries its own preview and consent. |
| `POST /api/install/cancel` | Request stop between safe steps; never interrupt atomic write/registration midway. Return completed/remaining steps; cancellation is not rollback. |

Use the same Node plan for terminal `--dry-run` and browser review. Plan enumerates
destination/payload replacement, backups, client registration commands, MCP/status bar,
shims, profile blocks/user PATH, config keys, policy/autostart and ownership conflicts.
Show paths, redacted before/after diffs, overwrite/skip decisions and recovery limits.
Fingerprint affected inputs and selected release/checksum; changed inputs require a fresh
preview. Downloads/extraction may use disposable staging before consent; installation,
profiles and configuration may not change. Do not claim current dry-run already provides this.

<a id="section-3"></a>
## 3. States, screens and reruns

`detect → requirements → review → applying → models → panel → accounts → reload → result → config`
Any pre-apply choice change invalidates review. Applying can end in failed/cancelled;
return to detection/review for retry, never replay writes on page load.

| Screen/state | User-visible contract |
| --- | --- |
| Client choice | Detected clients, executable/version, selected accounts; allow multiple installed clients. Missing selected client blocks Apply. |
| Requirements | Node/platform/tools/permissions, blocking failures and exact remediation. Read-only detection; model listing deadline retains existing 5-second server default. |
| Review | Dry-run checklist and exact changes; optional PATH/status bar/policy/autostart choices; explicit Apply, no default consent. |
| Progress | Per-client stages, warnings, current question, safe cancel; self-check and update smoke proof outcomes. Do not equate process exit alone with complete setup. |
| Models and effort | Existing config controls and confirmed-model rules; proposals from setup detection. `runSetup` stays the save/confirmation owner; add typed proposal/effort input to the shared flow. Preview and confirm once before its locked save. |
| Optional panel | Claude only, after registration; show plugin command/scope before `panelCommand`. Skip preserves successful base install. |
| Accounts | Reuse current account screens/routes, folder uniqueness and login launcher. Preview add/remove/rename/registration; login launches the native client, never collects credentials in-page. |
| PATH/reload | Applied/declined changes, `activationMessage`, open-new-terminal and restart-client instructions. Browser cannot alter its parent terminal environment. |
| Result and next steps | Per-client success/warning/failure, setup pending, self-check, kit row, recovery commands; Continue opens normal config tabs in this session. |

- Current `installerCommand` offers panel inside `runClient` before setup. Shared orchestration must defer that offer and automatic `initializeDetectedConfig` writes to the reviewed screens above; terminal keeps equivalent consent and behavior.
- Persist no token or browser draft. Reload with the live token reconnects to the in-memory job/snapshot; retain the same active page instance for the job. A second tab offers takeover of that view, without launching another install.
- Server/process restart: rediscover installation records and `setup.done.profiles`; no automatic continuation of half-finished writes. Rebuild plan and ask consent. Completed core steps are checked/idempotent; incomplete registration gets repair guidance.
- Already installed: **Update** uses `installerCommand('update', ...)`, preserving backup/smoke/rollback guidance; **Repair** reruns install for the recorded/current version via `--from` or pinned verified asset; **Change models** calls shared `runSetup` with `again: true`, without reinstalling payload.
- Failure in one client preserves successful clients and reports partial success. Setup or panel skipped/failed remains explicit; installation success never fabricates `setup.done`.

<a id="section-4"></a>
## 4. Security and lifecycle

| Existing config UI contract | Wizard decision |
| --- | --- |
| `listen(0, '127.0.0.1')`; 32 random bytes, hex token | Reuse random loopback port/token. No configurable public bind or LAN access. |
| `authorize()` checks exact `127.0.0.1:port` / `localhost:port` Host and matching allowed Origin | Reuse on every wizard route, including progress. No wildcard CORS; reject foreign/`null` origins and DNS-rebinding hosts. |
| Token on root GET URL or `x-okit-token`; timing-safe comparison | Keep URL token for initial page only, header for all APIs. Missing token = 403. No cookie authentication. |
| Non-GET requires Origin; JSON bodies limited to 64 KiB | Reuse CSRF boundary, method allowlist and body limits; GET never mutates. Add typed wizard schemas. |
| CSP nonce, `connect-src 'self'`, no-store, no-referrer, nosniff, frame denial | Reuse headers and escaped rendering; render process text as text, never HTML. All fonts/scripts/styles local; no analytics/CDN/page network to external hosts. |
| Redaction and secret rejection; `expectedMtime` conflict on config writes | Reuse `state.js: redact/sensitive`, installer redaction and config validation. Extend conflict protection to every approved file/profile input. |
| 10-minute idle timeout; SIGINT/close aborts observations, closes connections | Keep idle timeout when no operation is active. During apply, authenticated poll/answer counts as activity; on expiry/SIGINT/explicit close request safe cancellation, finish current atomic step, flush result, stop children/server and release locks. |
| Page instance + 3-second close grace and keepalive | Preserve idle config behavior. During an active job, tab unload/disconnect only detaches the view; it cannot kill an in-flight write. Reconnect within timeout. |

- One session/job per root: reuse same-process session, add cross-process lock; a second process refuses with guidance rather than exposing another session's token. One active page instance may answer/confirm.
- Token appears once in the initiating terminal's private launch URL for manual opening. Never put it in persistent logs, job events, errors, telemetry or child arguments except the OS browser-opening call. Redact URL query and token header explicitly; existing general redaction alone is not proof. Clear query via `history.replaceState` after boot; keep token only in page memory.
- Page may not execute arbitrary commands, browse/read arbitrary files, upload scripts, edit raw profiles, install Node/agent clients, elevate privileges or accept account secrets. All writes are typed operations derived by Node from the approved plan.
- Config/account mutations also show previews before requests; extend current direct-save interactions where necessary. External login remains an explicit native-client action; Node may make required release/client requests, the page itself may not.

<a id="section-5"></a>
## 5. No-browser operation, accessibility and language

- Unix auto mode: SSH (`SSH_CONNECTION`/`SSH_TTY`), container without a usable graphical session, Linux without DISPLAY/WAYLAND_DISPLAY, missing opener, or opener failure ⇒ explain concrete reason, then terminal Node installer. On macOS use session/opener availability, not DISPLAY alone.
- Example message: “No graphical session detected (SSH); using the terminal installer. Use --ui --headless for a forwarded browser session.” Localized equivalent in pt-BR. Opener success only means launch accepted: keep URL visible and offer explicit terminal retry if no browser connects; never run terminal concurrently with an active web job.
- `--ui` refuses automatic fallback: if opener unavailable, print launch URL and remain headless. `--headless` explicitly starts UI without opening it, including Windows; Windows never falls back to a terminal wizard.
- Remote example: server prints port P and private token URL; on the workstation run `ssh -N -L P:127.0.0.1:P user@host`, then open the printed URL locally. Use the same local port so Host/Origin checks remain unchanged. Never bind to `0.0.0.0`.
- Unix terminal fallback without TTY requires explicit client/options and consent flags supported by the current Node installer; otherwise actionable exit 2, no hanging prompt. `--yes` never counts as browser review consent.
- Extend `src/config-ui/labels.js: labels` (`en`, `pt-BR`), selected by existing locale resolution; no separate wizard translation system. Localize stages, errors, fallback and next steps; preserve paths/commands as data.
- Native form controls, visible labels and focus, logical Tab order, Enter/Space actions, existing keyboard tabs, focus on new screen heading/error summary, `aria-live="polite"` status, text alongside color. No focus stealing on polls. Support zoom/reflow, reduced motion and keyboard-only review/cancel.
- Unsaved models/accounts stay visible on error; language switch preserves typed choices and requires fresh review if the plan changes. No external page requests, including fonts and model discovery.

<a id="section-6"></a>
## 6. Acceptance and tests for implementation slices

This demand runs design review only; these are future implementation acceptance checks.
Use `node:test` and injected fs/process/browser/clock adapters; no new runtime dependencies.

| Must pass | Must refuse / preserve |
| --- | --- |
| Valid token + Host + Origin; first-run and config use same server | Foreign Host/Origin, absent token, cross-site POST, token on API query, wrong method, malformed/oversized JSON |
| Plan lists every file/profile/command with no install/config writes | Hidden initialization writes; edited input after review → 409 and zero apply writes |
| Poll reconnect, same apply key, one job/root, safe cancellation | Duplicate writes, second job/process, stale answer/plan, cancelling midway through atomic write |
| Models/effort, pending markers, panel skip, accounts/login, PATH and kit row | Unknown models without explicit confirmation, raw credentials/commands, foreign managed blocks overwritten |
| Both locales; errors and captured child output redacted | Token leakage in logs/events/URL errors; process output interpreted as HTML |
| Unix default GUI, SSH/container auto fallback, forced terminal/UI/headless | Missing/old Node, no agent, bad checksum, unsupported pair; Windows terminal wizard |
| Update/repair/reload/restart and partial success | Automatic replay after process restart or success fabricated after self-check failure |

- Add server contract cases beside existing config UI tests; exercise request authorization without binding where sandbox forbids loopback. Then run real HTTP contracts in an environment permitting `127.0.0.1`.
- Browser recommendation: one Playwright-driven acceptance scenario using an already available runner/browser, no package dependency. Cost: maintain one scenario plus browser provisioning in the verifier; if unavailable locally, keep DOM/contract tests and Director browser acceptance until a CI runner is approved. Cover keyboard-only preview/apply, reconnect, locale, hand-off, and reject external page requests.
- Installer container acceptance: retain the project's **Podman installer run**, with isolated HOME/state/client shims and offline release fixtures. Exercise Unix default/no-display fallback, `--terminal`, `--ui --headless`, requirements/checksum refusals, repeat repair and no writes before consent. Do not publish a host port for terminal cases.
- The exact existing Podman harness command/image is not identified in the permitted source set; Director must attach that project's invocation and results before accepting bootstrap slices. Do not substitute a newly invented container harness or claim Windows proof from Linux containers.

### Manual Windows script (Director; clean disposable VM)

Use the generated candidate `install.ps1` in Downloads; run cases separately in Windows
PowerShell 5.1 and PowerShell 7 (`pwsh`), as a normal user. Keep transcript private/redacted.

1. Snapshot VM with no Node and no clients. Run `powershell.exe -NoProfile -File .\install.ps1 --locale en`. Expect `Node required: https://nodejs.org/`, `$LASTEXITCODE` = 2, no browser/install files. Repeat `--locale pt-BR`: Portuguese equivalent.
2. Install Node 18 for the negative case; rerun. Expect Node >=20/actual-version refusal, exit 2, no download/install. Replace with supported Node (minimum from candidate release).
3. With no clients, rerun. Expect “Install at least one of claude, codex, opencode” (localized), exit 2, no registration/PATH changes. Install one supported client and authenticate through that client.
4. Run `powershell.exe -NoProfile -File .\install.ps1 --locale en`. Expect requirements + SHA-256 success + loopback URL + browser; no terminal client/model/panel prompts. Leave review open: destination/config/PATH/client registrations remain unchanged apart from disposable bootstrap staging.
5. Use a Windows user/home path containing spaces. Select detected client, inspect exact paths, profile/PATH/config preview, then Apply. Expect ordered progress and self-check results, optional Claude panel, models/effort confirmation and accounts; no elevation or automatic policy change.
6. Decline optional panel/PATH changes once; finish. Expect explicit skipped rows and exact new-terminal/manual activation guidance. In a second run approve PATH; open a new PowerShell, run `okit-plugin --help`. Expect successful command resolution. Existing terminal is told to reload.
7. Change models, add an account, cancel a pending review and reload during progress. Expect one job, retained live progress, no cancelled-review writes; reopen after process exit and expect rediscovery/review. Rerun install: update/repair/change-model choices, no duplicate PATH blocks or registrations.
8. Run `.\install.ps1 --headless --locale pt-BR`. Expect private URL, no browser, Portuguese page when opened manually. Repeat with browser launch disabled: URL and instructions, no terminal wizard. Close/idle: listener stops and temporary files are cleaned after safe boundaries.
9. With verifier-controlled release fixture, alter archive bytes after manifest creation and run candidate bootstrap against it. Expect `SHA-256 mismatch: package refused`, exit 1, no extraction/execution/registration. Test foreign Host/Origin using the server contract runner; expect 403.

<a id="section-7"></a>
## 7. Independently mergeable implementation demands

Sizes use the project's S/M/L classes; dependencies are slice numbers. Each slice
includes its focused tests and bilingual affected documentation, keeping shipped paths usable.

| Slice | Size / depends | Change and proof | Wrapper removal |
| --- | --- | --- | --- |
| 1. Shared plan contract | L / none | Typed read-only plan, fingerprints, mutation inventory, structured presenter; extract setup/panel boundaries and audit client assets. Terminal dry-run matches plan; preview writes nothing. | None; regenerate only if shared embedded source changes. |
| 2. Authorized job service | M / 1 | Same server/session, polling, locks, idempotency, typed answers/cancel, redaction/timeout. Security and concurrent-request contracts pass. | None. |
| 3. First-run screens | L / 2 | Detection → review → progress → models/panel/accounts/reload/result → config; reuse existing controls, consent for every write, keyboard/i18n and browser acceptance. Opt-in `install --ui` / extracted-package command works. | None; preserve released defaults until UI acceptance. |
| 4. Unix bootstrap/default | M / 3 | Verified acquisition, detected-client bootstrap, GUI/SSH/container routing, force flags/headless and cleanup. Existing Podman installer lane plus GUI opener contract passes. | Remove client questions/terminal presentation from default UI bootstrap; retain terminal route and tested Node presenter behind auto fallback/`--terminal`. |
| 5. Windows simple launcher | M / 3 | Generated PowerShell checks/acquisition/launch only; manual Windows script passes in 5.1/7. | Remove embedded terminal selection/setup/menu routes and terminal-only options from Windows generation/output; keep Node prelude, integrity/preflight/launch. |
| 6. Rerun and release acceptance | M / 4, 5 | Restart recovery, update/repair/model-only flows, partial failure, temporary cleanup and docs. Director supplies Podman, real-browser and Windows evidence. | Remove obsolete bootstrap interaction branches after compatibility audit; retain Unix fallback tests permanently. |

Do not hand-edit generated scripts: update `src/release/install-scripts.js` and its
embedded bootstrap source, then regenerate both outputs together. Shared changes must
not accidentally restore terminal interaction to the Windows launcher.

<a id="section-8"></a>
## 8. Risks and owner decisions

| Risk | Mitigation / decision |
| --- | --- |
| Current dry-run omits exact writes; setup initialization writes eagerly | Slice 1 is a prerequisite, with write inventory and no-write contracts; never ship consent over an incomplete plan. |
| Client-specific archive/version differences | Audit package contents; pin payload/checksum in plan and fetch selected assets before commit. Reject drift rather than silently updating the approved version. |
| Browser launch accepted but no usable window; disconnect mid-install | Visible private URL, headless option, safe cancellation, explicit partial outcomes; never auto-start another installer while web apply runs. |
| Local hostile process reads token; checksum source compromised | User-local capability boundary, short lifetime/redacted logs, no public listener; SHA-256 is integrity only. Publisher signatures are separate future work. |
| Multi-client operations are not one atomic transaction | Preserve existing per-client backup/recovery and show partial results; never promise all-client rollback. |

### Owner decisions (2026-11-08)

1. **Aliases:** `update` and `uninstall` aliases forward directly to Node, with no menus; announce deprecation before any removal, especially on Windows.
2. **Browser acceptance:** reuse an available Playwright runner, with no new repository dependency; the Director owns browser acceptance until a CI runner is approved.
3. **Common bootstrap:** keep the verified per-client assets; evaluate a common bootstrap only if the slice-1 audit proves it necessary.

### Asset audit

`payloadEntries()` includes shared `src` and shared adapters in every client asset;
the shared configuration UI and installer therefore travel with each verified package.
Keep per-client assets: a common bootstrap adds no required code. Select one bootstrap
client deterministically, then pin and verify every additional selected client's asset.
The plan never downloads packages or checksum manifests: remote payloads are trees,
with checksum pending until apply; local user-trusted sources are walked and hashed.
`install-scripts.js` embeds the presenter and bootstrap; presenter changes require
regeneration of both wrappers, while acquisition and launch behavior remain unchanged.
