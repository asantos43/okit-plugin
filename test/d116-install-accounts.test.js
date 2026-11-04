import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { main } from '../src/cli.js';
import { exitCodeFor } from '../src/install/exit.js';
import { readRecord } from '../src/install/place.js';
import { accountFiles } from '../src/accounts.js';
import { collectStatusline } from '../src/quota/statusline-collector.js';
import { paths } from '../src/store.js';
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
  assert.equal(await f.run('install', '--client', CLIENT, '--account', 'work', '--statusline'), 0, f.output.join('\n'));
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
});

test('update --account is refused, in the language of the run', async (t) => {
  const f = await world(t);
  assert.equal(await f.run('install', '--client', CLIENT, '--account', 'work'), 0, f.output.join('\n'));
  f.output.length = 0;
  assert.equal(await f.run('update', '--client', CLIENT, '--account', 'work'), exitCodeFor('usage'));
  assert.match(f.output.join('\n'), /An update moves every registered account; run it without --account\./);
  f.output.length = 0;
  assert.equal(await f.run('update', '--client', CLIENT, '--account', 'work', '--locale', 'pt-BR'), exitCodeFor('usage'));
  assert.match(f.output.join('\n'), /Uma atualização move todas as contas registradas; rode sem --account\./);
});

test('an unknown id, a client without accounts and a missing client are refused with pt-BR text', async (t) => {
  const f = await world(t);
  const refused = async (args, text) => {
    f.output.length = 0;
    assert.equal(await f.run(...args, '--locale', 'pt-BR'), exitCodeFor('usage'), args.join(' '));
    assert.match(f.output.join('\n'), text);
  };
  await refused(['install', '--client', CLIENT, '--account', 'nobody'], /Conta desconhecida\./);
  await refused(['install', '--client', CLIENT, '--account', 'Bad Id!'], /./);
  await refused(['install', '--client', 'opencode', '--account', 'work'], /Contas não são suportadas para este cliente\./);
  await refused(['install', '--account', 'work'], /Informe o cliente da conta com --client\./);
  await refused(['uninstall', '--account', 'work'], /Informe o cliente da conta com --client\./);
  await refused(['install', '--client', 'all', '--account', 'work'], /Informe o cliente da conta com --client\./);
  // A flag with no value (or an empty one) is refused as every value flag is; a repeated one is read the last way.
  await refused(['install', '--client', CLIENT, '--account'], /./);
  await refused(['install', '--client', CLIENT, '--account', ''], /./);
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
    const work = join(f.home, 'work');
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
  const f = await world(t);
  for (const account of ['work', 'personal']) {
    assert.equal(await f.run('install', '--client', CLIENT, '--account', account, '--statusline'), 0, f.output.join('\n'));
  }
  const command = (await settingsOf(f.work)).statusLine.command;
  // One command for every account: it names no account, the client's folder variable at run time does.
  assert.equal((await settingsOf(f.personal)).statusLine.command, command);
  assert.ok(!command.includes(f.work) && !command.includes(f.personal));
  const config = JSON.parse(await fs.readFile(join(f.root, 'config.json'), 'utf8'));
  const input = Buffer.from(JSON.stringify({ rate_limits: { five_hour: { used_percentage: 40, resets_at: 1800000000 } } }));
  for (const [id, folder] of [['work', f.work], ['personal', f.personal]]) {
    const root = join(f.home, `state-${id}`);
    await collectStatusline({ stateRoot: root, config, now: () => 1800000000000, input, env: { [FOLDER_VARIABLE]: folder } });
    assert.deepEqual(await fs.readdir(paths(root).quota), [accountFiles(CLIENT, id).statusline]);
  }
});
