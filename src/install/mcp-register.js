import { join, normalize } from 'node:path';
import { DEFAULT_CONFIG } from '../profiles.js';
import { clientLabel, presenterOf } from './present.js';
import { detect } from './menu.js';

// The MCP server of the plugin, registered in the client with the client's own `mcp` commands: the installer never
// writes the client's configuration itself, it asks the client to. Only the entry named in `install.mcp.name` is
// ever touched: an entry that is not ours is kept, never replaced.

// The clients this step handles: the ones the defaults give an `mcp` setting. The list is the defaults' own, so a
// client that is not one of them is never asked, whatever the user's configuration says (OpenCode is not registered
// by the installer yet).
export const MCP_CLIENTS = Object.freeze(Object.entries(DEFAULT_CONFIG.install.clients)
  .filter(([, settings]) => settings.mcp).map(([client]) => client));

// The words of what the client printed: the path of the server is one of them, whole.
const WORDS = /[\s"'`,\[\]{}()]+/;

/** The file the client starts, inside an installation. */
const serverPath = (path, config) => join(path, config.mcp.server);

/** A command of the client: the words of its argv, never a shell string. */
const command = (words) => ({ command: words[0], args: words.slice(1) });

/** A value the client would read as a flag is never placed as one. */
const plainWord = (value) => typeof value === 'string' && value !== '' && !value.startsWith('-');

/**
 * The commands of the client that register the MCP server: read the entry, add it, remove it.
 *
 * @param {object} record the installation record (`path` is the retained folder, `previous.path` the one before it)
 * @param {object} deps the dependencies of the installer (`config` and `run`)
 * @param {'install'|'update'|'uninstall'} action what the run is doing
 * @returns {{get: string[], add: string[], remove: string[], steps: string[][]}|null} null for a client with no MCP server
 */
export function mcpPlan(record, deps, action = 'install') {
  if (!MCP_CLIENTS.includes(record.client)) return null;
  const settings = deps.config.clients[record.client];
  const mcp = settings?.mcp;
  if (!mcp) return null;
  const { name, server } = deps.config.mcp;
  if (!plainWord(name)) return null;
  // The scope the client's own command takes (`--scope user`); a client that takes none has none.
  if (mcp.scope && !plainWord(mcp.scope)) return null;
  const scope = mcp.scope ? ['--scope', mcp.scope] : [];
  const path = join(record.path, server);
  const get = [settings.executable, 'mcp', 'get', name];
  const add = [settings.executable, 'mcp', 'add', ...scope, name, '--', deps.config.node, path];
  const remove = [settings.executable, 'mcp', 'remove', name, ...scope];
  // What a dry run shows: the read and the write the action would do.
  return { get, add, remove, steps: action === 'uninstall' ? [get, remove] : [get, add] };
}

/**
 * Registers the MCP server of the plugin in the client, or removes it: one entry, the one of `install.mcp.name`.
 *
 * The entry the client holds is read first: an entry that is ours (the output of the client names the server of this
 * installation, or the one it replaced) is ours to write; an entry that is not ours is kept, and a failure is a
 * warning, never a failure of the installation. An entry that could not be read is not an absent entry: nothing is
 * written, because the `mcp add` of a client replaces the entry of the same name and the foreign one would be lost.
 *
 * @param {object} record the installation record (`path` is the retained folder, `previous.path` the one before it)
 * @param {object} deps the dependencies of the installer (`config` and `run`)
 * @param {'install'|'update'|'uninstall'} action what the run is doing
 * @returns {Promise<{status: string, detail: string, reason?: string}|null>} null when the client has no MCP server
 */
export async function registerMcp(record, deps, action = 'install') {
  const plan = mcpPlan(record, deps, action);
  if (!plan) return null;
  const ui = presenterOf(deps);
  const client = clientLabel(record.client);
  const name = deps.config.mcp.name;
  const current = serverPath(record.path, deps.config);
  const previous = record.previous?.path ? serverPath(record.previous.path, deps.config) : null;
  const entry = await readEntry(plan, deps);
  // The entry could not be read: nothing is written, not even the add that would replace a foreign entry.
  if (entry.status === 'failed') return failure(ui, client, entry.reason, action === 'uninstall' ? plan.remove : plan.add);
  const ours = (path) => pointsAt(entry.output, [path], deps.platform);
  if (action === 'uninstall') {
    if (entry.status === 'absent') return { status: 'skipped', detail: '' };
    if (!ours(current) && !(previous && ours(previous))) {
      return { status: 'kept', detail: ui.text('mcpKept', { client, name }) };
    }
    const removed = await runPlan(plan.remove, deps);
    if (!removed.ok) return failure(ui, client, removed.reason, plan.remove);
    return { status: 'ok', detail: ui.text('mcpRemoved', { client }) };
  }
  if (entry.status === 'absent') {
    const added = await runPlan(plan.add, deps);
    if (!added.ok) return failure(ui, client, added.reason, plan.add);
    return { status: 'ok', detail: ui.text('mcpRegistered', { client }) };
  }
  // The entry is ours and it already points at this installation: there is nothing to write.
  if (ours(current)) return { status: 'skipped', detail: ui.text('mcpAlready', { client }) };
  // The entry points at the installation this one replaces: it is taken out and the new one is written.
  if (previous && ours(previous)) {
    const removed = await runPlan(plan.remove, deps);
    if (!removed.ok) return failure(ui, client, removed.reason, plan.remove);
    const added = await runPlan(plan.add, deps);
    if (!added.ok) return failure(ui, client, added.reason, plan.add);
    return { status: 'ok', detail: ui.text('mcpReplaced', { client }) };
  }
  return { status: 'kept', detail: ui.text('mcpKept', { client, name }) };
}

/**
 * The MCP step of an installation that is already there: the entry is read and, when it is absent, added again, so
 * that an installation whose first add failed is fixed by the next one. A client that is not on the machine is left
 * alone, quietly: the manual command is listed by the registration itself.
 *
 * @param {object} record the installation record (`path` is the retained folder)
 * @param {object} deps the dependencies of the installer (`config`, `run` and `detect`)
 * @returns {Promise<{status: string, detail: string, reason?: string}|null>} null when the client is not there
 */
export async function ensureMcp(record, deps) {
  const settings = deps.config.clients[record.client];
  if (!settings) return null;
  if (!await (deps.detect ?? detect)(settings.executable, deps)) return null;
  return registerMcp(record, deps, 'install');
}

/**
 * Whether what the client printed names one of our paths, whole: a path that is only a part of another one (a folder
 * that ends with ours, our version against the version that follows it) is not ours.
 *
 * @param {string} text what the client printed
 * @param {string[]} paths the paths of ours to look for
 * @param {string} [platform] the system of the run (on Windows the case and the separator do not matter)
 * @returns {boolean} whether one of the paths is named
 */
export function pointsAt(text, paths, platform = process.platform) {
  const wanted = paths.filter(Boolean).map((path) => normalize(path));
  return String(text ?? '').split(WORDS).filter(Boolean)
    .some((word) => wanted.some((path) => samePath(normalize(word), path, platform)));
}

/** The paths as they are compared: on Windows the case and the separator do not matter. */
const samePath = (one, other, platform) => {
  const fold = (value) => (platform === 'win32' ? value.replaceAll('\\', '/').toLowerCase() : value);
  return fold(one) === fold(other);
};

/** What the client answered about the entry: whether it holds one, and what it printed about it. */
async function readEntry(plan, deps) {
  presenterOf(deps).detail(plan.get.join(' '));
  try {
    const result = await deps.run({ ...command(plan.get), timeout: deps.config.timeoutMs });
    if (result?.code) return saysAbsent(result) ? { status: 'absent' } : { status: 'failed', reason: reasonOf(result) };
    return { status: 'exists', output: outputOf(result) };
  } catch (error) {
    // Only the client that says it holds no entry with this name means an absent entry; every other failure is one.
    if (error?.code === 1 && saysAbsent(error)) return { status: 'absent' };
    return { status: 'failed', reason: reasonOf(error) };
  }
}

/** What the client printed, in the two places it prints it. */
const outputOf = (result) => `${result?.stdout ?? ''}\n${result?.stderr ?? ''}`;

/** Whether the client answered that it holds no entry with this name. */
const saysAbsent = (result) => /no mcp server/i.test(outputOf(result));

/** Why a command of the client failed: its code and what it said. */
const reasonOf = (failure) => {
  const message = failure?.message ?? `${failure?.stdout ?? ''}${failure?.stderr ?? ''}`.trim();
  const code = failure?.code;
  return code === undefined || code === null ? String(message) : `${code}: ${String(message)}`;
};

/** Runs one command of the plan: the reason of a failure is kept, the failure is never raised. */
async function runPlan(words, deps) {
  presenterOf(deps).detail(words.join(' '));
  try { await deps.run({ ...command(words), timeout: deps.config.timeoutMs }); return { ok: true }; }
  catch (error) { return { ok: false, reason: reasonOf(error) }; }
}

/** A command that failed: the reason and the command the person can run by hand. */
const failure = (ui, client, reason, words) => ({
  status: 'failed', reason,
  detail: ui.text('mcpFailed', { client, reason, command: words.join(' ') }),
});
