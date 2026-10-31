import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { EXTRA_KEYS, INSTALL_SCHEMA } from '../../src/config-schema.js';
import { DEFAULT_CONFIG, configOf } from '../../src/profiles.js';
import { scriptDefaults } from '../../src/release/install-scripts.js';

// The closed inventory of what the installer takes in (invariant I9): the configuration keys it reads, the flags it
// parses, the OKIT_* variables it looks at and the files it opens. Each table below says, for every input, its domain
// and what a value outside it must do (usage: exit 2; unreadable: exit 1); the scanners read the source and fail when
// a new input is read that no table names. test/input-inventory.test.js proves every row against the real commands.
// An input that is read and not here is a new demand, not a failure of this round (see .delegate/invariantes.md, I9).

const ROOT = join(import.meta.dirname, '..', '..');
const read = (file) => readFileSync(join(ROOT, file), 'utf8');
export function sourceFiles(dir = 'src') {
  return readdirSync(join(ROOT, dir)).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(join(ROOT, path)).isDirectory()) return sourceFiles(path);
    return path.endsWith('.js') ? [path] : [];
  }).sort();
}
const lineOf = (text, index) => text.slice(0, index).split('\n').length;

// ---------------------------------------------------------------------------------------------------------------
// 1. The keys of config.json that the code reads.

/** The top-level keys, with the type the code expects and where a wrong value is refused. `range` is [min, max]. */
export const TOP_LEVEL_KEYS = Object.freeze({
  language: { type: 'choice', values: ['en', 'pt-BR'], checkedBy: 'resolveLocale (a value that is not a language is ignored as a saved language and refused as --locale)' },
  install: { type: 'object', checkedBy: 'INSTALL_SCHEMA (installConfig)' },
  limitWarnings: { type: 'list', checkedBy: 'configOf (ConfigError limitWarnings)' },
  orders: { type: 'object', checkedBy: 'src/orders.js (a reader never stops: a wrong value is the default)' },
  lowQuotaPct: { type: 'number', range: [0, 100], checkedBy: 'CONFIG_SCHEMA (config set); readers use the default for a value that is not a number' },
  staleMinutes: { type: 'number', checkedBy: 'readers use the default for a value that is not a number' },
  limits: { type: 'object', checkedBy: 'CONFIG_SCHEMA limits.*' },
  profiles: { type: 'object', checkedBy: 'configOf, CONFIG_SCHEMA profiles.*; setup reads a wrong shape as an unreadable file (exit 1, see FILE_RULES)' },
  daemon: { type: 'object', checkedBy: 'CONFIG_SCHEMA daemon.*' },
  smoke: { type: 'object', checkedBy: 'CONFIG_SCHEMA smoke.*' },
  telemetry: { type: 'object', checkedBy: 'CONFIG_SCHEMA telemetry.*, telemetry/config.js' },
  trajectory: { type: 'object', checkedBy: 'configOf, trajectory/config.js' },
  codexQuota: { type: 'object', checkedBy: 'CONFIG_SCHEMA codexQuota.*' },
  opencodeQuota: { type: 'object', checkedBy: 'readers use the default for a value that is not valid' },
  statuslineRegistration: { type: 'object', checkedBy: 'configOf (statusBarSetting, clientFolderSetting, statusBarShell)' },
  statuslineCollector: { type: 'object', checkedBy: 'src/quota/statusline-collector.js (defaults for a value that is not valid)' },
  inbox: { type: 'object', checkedBy: 'configOf' },
  todo: { type: 'object', checkedBy: 'configOf (todoProjectsObject ... todoCheckboxCharacter), CONFIG_SCHEMA todo.*' },
  setup: { type: 'object', checkedBy: 'setup/setup.js' },
  actors: { type: 'object', checkedBy: 'configOf' },
  postCompact: { type: 'object', checkedBy: 'src/hook-post-compact.js (defaults for a value that is not valid)' },
  profileMessages: { type: 'object', checkedBy: 'configOf' },
  smokeDrivers: { type: 'object', checkedBy: 'configOf' },
  release: { type: 'object', checkedBy: 'src/release/config.js (the maintainer commands, not the installer)' },
  configuredClients: { type: 'list', checkedBy: 'configuredClientsOf (names that are not safe are dropped)' },
});

/** The keys the code can know: the defaults, what configOf adds, and the keys the schema lists as extra. */
export function knownTopLevelKeys() {
  return new Set([...Object.keys(DEFAULT_CONFIG), ...Object.keys(configOf({})), ...Object.keys(EXTRA_KEYS)]);
}

// Files where `config` (or `user`) is not the file's own top level but a section or a value derived from one, and the
// keys they read from it. A key read in any other file must be a top-level key above.
const SECTION_READERS = Object.freeze({
  prefixes: Object.freeze({
    'src/release/': 'the release section, read by src/release/config.js (maintainer commands)',
    'src/telemetry/': 'the telemetry section, validated by telemetry/config.js',
    'src/trajectory/': 'the trajectory section, validated by trajectory/config.js',
    'src/smoke/': 'the smoke runner of the maintainers (a demand of its own)',
    'src/install/': 'the install section after installConfig: its keys are checked against INSTALL_SCHEMA below',
  }),
  files: Object.freeze({
    'src/cli.js': ['command', 'kit'],
    'src/env/path.js': ['windowsPlatform', 'pathExtensions', 'command'],
    'src/env/snapshot.js': ['clients', 'kit'],
    'src/todo/index.js': ['projects'],
    'src/profiles.js': ['fish'],
  }),
});

/** The top-level keys read by name, as `{ key, file, line }`. */
export function configKeysRead() {
  const found = [];
  for (const file of sourceFiles()) {
    if (['src/config.js', 'src/config-schema.js', 'src/install/present.js', 'src/install/rules.js', 'src/install/bootstrap.js'].includes(file)) continue;
    const text = read(file);
    for (const match of text.matchAll(/(?<![.\w$/'"`])(config|userConfig|user)\??\.([A-Za-z_]\w*)(?![\w(])/g)) {
      if (match[2] === 'json') continue; // the file name "config.json" in a message or a comment
      found.push({ key: match[2], name: match[1], file, line: lineOf(text, match.index) });
    }
  }
  return found;
}

/** Reads that are neither a top-level key nor a section's own: the new inputs that nothing names. */
export function configReadsOutsideTheInventory() {
  const known = knownTopLevelKeys();
  const install = new Set(Object.keys(INSTALL_SCHEMA.fields));
  return configKeysRead().filter(({ key, file }) => {
    if (known.has(key)) return false;
    if (SECTION_READERS.files[file]?.includes(key)) return false;
    if (file.startsWith('src/install/') && file !== 'src/install/index.js') return !install.has(key);
    return !Object.keys(SECTION_READERS.prefixes).some((prefix) => file.startsWith(prefix));
  }).map(({ key, file, line }) => `${file}:${line} reads config.${key}`);
}

// ---------------------------------------------------------------------------------------------------------------
// Every number of a schema, with its limits stated apart from the schema: the test passes the maximum, refuses the
// maximum + 1 (and the minimum - 1) and fails when the table and the schema disagree. A limit of the timers is
// 2^31 - 1 (what a timer takes, written here and not imported, so that changing the schema's constant is seen); the
// largest size is the largest integer a number holds exactly.

const TIMER = [1, 2 ** 31 - 1];
const SIZE = [1, Number.MAX_SAFE_INTEGER];
/** `install.*` numbers (installConfig). */
export const INSTALL_NUMBERS = Object.freeze({
  'kit.timeoutMs': TIMER, timeoutMs: TIMER, daemonPollMs: TIMER, maxDownloadBytes: SIZE, maxExtractBytes: SIZE,
  'selfcheck.timeoutMs': TIMER, 'selfcheck.sample.usedPercentage': SIZE, 'selfcheck.sample.resetsInSeconds': SIZE,
});
/** The numbers `config set` takes; `integer` or `number`. */
export const CONFIG_NUMBERS = Object.freeze({
  'limits.global': ['integer', ...SIZE], 'limits.clients.<client>': ['integer', ...SIZE],
  'profiles.<client>.<class>.maxTurns': ['integer', ...SIZE],
  lowQuotaPct: ['number', 0, 100], 'daemon.minQuotaPct': ['number', 0, 100], 'smoke.quotaFloorPct': ['number', 0, 100],
  'telemetry.retentionDays': ['integer', ...SIZE], 'telemetry.maxBytes': ['integer', ...SIZE],
  'telemetry.batchSeconds': ['integer', ...SIZE], 'telemetry.maxFileBytes': ['integer', ...SIZE],
  'telemetry.kitTimeoutMs': ['integer', ...TIMER], 'telemetry.rede.timeoutMs': ['integer', ...TIMER],
  'codexQuota.recentFiles': ['integer', ...SIZE], 'codexQuota.tailBytes': ['integer', ...SIZE],
  'codexQuota.maxTailBytes': ['integer', ...SIZE], 'codexQuota.maxAgeMinutes': ['integer', ...SIZE],
});

// ---------------------------------------------------------------------------------------------------------------
// 2. The flags.

const INSTALL_BASE = ['install', '--client', 'claude-code', '--dry-run'];
/** One argv that starts each command, valid by itself. */
export const COMMAND_BASES = Object.freeze({
  install: INSTALL_BASE, update: ['update', '--dry-run'], uninstall: ['uninstall', '--dry-run'], setup: ['setup', '--defaults'],
  kit: ['kit'], status: ['status'], config: ['config', 'show'], 'telemetry status': ['telemetry', 'status'],
  'telemetry export': ['telemetry', 'export'], 'quota set': ['quota', 'set', 'codex', '10'], 'autostart show': ['autostart', 'show'],
  actors: ['actors'], 'daemon status': ['daemon', 'status'],
});

const NAMES = ['no-such-name', '', ' ', 'a\nb'];
/**
 * The flags of the commands of the inventory. `value` is the domain of what follows the flag (`none`: a switch); `invalid`
 * is what must be refused with exit 2; `commands` are the keys of COMMAND_BASES that take it. A value flag is also
 * tried with no value after it ("missing value") and in the `--flag=value` form where the command accepts it.
 */
export const FLAG_TABLE = Object.freeze([
  { flag: '--client', value: 'client name', commands: ['install', 'update', 'uninstall', 'status', 'actors'], invalid: NAMES },
  { flag: '--from', value: 'folder of a package', commands: ['install'], invalid: ['/nonexistent/okit-from', ''] },
  { flag: '--repo', value: 'owner/repository', commands: ['install'], invalid: ['invalid', 'a b/c', '../x', './y', '..', '', '/'] },
  { flag: '--dest', value: 'folder', commands: ['install'], invalid: [' ', 'a\nb', ''] },
  { flag: '--asset', value: 'file name', commands: ['install'], invalid: [], missing: true },
  { flag: '--locale', value: 'en | pt-BR', commands: ['install', 'update', 'uninstall', 'setup', 'kit', 'status', 'actors', 'daemon status'], invalid: ['xx', 'EN', 'pt_BR', ' '] },
  { flag: '--kind', value: 'autostart kind', commands: ['autostart show'], invalid: ['invalid', 'SYSTEMD', ' '] },
  { flag: '--since', value: 'ISO date', commands: ['telemetry export'], invalid: ['nope', '2026-13-45', '', 'yesterday', '5'] },
  { flag: '--window-minutes', value: 'number > 0', commands: ['quota set'], invalid: ['NaN', 'Infinity', '-1', '0', 'abc', '', '1e999'] },
  { flag: '--dry-run', value: 'none', commands: ['install', 'update', 'uninstall'], invalid: [] },
  { flag: '--yes', value: 'none', commands: ['install', 'uninstall'], invalid: [] },
  { flag: '--prerelease', value: 'none', commands: ['install'], invalid: [] },
  { flag: '--verbose', value: 'none', commands: ['install', 'update', 'uninstall'], invalid: [] },
  { flag: '--defaults', value: 'none', commands: ['setup'], invalid: [] },
  { flag: '--again', value: 'none', commands: ['setup'], invalid: [] },
  { flag: '--require', value: 'none', commands: ['kit'], invalid: [] },
  { flag: '--all', value: 'none', commands: ['status', 'actors'], invalid: [] },
  { flag: '--json', value: 'none', commands: ['actors'], invalid: [] },
  { flag: '--table', value: 'none', commands: ['daemon status'], invalid: [] },
  { flag: '--check', value: 'none', commands: ['update'], invalid: [] },
  { flag: '--rollback', value: 'none', commands: ['update'], invalid: [] },
  { flag: '--purge', value: 'none', commands: ['uninstall'], invalid: [] },
  { flag: '--no-link', value: 'none', commands: ['install'], invalid: [] },
  { flag: '--no-path', value: 'none', commands: ['install', 'update'], invalid: [] },
  { flag: '--autostart', value: 'none', commands: ['install'], invalid: [] },
  { flag: '--statusline', value: 'none', commands: ['install', 'update'], invalid: [] },
  { flag: '--no-statusline', value: 'none', commands: ['install', 'update'], invalid: [] },
  { flag: '--set-execution-policy', value: 'none', commands: ['install', 'update'], invalid: [] },
  { flag: '--no-execution-policy', value: 'none', commands: ['install', 'update'], invalid: [] },
  { flag: '--fallback', value: 'none', commands: ['install'], invalid: [] },
]);

/** Positional numbers that are not behind a flag: `quota set <client> <percent>`. */
export const POSITIONAL_NUMBERS = Object.freeze([
  { command: ['quota', 'set', 'codex'], invalid: ['NaN', 'Infinity', '-1', '101', 'abc', '', '1e999'] },
]);

/** Flags that appear in the source of a command line and are not an input of the commands above, with the reason. */
export const OUT_OF_SCOPE_FLAGS = Object.freeze({
  '--help': 'help text, no value', '-h': 'help text, no value',
  '--now': 'autostart: starts the service at once, a switch the autostart command owns', '--user': 'autostart: a switch of the service manager',
  '--porcelain': 'git status argument of the inbox', '--project': 'inbox and todo (the orchestration commands, a demand of their own)',
  '--session': 'inbox take (orchestration)', '--worktree': 'inbox take (orchestration)', '--producer-takeover': 'inbox take (orchestration)',
  '--previous': 'statusline collector, run by the client, not by a person', '--version': 'the argument of a client program we start',
  '--connect-timeout': 'curl argument of the install script', '--max-time': 'curl argument of the install script',
  '--client=': 'the form of --client', '--locale=': 'the form of --locale', '--kind=': 'the form of --kind',
  '--confirm': 'smoke demo (maintainers)', '--timeout': 'smoke (maintainers)', '--only': 'smoke (maintainers)', '--keep': 'smoke (maintainers)',
  '--real': 'smoke (maintainers)', '--max-minutes': 'smoke (maintainers)', '--max-turns': 'smoke (maintainers)', '--max-usd': 'smoke (maintainers)',
  '--quota-floor': 'smoke (maintainers)',
  '--end-of-options': 'git/gh argument of the release publisher', '--latest': 'gh argument of the release publisher', '--list': 'git argument',
  '--notes-file': 'gh argument', '--tags': 'git argument', '--target': 'gh argument', '--title': 'gh argument', '--untracked-files': 'git argument',
  '--verify': 'git argument', '--format': 'argument of a program we start',
});
/** The files whose `'--flag'` literals are command-line inputs of the product. */
export const FLAG_FILES = Object.freeze(['src/cli.js', 'src/install/index.js', 'src/telemetry/cli.js', 'src/autostart.js', 'src/install/bootstrap.js']);

export function flagLiterals() {
  const found = new Map();
  for (const file of FLAG_FILES) {
    const text = read(file);
    for (const match of text.matchAll(/['"`](--[a-z][a-z-]*=?)/g)) {
      const at = found.get(match[1]) ?? [];
      at.push(`${file}:${lineOf(text, match.index)}`);
      found.set(match[1], at);
    }
  }
  return found;
}

/** `--flag` names the installer parses, from its own table. */
export function installFlags() {
  const text = read('src/install/index.js');
  const block = text.match(/const allowed = \{([\s\S]*?)\n\};/)[1];
  return new Set([...block.matchAll(/'([a-z][a-z-]*)'/g)].map((match) => `--${match[1]}`).filter((flag) => !['--install', '--update', '--uninstall'].includes(flag)));
}

// ---------------------------------------------------------------------------------------------------------------
// 3. The environment variables.

/** The domain of each OKIT_<KEY> the generated scripts read: the same keys as scriptDefaults. */
export const ENV_DOMAINS = Object.freeze({
  SYSTEMS: { domain: 'JSON object, values text', invalid: ['bad-json', '[]', '{}', '{"Linux":5}'] },
  ARCHITECTURES: { domain: 'JSON object, values text', invalid: ['bad-json', '[1]', '{}', '{"x86_64":null}'] },
  FORMATS: { domain: 'JSON object, values text', invalid: ['bad-json', '5'] },
  CLIENTS: { domain: 'JSON object, values text', invalid: ['bad-json', '{"a":1}'] },
  DATA_ROOTS: { domain: 'JSON object, values lists of text', invalid: ['bad-json', '{"linux":"x"}', '{"linux":[]}'] },
  MIN_NODE: { domain: 'whole number from 1', invalid: ['abc', '0', '1.5'] },
  API: { domain: 'http(s) address without credentials', invalid: ['ftp://example.invalid', 'https://user:password@example.invalid', 'not an address'] },
  REPO: { domain: 'owner/repository', invalid: ['invalid', ''] },
  STATE_ENV: { domain: 'variable name', invalid: ['1X', 'a b'] },
  STATE_FOLDER: { domain: 'text, one line', invalid: ['', 'a\nb'] },
  NAME: { domain: 'text, one line', invalid: ['', 'a\nb'] },
  MANIFEST: { domain: 'text, one line', invalid: ['', 'a\nb'] },
  COMMAND: { domain: 'text, one line', invalid: ['', 'a\nb'] },
  PACKAGE: { domain: 'text, one line', invalid: ['', 'a\nb'] },
  DIRECTORY: { domain: 'text, one line', invalid: ['', 'a\nb'] },
  QUOTA_CLIENT: { domain: 'text, one line', invalid: ['', 'a\nb'] },
  TAG_PREFIX: { domain: 'one line (may be empty)', invalid: ['a\nb'] },
  DEST: { domain: 'one line (may be empty)', invalid: ['a\nb'] },
});
/** The variables that are not one of the script's settings. */
export const ENV_OTHER = Object.freeze({
  OKIT_CLIENT: { domain: 'a client of OKIT_CLIENTS', invalid: ['no-such-client'], note: 'refused with exit 2 after the settings and before the network' },
  OKIT_LANGUAGE: { domain: 'en | pt-BR', invalid: [], note: 'a value that is not a language is ignored by design: the order of resolveLocale then falls to the saved language, the system and English' },
  OKIT_SELFCHECK: { domain: 'set (any non-empty value) or not set', invalid: [], note: 'set by the post-install check in the processes it starts, never by the person: the status bar collector then does not start the command of --previous; it is not an installer setting' },
});

export const envKeysOfTheScripts = () => Object.keys(scriptDefaults({ name: 'x', engines: { node: '>=22' } }));

/** `OKIT_*` names written in the source, other than the heredoc marker of the generated script. */
export function envLiterals() {
  const found = new Set();
  for (const file of sourceFiles()) {
    const text = read(file);
    for (const match of text.matchAll(/\bOKIT_([A-Z][A-Z_]*)\b(?!\$)/g)) {
      if (!['BOOTSTRAP', 'CONFIG'].includes(match[1])) found.add(`OKIT_${match[1]}`);
    }
  }
  return found;
}

// ---------------------------------------------------------------------------------------------------------------
// 4. The files that are read. The rule: a file that cannot be read (missing where it must exist, not text, not JSON,
// a folder) is a failure of the work (operational, exit 1); JSON that is read and has a field of the wrong type is a
// refusal of usage (exit 2); a file of another program that we would have to change and cannot preserve is unreadable.

export const FILE_RULES = Object.freeze([
  { file: 'config.json (the plugin\'s own)', readBy: 'readConfig / configOf / installConfig', unreadable: 1, wrongType: 2,
    proof: 'test/input-inventory.test.js#config.json is a folder',
    note: 'a root that is not an object is an empty configuration; setup reads a wrong shape of profiles as an unreadable file (1, test/setup-wizard.test.js)' },
  { file: 'package.json of --from', readBy: 'src/install/source.js', unreadable: 2, wrongType: 2, proof: 'test/input-inventory.test.js#package.json ${body}',
    note: 'a folder the person named that has no package is a wrong argument (--from), told as such' },
  { file: 'install.json / install.<client>.json (the record)', readBy: 'src/install/place.js, src/install/bootstrap.js', unreadable: 1, wrongType: 2,
    proof: 'test/input-inventory.test.js#${record} ${body}',
    note: 'every field is checked by RECORD_FIELDS (src/config-schema.js), also in the record the record replaced (`previous`); a wrong type names the field' },
  { file: 'managed-path.json (the PATH state)', readBy: 'src/install/link.js (pathState)', unreadable: 1, wrongType: 2, proof: 'test/input-inventory.test.js#managed-path.json ${body}',
    note: 'the profile blocks and the Windows PATH entry the installer added; checked by PATH_STATE_SCHEMA (src/config-schema.js)' },
  { file: 'package.json of the downloaded package', readBy: 'src/install/place.js', unreadable: 1, wrongType: 1, proof: 'test/install-invariants.test.js#Package metadata version differs from release',
    note: 'remote data that does not match the release is a failure of the work, never the person\'s usage' },
  { file: 'the release manifest (checksums)', readBy: 'src/install/manifest.js', unreadable: 1, wrongType: 1, proof: 'test/install-invariants.test.js#Checksum manifest malformed',
    note: 'remote data that does not match is a failure of the work (R12), never the person\'s usage' },
  { file: 'the release metadata (API)', readBy: 'src/install/release.js', unreadable: 1, wrongType: 1, proof: 'test/install-invariants.test.js#Release API returned',
    note: 'remote data, as above' },
  { file: 'settings of the client (statusline)', readBy: 'src/install/statusline.js', unreadable: 1, wrongType: 1, proof: 'test/install-invariants.test.js#new Error(unreadable(deps)',
    note: 'a file of another program that cannot be preserved is unreadable (test/install-invariants.test.js)' },
  { file: 'settings.json of the client (role)', readBy: 'adapters/claude-code/index.js (installRole)', unreadable: 1, wrongType: 0,
    proof: 'test/input-inventory.test.js#the client settings.json that the role step reads',
    note: 'not JSON is a failure of the work and the file is left as it was; JSON of another shape is kept as it is and the step says the role is unsupported (a detail line, no failure)' },
  { file: 'settings of the client (statusline state, read by status)', readBy: 'src/env/snapshot.js (statuslineState)', unreadable: 0, wrongType: 0,
    proof: 'test/env-report.test.js#status bar registration is read from settings',
    note: 'only to say whether the status bar is registered: a missing file is inactive, a file that cannot be read or parsed leaves the state unknown; status never fails for it' },
  { file: 'quota/<client>.json (the manual reading)', readBy: 'adapters/{claude-code,codex,opencode}/index.js (readQuota, by `status`)', unreadable: 1, wrongType: 0,
    proof: 'test/input-inventory.test.js#the quota file of a client (quota/<client>.json)',
    note: 'not JSON, empty or a folder cannot be read (1); valid JSON of another type, or a field of the wrong type, is no reading: status goes on and says no value is recorded' },
]);

// ---------------------------------------------------------------------------------------------------------------
// 4b. Every place that reads a file, found by scanning src/ (not written by hand).
//
// The scanner lists each call that reads a file or parses text (`readFile`, `readFileSync`, `readJson*`, `createReadStream`,
// `JSON.parse`, `createRequire`, a dynamic `import()`) with the text of its first argument. Every one of them must be
// classified: by a row of FILE_RULES (the file is an input with a rule: unreadable is 1, a wrong type is 2) or by an
// exclusion that says why it is not an input of the commands of this inventory. A read nobody classified fails
// test/input-inventory.test.js, so a new reader cannot skip the table; a classification that matches no read fails too.

const READ_CALL = /\b(readFile|readFileSync|readJson|readJsonSync|createReadStream)\s*\(|\bJSON\.parse\s*\(|\bimport\s*\(|\bcreateRequire\s*\(/g;

/** The source with comments blanked (the line numbers stay). */
function withoutComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' ')).replace(/^(\s*)\/\/.*$/gm, '$1');
}

/** The text of the first argument of the call whose `(` is just before `from`. */
function firstArgument(text, from) {
  let depth = 0;
  let quote = null;
  let end = from;
  for (; end < text.length; end += 1) {
    const char = text[end];
    if (quote) {
      if (char === '\\') end += 1;
      else if (char === quote) quote = null;
    } else if ('\'"`'.includes(char)) quote = char;
    else if ('([{'.includes(char)) depth += 1;
    else if (')]}'.includes(char)) { if (depth === 0) break; depth -= 1; } else if (char === ',' && depth === 0) break;
  }
  return text.slice(from, end).trim().replace(/\s+/g, ' ');
}

/** `{ file, line, call, arg }` for every read of a file in a source text. A `JSON.parse` of a read in the same call is the same read. */
export function readsIn(file, source) {
  const found = [];
  const text = withoutComments(source);
  for (const match of text.matchAll(READ_CALL)) {
    const call = match[0].replace(/\s*\($/, '');
    const arg = firstArgument(text, match.index + match[0].length);
    // `import('./x.js')` of a literal is the package's own code, not data; `JSON.parse(await readFile(...))` is the read inside.
    if (call === 'import' && /^'[^']*'$/.test(arg)) continue;
    if (call === 'JSON.parse' && /\b(readFile|readJson)\(/.test(arg)) continue;
    found.push({ file, line: lineOf(text, match.index), call, arg });
  }
  return found;
}

/** Every read of a file in src/. */
export const fileReads = () => [...sourceFiles(), ...sourceFiles('adapters')].flatMap((file) => readsIn(file, read(file)));

const CONFIG_JSON = 'config.json (the plugin\'s own)';
const RECORD = 'install.json / install.<client>.json (the record)';
const STATE_OF_OTHER_COMMANDS = 'state of a command outside this inventory (I9 lists install, update, uninstall, setup, kit, status, config, telemetry); written by okit itself';

/**
 * How each read is classified. A row matches a read by `file` (a path, or a folder when it ends in "/") and `arg` (a
 * regular expression on the text of the first argument); the first row that matches wins. `rule` is the `file` of a
 * FILE_RULES row; `excluded` says why the file is not an input of this inventory.
 */
export const READ_POINTS = Object.freeze([
  // The plugin's own configuration, wherever it is read.
  { file: 'src/', arg: /^(paths\([\w.]+\)\.config|join\(root, 'config\.json'\)|join\(ctx\.root, 'config\.json'\)|join\(stateRoot, 'config\.json'\)|target\.config|files\.config|join\(context\.root, 'config\.json'\))$/, rule: CONFIG_JSON },
  // The adapters (adapters/): the same scan, one table.
  { file: 'adapters/', arg: /\.quota, `\$\{CLIENT\}\.json`\)$/, rule: 'quota/<client>.json (the manual reading)' },
  { file: 'adapters/claude-code/index.js', arg: /^path$/, rule: 'settings.json of the client (role)' },
  { file: 'adapters/claude-code/index.js', arg: /^file$/, excluded: 'hooks/hooks.json of the client, read only by installHooks, which no command of this inventory calls (the maintainers\' smoke runner does); a file that is not JSON is refused and left alone' },
  { file: 'adapters/', arg: /^join\(source, 'SKILL\.md'\)$/, excluded: 'the SKILL.md of a skill folder of the package being installed (code and text of the program), read only to know the folder is a skill' },
  { file: 'adapters/codex/index.js', arg: /^join\(configRoot\(opts\), 'AGENTS\.override\.md'\)$/, excluded: 'text without a format: the client\'s AGENTS.override.md, only tested for being empty; never parsed (a file that cannot be read is a failure of the work, as for every file)' },
  { file: 'adapters/codex/index.js', arg: /^join\(base, 'config\.json'\)$/, rule: CONFIG_JSON },
  { file: 'adapters/codex/session-quota.js', arg: /^line$/, excluded: 'a line of a session file of the Codex client (a source of the client, not an input of the user): parsed inside a try/catch that returns no reading, so no content makes status fail (test/input-inventory.test.js#own sources)' },
  { file: 'adapters/opencode/quota-source.js', arg: /^output$/, excluded: 'the output of a source of the opencode client (a file or a command the configuration names): parsed inside a try/catch that returns no reading, so no content makes status fail (test/input-inventory.test.js#own sources)' },
  { file: 'adapters/opencode/index.js', arg: /^(source|path)$/, excluded: 'the plugin module okit wrote and the plugin file already in the client\'s folder, compared byte for byte; never parsed' },
  { file: 'src/telemetry/config.js', arg: /^config\.kitConfigFile$/, excluded: 'the kit\'s own configuration file, named by telemetry.kitConfigFile and optional: any failure to read it leaves the plugin standalone (a try/catch around it, by design)' },
  { file: 'src/telemetry/config.js', arg: /^\(await promisify\(execFile\)/, excluded: 'the output of the kit program (a process we start), not a file; a failure leaves the plugin standalone' },
  { file: 'src/telemetry/index.js', arg: /^await readFile\(join\(config\.dir, name\)|^join\(config\.dir, name\)$/, excluded: 'the measurement files okit wrote in telemetry.dir; a damaged one is reported by `telemetry check` as damaged, never as the person\'s usage' },
  { file: 'src/telemetry/index.js', arg: /^(join\(root, 'telemetry-export\.json'\)|file)$/, excluded: 'telemetry-export.json is written by okit (atomic write) and read back for the last-export line (a non-text `at`, from a hand edit, counts as no export time: input inventory test); `file` is the configuration file of `telemetry on|off` (CONFIG_JSON above)' },
  // The installer.
  { file: 'src/install/place.js', arg: /^(text|join\(destination, 'install\.json'\)|recordPath\(destination, client, config\))$/, rule: RECORD },
  { file: 'src/install/bootstrap.js', arg: /^(path|recordFile)$/, rule: RECORD },
  { file: 'src/install/place.js', arg: /^join\(staging, 'package\.json'\)$/, rule: 'package.json of the downloaded package' },
  { file: 'src/install/source.js', arg: /^join\(source, 'package\.json'\)$/, rule: 'package.json of --from' },
  { file: 'src/install/index.js', arg: /^join\(packageDirectory, 'package\.json'\)$/, rule: 'package.json of --from' },
  { file: 'src/install/link.js', arg: /^(stateFile|text)$/, rule: 'managed-path.json (the PATH state)' },
  { file: 'src/install/link.js', arg: /^(path|item\.path|actual)$/, excluded: 'text without a format: a shell profile, a shim or a symbolic link of the person, searched for our own marker or compared with what we would write; never parsed' },
  { file: 'src/install/link.js', arg: /^(join\(folder, 'package\.json'\)|metadata)$/, excluded: 'package.json of a folder above a command we find on the PATH, read only to know whether the command is ours; a file that is not JSON or not ours is "not ours" (a try/catch around it, by design)' },
  { file: 'src/install/link.js', arg: /^import\.meta\.url$/, excluded: 'package.json of this package (code of the program itself)' },
  { file: 'src/install/register.js', arg: /^pathToFileURL\(join\(record\.path, 'adapters'/, excluded: 'the adapter module of the package the record names (code of the installed package, not data); record.path is a text checked by RECORD_FIELDS' },
  { file: 'src/install/register.js', arg: /^path$/, excluded: 'the module shim okit itself wrote in the client\'s folder, compared with what it would write; never parsed' },
  { file: 'src/install/role-block.js', arg: /^path$/, excluded: 'text without a format: the client\'s role file, searched for okit\'s own block; never parsed' },
  { file: 'src/install/statusline.js', arg: /^(path|original\.toString\('utf8'\))$/, rule: 'settings of the client (statusline)' },
  { file: 'src/install/statusline.js', arg: /^(saved\.path|bytes\.toString\('utf8'\))$/, rule: 'settings of the client (statusline)' },
  { file: 'src/env/snapshot.js', arg: /^path$/, rule: 'settings of the client (statusline state, read by status)' },
  { file: 'src/install/selfcheck.js', arg: /^(file|text)$/, excluded: 'package.json of the package just installed (code of the program itself), read back only to compare its version; a file that cannot be read or is not JSON is a failed check (a row with its fix, exit 1), never a crash' },
  { file: 'src/install/selfcheck.js', arg: /^saved$/, excluded: 'the person\'s config.json, read to copy only the allowed keys (install.selfcheck.stateKeys) into the temporary state root; a file that is not JSON, or whose root is not an object, copies nothing and the scripts use their defaults; never a crash, never a failed check' },
  { file: 'src/install/selfcheck.js', arg: /^path$/, excluded: 'the client\'s settings file, read back to run the status bar and hook strings the installer wrote; a file that cannot be read or is not JSON is a failed check with its fix (exit 1), JSON of another shape finds no status bar and is a skipped row; never a crash' },
  { file: 'src/install/statusline.js', arg: /^saved\.backup$/, excluded: 'the copy of the client\'s settings that okit made before it changed them; restored byte for byte, never parsed' },
  { file: 'src/install/index.js', arg: /^join\(ctx\.root, 'config\.json'\)$/, rule: CONFIG_JSON },
  { file: 'src/install/bootstrap.js', arg: /^(metadata)$/, rule: 'the release metadata (API)' },
  { file: 'src/install/bootstrap.js', arg: /^hashes$/, rule: 'the release manifest (checksums)' },
  { file: 'src/install/bootstrap.js', arg: /^(value|text)$/, excluded: 'an OKIT_* environment variable (value) or the text of config.json read above (text): the variables are proved by the OKIT_* table, the file by CONFIG_JSON' },
  { file: 'src/install/bootstrap.js', arg: /^'\/dev\/tty'$/, excluded: 'the terminal, to ask a question; not a file of data' },
  { file: 'src/core/config.js', arg: /^trimmed$/, excluded: 'the text of a `config set` value, a command-line argument; parseValue refuses what is not a value of its entry' },
  // Hooks and processes that read what the client hands them, not a file of the person.
  { file: 'src/hook-post-compact.js', arg: /^(file|typeof stdin|await readFile)/, excluded: 'the transcript file or the standard input a client hook hands to the program (a hook, not a command of this inventory); a reader that never stops' },
  { file: 'src/hook-session-start.js', arg: /^(raw|files\.(inbox|orders))$/, excluded: 'the standard input of a client hook and the orchestration state of other commands (inbox, orders)' },
  { file: 'src/quota/statusline-collector.js', arg: /^input\.toString\(\)$/, excluded: 'the standard input the client\'s status line hands to the collector; a reader that never stops' },
  { file: 'src/mcp/', arg: /^(PACKAGE_URL|text)$|^await readFile\(PACKAGE_URL/, excluded: 'package.json of this package (code of the program) and the messages of the MCP protocol on the standard input' },
  { file: 'src/spawn-process.js', arg: /^(file|stdout)$/, excluded: 'the run file okit wrote for a started executor and the output of a process we started' },
  { file: 'src/state.js', arg: /^(file|raw|join\(lockDir, LOCK_OWNER_FILE\)|claim)$/, excluded: 'the generic reader of state files (each caller is a row of this table) and the lock files okit writes in its own state folder' },
  { file: 'src/skills.js', arg: /^(file|source)$/, excluded: 'the skill files of the package being installed (code and text of the program), copied byte for byte' },
  // Commands outside this inventory: orchestration state, read and written by okit itself.
  { file: 'src/daemon.js', arg: /^(logFile\(root, now\)|lines\[lines\.length - 1\]|pidFile\(root\))$/, excluded: 'the daemon\'s own log and pid file (the daemon command is outside this inventory)' },
  { file: 'src/demand-ref.js', arg: /^paths\(root\)\.project$/, excluded: STATE_OF_OTHER_COMMANDS },
  { file: 'src/inbox.js', arg: /^file$/, excluded: STATE_OF_OTHER_COMMANDS },
  { file: 'src/limits.js', arg: /^(join\(runsDir\(root\), name\)|file)$/, excluded: STATE_OF_OTHER_COMMANDS },
  { file: 'src/orders.js', arg: /^(legacy|file)$/, excluded: STATE_OF_OTHER_COMMANDS },
  { file: 'src/templates.js', arg: /^file$/, excluded: STATE_OF_OTHER_COMMANDS },
  { file: 'src/todo/', arg: /^(path\.file|paths\(root\)\.inbox)$/, excluded: 'the project TODO the person asked the todo command to read (a command outside this inventory), and the orchestration inbox' },
  { file: 'src/trajectory/', arg: /^(file|input|line|new URL\('\.\.\/\.\.\/package\.json', import\.meta\.url\))$/, excluded: 'the recordings okit wrote and the package.json of this program (the trajectory command is outside this inventory)' },
  // The maintainers' commands.
  { file: 'src/release/', arg: /./, excluded: 'the maintainers\' release commands (build, checksums, notes, publish): they read the repository of the package being released, not an input of an installation' },
  { file: 'src/smoke/', arg: /./, excluded: 'the maintainers\' smoke runner (a demand of its own; its flags are in OUT_OF_SCOPE_FLAGS)' },
]);

const rowMatches = (row, read) => (row.file.endsWith('/') ? read.file.startsWith(row.file) : read.file === row.file) && row.arg.test(read.arg);

/** The reads no row classifies: a new reader of a file that the inventory does not know. */
export function unclassifiedReads(reads = fileReads(), rows = READ_POINTS) {
  return reads.filter((found) => !rows.some((row) => rowMatches(row, found)))
    .map(({ file, line, call, arg }) => `${file}:${line} ${call}(${arg})`);
}

/** The rows that match no read: a classification of something the source no longer does. */
export function staleReadRows() {
  const reads = fileReads();
  return READ_POINTS.filter((row) => !reads.some((found) => rowMatches(row, found))).map((row) => `${row.file} ${row.arg}`);
}

// ---------------------------------------------------------------------------------------------------------------
// 4c. The readers of a subsystem's own configuration (telemetry, trajectory, quota, daemon, codexQuota, todo).
//
// A subsystem must not check the saved configuration with a validator of its own: the schema (CONFIG_SCHEMA and configOf) is
// the one place that says what a key takes, so that `config set` and the reader agree. The scanner lists every line of
// src/ that checks the type or range of a value of the configuration (a `config`/`settings` name beside `isSafeInteger`,
// `isInteger`, `isFinite`, `Array.isArray` or `typeof`) and fails for a file that is not named below.

const VALIDATING = /(?:\b(?:Number\.isSafeInteger|Number\.isInteger|Number\.isFinite|Array\.isArray)\([^)]*\b(?:config|settings)\b|\btypeof\s+(?:config|settings)\b[\w.?'\[\]]*|\b(?:config|settings)\b[\w.?'\[\]]*\s*(?:<=|>=|[<>])\s*0)/;

/** The files that may check a value of the configuration themselves, and why (the count is exact, so a new check is seen). */
export const OWN_VALIDATORS = Object.freeze({
  'src/trajectory/config.js': { count: 4, why: 'trajectory.* has no entry in CONFIG_SCHEMA (`config set` does not take it), so there is no schema for this reader to differ from; the test below fails if one is added' },
  'src/env/quota.js': { count: 1, why: 'configuredClients: a reader that never stops; a value that is not a list is the default' },
  'src/spawn-process.js': { count: 2, why: 'the command of a model listing (profile settings checked by configOf); a value that is not text is the default' },
  'src/quota/statusline-collector.js': { count: 2, why: 'statuslineCollector.previous: run by the client, never refuses; a value that is not a list is the default' },
  'src/setup/setup.js': { count: 1, why: 'setup: a root that is not an object is an empty section; the wrong shapes are refused as an unreadable file (FILE_RULES)' },
  'src/env/models.js': { count: 1, why: 'candidates of the model listing: a reader that never stops' },
});

/** `{ file, line, text }` for every line of src/ (outside the schema's own files) that checks a value of the configuration. */
export function ownValidators() {
  const found = [];
  for (const file of sourceFiles()) {
    if (['src/config-schema.js', 'src/profiles.js', 'src/config.js'].includes(file) || /^src\/(install|smoke|release)\//.test(file)) continue;
    withoutComments(read(file)).split('\n').forEach((text, index) => { if (VALIDATING.test(text)) found.push({ file, line: index + 1, text: text.trim() }); });
  }
  return found;
}
