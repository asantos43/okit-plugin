import { join } from 'node:path';
import { clientLabel, presenterOf } from './present.js';

// The MCP server of the plugin, registered in the client with the client's own `mcp` commands: the installer never
// writes the client's configuration itself, it asks the client to. Only the entry named in `install.mcp.name` is
// ever touched: an entry that is not ours is kept, never replaced.

// The file the client starts, inside an installation.
const serverPath = (path, config) => join(path, config.mcp.server);

/** A command of the client: the words of its argv, never a shell string. */
const command = (words) => ({ command: words[0], args: words.slice(1) });

/**
 * The commands of the client that register the MCP server: read the entry, add it, remove it.
 *
 * @param {object} record the installation record (`path` is the retained folder, `previous.path` the one before it)
 * @param {object} deps the dependencies of the installer (`config` and `run`)
 * @param {'install'|'update'|'uninstall'} action what the run is doing
 * @returns {{get: string[], add: string[], remove: string[], steps: string[][]}|null} null for a client with no MCP server
 */
export function mcpPlan(record, deps, action = 'install') {
  const settings = deps.config.clients[record.client];
  const mcp = settings?.mcp;
  if (!mcp) return null;
  const { name, server } = deps.config.mcp;
  // The scope the client's own command takes (`--scope user`); a client that takes none has none.
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
 * warning, never a failure of the installation.
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
  const ours = (path) => entry.exists && entry.output.includes(path);
  if (action === 'uninstall') {
    if (!entry.exists) return { status: 'skipped', detail: '' };
    if (!ours(current) && !(previous && ours(previous))) {
      return { status: 'kept', detail: ui.text('mcpKept', { client, name }) };
    }
    const removed = await runPlan(plan.remove, deps);
    if (!removed.ok) return failure(ui, client, removed.reason, plan.remove);
    return { status: 'ok', detail: ui.text('mcpRemoved', { client }) };
  }
  if (!entry.exists) {
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

/** What the client answered about the entry: whether it holds one and what it printed about it. */
async function readEntry(plan, deps) {
  presenterOf(deps).detail(plan.get.join(' '));
  try {
    const result = await deps.run(command(plan.get));
    if (result?.code) return { exists: false, output: '' };
    return { exists: true, output: `${result?.stdout ?? ''}\n${result?.stderr ?? ''}` };
  } catch { return { exists: false, output: '' }; }
}

/** Runs one command of the plan: the reason of a failure is kept, the failure is never raised. */
async function runPlan(words, deps) {
  presenterOf(deps).detail(words.join(' '));
  try { await deps.run(command(words)); return { ok: true }; }
  catch (error) { return { ok: false, reason: error?.message ?? String(error) }; }
}

/** A command that failed: the reason and the command the person can run by hand. */
const failure = (ui, client, reason, words) => ({
  status: 'failed', reason,
  detail: ui.text('mcpFailed', { client, reason, command: words.join(' ') }),
});
