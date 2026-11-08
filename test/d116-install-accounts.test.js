import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { main } from '../src/cli.js';
import { exitCodeFor } from '../src/install/exit.js';
import { readRecord } from '../src/install/place.js';
import { accountFiles } from '../src/accounts.js';
import { commandWords } from '../src/install/statusline.js';
import { HOME_ENV, paths } from '../src/store.js';
import { answerCheck, fixture, mcpWorld } from './helpers/install-fixture.js';

// D116: `install|uninstall --client C --account X` registers and unregisters the plugin in the folder of one account.
//
// | Input                                   | Must pass                                          | Must refuse                         |
// | install --account X (X saved)           | X's folder written, others untouched               | an id that is not saved             |
// | uninstall --account X                   | only X's registration and bar go out               | touching another account or payload |
// | update                                  | every registered account follows the new payload   | update --account X                  |
// | --account on opencode                   | -                                                  | "Accounts are not supported"        |

const CLIENT = 'claude-code';
const FOLDER_VARIABLE = 'CLAUDE_CONFIG_DIR';
const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));

/** The name of the MCP entry in the words of the client's own command (`mcp add --scope user NAME -- ...`). */
function entryName(args) {
  const words = args.slice(2);
  for (let index = 0; index < words.length; index += 1) {
    if (words[index] === '--') break;
    if (words[index].startsWith('-')) { index += 1; continue; }
    return words[index];
  }
  return undefined;
}

/** A world with two saved accounts of Claude Code; each folder holds the MCP entries its own client program was given. */
async function world(t, { accounts = true } = {}) {
  const f = await fixture(t);
  f.work = join(f.home, 'accounts', 'work');
  f.personal = join(f.home, 'accounts', 'personal');
  f.client = f.io.clientRoot;
  if (accounts) {
    const saved = JSON.parse(await fs.readFile(join(f.root, 'config.json'), 'utf8'));
    saved.accounts = { [CLIENT]: [{ id: 'work', label: 'Work', configDir: f.work }, { id: 'personal', label: 'Personal', configDir: f.personal }] };
    saved.quotaPoll = { enabled: true }; // tests that launch the active read opt in explicitly
    await fs.writeFile(join(f.root, 'config.json'), JSON.stringify(saved));
  }
  // One registry of MCP entries per client folder: the program of an account is run with that account's folder variable.
  const registries = new Map();
  f.registry = (folder) => { if (!registries.has(folder)) registries.set(folder, mcpWorld()); return registries.get(folder); };
  f.io.run = async (command) => {
    f.commands.push(command);
    if (command.args?.[0] !== 'mcp') return answerCheck(command, { bin: f.bin });
    return f.registry(command.env?.[FOLDER_VARIABLE] ?? f.client).run(command);
  };
  /** Whether the program run for a folder holds an MCP entry (the last command the fake world was given for it says). */
  f.holds = (folder) => {
    let held = false;
    for (const command of f.commands) {
      if (command.args?.[0] !== 'mcp' || (command.env?.[FOLDER_VARIABLE] ?? f.client) !== folder) continue;
      if (command.args[1] === 'add') held = true;
      if (command.args[1] === 'remove') held = false;
    }
    return held;
  };
  f.run = (...args) => main(args, f.io);
  f.record = () => readRecord(f.destination, CLIENT, fs);
  return f;
}

const settingsOf = async (folder) => JSON.parse(await fs.readFile(join(folder, 'settings.json'), 'utf8'));
const exists = (path) => fs.stat(path).then(() => true, () => false);
const registrationCommands = (f) => f.commands.filter(({ args }) => ['plugin', 'mcp'].includes(args?.[0]));

test('install of two accounts leaves each other\'s folders untouched', async (t) => {
  const f = await world(t);
  const quotaReads = [];
  f.io.spawn = (_command, args) => { quotaReads.push(args); return { on() {}, unref() {} }; };
  assert.equal(await f.run('install', '--client', CLIENT, '--account', 'work', '--statusline'), 0, f.output.join('\n'));
  assert.equal(quotaReads.length, 1);
  assert.deepEqual(quotaReads[0].slice(-3), [CLIENT, 'work', 'force']);
  // The payload is shared: one record, one folder; only the registration belongs to the account.
  const first = await f.record();
  assert.deepEqual(Object.keys(first.accounts), ['work']);
  assert.equal(first.defaultRegistered, false);
  assert.equal(first.statusline, undefined);
  const workBar = await fs.readFile(join(f.work, 'settings.json'));
  assert.ok(first.accounts.work.statusline.path.startsWith(f.work));
  assert.equal(await exists(join(f.personal, 'settings.json')), false);
  assert.equal(await exists(join(f.client, 'settings.json')), false);

  assert.equal(f.holds(f.work), true);
  // The commands of the first run stay in the log (`holds` reads it); only what the second run adds is looked at.
  const before = f.commands.length;
  assert.equal(await f.run('install', '--client', CLIENT, '--account', 'personal', '--statusline'), 0, f.output.join('\n'));
  const second = await f.record();
  assert.deepEqual(Object.keys(second.accounts).sort(), ['personal', 'work']);
  assert.equal(second.path, first.path);
  assert.ok(workBar.equals(await fs.readFile(join(f.work, 'settings.json'))));
  assert.ok(Object.hasOwn(await settingsOf(f.personal), 'statusLine'));
  assert.equal(await exists(join(f.client, 'settings.json')), false);
  // The same version is already here: nothing is placed again, the second account is only registered.
  assert.ok(f.holds(f.work) && f.holds(f.personal));
  const added = f.commands.slice(before).filter(({ args }) => ['plugin', 'mcp'].includes(args?.[0]));
  assert.ok(added.length > 0);
  assert.ok(added.every(({ env }) => env[FOLDER_VARIABLE] === f.personal));
});

test('the program of account X gets X\'s folder variable and none of another account', async (t) => {
  const f = await world(t);
  f.io.env[FOLDER_VARIABLE] = f.personal;
  assert.equal(await f.run('install', '--client', CLIENT, '--account', 'work'), 0, f.output.join('\n'));
  const commands = registrationCommands(f);
  assert.ok(commands.length > 0);
  for (const command of commands) {
    assert.equal(command.env[FOLDER_VARIABLE], f.work);
    assert.ok(!Object.values(command.env).includes(f.personal));
  }
  // The default account is the folder with no override: its program is run without the variable.
  f.commands.length = 0;
  assert.equal(await f.run('install', '--client', CLIENT), 0, f.output.join('\n'));
  const defaults = registrationCommands(f);
  assert.ok(defaults.length > 0);
  for (const command of defaults) assert.ok(!command.env || !Object.hasOwn(command.env, FOLDER_VARIABLE), JSON.stringify(command));
  assert.equal((await f.record()).defaultRegistered, undefined);
});

test('uninstall of one account leaves the other\'s settings, MCP entry, bar backup and the payload', async (t) => {
  const f = await world(t);
  for (const account of ['work', 'personal']) {
    assert.equal(await f.run('install', '--client', CLIENT, '--account', account, '--statusline'), 0, f.output.join('\n'));
  }
  const before = await f.record();
  const personalBar = await fs.readFile(join(f.personal, 'settings.json'));
  f.output.length = 0;
  assert.equal(await f.run('uninstall', '--client', CLIENT, '--account', 'work'), 0, f.output.join('\n'));
  const after = await f.record();
  assert.deepEqual(Object.keys(after.accounts), ['personal']);
  assert.equal(await exists(before.path), true);
  assert.equal(await exists(join(f.work, 'settings.json')), false);
  assert.ok(personalBar.equals(await fs.readFile(join(f.personal, 'settings.json'))));
  assert.equal(await exists(before.accounts.personal.statusline.backup), true);
  assert.equal(await exists(before.accounts.work.statusline.backup), false);
  assert.equal(f.holds(f.work), false);
  assert.equal(f.holds(f.personal), true);
  assert.match(f.output.join('\n'), /other accounts still use it: personal/);
  // An account that holds no registration is refused in words.
  f.output.length = 0;
  assert.equal(await f.run('uninstall', '--client', CLIENT, '--account', 'work'), exitCodeFor('usage'));
  assert.match(f.output.join('\n'), /That account is not registered\./);
});

test('uninstall of the last registration removes the payload and the record', async (t) => {
  const f = await world(t);
  for (const account of ['work', 'personal']) {
    assert.equal(await f.run('install', '--client', CLIENT, '--account', account, '--statusline'), 0, f.output.join('\n'));
  }
  const { path } = await f.record();
  assert.equal(await f.run('uninstall', '--client', CLIENT, '--account', 'work'), 0);
  // A default registration that is not there does not keep the payload either.
  assert.equal(await f.run('uninstall', '--client', CLIENT, '--account', 'personal'), 0, f.output.join('\n'));
  assert.equal(await f.record(), null);
  assert.equal(await exists(path), false);
  assert.equal(await exists(join(f.personal, 'settings.json')), false);
});

test('uninstall without --account acts on the default account and keeps the payload while extras are registered', async (t) => {
  const f = await world(t);
  assert.equal(await f.run('install', '--client', CLIENT), 0, f.output.join('\n'));
  assert.equal(await f.run('install', '--client', CLIENT, '--account', 'work', '--statusline'), 0, f.output.join('\n'));
  const { path } = await f.record();
  f.output.length = 0;
  assert.equal(await f.run('uninstall', '--client', CLIENT), 0, f.output.join('\n'));
  const record = await f.record();
  assert.equal(record.defaultRegistered, false);
  assert.deepEqual(Object.keys(record.accounts), ['work']);
  assert.equal(await exists(path), true);
  assert.equal(f.holds(f.client), false);
  assert.equal(f.holds(f.work), true);
  const text = f.output.join('\n');
  assert.match(text, /Accounts of .*: default, work, personal|Accounts of .*: default, work/);
  assert.match(text, /The default account was used\./);
  // --purge needs no registration left: it is refused (naming the account that stays), whichever account is named,
  // before the answer that the default account is not registered.
  f.output.length = 0;
  assert.notEqual(await f.run('uninstall', '--client', CLIENT, '--purge', '--yes'), 0);
  assert.match(f.output.join('\n'), /--purge requires no remaining accounts \(still registered: work\)/);
  assert.doesNotMatch(f.output.join('\n'), /That account is not registered\./);
  assert.equal((await f.record()).path, path);
  assert.equal(await exists(path), true);
  // Taking the last account out removes the record and the payload.
  assert.equal(await f.run('uninstall', '--client', CLIENT, '--account', 'work', '--purge', '--yes'), 0, f.output.join('\n'));
  assert.equal(await f.record(), null);
  assert.equal(await exists(path), false);
});

test('update moves the payload once and re-registers every registered account', async (t) => {
  const f = await world(t);
  assert.equal(await f.run('install', '--client', CLIENT), 0, f.output.join('\n'));
  for (const account of ['work', 'personal']) {
    assert.equal(await f.run('install', '--client', CLIENT, '--account', account, '--statusline'), 0, f.output.join('\n'));
  }
  const before = await f.record();
  f.setVersion('1.0.1');
  f.commands.length = 0;
  f.output.length = 0;
  assert.equal(await f.run('update', '--client', CLIENT), 0, f.output.join('\n'));
  const after = await f.record();
  assert.equal(after.version, '1.0.1');
  assert.notEqual(after.path, before.path);
  assert.deepEqual(Object.keys(after.accounts).sort(), ['personal', 'work']);
  assert.equal(after.accounts.work.statusline.path, before.accounts.work.statusline.path);
  const folders = new Set(registrationCommands(f).filter(({ args }) => args[0] === 'plugin')
    .map(({ env }) => env?.[FOLDER_VARIABLE] ?? 'default'));
  assert.deepEqual([...folders].sort(), ['default', f.personal, f.work].sort());
  assert.match(f.output.join('\n'), /The default account was used\./);
  // The MCP entry of every folder was written again to the new payload, and none still names the old one.
  for (const folder of [f.client, f.work, f.personal]) {
    const add = f.commands.filter(({ args, env }) => args?.[0] === 'mcp' && args[1] === 'add'
      && (env?.[FOLDER_VARIABLE] ?? f.client) === folder).at(-1);
    assert.ok(add, `no MCP entry written in ${folder}`);
    assert.ok(add.args.some((word) => word.startsWith(after.path)), add.args.join(' '));
    assert.ok(!add.args.some((word) => word.startsWith(before.path)), add.args.join(' '));
  }
});

test('update --account is refused, in the language of the run', async (t) => {
  const f = await world(t);
  assert.equal(await f.run('install', '--client', CLIENT, '--account', 'work'), 0, f.output.join('\n'));
  f.output.length = 0;
  assert.equal(await f.run('update', '--client', CLIENT, '--account', 'work'), exitCodeFor('usage'));
  assert.match(f.output.join('\n'), /An update moves every registered account; run it without --account\./);
  f.output.length = 0;
  assert.equal(await f.run('update', '--client', CLIENT, '--account', 'work', '--locale', 'pt-BR'), exitCodeFor('usage'));
  assert.match(f.output.join('\n'), /Uma atualização move todas as contas registradas; rode sem --account\./); // locale:pt-BR
});

test('an unknown id, a client without accounts and a missing client are refused with pt-BR text', async (t) => {
  const f = await world(t);
  const refused = async (args, text) => {
    f.output.length = 0;
    assert.equal(await f.run(...args, '--locale', 'pt-BR'), exitCodeFor('usage'), args.join(' '));
    const said = f.output.join('\n');
    assert.match(said, text);
    // Neither a stack nor a folder of the person leaks into the refusal.
    assert.doesNotMatch(said, /TypeError|RangeError|\bat .*\(.*:\d+:\d+\)|node:internal/);
    assert.ok(!said.includes(f.home), said);
  };
  await refused(['install', '--client', CLIENT, '--account', 'nobody'], /Conta desconhecida\./);
  await refused(['install', '--client', CLIENT, '--account', 'Bad Id!'], /Id de conta inválido\./); // locale:pt-BR
  await refused(['install', '--client', 'opencode', '--account', 'work'], /Contas não são suportadas para este cliente\./); // locale:pt-BR
  await refused(['install', '--account', 'work'], /Informe o cliente da conta com --client\./);
  await refused(['uninstall', '--account', 'work'], /Informe o cliente da conta com --client\./);
  await refused(['install', '--client', 'all', '--account', 'work'], /Informe o cliente da conta com --client\./);
  // A flag with no value (or an empty one) is refused as every value flag is; a repeated one is read the last way.
  await refused(['install', '--client', CLIENT, '--account'], /Falta o valor de --account/);
  await refused(['install', '--client', CLIENT, '--account', ''], /Falta o valor de --account/);
  await refused(['install', '--client', CLIENT, '--account', 'work', '--account', 'nobody'], /Conta desconhecida\./);
  assert.equal(await f.record(), null);
  assert.equal(await exists(join(f.work, 'settings.json')), false);
});

test('without extra accounts the install and the uninstall are what they always were', async (t) => {
  const plain = await world(t, { accounts: false });
  assert.equal(await plain.run('install', '--client', CLIENT), 0, plain.output.join('\n'));
  const record = await plain.record();
  assert.equal(record.accounts, undefined);
  assert.equal(record.defaultRegistered, undefined);
  for (const command of registrationCommands(plain)) assert.equal(command.env, undefined);
  assert.doesNotMatch(plain.output.join('\n'), /Accounts of/);
  // `--account default` is the same run as no account.
  const named = await world(t, { accounts: false });
  assert.equal(await named.run('install', '--client', CLIENT, '--account', 'default'), 0, named.output.join('\n'));
  assert.deepEqual(named.lines(), plain.lines());
  assert.equal(await plain.run('uninstall', '--client', CLIENT), 0, plain.output.join('\n'));
  assert.equal(await named.run('uninstall', '--client', CLIENT, '--account', 'default'), 0, named.output.join('\n'));
  assert.equal(await plain.record(), null);
  assert.equal(await named.record(), null);
});

test('platforms: the folder variable of the account reaches the program on linux, macOS and Windows alike', async (t) => {
  for (const platform of ['linux', 'darwin', 'win32']) {
    const f = await fixture(t, platform);
    // A folder with a space and an apostrophe: the variable carries it as it is, whatever the platform quotes.
    const work = join(f.home, "O'Brien work");
    const saved = JSON.parse(await fs.readFile(join(f.root, 'config.json'), 'utf8'));
    saved.accounts = { [CLIENT]: [{ id: 'work', label: 'Work', configDir: work }] };
    await fs.writeFile(join(f.root, 'config.json'), JSON.stringify(saved));
    assert.equal(await main(['install', '--client', CLIENT, '--account', 'work'], f.io), 0, `${platform}: ${f.output.join('\n')}`);
    const commands = f.commands.filter(({ args }) => ['plugin', 'mcp'].includes(args?.[0]));
    assert.ok(commands.length > 0, platform);
    for (const command of commands) assert.equal(command.env[FOLDER_VARIABLE], work, platform);
  }
});

test('the status bar registered for X writes X\'s reading when the client runs it with X\'s folder', async (t) => {
  const probe = spawnSync(process.execPath, ['-e', 'console.log("d145-pipe-probe")'], { encoding: 'utf8' });
  if (probe.status === 0 && probe.stdout.trim() === '') {
    t.skip('Sandbox drops child stdout pipes; Director must run the subprocess collector proof.');
    return;
  }
  const f = await world(t);
  for (const account of ['work', 'personal']) {
    assert.equal(await f.run('install', '--client', CLIENT, '--account', account, '--statusline'), 0, f.output.join('\n'));
  }
  const command = (await settingsOf(f.work)).statusLine.command;
  // One command for every account: it names no account, the client's folder variable at run time does.
  assert.equal((await settingsOf(f.personal)).statusLine.command, command);
  assert.ok(!command.includes(f.work) && !command.includes(f.personal));
  // The REGISTERED command is run, as the client runs it, over ONE shared state: the collector of the repository stands
  // for the command that the link names, and each run is given its own account's folder only.
  const words = commandWords(command);
  assert.ok(words && words[1] === 'statusline-collector', command);
  const shared = join(f.home, 'shared-state');
  await fs.mkdir(shared);
  await fs.copyFile(join(f.root, 'config.json'), join(shared, 'config.json'));
  const input = JSON.stringify({ rate_limits: { five_hour: { used_percentage: 40, resets_at: Math.floor(Date.now() / 1000) + 3600 } } });
  const ran = [];
  for (const [id, folder] of [['work', f.work], ['personal', f.personal]]) {
    const result = spawnSync(process.execPath, [CLI, ...words.slice(1)], { input, encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: f.home, [HOME_ENV]: shared, [FOLDER_VARIABLE]: folder } });
    assert.equal(result.status, 0, result.stderr);
    ran.push(accountFiles(CLIENT, id).statusline);
    // After each run the shared state holds the readings of the accounts that ran so far, and no other file.
    assert.deepEqual((await fs.readdir(paths(shared).quota)).sort(), [...ran].sort());
  }
  // A folder that names no saved account writes nothing: the readings of the accounts are never overwritten by it.
  const result = spawnSync(process.execPath, [CLI, ...words.slice(1)], { input, encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: f.home, [HOME_ENV]: shared, [FOLDER_VARIABLE]: join(f.home, 'forgotten') } });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual((await fs.readdir(paths(shared).quota)).sort(), [...ran].sort());
});

/** Saves the accounts of the client in the configuration of the run: the ones left out are forgotten by it. */
async function saveAccounts(f, list) {
  const saved = JSON.parse(await fs.readFile(join(f.root, 'config.json'), 'utf8'));
  saved.accounts = { [CLIENT]: list };
  await fs.writeFile(join(f.root, 'config.json'), JSON.stringify(saved));
}

/** Every file under a folder, as paths (a folder that is not there holds none). */
async function filesUnder(folder) {
  const found = [];
  const entries = await fs.readdir(folder, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) found.push(...await filesUnder(path));
    else found.push(path);
  }
  return found;
}

test('an account taken out of the configuration still holds the payload and is taken out where it was registered', async (t) => {
  const f = await world(t);
  assert.equal(await f.run('install', '--client', CLIENT), 0, f.output.join('\n'));
  assert.equal(await f.run('install', '--client', CLIENT, '--account', 'work', '--statusline'), 0, f.output.join('\n'));
  const { path } = await f.record();
  // The person forgets `work`: only the record knows that it is registered.
  await saveAccounts(f, [{ id: 'personal', label: 'Personal', configDir: f.personal }]);
  f.output.length = 0;
  assert.equal(await f.run('uninstall', '--client', CLIENT), 0, f.output.join('\n'));
  assert.deepEqual(Object.keys((await f.record()).accounts), ['work']);
  assert.equal(await exists(path), true);
  assert.match(f.output.join('\n'), /other accounts still use it: work/);
  // --purge is refused while the forgotten account holds a registration, naming it.
  f.output.length = 0;
  assert.equal(await f.run('uninstall', '--client', CLIENT, '--purge', '--yes'), exitCodeFor('usage'));
  assert.match(f.output.join('\n'), /still registered: work/);
  assert.equal(await exists(path), true);
  assert.equal(f.holds(f.work), true);
  // Installing it again needs it saved; nothing changes.
  const commandsBefore = f.commands.length;
  assert.equal(await f.run('install', '--client', CLIENT, '--account', 'work'), exitCodeFor('usage'));
  assert.equal(f.commands.length, commandsBefore);
  // Taking it out acts in the folder it was registered in, and then nothing holds the payload.
  f.output.length = 0;
  assert.equal(await f.run('uninstall', '--client', CLIENT, '--account', 'work', '--purge', '--yes'), 0, f.output.join('\n'));
  const removed = f.commands.slice(commandsBefore).filter(({ args }) => ['plugin', 'mcp'].includes(args?.[0]));
  assert.ok(removed.length > 0);
  assert.ok(removed.every(({ env }) => env[FOLDER_VARIABLE] === f.work), JSON.stringify(removed));
  assert.equal(f.holds(f.work), false);
  assert.equal(await exists(join(f.work, 'settings.json')), false);
  assert.equal(await f.record(), null);
  assert.equal(await exists(path), false);
});

test('a rollback keeps the registrations of now: an account gone since then stays gone', async (t) => {
  const f = await world(t);
  for (const account of ['work', 'personal']) {
    assert.equal(await f.run('install', '--client', CLIENT, '--account', account), 0, f.output.join('\n'));
  }
  const first = await f.record();
  f.setVersion('1.0.1');
  assert.equal(await f.run('update', '--client', CLIENT), 0, f.output.join('\n'));
  assert.equal(await f.run('uninstall', '--client', CLIENT, '--account', 'personal'), 0, f.output.join('\n'));
  assert.deepEqual(Object.keys((await f.record()).accounts), ['work']);
  // The old record held both accounts; the rollback must not bring `personal` back.
  const commandsBefore = f.commands.length;
  assert.equal(await f.run('update', '--rollback', '--client', CLIENT), 0, f.output.join('\n'));
  const rolled = await f.record();
  assert.equal(rolled.version, '1.0.0');
  assert.equal(rolled.path, first.path);
  assert.deepEqual(Object.keys(rolled.accounts), ['work']);
  assert.equal(rolled.defaultRegistered, false);
  assert.equal(f.holds(f.personal), false);
  assert.equal(f.holds(f.work), true);
  const registered = f.commands.slice(commandsBefore).filter(({ args }) => ['plugin', 'mcp'].includes(args?.[0]));
  assert.ok(registered.length > 0);
  assert.ok(registered.every(({ env }) => env[FOLDER_VARIABLE] === f.work), JSON.stringify(registered));
  const entry = registered.filter(({ args }) => args[0] === 'mcp' && args[1] === 'add').at(-1);
  assert.ok(entry.args.some((word) => word.startsWith(first.path)), entry.args.join(' '));
});

test('a rollback keeps the default registered since then, and does not bring back an old absence', async (t) => {
  const f = await world(t);
  assert.equal(await f.run('install', '--client', CLIENT, '--account', 'work'), 0, f.output.join('\n'));
  f.setVersion('1.0.1');
  assert.equal(await f.run('update', '--client', CLIENT), 0, f.output.join('\n'));
  // The record that the rollback goes back to says the default was not registered; now it is.
  assert.equal((await f.record()).previous.defaultRegistered, false);
  assert.equal(await f.run('install', '--client', CLIENT), 0, f.output.join('\n'));
  assert.equal((await f.record()).defaultRegistered, undefined);
  const commandsBefore = f.commands.length;
  assert.equal(await f.run('update', '--rollback', '--client', CLIENT), 0, f.output.join('\n'));
  const rolled = await f.record();
  assert.equal(rolled.version, '1.0.0');
  assert.equal(rolled.defaultRegistered, undefined);
  assert.deepEqual(Object.keys(rolled.accounts), ['work']);
  const folders = new Set(f.commands.slice(commandsBefore).filter(({ args }) => args?.[0] === 'plugin')
    .map(({ env }) => env?.[FOLDER_VARIABLE] ?? 'default'));
  assert.deepEqual([...folders].sort(), ['default', f.work].sort());
  assert.equal(f.holds(f.client), true);
});

test('a rollback brings back no status bar of an old record: reinstalling the default then makes its backup', async (t) => {
  const f = await world(t);
  // Settings that exist before the plugin, with bytes the install would not write (spaces, a tab, a closing newline).
  const originals = { default: Buffer.from('{\n  "mark": "original-default",\t"x": 1  \n}\n'), work: Buffer.from('{ "mark" : "original-work" }\n') };
  await fs.mkdir(f.client, { recursive: true });
  await fs.mkdir(f.work, { recursive: true });
  await fs.writeFile(join(f.client, 'settings.json'), originals.default);
  await fs.writeFile(join(f.work, 'settings.json'), originals.work);
  assert.equal(await f.run('install', '--client', CLIENT, '--statusline'), 0, f.output.join('\n'));
  assert.equal(await f.run('install', '--client', CLIENT, '--account', 'work', '--statusline'), 0, f.output.join('\n'));
  f.setVersion('1.0.1');
  assert.equal(await f.run('update', '--client', CLIENT), 0, f.output.join('\n'));
  const oldBar = (await f.record()).previous.statusline;
  assert.ok(oldBar, 'the old record held the default\'s bar');
  // The default goes: its settings come back and its bar and backup are gone from the record of now.
  assert.equal(await f.run('uninstall', '--client', CLIENT), 0, f.output.join('\n'));
  assert.ok(originals.default.equals(await fs.readFile(join(f.client, 'settings.json'))));
  const gone = await f.record();
  assert.equal(gone.statusline, undefined);
  assert.equal(gone.defaultRegistered, false);
  assert.equal(await exists(oldBar.backup), false);
  // The rollback brings the old payload, not the old bar of the default; the bar of `work` (registered now) stays.
  assert.equal(await f.run('update', '--rollback', '--client', CLIENT), 0, f.output.join('\n'));
  const rolled = await f.record();
  assert.equal(rolled.version, '1.0.0');
  assert.equal(rolled.statusline, undefined);
  assert.equal(rolled.defaultRegistered, false);
  assert.deepEqual(rolled.accounts, gone.accounts);
  assert.equal(await exists(rolled.accounts.work.statusline.backup), true);
  assert.ok(originals.default.equals(await fs.readFile(join(f.client, 'settings.json'))));
  // The default is installed again in the restored version: its backup is made now, and its uninstall restores the original.
  f.setVersion('1.0.0');
  assert.equal(await f.run('install', '--client', CLIENT, '--statusline'), 0, f.output.join('\n'));
  const again = await f.record();
  assert.ok(again.statusline, 'the bar of the default is registered again');
  assert.equal(await exists(again.statusline.backup), true);
  assert.equal(again.defaultRegistered, undefined);
  f.output.length = 0;
  assert.equal(await f.run('uninstall', '--client', CLIENT), 0, f.output.join('\n'));
  assert.ok(originals.default.equals(await fs.readFile(join(f.client, 'settings.json'))));
  assert.equal(await exists(again.statusline.backup), false);
  assert.ok(Object.hasOwn(await settingsOf(f.work), 'statusLine'), 'the bar of work is still there');
});

test('the backup of an update keeps the plugin\'s files of every account and never a login', async (t) => {
  const f = await world(t);
  const folders = { default: f.client, work: f.work, personal: f.personal };
  // Each folder holds the files of a login (that no backup may copy) and settings of its own that the install keeps.
  for (const [id, folder] of Object.entries(folders)) {
    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(join(folder, '.credentials.json'), `SECRET-CREDENTIALS-${id}`);
    await fs.writeFile(join(folder, 'auth.json'), `SECRET-AUTH-${id}`);
    await fs.writeFile(join(folder, 'oauth-token.txt'), `SECRET-TOKEN-${id}`);
    // Inside the plugins folder (copied as a whole): only the recursive filter of the copy keeps the login out.
    await fs.mkdir(join(folder, 'plugins', 'cache'), { recursive: true });
    await fs.writeFile(join(folder, 'plugins', 'cache', 'auth.json'), `SECRET-NESTED-${id}`);
    await fs.writeFile(join(folder, 'plugins', 'cache', 'keep.txt'), `kept-${id}`);
    await fs.writeFile(join(folder, 'settings.json'), JSON.stringify({ mark: `original-${id}` }));
  }
  assert.equal(await f.run('install', '--client', CLIENT, '--statusline'), 0, f.output.join('\n'));
  for (const account of ['work', 'personal']) {
    assert.equal(await f.run('install', '--client', CLIENT, '--account', account, '--statusline'), 0, f.output.join('\n'));
  }
  f.setVersion('1.0.1');
  assert.equal(await f.run('update', '--client', CLIENT), 0, f.output.join('\n'));
  const kept = await filesUnder(join(f.destination, 'backups'));
  assert.ok(kept.length > 0);
  for (const file of kept) {
    assert.ok(!/credential|auth\.json|token/i.test(file.slice(f.destination.length)), file);
    assert.doesNotMatch(await fs.readFile(file, 'utf8'), /SECRET-/, file);
  }
  // The files the plugin writes are there, each folder's own original content apart from the others'.
  const settings = await Promise.all(kept.filter((file) => file.endsWith('settings.json')).map((file) => fs.readFile(file, 'utf8')));
  for (const id of Object.keys(folders)) assert.ok(settings.some((text) => text.includes(`original-${id}`)), `no backup of ${id}`);
  // The plugins folder was copied (its harmless file is there), without the login file inside it.
  const harmless = await Promise.all(kept.filter((file) => file.endsWith('keep.txt')).map((file) => fs.readFile(file, 'utf8')));
  for (const id of Object.keys(folders)) assert.ok(harmless.includes(`kept-${id}`), `no plugins folder of ${id}`);
  // The logins themselves were not touched.
  for (const [id, folder] of Object.entries(folders)) assert.equal(await fs.readFile(join(folder, '.credentials.json'), 'utf8'), `SECRET-CREDENTIALS-${id}`);
});

test('the check of a run asks each registered account with that account\'s own folder, once', async (t) => {
  const f = await world(t);
  // The run itself names a folder (the personal one): no account may be asked with it unless it is that account.
  f.io.env[FOLDER_VARIABLE] = f.personal;
  assert.equal(await f.run('install', '--client', CLIENT, '--statusline'), 0, f.output.join('\n'));
  for (const account of ['work', 'personal']) {
    assert.equal(await f.run('install', '--client', CLIENT, '--account', account, '--statusline'), 0, f.output.join('\n'));
  }
  f.commands.length = 0;
  // The same version is here: the run is only the check, which runs the written status bar of every registered account.
  assert.equal(await f.run('install', '--client', CLIENT, '--account', 'work', '--statusline'), 0, f.output.join('\n'));
  const asked = f.commands.filter(({ args }) => (args ?? []).some((word) => String(word).includes('statusline-collector')));
  const count = new Map();
  for (const { env } of asked) {
    const folder = env[FOLDER_VARIABLE] ?? 'default';
    count.set(folder, (count.get(folder) ?? 0) + 1);
  }
  assert.deepEqual([...count.keys()].sort(), ['default', f.personal, f.work].sort());
  // Every account is asked the same number of times (no query repeated for one and missed for another).
  assert.equal(new Set(count.values()).size, 1, JSON.stringify([...count]));
  // The default is asked with a clean environment: the variable of the run (the personal folder) does not reach it.
  assert.ok(asked.filter(({ env }) => !Object.hasOwn(env, FOLDER_VARIABLE)).length > 0);
});

test('the doctor reads the registration of each account with its own folder, one query each', async (t) => {
  const f = await world(t);
  for (const account of [null, 'work', 'personal']) {
    assert.equal(await f.run('install', '--client', CLIENT, ...(account ? ['--account', account] : [])), 0, f.output.join('\n'));
  }
  // The terminal of the person happens to name the work folder.
  f.io.env[FOLDER_VARIABLE] = f.work;
  f.commands.length = 0;
  await main(['doctor'], f.io);
  const queries = f.commands.filter(({ args }) => args?.[0] === 'mcp' && args[1] === 'get');
  const folders = queries.map(({ env }) => env?.[FOLDER_VARIABLE] ?? 'default');
  assert.deepEqual([...folders].sort(), ['default', f.personal, f.work].sort(), JSON.stringify(folders));
});

test('an id saved again with another folder is refused until the account is uninstalled where it was registered', async (t) => {
  const f = await world(t);
  assert.equal(await f.run('install', '--client', CLIENT, '--account', 'work', '--statusline'), 0, f.output.join('\n'));
  const before = await f.record();
  const elsewhere = join(f.home, 'accounts', 'work-moved');
  await saveAccounts(f, [{ id: 'work', label: 'Work', configDir: elsewhere }, { id: 'personal', label: 'Personal', configDir: f.personal }]);
  const commandsBefore = f.commands.length;
  for (const [locale, text] of [['en', /registered in another folder/], ['pt-BR', /registrada em outra pasta/]]) { // locale:pt-BR
    f.output.length = 0;
    assert.equal(await f.run('install', '--client', CLIENT, '--account', 'work', '--statusline', '--locale', locale), exitCodeFor('usage'));
    assert.match(f.output.join('\n'), text);
    assert.doesNotMatch(f.output.join('\n'), /TypeError|node:internal/);
  }
  // Nothing was touched: no command, no file in the new folder, the same record.
  assert.equal(f.commands.length, commandsBefore);
  assert.equal(await exists(elsewhere), false);
  assert.deepEqual(await f.record(), before);
  // Uninstalling takes the registration out of the folder it was made in, and leaves the new folder alone.
  assert.equal(await f.run('uninstall', '--client', CLIENT, '--account', 'work'), 0, f.output.join('\n'));
  const removed = f.commands.slice(commandsBefore).filter(({ args }) => ['plugin', 'mcp'].includes(args?.[0]));
  assert.ok(removed.length > 0);
  assert.ok(removed.every(({ env }) => env[FOLDER_VARIABLE] === f.work), JSON.stringify(removed));
  assert.equal(await exists(join(f.work, 'settings.json')), false);
  assert.equal(await exists(elsewhere), false);
  assert.equal(await f.record(), null);
});

test('an install of one account does not move the others to another version', async (t) => {
  const f = await world(t);
  for (const account of ['work', 'personal']) {
    assert.equal(await f.run('install', '--client', CLIENT, '--account', account), 0, f.output.join('\n'));
  }
  const before = await f.record();
  const commandsBefore = f.commands.length;
  f.setVersion('1.0.1');
  for (const [locale, text] of [['en', /Other accounts use version 1\.0\.0; run \S+ update first\./],
    ['pt-BR', /Outras contas usam a versão 1\.0\.0; rode \S+ update primeiro\./]]) { // locale:pt-BR
    f.output.length = 0;
    assert.equal(await f.run('install', '--client', CLIENT, '--account', 'personal', '--locale', locale), exitCodeFor('usage'));
    assert.match(f.output.join('\n'), text);
  }
  assert.deepEqual(await f.record(), before);
  assert.equal(f.commands.length, commandsBefore);
  assert.equal(await exists(before.path), true);
  // An update moves them all; a single registered account may bring its own version.
  const alone = await world(t);
  assert.equal(await alone.run('install', '--client', CLIENT, '--account', 'work'), 0, alone.output.join('\n'));
  alone.setVersion('1.0.1');
  assert.equal(await alone.run('install', '--client', CLIENT, '--account', 'work'), 0, alone.output.join('\n'));
  assert.equal((await alone.record()).version, '1.0.1');
});

test('an install of one account repairs a payload that is not whole without touching the others', async (t) => {
  const f = await world(t);
  for (const account of ['work', 'personal']) {
    assert.equal(await f.run('install', '--client', CLIENT, '--account', account), 0, f.output.join('\n'));
  }
  const before = await f.record();
  const server = join(before.path, 'src/mcp/server.js');
  await fs.rm(server);
  const commandsBefore = f.commands.length;
  assert.equal(await f.run('install', '--client', CLIENT, '--account', 'personal'), 0, f.output.join('\n'));
  const after = await f.record();
  assert.equal(after.path, before.path);
  assert.equal(await exists(server), true);
  assert.deepEqual(after.accounts.work, before.accounts.work);
  assert.deepEqual(Object.keys(after.accounts).sort(), ['personal', 'work']);
  // The registration of `work` was not written again; only the named account was.
  const touched = f.commands.slice(commandsBefore).filter(({ args }) => ['plugin', 'mcp'].includes(args?.[0]));
  assert.ok(touched.length > 0);
  assert.ok(touched.every(({ env }) => env[FOLDER_VARIABLE] === f.personal), JSON.stringify(touched));
});

test('codex: the folder of the account (with a space and an apostrophe) reaches every command of the client', async (t) => {
  for (const platform of ['linux', 'win32']) {
    const f = await fixture(t, platform);
    const dir = join(f.home, "O'Brien codex work");
    const saved = JSON.parse(await fs.readFile(join(f.root, 'config.json'), 'utf8'));
    saved.accounts = { codex: [{ id: 'work', label: 'Work', configDir: dir }] };
    await fs.writeFile(join(f.root, 'config.json'), JSON.stringify(saved));
    assert.equal(await main(['install', '--client', 'codex', '--account', 'work'], f.io), 0, `${platform}: ${f.output.join('\n')}`);
    const commands = f.commands.filter(({ args }) => ['plugin', 'mcp'].includes(args?.[0]));
    assert.ok(commands.length > 0, platform);
    for (const command of commands) assert.equal(command.env.CODEX_HOME, dir, platform);
    assert.equal((await readRecord(f.destination, 'codex', fs)).accounts.work.configDir, dir);
  }
});
