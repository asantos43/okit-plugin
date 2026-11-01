import { join, normalize } from 'node:path';
import { DEFAULT_CONFIG } from '../profiles.js';
import { clientLabel, presenterOf } from './present.js';
import { detect } from './menu.js';

// The MCP server of the plugin, registered in the client with the client's own `mcp` commands: the installer never
// writes the client's configuration itself, it asks the client to. Only the entry named in `install.mcp.name` is
// ever touched: an entry that is not ours is kept, never replaced. A client whose own `mcp get` does not say where an
// entry is kept (Codex) is only ever added to: what it shows and what its `mcp add` writes are not the same entry.

// The clients this step handles: the ones the defaults give an `mcp` setting. The list is the defaults' own, so a
// client that is not one of them is never asked, whatever the user's configuration says (OpenCode is not registered
// by the installer yet).
export const MCP_CLIENTS = Object.freeze(Object.entries(DEFAULT_CONFIG.install.clients)
  .filter(([, settings]) => settings.mcp).map(([client]) => client));

/** The file the client starts, inside an installation. */
const serverPath = (path, config) => join(path, config.mcp.server);

/** A command of the client: the words of its argv, never a shell string. */
const command = (words) => ({ command: words[0], args: words.slice(1) });

/** A value the client would read as a flag, or a name with a dot the client refuses, is never placed as one. */
const plainWord = (value) => typeof value === 'string' && value !== '' && !value.startsWith('-') && !value.includes('.');

/** A word no shell reads differently: only the characters that mean nothing to it. */
const PLAIN = /^[A-Za-z0-9_@%+=:,./-]+$/;
/** The same on Windows, where the separator of the paths is a backslash. */
const PLAIN_WIN = /^[A-Za-z0-9_@%+=:,./\\-]+$/;

/**
 * The word as the shell of the platform reads it: as it is when the shell reads it that way, quoted when it does not
 * (a space, a quote, a `$`, a `;`, a `~` at its front, an empty word: anything a shell would not give back as it is).
 */
const quotedWord = (word, platform) => {
  const text = String(word);
  if ((platform === 'win32' ? PLAIN_WIN : PLAIN).test(text)) return text;
  return platform === 'win32' ? `'${text.replaceAll("'", "''")}'` : `'${text.replaceAll("'", "'\\''")}'`;
};

/**
 * The argv of a command as one command line: the clients take an argv, a person pastes one line.
 *
 * @param {string[]} words the argv of the command
 * @param {string} [platform] the system of the run (the shell of the person: POSIX or PowerShell)
 * @returns {string} the command line, every word a shell would read differently quoted
 */
export function shown(words, platform = process.platform) {
  return words.map((word) => quotedWord(word, platform)).join(' ');
}

/**
 * The commands of the client that register the MCP server: read the entry, add it, remove it.
 *
 * @param {object} record the installation record (`path` is the retained folder, `previous.path` the one before it)
 * @param {object} deps the dependencies of the installer (`config` and `run`)
 * @param {'install'|'update'|'uninstall'} action what the run is doing
 * @returns {{get: string[], add: string[], remove: string[], steps: string[][], scope: string|null, cwd: string}|null} null for a
 * client with no MCP server (or with the module strategy and no module of ours: nothing of it is ours to register)
 */
export function mcpPlan(record, deps, action = 'install') {
  if (!MCP_CLIENTS.includes(record.client)) return null;
  const settings = deps.config.clients[record.client];
  // A client with the module strategy and no module of ours has nothing of ours in it: the MCP step is not its.
  if (settings?.strategy === 'module' && !settings.module) return null;
  const mcp = settings?.mcp;
  if (!mcp) return null;
  const { name, server } = deps.config.mcp;
  if (!plainWord(name)) return null;
  // The scope the client's own command takes (`--scope user`); a client that takes none has none.
  if (mcp.scope && !plainWord(mcp.scope)) return null;
  const scope = mcp.scope ?? null;
  const scopeWords = scope ? ['--scope', scope] : [];
  const path = join(record.path, server);
  const get = [settings.executable, 'mcp', 'get', name];
  const add = [settings.executable, 'mcp', 'add', ...scopeWords, name, '--', deps.config.node, path];
  const remove = [settings.executable, 'mcp', 'remove', name, ...scopeWords];
  // What a dry run shows: the read and the write the action would do.
  return { get, add, remove, steps: action === 'uninstall' ? [get, remove] : [get, add], scope, cwd: mcpCwd(deps, record) };
}

/**
 * Registers the MCP server of the plugin in the client, or removes it: one entry, the one of `install.mcp.name`.
 *
 * Every command of the client runs from the installation folder of the record being handled (or from the directory the
 * dependencies name), a folder the installer owns and that holds no configuration of any project: the configuration of
 * a project is never read nor changed, so what the client shows there is the global entry, the one this step owns.
 *
 * The entry the client holds is read first: an entry that is ours (the output of the client names the server of this
 * installation, or the one it replaced) is ours to write; an entry that is not ours is kept, and a failure is a
 * warning, never a failure of the installation. An entry that could not be read is not an absent entry: nothing is
 * written, because the `mcp add` of a client replaces the entry of the same name and the foreign one would be lost.
 * An entry at another scope than the configured one is not ours either: the client shows the entry of the highest
 * precedence it holds, and the entry of that scope is never written nor taken out.
 *
 * The path of an installation that holds whitespace is another case where the display cannot tell our entry from a
 * foreign one: the clients print the arguments of an entry joined by spaces, never quoted, so the entry of a foreign
 * server whose arguments were split (`/opt/Jo` and `Silva/1.0.0/src/mcp/server.js`) is printed exactly like ours
 * (`/opt/Jo Silva/1.0.0/src/mcp/server.js`). The installer never claims, replaces nor takes out such an entry: it
 * only adds the entry that is missing and prints the commands to run by hand.
 *
 * A client whose own `mcp get` does not say where an entry is kept (Codex) is the other side of the same coin: what it
 * shows is the entry of the highest precedence it holds (the one of a project, when the installation folder sits inside
 * one) while `mcp add` and `mcp remove` only ever touch the global entry. The installer cannot tell which one it is
 * looking at, so for such a client it only ever adds: an entry that is there is never replaced nor taken out by it, and
 * the warning gives the commands to run by hand.
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
  if (entry.status === 'failed') return failure(ui, client, entry.reason, action === 'uninstall' ? plan.remove : plan.add, deps.platform);
  // The entry is at another scope than ours: it is not ours, and nothing of it is written nor taken out.
  if (entry.status === 'otherScope') return { status: 'kept', detail: ui.text('mcpKept', { client, name }) };
  const ours = (path) => pointsAt(entry.output, [path], deps.platform);
  // The client prints the arguments of an entry joined by spaces, never quoted: an entry whose arguments were split
  // is printed like ours when our path holds whitespace. Such an entry cannot be told apart from ours, so it is
  // never claimed, replaced nor taken out: only the commands to run by hand are given.
  const ambiguous = (path) => /\s/.test(path) && ours(path);
  // A client whose own `mcp get` does not say where an entry is kept (Codex): what it shows is the entry of the
  // highest precedence it holds (the one of a project, when the installation folder sits inside one), while `mcp add`
  // and `mcp remove` only ever touch the global entry. The installer cannot tell which one it is looking at, so for
  // such a client it only ever adds: an entry that is there is never replaced nor taken out by it, and the commands
  // to run by hand are given instead.
  const unscoped = plan.scope === null;
  // An entry that is not there is added (on the uninstall there is nothing to do), whatever the paths are.
  if (entry.status === 'absent') {
    if (action === 'uninstall') return { status: 'skipped', detail: '' };
    const added = await runPlan(plan.add, deps, plan.cwd);
    if (!added.ok) return failure(ui, client, added.reason, plan.add, deps.platform);
    return { status: 'ok', detail: ui.text('mcpRegistered', { client }) };
  }
  // The entry is there and the display matches a path of ours that holds whitespace: it cannot be told apart from a
  // foreign entry whose arguments were split, so it is left as it is.
  if (ambiguous(current) || (previous && ambiguous(previous))) {
    const command = action === 'uninstall' ? shown(plan.remove, deps.platform)
      : `${shown(plan.remove, deps.platform)} ; ${shown(plan.add, deps.platform)}`;
    return { status: 'kept', manual: true, detail: ui.text('mcpAmbiguous', { client, name, command }) };
  }
  if (action === 'uninstall') {
    if (!ours(current) && !(previous && ours(previous))) {
      return { status: 'kept', detail: ui.text('mcpKept', { client, name }) };
    }
    if (unscoped) return { status: 'kept', manual: true, detail: ui.text('mcpManual', { client, name, command: shown(plan.remove, deps.platform) }) };
    const removed = await runPlan(plan.remove, deps, plan.cwd);
    if (!removed.ok) return failure(ui, client, removed.reason, plan.remove, deps.platform);
    return { status: 'ok', detail: ui.text('mcpRemoved', { client }) };
  }
  // The entry is ours and it already points at this installation: there is nothing to write.
  if (ours(current)) return { status: 'skipped', detail: ui.text('mcpAlready', { client }) };
  // The entry points at the installation this one replaces: it is taken out and the new one is written.
  if (previous && ours(previous)) {
    if (unscoped) {
      return { status: 'kept', manual: true, detail: ui.text('mcpManual', { client, name,
        command: `${shown(plan.remove, deps.platform)} ; ${shown(plan.add, deps.platform)}` }) };
    }
    const removed = await runPlan(plan.remove, deps, plan.cwd);
    if (!removed.ok) return failure(ui, client, removed.reason, plan.remove, deps.platform);
    const added = await runPlan(plan.add, deps, plan.cwd);
    if (!added.ok) return failure(ui, client, added.reason, plan.add, deps.platform);
    return { status: 'ok', detail: ui.text('mcpReplaced', { client }) };
  }
  return { status: 'kept', detail: ui.text('mcpKept', { client, name }) };
}

/**
 * The MCP step of an installation that is already there: the entry is read and, when it is absent, added again, so
 * that an installation whose first add failed is fixed by the next one. A client that is not on the machine is left
 * alone, quietly: the manual command is listed by the registration itself.
 *
 * Nothing of this step throws into the installer: a client that cannot even be looked for is a warning, and a client
 * this step does not handle is never looked for.
 *
 * @param {object} record the installation record (`path` is the retained folder)
 * @param {object} deps the dependencies of the installer (`config`, `run` and `detect`)
 * @returns {Promise<{status: string, detail: string, reason?: string}|null>} null when the client is not there
 */
export async function ensureMcp(record, deps) {
  const ui = presenterOf(deps);
  const client = clientLabel(record.client);
  let plan = null;
  try {
    // The eligibility comes first: a client this step does not handle is never even looked for.
    plan = mcpPlan(record, deps, 'install');
    if (!plan) return null;
    const settings = deps.config.clients[record.client];
    if (!await (deps.detect ?? detect)(settings.executable, deps)) return null;
    return await registerMcp(record, deps, 'install');
  } catch (error) {
    // A client that cannot be looked for is a warning, never a failure of the installation.
    return failure(ui, client, reasonOf(error), plan ? plan.add : [], deps.platform);
  }
}

/**
 * Whether what the client printed names one of our paths: the arguments of a stdio entry are one of our paths, whole.
 *
 * The clients print the arguments of an entry joined by spaces, never quoted (`Args: /path/server.js`), so the value
 * of the arguments field is the whole argument list of the entry: a line that holds our path with another word at its
 * side (a file name with a space, a second argument, a quote) names another entry, not ours. The value is read as the
 * client wrote it, so the space that ends it is part of it: a foreign file name that ends with a space is not our path.
 * The first arguments field of the text is the one that is read.
 *
 * Only a stdio entry is ours. The fields of an entry are the lines indented by exactly two spaces (the nested lists,
 * such as the headers or the environment, are indented four), and the first field that names the type of the server
 * (`Type` for Claude Code, `transport` for Codex) has to be `stdio`: a server of another type never runs our server,
 * even when one of its headers holds a line that looks like the arguments field. An entry that names no type is not
 * ours either: the safe side is the one where the entry of somebody else is kept.
 *
 * @param {string} text what the client printed
 * @param {string[]} paths the paths of ours to look for
 * @param {string} [platform] the system of the run (on Windows the case and the separator do not matter)
 * @returns {boolean} whether the arguments of the entry are one of the paths
 */
export function pointsAt(text, paths, platform = process.platform) {
  const value = argumentsOf(String(text ?? ''));
  if (value === null) return false;
  const printed = platform === 'win32' ? folded(value) : value;
  return paths.filter(Boolean).map((path) => normalize(path)).some((path) => {
    const wanted = platform === 'win32' ? folded(path) : path;
    return wanted !== '' && wanted === printed;
  });
}

/**
 * The value of the arguments field of a stdio entry: the value of the first `args` field of the entry, whole, as the
 * client wrote it (null when there is none, or when the entry is not a stdio one). The value is read exactly: the
 * space that ends it is part of it, so a foreign file name that ends with a space is not our path. The line ends at
 * the end of the line, and the `\r` of a CRLF output is not part of the value.
 */
const argumentsOf = (text) => {
  const fields = fieldsOf(text);
  // The type of the server decides: only a stdio one runs our server.
  const type = fields.find((field) => /^(type|transport)$/i.test(field.key));
  if (!type || type.value !== 'stdio') return null;
  const args = fields.find((field) => /^args$/i.test(field.key));
  return args ? args.value : null;
};

/**
 * The fields of the entry the client printed: the lines indented by exactly two spaces, as the clients print them (the
 * fields of the server are indented two spaces, the values of the nested lists, such as the headers or the environment,
 * four). A line with three or more spaces is a value of a nested list, never a field of the entry.
 */
const fieldsOf = (text) => [...String(text ?? '').matchAll(/^ {2}(?! )([A-Za-z_]+): ([^\r\n]*)/gm)]
  .map((match) => ({ key: match[1], value: match[2] }));

/** The paths as they are compared on Windows: the separator and the case do not matter. */
const folded = (value) => value.replaceAll('\\', '/').toLowerCase();

/** What the client answered about the entry: whether it holds one, and what it printed about it. */
async function readEntry(plan, deps) {
  const answer = await ask(plan.get, deps, plan.cwd);
  if (!answer.ok) {
    // Only the client that says it holds no entry with this name means an absent entry; every other failure is one.
    if (answer.code === 1 && /no mcp server/i.test(answer.text)) return { status: 'absent' };
    return { status: 'failed', reason: answer.reason };
  }
  const output = answer.text;
  // The scope the client names is the scope the entry is at: the client shows the entry of the highest precedence it
  // holds, so an entry at another scope than ours is not ours, even when its arguments name our path.
  const scope = scopeOf(output);
  if (plan.scope && scope && scope.toLowerCase() !== plan.scope.toLowerCase()) return { status: 'otherScope', output };
  return { status: 'exists', output };
}

/**
 * The scope the client named about the entry it printed: the first word of its `Scope` field (null when it names none).
 * The scope is a field of the entry, at the two spaces indent: a header of an HTTP server that holds a line named
 * `Scope` is not the scope of the entry.
 */
const scopeOf = (text) => {
  const field = fieldsOf(text).find((item) => /^scope$/i.test(item.key));
  return field ? /^\s*(\w+)/.exec(field.value)?.[1] ?? null : null;
};

/**
 * The directory the commands of the client run from: the installation folder of the record being handled, or the one
 * the dependencies name.
 *
 * The `mcp` commands of a client read the configuration of the project of the directory they run in (Codex reads the
 * `.codex/config.toml` of the trusted project it finds from the current directory upward), and they write or take out
 * the global entry. A run inside a project would therefore read the entry of that project and decide about the global
 * one: the entry of the project looks like ours, the global one is the one that goes. The installation folder is one
 * the installer owns: it holds the plugin and no configuration of any project, so what the client shows there is the
 * global entry, the one this step owns.
 *
 * @param {object} deps the dependencies of the installer (`mcpCwd` is the directory to use, when there is one)
 * @param {object} record the installation record (`path` is the installation folder)
 * @returns {string} the directory the commands of the client run from
 */
const mcpCwd = (deps, record) => deps.mcpCwd || record.path;

/**
 * Runs one command of the client and answers in one shape: a runner that resolves a non-zero code failed as much as
 * a runner that throws, and both answers are the same here.
 *
 * @param {string[]} words the argv of the command
 * @param {object} deps the dependencies of the installer
 * @param {string} cwd the directory the command runs from
 * @returns {Promise<{ok: boolean, code: number|string|null, text: string, reason: string}>}
 */
async function ask(words, deps, cwd) {
  presenterOf(deps).detail(shown(words, deps.platform));
  try {
    return answered(await deps.run({ ...command(words), timeout: deps.config.timeoutMs, cwd }));
  } catch (error) {
    return answered(error, true);
  }
}

/** What a command answered: whether it worked, its code, what it printed and why it failed. */
const answered = (result, thrown = false) => {
  const code = result?.code ?? null;
  const text = `${result?.stdout ?? ''}\n${result?.stderr ?? ''}`;
  const ok = !thrown && (code === null || code === 0);
  return { ok, code, text, reason: ok ? '' : reasonOf(result) };
};

/** Runs one command of the plan: the reason of a failure is kept, the failure is never raised. */
async function runPlan(words, deps, cwd) {
  const answer = await ask(words, deps, cwd);
  return answer.ok ? { ok: true } : { ok: false, reason: answer.reason };
}

/** Why a command of the client failed: its code and what it said. */
const reasonOf = (failure) => {
  const message = failure?.message ?? `${failure?.stdout ?? ''}${failure?.stderr ?? ''}`.trim();
  const code = failure?.code;
  return code === undefined || code === null ? String(message) : `${code}: ${String(message)}`;
};

/** A command that failed: the reason and the command the person can run by hand, quoted for the shell. */
const failure = (ui, client, reason, words, platform = process.platform) => ({
  status: 'failed', reason,
  detail: ui.text('mcpFailed', { client, reason, command: shown(words, platform) }),
});
