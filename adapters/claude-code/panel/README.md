# Optional Claude Code panel

[Português](README.pt-BR.md)

This small mod draws schema 1 from `okit-plugin panel-state --json --client claude`.
Its entry point is the named `register` export in `register.js`. Once loaded by
the mod host, `/okit-panel` opens or closes the **okit plugin** pane. Installation
is opt-in; default installation does not load it. Packaging belongs to D120.
The core works without this directory.

Runs are grouped by account, including failed and stale runs and orphan account
IDs. Both session (5 h) and weekly quotas show remaining percentages: null is
`unknown`, zero is `0%`. The readiness line and warnings come from the command.
Missing commands, nonzero exits, invalid documents and unsupported schemas become
plain messages. No render performs I/O.

Each account shows its 20 newest runs and a count of the remainder. Unreadable
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
not vendor typings. Registration uses the reference's `h`, command, UI, clock and
argv process APIs. Host support for `process.run`'s `maxOutputBytes` option and
global `h` in JavaScript must be checked by the Director before installation.
The post-read limit alone does not guarantee a host-side memory bound.

## Focused checks

No dependencies were added. JavaScript with JSDoc runs directly under `node --test`;
`tsc -p adapters/claude-code/panel/tsconfig.json` checks only this mod, using an
available TypeScript executable (TypeScript is not a repository dev dependency).
Tests are `test/panel-mod.test.js` and `test/panel-isolation.test.js`. Generic
formatter/frame cases and safe parsing, command-failure, registration and cached
rendering cases were ported from the three reference test files. Kit-only tests
were omitted. A real Claude Code mod session and its API remain unverified.
