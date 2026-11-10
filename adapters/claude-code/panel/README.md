# Optional Claude Code panel

[Português](README.pt-BR.md)

This small mod draws schema 1 from `okit-plugin panel-state --json --client claude`.
Its entry point is the named `register` export in `register.js`. Once loaded by
the mod host, the **okit plugin** pane opens automatically at session start.
Set `panel.autoOpen` to `false` in the state root's `config.json` to disable this;
`/okit-panel` still opens or closes it. The setting comes from the same
`panel-state` command's `panel.autoOpen` field. Installation
is opt-in; default installation does not load it. Packaging belongs to D120.
The core works without this directory.

The header shows `okit plugin · claude · N accounts · ready: yes|no`, with readiness
from the command. Framed sections follow: **ACCOUNTS**, **RUNNING**, **RECENT**,
**LAUNCHABLE NOW**, then **Readiness** with the existing line and warnings.
Accounts show only aliases, running/idle markers, `5h` and `week` bars,
percent left, local 24 h reset time and time until reset (`4h35m` or `1d 21h`).
Each account is a title (name in bold, state dim), two quota lines in aligned
columns (label, 10-cell bar of thin line characters, `NN%`, `resets …`) and a
blank line before the next account. Columns align across accounts; resets more
than 24 h away include the weekday. `!` marks less than 20% left. Null is
`unknown`; zero is `0%`. The board starts with the header and a blank line.

Colour follows one rule: only the `NN%` text and the filled part of the bar take
the band's tone (green from 50, yellow from 20, red below 20, dim when unknown);
labels, frame and the board's other text have none, resets are dim. `!` warnings
(`Not registered: …`, a non-eligible rotation) are yellow text only; `Eligible for
rotation.` is dim. With `panel.color` set to `false` there is no colour or bold.
The model is segments, not rows: `boardSegments` returns lines of `{text, tone?,
bold?}`, `boardLines` is the same lines joined, and `register.js` draws one `Text`
per line with a nested `Text` per segment.

```text
 okit plugin · claude · 2 accounts · ready: no

╔═ ACCOUNTS ═════════════════════════════════════════════╗
║ Personal · running                                     ║
║   5h    ━━━━━━━━━━  96%  resets 16:25 (in 4h25m)       ║
║   week  ━━━───────  30%  resets Mon 10:00 (in 2d 22h)  ║
║ Eligible for rotation.                                 ║
║                                                        ║
║ Work · idle                                            ║
║ ! 5h    ━─────────  10%  reset unknown                 ║
║   week  ──────────  unknown                            ║
║ ! Not registered: Could not register the collector.    ║
╚════════════════════════════════════════════════════════╝
```
Live, non-stale runs show account alias, demand when saved, model, effort,
elapsed and last progress. Recent includes finished, failed, stale and unknown
statuses with elapsed and a saved error reason when available. Unknown accounts
display `unknown account`; their runs never attach to another account.
Launchability lists simple/normal/hard/critic aliases using `launchable[]` classes.
Older documents without classes cannot identify launchable actor classes.
Step, approval and quota-ended reasons are unavailable in run records and omitted.
Missing commands, nonzero exits, invalid documents and unsupported schemas become
plain messages. No render performs I/O.

RUNNING and RECENT each show their 20 newest runs and a remainder count. Unreadable
runs are skipped with a count only when they are not objects; invalid optional run
text becomes `unknown` or `-`. Any string status is preserved, including future
statuses; null or non-string statuses display as `unknown`.
Readiness, warnings and progress wrap by terminal cell width to at most three
rows each, with an ellipsis when truncated. Quota percentages round and clamp to 0–100.

The refresh clock defaults to 3 seconds with a hard minimum of 2 seconds. Requests
never overlap within a generation. Each load has a separate 15-second timeout;
timed-out results are ignored and the next tick can retry. Reopening starts a
fresh load immediately and resets the display to `Loading state…`.
Closing through the command cancels the timer immediately; manual
pane closure is detected on the next tick before another process starts. Closing
or resetting the session discards pending results. The process receives an argv
array, a 5-second timeout and a 1 MiB output limit; oversized returned UTF-8 is
also rejected. There is no shell, network, filesystem or credential API in this mod.

## Origin and API compatibility

Generic code was adapted from **orchestration-kit commit `3451493`**, using the
read-only reference supplied inside `.delegate/reference/task-board/`:
`hooks/frame.ts` (cell widths, clipping, frames), `hooks/panel.ts` (safe parser
and command results), `hooks/panels.tsx` (cached rendering, command registration,
busy guard), `hooks/logic.ts` (`elapsed`, `formatHm`, bar cell scaling), and
`hooks/register.tsx` (pane registration, cancellable `$.clock.every`, pane checks).
No kit workflows or state readers were copied. The ignored reference is not a payload.

**Tested Claude Code mod API version: unavailable / not verified.** The supplied
README and `types/index.d.ts` do not pin a numeric host/API version; the latter
only augments kit state. `types.d.ts` here describes our synthetic test contract,
not vendor typings. Registration uses handler-local `$` closures for command, UI,
clock and argv process APIs. A temporary `claude-code/testing` probe confirmed global
`h` in JavaScript and `$.ui.resolve(e)` returning Box/Text factories for a render
event with `surface: 'terminal'`; the runner itself exited without a test report.
Host support for `process.run`'s `maxOutputBytes` still needs Director verification.
The post-read limit alone does not guarantee a host-side memory bound.

## Focused checks

No dependencies were added. JavaScript with JSDoc runs directly under `node --test`;
`tsc -p adapters/claude-code/panel/tsconfig.json` checks only this mod, using an
available TypeScript executable (TypeScript is not a repository dev dependency).
Tests are `test/panel-mod.test.js` and `test/panel-isolation.test.js`. Generic
formatter/frame cases and safe parsing, command-failure, registration and cached
rendering cases were ported from the three reference test files. Kit-only tests
were omitted. A real Claude Code mod session and its API remain unverified.
