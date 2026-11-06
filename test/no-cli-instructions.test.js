// D99 slice 6a: nothing the model reads tells it to run a command of the kit.
//
// The model works with the MCP tools; a command of the kit is a step of the person. So every text the model reads
// (the skills, the replies of the tools, the context of the hooks, the message tables) names a tool, names no flag of
// the command line, and names a command of the kit only when it is one of the five the person may run: install,
// update, uninstall, setup and doctor.
//
// | proof | what it holds |
// | the skills | the whole file, front matter included: no command but the five, no flag, no command of their own |
// | the runtime texts | the environment, the status, the actors and the two hooks, in both languages |
// | the message tables | the values of every table, filled with the sample values |
// | the source | the literals of the normalised code, as a second net |
// | the normaliser | the texts that are built by concatenation or by a template are seen |

import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { listActors } from '../src/actors.js';
import { CONFIG_SCHEMA } from '../src/config-schema.js';
import { DETECT_MESSAGES } from '../src/env/models.js';
import { LABELS } from '../src/env/quota.js';
import { environmentReport, formatEnvironmentReport } from '../src/env/report.js';
import { runPostCompact } from '../src/hook-post-compact.js';
import { runSessionStart } from '../src/hook-session-start.js';
import { TEXTS } from '../src/install/present.js';
import { TOOLS, TOOL_NAMES } from '../src/mcp/tools.js';
import { CONFIG_MESSAGES, DEFAULT_CONFIG } from '../src/profiles.js';
import { CONFIG_NOT_SAVED, CONFIG_UNREADABLE, SETUP_MESSAGES } from '../src/setup/setup.js';
import { runSetup } from '../src/setup/setup.js';
import { OFFER_MESSAGES } from '../src/setup/offer.js';
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
// Non-tool tokens actually used by the six skills, with their field/argument meaning.
const SKILL_TOKENS = new Map([
  ['okit', 'legacy install.command value'], ['kit', 'legacy install.command alias'],
  ['pass', 'critic verdict value'], ['revise', 'critic verdict value'], ['reject', 'critic verdict value'],
  ['accept', 'inbox acceptance field'], ['id', 'item identifier argument'],
  ['markdown', 'status response field'], ['capacityLine', 'status response field'],
  ['client', 'client selection argument'], ['L', 'size argument value'],
  ['event', 'quota_notice argument'], ['locale', 'per-call language argument'],
  ['available', 'quota_notice response field'], ['text', 'quota_notice response field'],
  ['language', 'saved language configuration key'], ['en', 'language default value'],
  ['planHash', 'smoke preview response field'], ['confirm', 'smoke confirmation argument'],
]);
// The exemptions of the rule, and they are all of one kind: every one of them is an explicit entry of an allow-list
// with a reason. None of them is decided by the shape of the text (whitespace, dots, quotes).

// The ordinary words of the prose around "tool" ("the tool answers", "in tool/command arguments", "a ferramenta
// responde"): they name no tool, so the phrase is not a reference to one.
const TOOL_NOUNS = new Set(['the', 'a', 'this', 'each', 'any', 'which', 'that', 'mcp', 'one', 'in', 'and',
  'responde']);
// The keys whose values are the arguments of a command: a flag there is the flag of the program, not of the kit.
// `args` is the argument list of the drivers, `argv` the one of a process, `versionArgs` the version arguments of the
// kit and `helpArgs`/`requiredFlags` the ones of the clients.
const ARGV_KEYS = new Set(['args', 'argv', 'versionArgs', 'helpArgs', 'requiredFlags']);
// The commands of another program, in backticks, that the model may check: only these, with their own flags.
const EXTERNAL_COMMANDS = new Set(['`node --version`', '`claude --version`', '`codex --version`', '`opencode --version`',
  '`npm run client-smoke -- --client <client>`']);
// The snake_case name of a tool, as the skills write it.
const SNAKE_CASE = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g;
// The name of a skill, as the skills mention each other.
const SKILL_NAME = /\bokit-[a-z-]+\b/g;
// A flag of the command line, as it is written.
const FLAG = /--[a-z][a-z-]*/g;

// The words of the commands the kit had, written down on purpose: the command line loses those commands in the next
// slice, and no text may name them again.
const OLD_COMMANDS = new Set(['config', 'quota', 'actors', 'env', 'status', 'smoke', 'smoke-demo', 'client-smoke',
  'inbox', 'telemetry', 'todo', 'order', 'orders', 'daemon', 'autostart', 'trajectory', 'limits', 'classify',
  'profile', 'kit', 'slot', 'release', 'acquire', 'mcp', 'role', 'hook', 'statusline-collector']);

// The words that continue a sentence about the command itself ("okit-plugin removed", "the shell finds okit-plugin at
// /path"): they are not commands, and the generic pattern of a command would say they are.
const NOT_A_COMMAND = new Set(['failed', 'removed', 'removido', 'kept', 'mantido', 'at', 'em', 'claude-code', 'codex',
  'opencode']);

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

/**
 * Whether the text names a command of the kit that the person may not run.
 *
 * @param {string} text the text a model reads
 * @returns {boolean}
 */
function forbiddenCommand(text) {
  for (const match of text.matchAll(new RegExp(`(${COMMAND}|\\{command\\})\\s+([a-z][a-z-]*)`, 'g'))) {
    if (isCommand(match[2])) return true;
  }
  return false;
}

/**
 * Whether the text names a flag of the command line outside a command the person may run.
 *
 * A flag is allowed only inside the span of a command the person may run (`okit-plugin install --client claude-code`),
 * which ends at the next backtick, period, semicolon or newline. An earlier mention of a command does not excuse a
 * flag that is somewhere else in the text.
 *
 * @param {string} text the text a model reads
 * @returns {boolean}
 */
function forbiddenFlag(text) {
  const spans = [...text.matchAll(new RegExp(`(?:${COMMAND}|\\{command\\})\\s+(?:${FIVE.join('|')})\\b(?:[^\\n\`;.]|\\.(?!\\s|$))*`, 'g'))]
    .map((match) => [match.index, match.index + match[0].length]);
  // The commands of another program that the model may check keep their own flags: only the ones listed, exactly.
  for (const command of EXTERNAL_COMMANDS) {
    const pattern = new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
    for (const match of text.matchAll(pattern)) spans.push([match.index, match.index + match[0].length]);
  }
  for (const match of text.matchAll(FLAG)) {
    const inside = spans.some(([from, to]) => match.index >= from && match.index < to);
    if (!inside) return true;
  }
  return false;
}

/**
 * Whether the text breaks the rule of the texts a model reads: a command of the kit the person may not run, a group of
 * the command line in backticks (`config show`), a flag outside a command the person may run, or a command of its own.
 *
 * @param {string} text the text a model reads
 * @param {{flags?: boolean}} [options] whether the flags are refused; the source holds the flags of the clients and of
 *   the configuration of the command line, which are not texts a model reads
 * @returns {boolean}
 */
function forbiddenText(text, { flags = true } = {}) {
  if (forbiddenCommand(text)) return true;
  // A backticked phrase of two words: the first one is the verb of a command of the kit. The real tools use
  // underscores (`config_set`), so they are not groups.
  for (const match of text.matchAll(/`([a-z][a-z-]*) [^`]+`/g)) {
    if (OLD_COMMANDS.has(match[1])) return true;
  }
  if (flags && forbiddenFlag(text)) return true;
  if (/node\s+"\$\{CLAUDE_PLUGIN_ROOT\}/.test(text)) return true;
  if (/\bnode\b[^\n`]*\bcli\.js\b/.test(text)) return true;
  if (/\bokit-plugin\b[^\n`]*\bcli\.js\b/.test(text)) return true;
  return false;
}

// The marks that quote or wrap a name in the prose of a skill: backticks, straight and curly quotes, guillemets,
// brackets and the stars of bold. An apostrophe between letters ("person's") is part of a word, not a quote.
const OPENING = '`"“«‘';
const CLOSING = '`"”»’';
const QUOTE_MARKS = /[`"“”«»()[\]*‘]|(?<!\p{L})['’]|['’](?!\p{L})/gu;

/**
 * Check single backticked words, and the phrases that name a tool even when the word is an allowed field or command.
 *
 * A name is judged whatever wraps it (backticks, quotes of any kind, brackets, bold) and whatever spaces are around it:
 * the quote marks are first turned into spaces and then one rule reads the words.
 */
function forbiddenSkillTool(text) {
  for (const [, name] of text.matchAll(/`(\w+)`/g)) {
    if (!TOOL_NAMES_SET.has(name) && !SKILL_TOKENS.has(name) && !FIVE.includes(name)) return true;
  }
  // A quoted name next to the word tool: `x` tool, "x" tool, tool “x”, ferramenta ‘x’.
  const quoted = new RegExp(
    `[${OPENING}]([^${OPENING}${CLOSING}\\n]+)[${CLOSING}]\\s+tool\\b|\\b(?:tool|ferramenta)\\s+[${OPENING}]([^${OPENING}${CLOSING}\\n]+)[${CLOSING}]`,
    'giu',
  );
  for (const match of text.matchAll(quoted)) {
    if (!TOOL_NAMES_SET.has(match[1] ?? match[2])) return true;
  }
  // The same phrases without or with other marks ("doctor tool", "(doctor) tool", "ferramenta doctor"): the word names
  // a tool of the server or it is ordinary prose.
  const plain = text.replace(QUOTE_MARKS, ' ');
  for (const match of plain.matchAll(/(?<![\w'’-])([\w'’-]+)\s+tool\b|(?<![\w'’-])ferramenta\s+([\w'’-]+)/gi)) {
    const word = match[1] ?? match[2];
    // A possessive or a contraction ("the person's tool") is prose: the names of the tools have no apostrophe.
    if (/['’]/.test(word) || TOOL_NOUNS.has(word.toLowerCase())) continue;
    if (!TOOL_NAMES_SET.has(word)) return true;
  }
  return false;
}

/**
 * Walk string values, never keys: the key of the value says what it is.
 *
 * The arguments of a command (`args`) carry the flags of the program; every other value is scanned with the flags on,
 * whether it has spaces or not.
 *
 * @param {unknown} value the value of the reply
 * @param {string} [key] the key the value sits under
 * @returns {boolean}
 */
function forbiddenValue(value, key = '') {
  if (typeof value === 'string') return forbiddenText(value, { flags: !ARGV_KEYS.has(key) });
  if (Array.isArray(value)) return value.some((entry) => forbiddenValue(entry, key));
  if (value && typeof value === 'object') {
    return Object.entries(value).some(([name, entry]) => forbiddenValue(entry, name));
  }
  return false;
}

/** JSON replies use the value walker; plain text replies always check flags. */
function forbiddenReply(reply) {
  let value;
  try { value = JSON.parse(reply); } catch { return forbiddenText(reply); }
  return forbiddenValue(value);
}

/** The folders of the skills, in the order of the disk. */
async function skillFolders() {
  const entries = await readdir(SKILLS_DIR, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

// | skill | must hold | must refuse |
// | every skill | no command but the five, no flag, no command of its own | `okit-plugin quota set`, `node .../cli.js` |
// | every skill | every snake_case name is a tool of the server | a name the server does not publish |
// | every skill | every skill it names exists | a skill that is not there |
test('no skill tells the model to run a command of the kit', async () => {
  const folders = await skillFolders();
  assert.ok(folders.length > 0, 'the plugin ships skills');
  for (const folder of folders) {
    // The whole file: the front matter is read by the model too.
    const text = await readFile(join(SKILLS_DIR, folder, 'SKILL.md'), 'utf8');
    assert.ok(!forbiddenText(text), `${folder} breaks the rule of the texts a model reads`);
    assert.ok(!forbiddenSkillTool(text), `${folder} names an unknown tool or backticked token`);
    for (const name of new Set(text.match(SNAKE_CASE) ?? [])) {
      assert.ok(TOOL_NAMES_SET.has(name), `${folder} names ${name}, which the server does not publish`);
    }
    for (const name of new Set((text.match(SKILL_NAME) ?? []).filter((named) => named !== COMMAND))) {
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

// The neutral note when no client was selected or detected.
const UNKNOWN = { en: 'Showing all clients', 'pt-BR': 'Mostrando todos os clientes' };

// | the text | must hold | must refuse |
// | the report of the environment | the tool that fixes it, the command of the person | `okit-plugin quota set` |
// | the object the model receives | no command of the kit in it | `command: "okit-plugin quota set ..."` |
// | the status and the actors | the same, and the note of the client that cannot be chosen | `okit-plugin config show` |
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
    assert.ok(!forbiddenText(formatEnvironmentReport(report, locale)), `env_report ${locale}`);
    // Check every string value: configuration tokens may hold flags, sentences may not.
    assert.ok(!forbiddenValue(report), `the report of the environment ${locale}`);
    const status = await statusTable(root, { ...deps, demands: [] });
    assert.ok(!forbiddenText(status.markdown), `status ${locale}`);
    assert.ok(!forbiddenText(status.capacityLine), `status ${locale}`);
    assert.ok(!forbiddenValue(status), `the status ${locale}`);
    // The world where the client cannot be chosen: the note that says how to choose it is really printed.
    assert.ok(status.markdown.includes(UNKNOWN[locale]), `status ${locale} says how to choose a client`);
    const actors = await listActors(deps);
    assert.ok(!forbiddenText(actors.markdown), `actors_list ${locale}`);
    assert.ok(!forbiddenValue(actors), `the actors ${locale}`);
    for (const note of actors.notes) assert.ok(!forbiddenText(note), `actors_list ${locale}`);
    assert.ok(actors.notes.some((note) => note.includes(UNKNOWN[locale])), `actors_list ${locale} says how to choose`);
    // The real replies of the tools of the server, in the two languages.
    for (const name of ['env_report', 'status', 'actors_list']) {
      const reply = await replyOf(name, { locale }, deps);
      assert.ok(!forbiddenReply(reply), `${name} ${locale}: ${reply}`);
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
  for (const text of output) assert.ok(!forbiddenText(text), `the hooks: ${text}`);
});

// The values of the placeholders of the texts: the name of the command of the kit is the configured one.
const VALUES = {
  command: COMMAND, client: 'claude-code', clients: 'claude-code', class: 'normal', classes: 'simple',
  model: 'model-a', models: 'model-a', path: '/tmp/okit', bin: '/tmp/okit/bin', where: '/tmp/okit',
  key: 'language', value: 'pt-BR', locale: 'en', reason: 'a reason', sizes: ['S'], size: 'M', code: '1',
  name: 'okit', shell: 'bash', found: '/tmp/okit', node: '/usr/bin/node', minimum: '20', version: '1.0.0',
  asset: 'okit-plugin', package: 'okit-plugin', system: 'linux', arch: 'x64', languages: 'en', msg: 'a message',
};

/**
 * The texts of a message table: every string of every locale, filled with the sample values, and the label functions
 * called with the sample arguments.
 *
 * @param {object} table the table of the messages
 * @returns {string[]} the texts of the table
 */
function textsOf(table) {
  const texts = [];
  const fill = (text) => text.replace(/\{(\w+)\}/g, (_, key) => String(VALUES[key] ?? `{${key}}`));
  const walk = (value) => {
    if (typeof value === 'string') { texts.push(fill(value)); return; }
    if (typeof value === 'function') {
      // The label functions take their arguments in their own order; the sample is a client and a command line.
      const result = value('claude-code', `${COMMAND} setup --again`);
      if (typeof result === 'string') texts.push(fill(result));
      return;
    }
    if (Array.isArray(value)) { for (const entry of value) walk(entry); return; }
    if (value && typeof value === 'object') { for (const entry of Object.values(value)) walk(entry); }
  };
  walk(table);
  return texts;
}

// The message tables of the plugin, imported: the values are what a model reads. The texts of the installer are for the
// person, who runs the commands of the CLI: a flag of the command line is fine there.
// | table | whose text it is |
// | LABELS | the model (the status, the actors and the report of the environment) |
// | DETECT_MESSAGES | the model (the report of the environment) |
// | SETUP_MESSAGES, CONFIG_UNREADABLE, CONFIG_NOT_SAVED | the setup, read by the person and by the model |
// | OFFER_MESSAGES | the offer of the installer, read by the person |
// | CONFIG_SCHEMA.messages | the model (the tool of the configuration) |
// | CONFIG_MESSAGES, the actors, the context after the compaction | the model |
// | TEXTS | the person (the installer and the doctor) |
const TABLES = [
  { table: LABELS, model: true },
  { table: DETECT_MESSAGES, model: true },
  { table: SETUP_MESSAGES, model: true },
  { table: CONFIG_UNREADABLE, model: true },
  { table: CONFIG_NOT_SAVED, model: true },
  { table: OFFER_MESSAGES, model: true },
  { table: CONFIG_SCHEMA.messages, model: true },
  { table: CONFIG_MESSAGES, model: true },
  { table: DEFAULT_CONFIG.actors.messages, model: true },
  { table: DEFAULT_CONFIG.postCompact.text, model: true },
  { table: TEXTS, model: false },
];

// | the table | must hold | must refuse |
// | every message table | no command of the kit but the five | `okit-plugin quota set`, `{command} autostart install` |
// | the tables the model reads | no flag of the command line | `use --client <name>` |
test('no message table names a command of the kit the person may not run', () => {
  for (const { table, model } of TABLES) {
    const texts = textsOf(table);
    assert.ok(texts.length > 0, 'the table has texts');
    for (const text of texts) {
      assert.ok(!forbiddenText(text, { flags: model }), `the table breaks the rule: ${text}`);
    }
  }
});

// The tools the setup's output may name: every one of them is a tool of the assistant.
const TOOL_NAME = /\b(?:quota_set|config_set|config_get|quota_show|env_report|smoke_demo|daemon|actors_list)\b/;

// | the output of the setup | must hold | must refuse |
// | every message that names a tool | it says the assistant calls it | "Call `quota_set`" without who calls it |
test('the output of the setup asks the assistant for the tool it names', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'okit-no-cli-setup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'config.json'), '{}');
  const adapter = { CLIENT: 'claude-code', listModels: async () => ({ client: 'claude-code', installed: true,
    models: ['haiku'], hidden: [], source: 'listing' }) };
  for (const [locale, asked] of [['en', 'assistant'], ['pt-BR', 'assistente']]) {
    let questions = 0;
    const result = await runSetup({ root, locale, adapters: [adapter],
      // The question of the model takes the model; the confirmation of what is saved takes the yes.
      ask: async (question) => {
        questions += 1;
        return /^(Choose a model|Escolha um modelo)/.test(question) ? 'haiku' : 'yes'; // locale:pt-BR
      },
      readQuota: async () => ({ source: 'off' }), run: async () => ({ code: 0, stdout: '' }),
      env: { HOME: root, USERPROFILE: root } });
    const messages = result.messages ?? [];
    assert.ok(messages.length > 0, `the setup says something (${locale})`);
    for (const message of messages) {
      if (!TOOL_NAME.test(message)) continue;
      assert.ok(message.includes(asked), `the setup names a tool without saying who calls it (${locale}): ${message}`);
    }
  }
});

// | the omitted class of the setup | must hold | must refuse |
// | no model chosen (defaults) | it asks the assistant to call `config_set` with the key | "call `config_set`" without who calls it |
test('the message of an omitted model asks the assistant for the tool', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'okit-no-cli-omitted-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const adapter = { CLIENT: 'claude-code', listModels: async () => ({ client: 'claude-code', installed: true,
    models: ['haiku'], hidden: [], source: 'listing' }) };
  for (const [locale, asked, key] of [['en', 'ask your assistant to call `config_set`', 'profiles.claude-code.simple.model'],
    ['pt-BR', 'peça ao seu assistente para chamar `config_set`', 'profiles.claude-code.simple.model']]) { // locale:pt-BR
    const result = await runSetup({ root, locale, defaults: true, adapters: [adapter],
      config: { profiles: { 'claude-code': { simple: { model: 'gone-model' } } } },
      readQuota: async () => ({ source: 'off' }), run: async () => ({ code: 0, stdout: '' }),
      env: { HOME: root, USERPROFILE: root } });
    const message = (result.messages ?? []).find((entry) => entry.includes('config_set'));
    assert.ok(message, `the setup says how to choose the omitted model (${locale})`);
    assert.ok(message.includes(asked), `the message does not ask the assistant (${locale}): ${message}`);
    assert.ok(message.includes(key), `the message does not name the key (${locale}): ${message}`);
  }
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

/**
 * The code as the program builds it: the literals of a concatenation joined, and the command of the configuration
 * written as `{command}` wherever a template builds it.
 *
 * What it cannot see: a text built by `join`, by a call or by a variable, or interpolations nested more than one
 * level. Those are covered by the runtime cases only. Quoted/template literals inside an expression stay in order.
 *
 * @param {string} code the code of a file
 * @returns {string} the normalised code
 */
function normalise(code) {
  let out = code;
  // The literals of a concatenation, joined: 'a' + 'b' → 'ab' (the same with " and across lines).
  for (let pass = 0; pass < 8; pass += 1) {
    const joined = out.replace(/(['"`])((?:[^\\]|\\.)*?)\1\s*\+\s*(['"`])((?:[^\\]|\\.)*?)\3/g,
      (all, first, left, second, right) => `${first}${left}${right}${first}`);
    if (joined === out) break;
    out = joined;
  }
  // Preserve literal suffixes as well as the configured command; leave opaque expressions visible.
  return out.replace(/\$\{((?:[^{}'"`]|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`|\{[^{}]*\})*)\}/g,
    (all, expression) => {
      const literals = [...expression.matchAll(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g)]
        .map((match) => match[1] ?? match[2] ?? match[3]).join('');
      const command = /command/i.test(expression) ? '{command}' : '';
      return command || literals ? command + literals : all;
    });
}

// The literals of the source that name a command of the kit, and why they may. The exemption is exact: the literal
// has to be there, and a new forbidden literal of the same file is still refused.
// | file | literal | why |
// | src/autostart.js | Description={command} daemon | the unit of the machine starts the daemon; it is a file of the system, not a text the model reads |
const ALLOWED = new Map([
  ['src/autostart.js', new Map([
    ['Description={command} daemon', 'the unit of the machine starts the daemon; it is a file of the system, not a text the model reads'],
  ])],
]);

// | the source | must hold | must refuse |
// | every literal | no command of the kit but the five | `okit-plugin quota set`, `{command} autostart install` |
test('no literal of the source names a command of the kit the person may not run', async () => {
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
    const code = normalise(codeOf(source));
    const literals = [...code.matchAll(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g)]
      .map((match) => match[1] ?? match[2] ?? match[3]);
    const exempt = ALLOWED.get(name) ?? new Map();
    for (const literal of literals) {
      if (exempt.has(literal)) {
        assert.ok(exempt.get(literal).length > 0, `${name}: the exemption of ${literal} has no reason`);
        continue;
      }
      // A flag is only refused in a literal that names the command of the kit: the source holds the flags of the
      // clients and of the configuration of the command line, which are not texts a model reads.
      const names = new RegExp(`(${COMMAND}|\\{command\\})`).test(literal);
      assert.ok(!forbiddenText(literal, { flags: names }), `${name} breaks the rule: ${literal}`);
    }
    for (const literal of exempt.keys()) {
      assert.ok(literals.includes(literal), `${name}: the exemption of ${literal} is not there any more`);
    }
  }
});

// | the fixture | must hold |
// | a text built by concatenation | it is forbidden |
// | a text built by a template | it is forbidden |
test('the normaliser sees the texts that are built', () => {
  assert.ok(forbiddenText(normalise("'Run okit-plugin ' + 'quota set 1'")), 'the concatenation is seen');
  assert.ok(forbiddenText(normalise('`${DEFAULT_CONFIG.install.command} quota set 1`')), 'the template is seen');
  assert.ok(forbiddenText(normalise('`${x.command} set 1`')), 'the template of a command is seen');
  assert.ok(!forbiddenText(normalise("'Run okit-plugin ' + 'setup'")), 'the command of the person is allowed');
  assert.equal(normalise('${command + " quota set codex 50"}'), '{command} quota set codex 50');
  assert.ok(forbiddenText(normalise('${command + " quota set codex 50"}')), 'the literal inside the interpolation is seen');
  assert.equal(normalise('${DEFAULT_CONFIG.install.command}'), '{command}');
  assert.equal(normalise('${value + "okit-plugin quota set codex 50"}'), 'okit-plugin quota set codex 50');
  assert.equal(normalise('${COMMAND + ` quota set codex 50`}'), '{command} quota set codex 50');
  assert.equal(normalise('${command + ({suffix: " quota set codex 50"}).suffix}'), '{command} quota set codex 50');
  assert.equal(normalise('${value + "okit-plugin " + suffix + "quota set codex 50"}'), 'okit-plugin quota set codex 50');
});

test('skill tool checks reject unknown words and tool phrases in both languages', () => {
  assert.ok(forbiddenSkillTool('`doctor` tool'));
  assert.ok(!forbiddenSkillTool('`smoke_demo`'));
  assert.ok(forbiddenSkillTool('`unknown`'));
  for (const name of ['doctor', 'client', 'missing_tool', 'missing-tool']) {
    for (const text of [`the \`${name}\` tool`, `tool \`${name}\``, `a ferramenta \`${name}\``, `ferramenta \`${name}\``]) {
      assert.ok(forbiddenSkillTool(text), text);
    }
  }
  for (const text of ['the `status` tool', 'tool `smoke_demo`', 'a ferramenta `daemon`', '`client`', '`setup`']) {
    assert.ok(!forbiddenSkillTool(text), text);
  }
  // The same phrases without the backticks: the word names a tool of the server or it is ordinary prose.
  assert.ok(forbiddenSkillTool('doctor tool'), 'doctor tool');
  assert.ok(forbiddenSkillTool('ferramenta doctor'), 'ferramenta doctor');
  // Whatever the spaces are, and the whole name counts, not its first word.
  assert.ok(forbiddenSkillTool('doctor\ntool'), 'a line break before tool');
  assert.ok(forbiddenSkillTool('ferramenta\ndoctor'), 'a line break after ferramenta');
  assert.ok(forbiddenSkillTool('ferramenta daemon-start'), 'a hyphenated name is validated whole');
  assert.ok(forbiddenSkillTool('the daemon-start tool'), 'a hyphenated name before tool');
  assert.ok(forbiddenSkillTool('doctor  tool'), 'two spaces');
  // Whatever wraps the name: quotes of any kind, brackets, bold.
  for (const text of ['Use the "doctor" tool.', 'Use a ferramenta \u201cdoctor\u201d.', 'the (doctor) tool', 'the *doctor* tool',
    'ferramenta \u2018doctor\u2019', 'the \u00abdoctor\u00bb tool', 'tool "doctor"', 'the \u201cdoctor\u201d tool', 'the **doctor** tool',
    'a ferramenta [doctor]']) {
    assert.ok(forbiddenSkillTool(text), text);
  }
  for (const text of ['the "status" tool', 'ferramenta \u201cdaemon\u201d', 'the person\u2019s tool', "the person's tool", 'the tool\u2019s answer',
    'Done. Tool answers', 'the (status) tool']) {
    assert.ok(!forbiddenSkillTool(text), text);
  }
  assert.ok(!forbiddenSkillTool('`smoke_demo` tool'), '`smoke_demo` tool');
  assert.ok(!forbiddenSkillTool('the tool answers'), 'the tool answers');
  assert.ok(!forbiddenSkillTool('The tool answers'), 'a capital at the start of a sentence');
  assert.ok(!forbiddenSkillTool('a ferramenta responde'), 'a ferramenta responde');
});

test('runtime value checks scan sentences at every depth and allow configuration tokens', () => {
  assert.ok(forbiddenValue({ guidance: 'Use --client to select one.' }));
  assert.ok(!forbiddenValue({ args: ['--model', 'x'] }));
  assert.ok(forbiddenValue({ nested: [{ guidance: 'Use --client to select one.' }] }));
  assert.ok(forbiddenValue({ args: ['okit-plugin quota'] }), 'tokens still check commands');
  assert.ok(!forbiddenValue({ 'Use --client': [null, true, 1, 'claude-code'] }), 'keys are not values');
  assert.ok(forbiddenReply(JSON.stringify({ guidance: 'Use --client to select one.' })));
  assert.ok(!forbiddenReply(JSON.stringify({ args: ['--model', 'x'] })));
  assert.ok(forbiddenReply('Use --client to select one.'));
  assert.ok(forbiddenReply('--client'), 'plain text replies check even a standalone flag');
  // A bare flag token is refused everywhere but in the arguments of a command: the shape of the text decides nothing.
  assert.ok(forbiddenValue({ guidance: '`--client`' }), 'a flag in backticks');
  assert.ok(forbiddenValue({ guidance: '--client' }), 'a bare flag token');
  assert.ok(forbiddenValue({ note: ['--client'] }), 'a bare flag token in an array');
  assert.ok(!forbiddenValue({ args: ['--model', 'x'] }), 'the arguments of a command carry the flags of the program');
  assert.ok(forbiddenValue({ args: ['okit-plugin quota'] }), 'the commands are still checked in the arguments');
});

// | the fixture | must hold | must refuse |
// | a flag | inside the span of a command of the person | a flag after a mention of `setup` somewhere else in the text |
// | a group in backticks | none | `config show`, `quota set 1` |
test('the rule of the texts has teeth', () => {
  assert.ok(!forbiddenText('Ask the user to run `okit-plugin install --client claude-code`.'), 'the flag of a command of the person');
  assert.ok(forbiddenText('Ask the user to run `okit-plugin setup`. Use --client to select a client.'), 'a flag after a mention of setup');
  assert.ok(forbiddenText('Use --client to select a client.'), 'a bare flag');
  assert.ok(!forbiddenText('Run `npm run client-smoke -- --client <client>`.'), 'the maintainer npm runner');
  assert.ok(forbiddenText('Run `npm run client-smoke -- --client <client>`. Use --client elsewhere.'), 'npm flags stay inside their command');
  assert.ok(!forbiddenText('Node 22 is required: check it with `node --version`.'), 'the flag of another program in backticks');
  assert.ok(forbiddenText('Use `--client` to select a client.'), 'a flag alone in backticks is the flag of the kit');
  assert.ok(forbiddenText('Ask the user to run okit-plugin setup. Use --client.'), 'a period closes an unquoted command');
  assert.ok(!forbiddenText('Run okit-plugin install --client claude-code and wait.'), 'an unquoted installation flag');
  assert.ok(!forbiddenText('okit-plugin install --client x.y'), 'a period within a word stays in the command');
  assert.ok(!forbiddenText('okit-plugin install config.json 1.2 --client x'), 'internal periods do not close the span');
  assert.ok(forbiddenText('okit-plugin setup\nUse --client.'), 'a newline closes the command');
  assert.ok(forbiddenText('Run `config show` to view the settings.'), 'a group in backticks');
  assert.ok(forbiddenText('Run `quota set codex 50`.'), 'a group with arguments');
  assert.ok(!forbiddenText('Call `config_set` with the key.'), 'a tool is not a group');
  assert.ok(forbiddenText('node "${CLAUDE_PLUGIN_ROOT}/bin/cli.js" status'), 'the cli of the plugin');
  // The commands of another program: only the ones listed keep their own flags.
  assert.ok(!forbiddenText('check it with `node --version`.'), 'the version of node');
  assert.ok(forbiddenText('`node --client`'), 'a flag of another program that is not listed');
  const cli = 'Run `node ./src/cli.js status --client codex`.';
  assert.ok(forbiddenText(cli), 'the flags of a command that is not listed');
  assert.ok(forbiddenText(cli, { flags: false }), 'the cli of the plugin, whatever the dots are');
  assert.ok(forbiddenText('Run okit-plugin setup ./src/cli.js.', { flags: false }), 'the cli after a command of the plugin');
});
