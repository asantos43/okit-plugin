import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { calls, dotted, insideCallTo, tokenize, topLiterals, topMembers } from './helpers/source-scan.js';
import { renderInstallScripts } from '../src/release/install-scripts.js';

// The invariants of the installer's output, checked over the whole set of files that print (not over the examples
// someone thought of). A new line of code that breaks one fails here, with the file and the text.
//
// Must pass / must refuse:
// | invariant | must pass | must refuse |
// | I1 text of the user | every text in an output call comes from the presenter (ui.text, t(), pick) | a literal sentence in an output call |
// | I2 one door | stdout and stderr only through redactingWriter / redactingStream / the cli door | console.*, process.stdout.write, a readline on a raw stream |
// | I6 one language | one function resolves it; the only other readers are the shell preludes before Node exists | a second read of OKIT_LANGUAGE or of the saved language |

const root = new URL('../', import.meta.url);
const read = (path) => fs.readFile(new URL(path, root), 'utf8');

/** Every .js file under a folder, at any depth, as paths from the root of the repository. */
async function walkJs(folder) {
  const out = [];
  for (const entry of await fs.readdir(new URL(folder, root), { withFileTypes: true })) {
    const path = `${folder}/${entry.name}`;
    if (entry.isDirectory()) out.push(...await walkJs(path));
    else if (entry.name.endsWith('.js')) out.push(path);
  }
  return out.sort();
}

/** The installer's files: everything in src/install and src/setup, and what src/cli.js runs for them. */
async function installerSources() {
  const files = [];
  for (const folder of ['src/install', 'src/setup']) {
    for (const file of await walkJs(folder)) files.push({ file, source: await read(file) });
  }
  // src/cli.js is the whole program; the installer owns the parts that install, set up and probe the kit.
  const cli = await read('src/cli.js');
  const slice = (from, to) => {
    const start = cli.indexOf(from);
    assert.ok(start >= 0, `src/cli.js: ${from} not found`);
    const end = cli.indexOf(to, start + from.length);
    assert.ok(end > start, `src/cli.js: end of ${from} not found`);
    return cli.slice(start, end);
  };
  files.push({ file: 'src/cli.js (setupCommand)', source: slice('function refuse(ctx, locale', '\nasync function quotaCommand') });
  files.push({ file: 'src/cli.js (installerLifecycle)', source: slice('function installerLifecycle', '\n/**\n * Runs one') });
  files.push({ file: 'src/cli.js (kit)', source: slice("if (group === 'kit')", "if (['install', 'update', 'uninstall'].includes(group))") });
  files.push({ file: 'src/cli.js (door)', source: slice('const door = ', "const now = io.now") });
  files.push({ file: 'src/cli.js (main)', source: slice('export async function main', '\n/**\n * The `okit` entry point') });
  return files.filter(({ file }) => file !== 'src/install/present.js').map((item) => ({ ...item, tokens: tokenize(item.source) }));
}

// ---------------------------------------------------------------------------------------------------------------
// I1: no sentence of the program written in an output call.

/** The calls that put text on the screen: the presenter's lines and the writers the commands hold. */
const OUTPUT = new Set(['row', 'detail', 'warn', 'explain', 'note', 'summary', 'header', 'out', 'err', 'say', 'ok', 'skip', 'plan', 'fail', 'question']);
// Words that are not text: the status keys of a row and the verb of a request line.
const NOT_TEXT = new Set(['ok', 'info', 'skipped', 'failed', 'plan', 'GET', 'operational', 'usage', 'language']);
// Output calls that may carry a raw text (what a process or the system said) and why. The key is "file: callee: member".
const RAW_ALLOWED = new Map([
  ['src/install/policy.js: detail: error.message', 'the text PowerShell raised, shown only with --verbose, after our own label'],
  ['src/install/bootstrap.js: fail: result.stderr', 'what a child process (uname, curl, PowerShell) printed is passed on as it came'],
  ['src/install/bootstrap.js: fail: result.error', 'the system error of a child process that could not start'],
  ['src/install/register.js: detail: error.message', 'the text the adapter module raised when it could not be loaded, shown only with --verbose after our own label'],
  ['src/install/index.js: detail: result.stdout', 'what the smoke command printed, shown only with --verbose'],
  ['src/install/index.js: failure: error.message', 'the presenter translates the reason (REASONS) and redacts it'],
  ['src/cli.js (main): err: error.message', 'an unexpected failure of any command, after the command name; the door redacts it for the installer\'s groups'],
]);

test('I1: no output call writes a sentence of its own; the text comes from the presenter, t() or pick', async () => {
  const sources = await installerSources();
  const raised = [];
  let checked = 0;
  for (const { file, tokens } of sources) {
    for (const call of calls(tokens)) {
      if (!OUTPUT.has(call.last)) continue;
      // A call named like an output but with nothing of ours to say (an assert, a method of a promise) has no arguments.
      checked += 1;
      for (const literal of topLiterals(call.args)) {
        const words = (literal.match(/[A-Za-z]{3,}/g) ?? []).filter((word) => !NOT_TEXT.has(word));
        if (words.length) raised.push(`${file}: ${call.callee}(${JSON.stringify(literal)}): text outside the presenter`);
      }
      for (const member of topMembers(call.args)) {
        const raw = member.match(/\.(message|stderr|stdout)$/);
        if (raw && !RAW_ALLOWED.has(`${file}: ${call.last}: ${member}`)) raised.push(`${file}: ${call.callee}(... ${member} ...): a raw text; say why in RAW_ALLOWED`);
      }
    }
  }
  assert.ok(checked > 40, `only ${checked} output calls found: the scan is not reading the code`);
  assert.deepEqual(raised, []);
});

test('I1: the raw texts that are allowed still exist (an entry no code uses is removed)', async () => {
  const used = new Set();
  for (const { file, tokens } of await installerSources()) {
    for (const call of calls(tokens)) for (const member of topMembers(call.args)) used.add(`${file}: ${call.last}: ${member}`);
  }
  for (const key of RAW_ALLOWED.keys()) assert.ok(used.has(key), `RAW_ALLOWED has an entry that no code needs: ${key}`);
});

const PROGRAMMER_ERRORS = new Map([
  ['src/state.js: x: x', 'faultError: the fault a test injects into a step of the state writer (a code, never a sentence for a person)'],
  ['src/env/models.js: listModels is not a function', 'an adapter without listModels: a bug of the caller'],
  ['src/env/snapshot.js: timeout', 'an internal timer rejection, coded ETIMEDOUT and caught by the snapshot'],
  ['src/env/snapshot.js: client must be one of ', 'a call of the snapshot with an unknown client: a bug of the caller'],
  ['src/env/snapshot.js: all must be a boolean', 'a call of the snapshot with a wrong option: a bug of the caller'],
  ['src/install/exit.js: Unknown exit kind: x', 'exitCodeFor called with a kind that does not exist: a bug of the caller'],
  ['src/setup/setup.js: root is required', 'runSetup called without a root: a bug of the caller, never a user input']]);

// The modules whose refusals can reach the installer's screen are chosen by a rule, not by a list of files: the
// static imports reachable from src/install/** and src/setup/**, minus the other commands' own subsystems below
// (each with the reason it is not the installer's output). A new module the installer imports is scanned at once.
const OTHER_COMMANDS = new Map([
  ['adapters/', 'the client adapters: their errors go to the daemon and the MCP tools, never to the installer\'s screen'],
  ['src/telemetry/', 'the telemetry command: its own refusals, in its own words'],
  ['src/trajectory/', 'the trajectory command: its own refusals, in its own words'],
  ['src/orders.js', 'standing orders: argument checks of the MCP tools and the inbox, English by contract'],
  ['src/applies.js', 'appliesTo checks of the MCP tools, English by contract'],
  ['src/skills.js', 'skill checks of the MCP tools, English by contract'],
  ['src/roles.js', 'role checks of the daemon'],
  ['src/spawn-process.js', 'starts the clients for the daemon'],
  ['src/hook-post-compact.js', 'a hook of the client, a machine protocol'],
]);

/** The files the installer imports, directly or not (`import ... from './x.js'`), without the other commands' subsystems. */
async function installerClosure() {
  const seen = new Set();
  const queue = [];
  for (const folder of ['src/install', 'src/setup']) {
    for (const name of await fs.readdir(new URL(folder, root))) if (name.endsWith('.js')) queue.push(`${folder}/${name}`);
  }
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    for (const match of (await read(file)).matchAll(/(?:^|\n)\s*(?:import|export)\b[^'"\n;]*?from\s*['"](\.[^'"]+)['"]|(?:^|\n)\s*import\s*['"](\.[^'"]+)['"]/g)) {
      const target = join(file, '..', match[1] ?? match[2]).replaceAll('\\', '/');
      if ([...OTHER_COMMANDS.keys()].some((prefix) => target.startsWith(prefix))) continue;
      if (await fs.stat(new URL(target, root)).then(() => true, () => false)) queue.push(target);
    }
  }
  return [...seen].sort();
}

// A refusal whose text is not a literal, outside the presenter's own calls, and why it is not the installer's.
const NON_LITERAL_ALLOWED = new Map([
  ['src/config-schema.js: CONFIG_SCHEMA.messages.', 'assertSavedValues: the one bilingual line of `config set` (CONFIG_SCHEMA.messages.invalidValue), so that a saved value and a typed one are refused with the same words'],
  ['src/profiles.js: fill(profileMessages.', 'profilePick: the texts of `profileMessages` are a user setting of the daemon\'s profile choice, bilingual by their own configuration'],
]);

test('I1/R12-2: every refusal the code raises is translated, in the modules the installer imports (chosen by rule, not by a list)', async () => {
  const { localizeReason, pick, TEXTS } = await import('../src/install/present.js');
  const { CONFIG_MESSAGES } = await import('../src/profiles.js');
  // Where a refusal takes its text from something other than a literal, and why that is not a bilingual sentence.
  const FROM_PRESENTER = /^(unreadable\(|formatUnreadable\(|formatNotSaved\(|format\(|refusalText\(|ui\.text\(|pick\(|message$|delivery\.reason)/;
  const sites = [];
  const open = [];
  const bilingual = [];
  const missing = [];
  const files = await installerClosure();
  assert.ok(files.length > 25 && files.includes('src/profiles.js') && files.includes('src/store.js'), files.join(', '));
  for (const file of files) {
    if (file === 'src/install/bootstrap.js' || file === 'src/install/present.js') continue;
    const tokens = tokenize(await read(file));
    for (const call of calls(tokens)) {
      if (!/Error$/.test(call.last) || tokens[call.at - 1]?.v !== 'new') continue;
      const first = call.args[0];
      if (call.last === 'ConfigError') {
        assert.equal(first?.t, 's', `${file}: a ConfigError takes the literal code of CONFIG_MESSAGES`);
        assert.ok(Object.hasOwn(CONFIG_MESSAGES, first.v), `${file}: ConfigError('${first.v}') is not in CONFIG_MESSAGES`);
        sites.push({ file, code: first.v });
      } else if (first?.t === 's' || first?.t === 'tpl') {
        const text = first.t === 's' ? first.v : first.chunks.join('x');
        // "English / Português" in one message is two languages in one line: never allowed, not skipped.
        if (text.includes(' / ')) bilingual.push(`${file}:${first.line}: ${text}`);
        else sites.push({ file, reason: text });
      } else {
        const head = call.args.slice(0, 4).map((token) => token.v).join('');
        if (!FROM_PRESENTER.test(head) && !NON_LITERAL_ALLOWED.has(`${file}: ${head}`)) open.push(`${file}: new ${call.last}(${head}...`);
      }
    }
  }
  assert.ok(sites.length > 60, `only ${sites.length} refusals found`);
  assert.deepEqual(bilingual, [], 'a message with both languages in one line; put it in CONFIG_MESSAGES (src/profiles.js) or REASONS (src/install/present.js)');
  assert.deepEqual(open, [], 'a refusal whose text is not a literal must come from the presenter');
  for (const site of sites) {
    // A programmer's error (a call without its argument) never reaches a user's screen.
    if (site.reason !== undefined && PROGRAMMER_ERRORS.has(`${site.file}: ${site.reason}`)) continue;
    if (site.reason === undefined) continue;
    if (localizeReason(site.reason, "pt-BR") === site.reason) missing.push(`${site.file}: ${site.reason}`);
  }
  assert.deepEqual(missing, [], 'a refusal with no pt-BR text (REASONS in present.js, or CONFIG_MESSAGES in profiles.js)');
  for (const [name, entry] of Object.entries(CONFIG_MESSAGES)) {
    assert.notEqual(entry.en, entry['pt-BR'], `${name}: the same text in both languages`);
    assert.ok(!entry.en.includes(' / ') && !entry['pt-BR'].includes(' / '), `${name}: a message with both languages`);
    assert.deepEqual(entry.en.match(/\{\w+\}/g) ?? [], entry['pt-BR'].match(/\{\w+\}/g) ?? [], `${name}: the parameters differ between the languages`);
  }
  assert.notEqual(pick(TEXTS.statuslineError, 'pt-BR'), pick(TEXTS.statuslineError, 'en'));
});

// ---------------------------------------------------------------------------------------------------------------
// I2: one door for the output.

const WRITERS = ['redactingWriter', 'redactingStream', 'door'];
// Places that touch a stream or start a process without the door, each with the reason it is safe.
const DOOR_EXCEPTIONS = new Map([
  ['src/install/bootstrap.js: stdio inherit', 'the child is this program (okit-plugin install ...): its own output already goes through the cli door'],
  ['src/install/index.js: process.stdout.isTTY', 'reads whether the output is a terminal; writes nothing'],
  ['src/install/bootstrap.js: process.stdout.isTTY', 'reads whether the output is a terminal; writes nothing'],
  ['src/install/bootstrap.js: process.stdin.isTTY', 'reads whether the input is a terminal; writes nothing'],
  ['src/install/index.js: process.stdin.isTTY', 'reads whether the input is a terminal; writes nothing'],
  ['src/setup/setup.js: process.stdout', 'the default of the reader, which wraps it in redactingStream on the next line'],
]);

/** Everything in the file set that writes to the screen or hands a stream or a terminal to something else. */
function doorFindings(file, tokens) {
  const found = [];
  const watch = dotted(tokens).filter(({ name }) => /^(console\.(log|error|warn|info|debug)|process\.(stdout|stderr)(\.\w+)?)$/.test(name));
  for (const { name, tokens: list, at } of watch) {
    if (insideCallTo(list, at, WRITERS)) continue;
    found.push(`${file}: ${name}`);
  }
  for (const call of calls(tokens)) {
    if (call.last === 'createInterface' && !call.args.some((token) => token.t === 'id' && token.v === 'redactingStream')) {
      found.push(`${file}: createInterface without redactingStream`);
    }
  }
  tokens.forEach((token, at) => {
    if (token.t === 'id' && token.v === 'stdio' && tokens[at + 1]?.v === ':' && tokens[at + 2]?.v === 'inherit') found.push(`${file}: stdio inherit`);
  });
  return found;
}

test('I2: nothing in the installer writes to stdout or stderr except through the one door', async () => {
  const raised = [];
  for (const { file, tokens } of await installerSources()) {
    for (const item of doorFindings(file, tokens)) {
      const key = item.replace(/^(src\/[\w/.-]+)(?: \([^)]*\))?:/, '$1:');
      if (!DOOR_EXCEPTIONS.has(key)) raised.push(item);
    }
  }
  assert.deepEqual(raised, [], 'an output outside redactingWriter / redactingStream / the cli door; add it to the door or justify it in DOOR_EXCEPTIONS');
});

test('I2: the exceptions of the door still exist (an entry no code needs is removed)', async () => {
  const used = new Set();
  for (const { file, tokens } of await installerSources()) {
    for (const item of tokens && doorFindings(file, tokens)) used.add(item.replace(/^(src\/[\w/.-]+)(?: \([^)]*\))?:/, '$1:'));
    // The reads of isTTY and the default of the reader are found as dotted names inside the door or beside it.
    for (const { name } of dotted(tokens)) if (/^process\.(stdin|stdout)/.test(name)) used.add(`${file.replace(/ \(.*\)/, '')}: ${name.replace(/\.(write|isTTY)$/, name.endsWith('isTTY') ? '.isTTY' : '')}`);
  }
  for (const key of DOOR_EXCEPTIONS.keys()) assert.ok(used.has(key), `DOOR_EXCEPTIONS has an entry that no code needs: ${key}`);
});

test('I2: the scripts the build generates write only through the door as well', async () => {
  const pkg = JSON.parse(await read('package.json'));
  const rendered = await renderInstallScripts('.', pkg);
  for (const [name, script] of Object.entries(rendered)) {
    // The program of the script is the part the shell hands to Node; the shell's own lines are checked in install-scripts.test.js.
    const raised = [];
    const tokens = tokenize(script.slice(script.indexOf('// BEGIN OKIT CONFIG')));
    for (const { name: used, tokens: list, at } of dotted(tokens).filter(({ name: item }) => /^(console\.(log|error|warn|info|debug)|process\.(stdout|stderr)\.write)$/.test(item))) {
      if (!insideCallTo(list, at, WRITERS)) raised.push(used);
    }
    assert.deepEqual(raised, [], `${name}: a write outside redactingWriter`);
    assert.ok(/redactingWriter\(\(line\) => console\.error\(line\)\)/.test(script), `${name}: the error door is gone`);
    assert.ok(/redactingWriter\(\(line\) => console\.log\(line\), hide\)/.test(script), `${name}: the output door is gone`);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// I6: one function resolves the language.

test('I6: OKIT_LANGUAGE is read by resolveLocale and by the shell preludes before Node exists, nowhere else', async () => {
  const sourceFiles = async (folder) => {
    const out = [];
    for (const entry of await fs.readdir(new URL(folder, root), { withFileTypes: true })) {
      const path = `${folder}/${entry.name}`;
      if (entry.isDirectory()) out.push(...await sourceFiles(path));
      else if (entry.name.endsWith('.js')) out.push(path);
    }
    return out;
  };
  const files = await sourceFiles('src');
  assert.ok(files.length > 50);
  const readers = [];
  for (const file of files) {
    const visit = (list) => list.forEach((token) => {
      if (token.t === 'tpl') token.exprs.forEach(visit);
      if ((token.t === 's' || token.t === 'id') && token.v.includes('OKIT_LANGUAGE')) readers.push(file);
      if (token.t === 'tpl' && token.chunks.some((chunk) => chunk.includes('OKIT_LANGUAGE'))) readers.push(file);
    });
    visit(tokenize(await read(file)));
  }
  assert.deepEqual([...new Set(readers)].sort(), ['src/install/present.js', 'src/release/install-scripts.js'],
    'OKIT_LANGUAGE is read by resolveLocale (present.js) and by the preludes of the generated scripts (install-scripts.js)');
});

test('I6: the saved language and --locale are read only to be handed to resolveLocale', async () => {
  const raised = [];
  let handed = 0;
  for (const { file, tokens } of await installerSources()) {
    const visit = (list) => list.forEach((token, at) => {
      if (token.t === 'tpl') token.exprs.forEach(visit);
      // The saved language: a property named `language`, which belongs inside the call that resolves it.
      if (token.t === 'id' && token.v === 'language' && list[at - 1]?.v === '.' && list[at - 1].t === 'p') {
        if (insideCallTo(list, at, ['resolveLocale'])) handed += 1; else raised.push(`${file}: ${list[at - 2]?.v}.language outside resolveLocale`);
      }
      if (token.t === 'id' && token.v === 'localeOf') raised.push(`${file}: localeOf (the other commands' resolver) in the installer`);
    });
    visit(tokens);
    for (const call of calls(tokens)) {
      if (['indexOf', 'lastIndexOf', 'includes'].includes(call.last) && call.args.some((token) => token.t === 's' && token.v === '--locale')) {
        raised.push(`${file}: --locale searched in the arguments outside resolveLocale`);
      }
    }
  }
  assert.ok(handed >= 2, 'the installer and the kit command hand the saved language to resolveLocale');
  assert.deepEqual(raised, []);
});

test('I6: the shell preludes read OKIT_LANGUAGE only to name the language of "Node is missing"', async () => {
  const source = await read('src/release/install-scripts.js');
  const lines = source.split('\n').filter((line) => line.includes('OKIT_LANGUAGE') && !line.trim().startsWith('//') && !line.trim().startsWith('*'));
  assert.ok(lines.length >= 2 && lines.length <= 6, `${lines.length} lines read OKIT_LANGUAGE`);
  for (const line of lines) assert.match(line, /okit_lang|okitLang/, `a read of OKIT_LANGUAGE that is not the prelude's: ${line}`);
});

// ---------------------------------------------------------------------------------------------------------------
// Round 12: the structure, so a new bypass fails here and not in a review. Three scans over the whole source:
// no write to the screen outside the door, no read of the language outside resolveLocale, no exit code outside
// exitCodeFor. Each finding is named `file:line`.

async function allSources() {
  const files = [];
  for (const file of await walkJs('src')) files.push({ file, source: await read(file) });
  return files.map((item) => ({ ...item, tokens: tokenize(item.source) }));
}

// Writes to the screen that are not the installer's, each with the reason it is not (key: "file: name").
const SCREEN_ELSEWHERE = new Map([
  ['src/cli.js: process.stdout', 'the question of `inbox take` (an inbox command, not the installer), read by a readline on the terminal'],
  ['src/setup/setup.js: process.stdout', 'the default of the reader, which wraps it in redactingStream on the next line'],
  ['src/mcp/server.js: process.stdout', 'the MCP protocol: JSON-RPC messages are its output, not text for a person'],
  ['src/mcp/server.js: process.stderr.write', 'the MCP server log of a failure it cannot answer on the protocol'],
  ['src/quota/statusline-collector.js: process.stdout.write', 'the statusline collector prints the line the client shows; not the installer'],
  ['src/smoke/client.js: process.stdout.write', 'the smoke runner prints its own facts; not the installer'],
  ['src/smoke.js: process.stdout.write', 'the smoke runner prints its own facts; not the installer'],
  ['src/smoke.js: process.stderr.write', 'the smoke runner prints its own facts; not the installer'],
  ['src/spawn-process.js: process.stderr.write', 'relays the stderr of a client the daemon started; not the installer'],
]);

function screenFindings(file, tokens) {
  const found = [];
  for (const { name, tokens: list, at } of dotted(tokens)) {
    if (!/^(console\.\w+|process\.(stdout|stderr)(\.\w+)*)$/.test(name)) continue;
    // Reading whether the stream is a terminal, or how wide it is, writes nothing.
    if (/\.(isTTY|columns|rows|hasColors)$/.test(name)) continue;
    if (insideCallTo(list, at, WRITERS)) continue;
    found.push({ key: `${file}: ${name}`, where: `${file}:${list[at].line}: ${name}` });
  }
  return found;
}

test('round 12: no console.*, process.stdout or process.stderr in src/** outside the door and the presenter', async () => {
  const raised = [];
  for (const { file, tokens } of await allSources()) {
    for (const item of screenFindings(file, tokens)) if (!SCREEN_ELSEWHERE.has(item.key)) raised.push(item.where);
  }
  assert.deepEqual(raised, [], 'a write to the screen outside redactingWriter / redactingStream / the cli door; route it through the presenter or justify it in SCREEN_ELSEWHERE');
});

test('round 12: the places that write to the screen elsewhere still exist (an entry no code needs is removed)', async () => {
  const used = new Set();
  for (const { file, tokens } of await allSources()) for (const item of screenFindings(file, tokens)) used.add(item.key);
  for (const key of SCREEN_ELSEWHERE.keys()) assert.ok(used.has(key), `SCREEN_ELSEWHERE has an entry that no code needs: ${key}`);
});

test('round 12: the language is read by resolveLocale only (OKIT_LANGUAGE, the saved language, --locale), in the installer\'s files and in main', async () => {
  const raised = [];
  for (const { file, tokens } of await installerSources()) {
    tokens.forEach((token, at) => {
      if (token.t === 'id' && token.v === 'language' && tokens[at - 1]?.v === '.' && tokens[at - 1].t === 'p' && !insideCallTo(tokens, at, ['resolveLocale'])) {
        raised.push(`${file}:${token.line}: .language read outside resolveLocale`);
      }
      if ((token.t === 's' || token.t === 'id') && token.v.includes('OKIT_LANGUAGE')) raised.push(`${file}:${token.line}: OKIT_LANGUAGE read outside resolveLocale`);
    });
  }
  assert.deepEqual(raised, []);
});

/**
 * Every place that decides an exit code by writing a number: `return 1`, `return x ? 1 : 2`, `process.exitCode = 2`,
 * `code: 2`. The numbers belong to exitCodeFor (src/install/exit.js); everything else asks it.
 */
function exitLiterals(file, tokens) {
  const found = [];
  const isCode = (token) => token?.t === 'n' && (token.v === '1' || token.v === '2');
  const where = (token, what) => `${file}:${token.line}: ${what}`;
  tokens.forEach((token, at) => {
    if (token.t === 'tpl') token.exprs.forEach((expr) => found.push(...exitLiterals(file, expr)));
    if (token.t === 'id' && token.v === 'return') {
      // The statement: up to the first `;` or `}` at the depth of the return.
      let depth = 0;
      for (let i = at + 1; i < tokens.length; i += 1) {
        const next = tokens[i];
        if (next.t === 'p' && '([{'.includes(next.v)) depth += 1;
        if (next.t === 'p' && ')]}'.includes(next.v)) { if (depth === 0) break; depth -= 1; }
        if (next.t === 'p' && next.v === ';' && depth === 0) break;
        if (isCode(next) && depth === 0 && (i === at + 1 || ['?', ':'].includes(tokens[i - 1].v))) found.push(where(next, `return ... ${next.v}`));
      }
    }
    if (token.t === 'id' && token.v === 'exit' && tokens[at - 1]?.v === '.' && tokens[at + 1]?.v === '(' && isCode(tokens[at + 2])) {
      found.push(where(tokens[at + 2], `exit(${tokens[at + 2].v})`));
    }
    if (token.t === 'id' && ['exitCode', 'code'].includes(token.v) && ['=', ':'].includes(tokens[at + 1]?.v) && isCode(tokens[at + 2])) {
      found.push(where(tokens[at + 2], `${token.v} ${tokens[at + 1].v} ${tokens[at + 2].v}`));
    }
  });
  return found;
}

test('round 12: no exit code is a number written in the installer\'s path; they all come from exitCodeFor', async () => {
  const raised = [];
  const files = (await allSources()).filter(({ file }) => (/^src\/(install|setup)\//.test(file) || ['src/cli.js', 'src/config.js', 'src/config-schema.js', 'src/release/install-scripts.js'].includes(file)) && file !== 'src/install/exit.js');
  assert.ok(files.length > 15);
  for (const { file, tokens } of files) raised.push(...exitLiterals(file, tokens));
  const pkg = JSON.parse(await read('package.json'));
  for (const [name, script] of Object.entries(await renderInstallScripts('.', pkg))) {
    raised.push(...exitLiterals(name, tokenize(script.slice(script.indexOf('// BEGIN OKIT CONFIG')))));
  }
  assert.deepEqual(raised, [], 'an exit code written as a number; use exitCodeFor(kind) of src/install/exit.js');
});

test('round 12: exitCodeFor is the one policy: success 0, operational failure 1, usage and language 2, anything else refused', async () => {
  const { exitCodeFor } = await import('../src/install/exit.js');
  assert.deepEqual(['ok', 'operational', 'usage', 'language'].map(exitCodeFor), [0, 1, 2, 2]);
  assert.throws(() => exitCodeFor('other'), RangeError);
  assert.throws(() => exitCodeFor('toString'), RangeError);
});

// ---------------------------------------------------------------------------------------------------------------
// I9 (round 16): an error with no `kind` leaves the command as exit 1 (kindOf), so a refusal of the user's input that
// is raised as a plain `new Error` is the wrong code. Every `new Error(` / `new TypeError(` in src/install/** and
// src/setup/** is listed here with why 1 (or a bug of the caller) is right; anything else must be a UsageError,
// LanguageError, OperationalError or SetupRefusal, which carry their kind. A new plain error fails until it is named.
// Each entry is one point of the code: the file, a fragment of the line that raises it and why. The number of lines that
// carry the fragment is `count` (1 when not said), so a second error with the same words, or a new one beside it,
// fails until it is named. Nothing here is a file as a whole: a new `throw new Error('X')` in any of these files has
// no entry and fails, whatever else the file raises.
const PLAIN_ERRORS = [
  { file: 'src/setup/setup.js', fragment: "new TypeError('root is required')", why: 'programmer: runSetup called without a root, a bug of the caller, never an input' },
  { file: 'src/install/bootstrap.js', fragment: 'Object.assign(new Error(text)', why: 'the same line sets `kind` and `code` with Object.assign' },
  { file: 'src/install/client-plugin.js', fragment: 'new Error(delivery.reason)', why: 'operational: the client could not deliver the plugin (the environment); the presenter translates the reason' },
  { file: 'src/install/download.js', fragment: 'Download returned', why: 'operational: the release server answered with an error (the network)' },
  { file: 'src/install/download.js', fragment: "'Download size limit exceeded'", count: 2, why: 'operational: the package is larger than install.maxDownloadBytes, a validated limit (the release is the problem)' },
  { file: 'src/install/download.js', fragment: "'Download timeout exceeded'", why: 'operational: the download took longer than install.timeoutMs, a validated timer (the network)' },
  { file: 'src/install/download.js', fragment: "'Unsafe asset filename'", why: 'operational: the release names an asset with an unsafe name (the release)' },
  { file: 'src/install/download.js', fragment: "'Checksum manifest malformed", why: 'operational: the release checksum file is wrong (the release)' },
  { file: 'src/install/download.js', fragment: "'SHA-256 mismatch: package refused'", why: 'operational: the package does not match its checksum (the release or the network)' },
  { file: 'src/install/extract.js', fragment: "'Invalid tar header checksum'", why: 'operational: a corrupt archive from the release' },
  { file: 'src/install/extract.js', fragment: "'Archive links and special entries refused'", why: 'operational: an archive from the release with links or special files' },
  { file: 'src/install/extract.js', fragment: "'Archive links or unsupported zip entry refused'", why: 'operational: an archive from the release with links, encryption or a method that is not supported' },
  { file: 'src/install/extract.js', fragment: "'Truncated tar entry'", why: 'operational: a corrupt archive from the release' },
  { file: 'src/install/extract.js', fragment: "'Truncated tar archive'", why: 'operational: a corrupt archive from the release' },
  { file: 'src/install/extract.js', fragment: "'Invalid zip directory'", why: 'operational: a corrupt archive from the release' },
  { file: 'src/install/extract.js', fragment: "'Invalid zip entry')", why: 'operational: a corrupt archive from the release' },
  { file: 'src/install/extract.js', fragment: "'Invalid zip local header'", why: 'operational: a corrupt archive from the release' },
  { file: 'src/install/extract.js', fragment: "'Truncated zip entry'", why: 'operational: a corrupt archive from the release' },
  { file: 'src/install/extract.js', fragment: "'Invalid zip entry size'", why: 'operational: a corrupt archive from the release' },
  { file: 'src/install/extract.js', fragment: "'Extraction size limit exceeded'", count: 2, why: 'operational: the archive unpacks to more than install.maxExtractBytes, a validated limit (the release is the problem)' },
  { file: 'src/install/extract.js', fragment: 'Unsupported archive:', why: 'operational: the release format comes from the release settings of the program, not from the user\'s configuration' },
  { file: 'src/install/extract.js', fragment: 'Unsafe archive path:', why: 'operational: an archive from the release with an unsafe path' },
  { file: 'src/install/extract.js', fragment: 'Duplicate archive path:', why: 'operational: an archive from the release with a repeated path' },
  { file: 'src/install/index.js', fragment: 'formatUnreadable(ui.', why: 'operational: a configuration that is not JSON cannot be read (1); every value that is read and not valid is a ConfigError' },
  { file: 'src/install/index.js', fragment: "'Smoke proof failed'", count: 2, why: 'operational: the proof that the installed command runs failed (the environment)' },
  { file: 'src/install/kit.js', fragment: 'version command timed out after', why: 'operational: the kit did not answer in install.kit.timeoutMs, a validated timer (the environment); it is read as "not installed"' },
  { file: 'src/install/kit.js', fragment: "'version command failed'", why: 'operational: the kit executable ran and failed (the environment)' },
  { file: 'src/install/kit.js', fragment: "'invalid version output'", why: 'operational: the kit executable printed no version (the environment)' },
  { file: 'src/install/place.js', fragment: 'Package metadata version differs from release', why: 'operational: the package does not match the release (the release)' },
  { file: 'src/install/place.js', fragment: 'Version destination already exists', why: 'operational: the destination exists with other content (the disk)' },
  { file: 'src/install/present.js', fragment: 'throw new Error(reason)', why: 'operational: the command link conflicts with a file of the user (the environment); the step already said so' },
  { file: 'src/install/release.js', fragment: 'Release/download request failed', why: 'operational: the network failed (the request has a validated timeout, so no input makes it throw a RangeError)' },
  { file: 'src/install/release.js', fragment: 'Release API returned', why: 'operational: the release API answered with an error (the network)' },
  { file: 'src/install/release.js', fragment: 'Release list API returned', why: 'operational: the release API answered with an error (the network)' },
  { file: 'src/install/source.js', fragment: "new Error('Missing CLI')", why: 'caught in the same function and re-raised as a UsageError' },
  { file: 'src/install/statusline.js', fragment: 'new Error(unreadable(deps)', count: 4, why: 'operational: a settings file of the client that cannot be read, the same class as a configuration that cannot be read (1)' },
];

/** The `new Error(` and `new TypeError(` of one source: where, the head of the message and the line that raises it. */
function plainErrors(file, tokens, source = '') {
  const lines = source.split('\n');
  const found = [];
  for (const call of calls(tokens)) {
    if (!/^(Type)?Error$/.test(call.last) || tokens[call.at - 1]?.v !== 'new') continue;
    const line = call.args[0]?.line ?? tokens[call.at].line;
    found.push({ file, head: call.args.slice(0, 4).map((token) => token.v).join(''), line, text: lines[line - 1] ?? '' });
  }
  return found;
}
const matches = (entry, site) => entry.file === site.file && site.text.includes(entry.fragment);
const named = (site) => PLAIN_ERRORS.some((entry) => matches(entry, site));

test('round 16/I9: no plain Error in the installer\'s path without a name and a reason (the exit code is the error\'s kind)', async () => {
  const sites = [];
  for (const file of [...await walkJs('src/install'), ...await walkJs('src/setup')]) {
    sites.push(...plainErrors(file, tokenize(await read(file)), await read(file)));
  }
  assert.ok(sites.length > 30, `only ${sites.length} plain errors found: the scan is not reading the code`);
  assert.deepEqual(sites.filter((site) => !named(site)).map((site) => `${site.file}:${site.line}: ${site.text.trim()}`), [],
    'a plain Error ends the command with exit 1; raise a UsageError / ConfigError / SetupRefusal(…, \'usage\') for input the command does not accept, or name the point in PLAIN_ERRORS with the reason');
  for (const entry of PLAIN_ERRORS) {
    assert.ok(entry.why.length > 30, `${entry.file}: say why`);
    assert.ok(entry.fragment.length > 8, `${entry.file}: a fragment that names the point`);
    const count = sites.filter((site) => matches(entry, site)).length;
    assert.equal(count, entry.count ?? 1, `PLAIN_ERRORS: ${entry.file} ${entry.fragment}: ${count} points carry it`);
  }
  // No point is named twice: an entry never covers a site that another one covers.
  for (const site of sites) assert.equal(PLAIN_ERRORS.filter((entry) => matches(entry, site)).length, 1, `${site.file}:${site.line} is named by more than one entry`);
  // A file is never named as a whole: no entry without a fragment.
  assert.ok(PLAIN_ERRORS.every((entry) => typeof entry.fragment === 'string'));
});

test('round 16/I9: the scan sees a new plain Error and a TypeError, and does not see the errors that carry a kind', () => {
  const source = "if (x) throw new Error(format('invalidAnswer', locale));\nthrow new TypeError('bad');\nthrow new SetupRefusal('a', 'usage');\nthrow new UsageError('b');";
  const sites = plainErrors('src/setup/setup.js', tokenize(source), source);
  assert.equal(sites.length, 2);
  assert.ok(sites.every((site) => !named(site)));
  // A new error in a file that already has named points is found too (kit.js: the whole file is not an exception).
  const kit = "throw new Error('version command failed');\nthrow new Error('something about the user input');";
  const found = plainErrors('src/install/kit.js', tokenize(kit), kit);
  assert.deepEqual(found.map((site) => named(site)), [true, false]);
});
