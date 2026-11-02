// D99 slice 6a: nothing the model reads tells it to run a command of the kit.
//
// The model works with the MCP tools; a command of the kit is a step of the person. So every text the model reads
// (the skills, the replies of the tools, the context of the hooks) names a tool, and names a command of the kit only
// when it is one of the five the person may run: install, update, uninstall, setup and doctor.
//
// | proof | what it holds |
// | the skills | no command of the kit but the five, no command of their own, and every name is a tool of the server |
// | the runtime texts | the environment, the status, the actors and the two hooks, in both languages, name no other command |
// | the source | no string of a message table names a command of the kit but the five |

import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { listActors } from '../src/actors.js';
import { environmentReport, formatEnvironmentReport } from '../src/env/report.js';
import { runPostCompact } from '../src/hook-post-compact.js';
import { runSessionStart } from '../src/hook-session-start.js';
import { TOOLS, TOOL_NAMES } from '../src/mcp/tools.js';
import { DEFAULT_CONFIG } from '../src/profiles.js';
import { statusTable } from '../src/status.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SKILLS_DIR = join(ROOT, 'skills');
const SRC_DIR = join(ROOT, 'src');
// The commands the person may be told to run: the five the CLI keeps.
const FIVE = ['install', 'update', 'uninstall', 'setup', 'doctor'];
// The name of the command of the kit, as the configuration has it.
const COMMAND = DEFAULT_CONFIG.install.command;
// The tools the server publishes: a skill names them by name.
const TOOL_NAMES_SET = new Set(TOOL_NAMES);
// The snake_case name of a tool, as the skills write it.
const SNAKE_CASE = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g;
// The name of a skill, as the skills mention each other.
const SKILL_NAME = /\bokit-[a-z-]+\b/g;

// The words of the commands the kit had, written down on purpose: the command line loses those commands in the next
// slice, and no text may name them again.
const OLD_COMMANDS = new Set(['config', 'quota', 'actors', 'env', 'status', 'smoke', 'smoke-demo', 'client-smoke',
  'inbox', 'telemetry', 'todo', 'order', 'orders', 'daemon', 'autostart', 'trajectory', 'limits', 'classify',
  'profile', 'kit', 'slot', 'release', 'acquire', 'mcp', 'role', 'hook', 'statusline-collector']);

// The words that continue a sentence about the command itself ("okit-plugin removed", "the shell finds okit-plugin at
// /path"): they are not commands, and the generic pattern of a command would say they are.
const NOT_A_COMMAND = new Set(['failed', 'removed', 'removido', 'kept', 'mantido', 'at', 'em']);

/**
 * Whether the text names a command of the kit that the person may not run.
 *
 * @param {string} text the text a model reads
 * @returns {boolean}
 */
function forbiddenCommand(text) {
  return new RegExp(`(${COMMAND}|\\{command\\})\\s+(?!(?:${FIVE.join('|')})\\b)[a-z]`).test(text);
}

/**
 * Whether a word that follows the name of the command is a command of the kit.
 *
 * @param {string} word the word that follows the name of the command
 * @returns {boolean}
 */
function isCommand(word) {
  if (OLD_COMMANDS.has(word)) return true;
  return !FIVE.includes(word) && !NOT_A_COMMAND.has(word);
}

/** The folders of the skills, in the order of the disk. */
async function skillFolders() {
  const entries = await readdir(SKILLS_DIR, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

/** The body of a skill: everything under its front matter. */
async function skillBody(folder) {
  const text = await readFile(join(SKILLS_DIR, folder, 'SKILL.md'), 'utf8');
  const close = text.indexOf('\n---', 4);
  return text.slice(close + 4);
}

// | skill | must hold | must refuse |
// | every skill | no command but the five, no command of its own | `okit-plugin quota set`, `node .../cli.js` |
// | every skill | every snake_case name is a tool of the server | a name the server does not publish |
// | every skill | every skill it names exists | a skill that is not there |
test('no skill tells the model to run a command of the kit', async () => {
  const folders = await skillFolders();
  assert.ok(folders.length > 0, 'the plugin ships skills');
  for (const folder of folders) {
    const body = await skillBody(folder);
    assert.ok(!forbiddenCommand(body), `${folder} names a command of the kit the person may not run`);
    assert.doesNotMatch(body, /node\s+"\$\{CLAUDE_PLUGIN_ROOT\}/, `${folder} runs the cli of the plugin`);
    assert.doesNotMatch(body, /\bnode\b[^.\n]*cli\.js/, `${folder} runs a command of its own`);
    for (const name of new Set(body.match(SNAKE_CASE) ?? [])) {
      assert.ok(TOOL_NAMES_SET.has(name), `${folder} names ${name}, which the server does not publish`);
    }
    for (const name of new Set((body.match(SKILL_NAME) ?? []).filter((named) => named !== COMMAND))) {
      assert.ok(folders.includes(name), `${folder} names ${name}, which is not a skill`);
    }
  }
});

/**
 * The world of the runtime texts: a root with nothing in it, no quota recorded, no model chosen and no collector
 * registered. Every remedy of the world is therefore printed.
 *
 * @param {string} root the state root of the world
 * @returns {object} the dependencies of the readers
 */
function world(root) {
  const missing = async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); };
  return {
    root,
    home: root,
    env: { HOME: root, USERPROFILE: root },
    config: {},
    detectClients: async () => ({ clients: [] }),
    versions: {},
    plugin: { path: 'plugin-from-reading', onPath: false },
    readQuota: async () => ({ source: 'off' }),
    limits: { limits: { global: 3, clients: {} }, byClient: {} },
    orders: [],
    fs: { readFile: missing, stat: missing, readdir: async () => [], access: missing },
    run: async () => { throw Object.assign(new Error('not run'), { code: 'ENOENT' }); },
  };
}

/**
 * The reply of a tool of the server: the handler of the table of the server, called with the world of the empty root.
 *
 * @param {string} name the name of the tool
 * @param {object} args the arguments of the call
 * @param {object} deps the dependencies of the world
 * @returns {Promise<string>} the reply, as the server sends it
 */
async function replyOf(name, args, deps) {
  const tool = TOOLS.find((entry) => entry.name === name);
  assert.ok(tool, `the server publishes ${name}`);
  const { root, ...rest } = deps;
  return tool.handler(args, { root, ...rest });
}

// | the text | must hold | must refuse |
// | the report of the environment | the tool that fixes it, the command of the person | `okit-plugin quota set` |
// | the object the model receives | no command of the kit in it | `command: "okit-plugin quota set ..."` |
// | the status and the actors | the same | `okit-plugin config show` |
// | the replies of the tools of the server | the same | any command but the five |
test('no runtime text tells the model to run a command of the kit', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'okit-no-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'config.json'), '{}');
  await writeFile(join(root, 'inbox.json'), JSON.stringify({ version: 1, seq: 0, items: [] }));
  await writeFile(join(root, 'orders.json'), JSON.stringify({ version: 1, seq: 0, orders: [] }));
  for (const locale of ['en', 'pt-BR']) {
    const deps = { ...world(root), locale };
    const report = await environmentReport(deps);
    assert.ok(!forbiddenCommand(formatEnvironmentReport(report, locale)), `env_report ${locale}`);
    // The model receives the object, not only the sentence: the object carries no command of the kit either.
    assert.ok(!forbiddenCommand(JSON.stringify(report)), `the report of the environment ${locale}`);
    const status = await statusTable(root, { ...deps, demands: [] });
    assert.ok(!forbiddenCommand(status.markdown), `status ${locale}`);
    assert.ok(!forbiddenCommand(status.capacityLine), `status ${locale}`);
    assert.ok(!forbiddenCommand(JSON.stringify(status)), `the status ${locale}`);
    const actors = await listActors(deps);
    assert.ok(!forbiddenCommand(actors.markdown), `actors_list ${locale}`);
    assert.ok(!forbiddenCommand(JSON.stringify(actors)), `the actors ${locale}`);
    for (const note of actors.notes) assert.ok(!forbiddenCommand(note), `actors_list ${locale}`);
    // The real replies of the tools of the server, in the two languages.
    for (const name of ['env_report', 'status', 'actors_list']) {
      const reply = await replyOf(name, { locale }, deps);
      assert.ok(!forbiddenCommand(reply), `${name} ${locale}: ${reply}`);
    }
  }
});

test('the context of the hooks names no command of the kit', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'okit-no-cli-hooks-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'config.json'), '{}');
  await writeFile(join(root, 'inbox.json'), JSON.stringify({ version: 1, seq: 1,
    items: [{ id: 'I1', title: 'Work in hand', status: 'pending' }] }));
  await writeFile(join(root, 'orders.json'), JSON.stringify({ version: 1, seq: 1,
    orders: [{ id: 'G1', text: 'Standing order', active: true }] }));
  const output = [];
  const stdout = (text) => output.push(text);
  assert.equal(await runSessionStart({ root, env: { HOME: root, USERPROFILE: root },
    stdin: JSON.stringify({ cwd: root }), stdout }), 0);
  assert.equal(await runPostCompact({ root, stdin: JSON.stringify({ cwd: root }), stdout }), 0);
  assert.ok(output.length > 0, 'the hooks answered');
  for (const text of output) assert.ok(!forbiddenCommand(text), `the hooks: ${text}`);
});

/**
 * The source without its comments: the strings stay, the comments go.
 *
 * @param {string} source the source of a file
 * @returns {string} the code of the file
 */
function codeOf(source) {
  let out = '';
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (char === '/' && source[index + 1] === '/') {
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }
    if (char === '/' && source[index + 1] === '*') {
      index += 2;
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) index += 1;
      index += 2;
      continue;
    }
    if (char === '\'' || char === '"' || char === '`') {
      const quote = char;
      out += char;
      index += 1;
      while (index < source.length) {
        if (source[index] === '\\') {
          out += source.slice(index, index + 2);
          index += 2;
          continue;
        }
        out += source[index];
        if (source[index] === quote) {
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}

// The files whose strings name a command of the kit that the person may not run, and why.
// | file | why |
// | src/autostart.js | the unit of the machine starts the daemon; it is a file of the system, not a text the model reads |
// | src/smoke.js | every line of the smoke carries the name of the command that is running; it is a label, not an instruction |
const ALLOWED = new Map([
  ['src/autostart.js', 'the unit of the machine starts the daemon; it is a file of the system, not a text the model reads'],
  ['src/smoke.js', 'every line of the smoke carries the name of the command that is running; it is a label, not an instruction'],
]);

// | the source | must hold | must refuse |
// | every message table | no command of the kit but the five | `okit-plugin quota set`, `{command} autostart install` |
test('no message table of the source names a command of the kit the person may not run', async () => {
  const files = [];
  const walk = async (folder) => {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name.endsWith('.js')) files.push(path);
    }
  };
  await walk(SRC_DIR);
  assert.ok(files.length > 0, 'the source has files');
  for (const path of files) {
    const name = relative(ROOT, path).split(sep).join('/');
    // The command line of the kit is the slice of the dispatch; the smoke runs the clients of their own.
    if (name === 'src/cli.js' || name.startsWith('src/smoke/')) continue;
    const source = await readFile(path, 'utf8');
    const literals = [...codeOf(source).matchAll(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g)]
      .map((match) => match[1] ?? match[2] ?? match[3]);
    const commands = [];
    for (const literal of literals) {
      // The name of the command and the word that follows it: the word is a command when it is one of the old ones or
      // when it is not a word of a sentence about the command itself.
      for (const match of literal.matchAll(new RegExp(`(${COMMAND}|\\{command\\})\\s+([a-z][a-z-]*)`, 'g'))) {
        if (isCommand(match[2])) commands.push(match[2]);
      }
      // A backticked phrase of two words: the first one is the verb of a command of the kit (`config unset`). The
      // commands of the clients (`claude plugin install ...`) are not commands of the kit.
      for (const match of literal.matchAll(/`([a-z][a-z-]*) ([^`]+)`/g)) {
        if (OLD_COMMANDS.has(match[1])) commands.push(match[1]);
      }
    }
    if (ALLOWED.has(name)) {
      assert.ok(commands.length > 0, `${name} is allow-listed for a reason it no longer has`);
      continue;
    }
    assert.deepEqual(commands, [], `${name} names a command of the kit the person may not run`);
  }
});
