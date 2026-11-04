import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.js';
import { paths } from '../src/store.js';
import { accountOfConfigDir } from '../src/accounts.js';
import { collectStatusline } from '../src/quota/statusline-collector.js';
import { adapterQuotaReader } from '../src/env/quota.js';

async function fixture(t) {
  const root = await fs.mkdtemp(join(tmpdir(), 'd115-cli-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  await fs.mkdir(home);
  const invoke = async (args, extra = {}) => {
    const out = [], err = [];
    const code = await main(['account', ...args], { root, home, env: { HOME: home, USERPROFILE: home, OKIT_LANGUAGE: 'en' },
      stdout: (line) => out.push(line), stderr: (line) => err.push(line), ...extra });
    const text = [...out, ...err].join('\n');
    assert.ok(!text.includes('SECRET-D115'), text);
    return { code, text, out, err };
  };
  const config = async () => JSON.parse(await fs.readFile(paths(root).config, 'utf8'));
  return { root, home, invoke, config };
}

test('add creates a private directory, preserves markers and reports login without secrets', async (t) => {
  const { root, invoke, config } = await fixture(t);
  for (const [client, label, marker] of [['claude-code', 'Claude', '.credentials.json'], ['codex', 'Codex', 'auth.json']]) {
    const directory = join(root, label);
    let result = await invoke(['add', client, label, '--config-dir', directory], { platform: 'linux' });
    assert.equal(result.code, 0, result.text);
    assert.match(result.text, /logged-out/);
    assert.match(result.text, /Login is manual/);
    if (process.platform !== 'win32') assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
    await fs.writeFile(join(directory, marker), 'SECRET-D115');
    result = await invoke(['list', client, '--json'], { platform: 'linux' });
    assert.equal(JSON.parse(result.out[0])[1].login, 'logged-in');
    assert.equal((await config()).accounts[client][0].configDir, directory);
    result = await invoke(['add', client, `${label} alias`, '--config-dir', directory], { platform: 'linux' });
    assert.equal(result.code, 2);
    assert.match(result.text, /Account folders must be unique/);
    assert.doesNotMatch(result.text, /Login is manual/);
    assert.equal(await fs.readFile(join(directory, marker), 'utf8'), 'SECRET-D115');
    assert.deepEqual(await fs.readdir(directory), [marker]);
  }
});

test('unknown logins and Windows PowerShell instructions', async (t) => {
  const { root, invoke } = await fixture(t);
  const directory = join(root, "Key ring's home");
  await fs.mkdir(directory);
  await fs.writeFile(join(directory, 'config.toml'), 'cli_auth_credentials_store = "keyring"');
  await fs.writeFile(join(directory, 'auth.json'), 'SECRET-D115');
  const result = await invoke(['add', 'codex', 'Keyring', '--config-dir', directory], { platform: 'win32' });
  assert.equal(result.code, 0, result.text);
  assert.match(result.text, /unknown/);
  assert.ok(result.text.includes(`$env:CODEX_HOME='${directory.replaceAll("'", "''")}'; codex`));
  const mac = await invoke(['add', 'claude-code', 'Mac', '--config-dir', join(root, 'mac')], { platform: 'darwin' });
  assert.match(mac.text, /unknown/);
  assert.match(mac.text, /CLAUDE_CONFIG_DIR=.* claude/);
  assert.match(mac.text, /OKWORK_HOME=.* statusline-collector/);
});

// | Corpus | Must pass | Must refuse |
// | commands | supported clients, absolute paths, quoted labels | missing/extra args, bad flags, relative paths |
// | labels | Unicode, 40 chars, rename by id/label | empty, controls, >40 chars, duplicates |
test('refusals use English reasons and Portuguese translations without changing configuration', async (t) => {
  const { root, invoke, config } = await fixture(t);
  const directory = join(root, 'work');
  assert.equal((await invoke(['add', 'codex', 'Work', '--config-dir', directory])).code, 0);
  const before = await config();
  const refusals = [
    ['add', 'opencode', 'Work', '--config-dir', directory],
    ['add', 'codex', 'Work', '--config-dir', directory],
    ['add', 'codex', 'Other', '--config-dir', 'relative'],
    ['remove', 'codex', 'default'], ['remove', 'codex', 'missing'],
    ['rename', 'codex', 'missing', 'Other'], ['rename', 'codex', 'work', 'default'],
    ...['', ' ', 'x'.repeat(41), 'a\nb', 'a\u0085b'].flatMap((label) => [
      ['add', 'codex', label, '--config-dir', directory], ['rename', 'codex', 'Work', label],
    ]),
  ];
  for (const args of refusals) {
    const en = await invoke(args);
    const pt = await invoke([...args, '--locale', 'pt-BR']);
    assert.equal(en.code, 2, en.text);
    assert.equal(pt.code, 2, pt.text);
    assert.doesNotMatch(pt.text, /^uso:/);
    assert.notEqual(pt.text, en.text);
    assert.deepEqual(await config(), before);
  }
  for (const args of [[], ['add'], ['list', 'codex', 'extra'], ['list', '--bad'], ['remove', 'codex'], ['rename', 'codex', 'work']]) {
    assert.equal((await invoke(args)).code, 2);
  }
});

test('list defaults first; rename keeps identity and quota lookup; remove keeps directory and login', async (t) => {
  const { root, invoke, config } = await fixture(t);
  const directory = join(root, 'work');
  await invoke(['add', 'claude-code', 'Work', '--config-dir', directory]);
  await fs.writeFile(join(directory, '.credentials.json'), 'SECRET-D115');
  for (const [selector, label] of [['work', 'Production'], ['Production', 'New name']]) {
    const result = await invoke(['rename', 'claude-code', selector, label]);
    assert.equal(result.code, 0, result.text);
    assert.equal((await config()).accounts['claude-code'][0].id, 'work');
  }
  const raw = await config();
  const env = { HOME: '', CLAUDE_CONFIG_DIR: directory };
  assert.equal(accountOfConfigDir({ client: 'claude-code', config: raw, env }).id, 'work');
  await collectStatusline({ stateRoot: root, config: raw, env, input: Buffer.from(JSON.stringify({
    rate_limits: { five_hour: { used_percentage: 25, resets_at: Date.now() / 1000 + 3600 } },
  })) });
  assert.equal((await adapterQuotaReader({ stateRoot: root, config: raw, env })('claude-code', 'work')).remainingPct, 75);
  const listed = await invoke(['list', '--json']);
  const rows = JSON.parse(listed.out[0]);
  assert.deepEqual(rows.map((row) => row.id), ['default', 'work', 'default']);
  assert.deepEqual(rows[1], { client: 'claude-code', id: 'work', label: 'New name', configDir: directory, login: process.platform === 'darwin' ? 'unknown' : 'logged-in' });
  const text = await invoke(['list', 'claude-code']);
  assert.match(text.text, /claude-code\tdefault\tdefault\tdefault\t/);
  assert.ok(text.text.includes(`work\tNew name\t${directory}`));
  assert.equal((await invoke(['rename', 'claude-code', 'work', 'A'.repeat(40)])).code, 0);
  const removed = await invoke(['remove', 'claude-code', 'work']);
  assert.equal(removed.code, 0);
  assert.match(removed.text, /folder and login remain/);
  assert.equal(await fs.readFile(join(directory, '.credentials.json'), 'utf8'), 'SECRET-D115');
  assert.deepEqual((await config()).accounts['claude-code'], []);
});

test('help includes account commands in both languages and failures exit 1', async (t) => {
  const { root, invoke } = await fixture(t);
  for (const locale of ['en', 'pt-BR']) {
    const result = await invoke(['--help', '--locale', locale]);
    assert.equal(result.code, 0);
    for (const action of ['add', 'list', 'remove', 'rename']) assert.ok(result.text.includes(`account ${action}`));
    assert.ok(result.text.startsWith(locale === 'en' ? 'usage:' : 'uso:'));
    const output = [];
    assert.equal(await main(['--help', '--locale', locale], { root, stdout: (line) => output.push(line) }), 0);
    assert.ok(output[0].includes('account add'));
  }
  const file = join(root, 'not-directory');
  await fs.writeFile(file, '');
  assert.equal((await invoke(['add', 'codex', 'Failure', '--config-dir', join(file, 'child')])).code, 1);
  await fs.writeFile(paths(root).config, '[]');
  const invalid = await invoke(['remove', 'codex', 'work', '--locale', 'pt-BR']);
  assert.equal(invalid.code, 1);
  assert.match(invalid.text, /configuração de contas/);
  assert.equal(await fs.readFile(paths(root).config, 'utf8'), '[]');
});

test('round 11: a folder is checked against the default as it will be once the first account is saved', async (t) => {
  const { root, home, invoke, config } = await fixture(t);
  const env = { HOME: home, USERPROFILE: home, OKIT_LANGUAGE: 'en', CLAUDE_CONFIG_DIR: join(root, 'work-folder') };
  // Saving the first account stops the default from following the variable: it is the install folder then.
  let result = await invoke(['add', 'claude-code', 'Personal', '--config-dir', join(home, '.claude')], { platform: 'linux', env });
  assert.equal(result.code, 2, result.text);
  assert.match(result.text, /Account folders must be unique/);
  assert.equal((await fs.readFile(paths(root).config, 'utf8').catch(() => null)), null);
  // The folder the variable names can become an account: it is no longer the default's.
  result = await invoke(['add', 'claude-code', 'Work', '--config-dir', env.CLAUDE_CONFIG_DIR], { platform: 'linux', env });
  assert.equal(result.code, 0, result.text);
  assert.equal((await config()).accounts['claude-code'][0].configDir, env.CLAUDE_CONFIG_DIR);
});

test('round 11: labelling the default is refused when it would move the default off the folder variable', async (t) => {
  const { root, home, invoke, config } = await fixture(t);
  const env = { HOME: home, USERPROFILE: home, OKIT_LANGUAGE: 'en', CLAUDE_CONFIG_DIR: join(root, 'work-folder') };
  let result = await invoke(['rename', 'claude-code', 'default', 'Main'], { platform: 'linux', env });
  assert.equal(result.code, 2, result.text);
  assert.match(result.text, /register that folder as an account/);
  assert.doesNotMatch(result.text, /account (add|rename)/);
  assert.equal((await fs.readFile(paths(root).config, 'utf8').catch(() => null)), null);
  result = await invoke(['rename', 'claude-code', 'default', 'Main'], { platform: 'linux', env: { ...env, CLAUDE_CONFIG_DIR: undefined } });
  assert.equal(result.code, 0, result.text);
  assert.equal((await config()).accounts['claude-code'][0].label, 'Main');
  const ptBr = await invoke(['rename', 'codex', 'default', 'Principal', '--locale', 'pt-BR'], { platform: 'linux', env: { ...env, CODEX_HOME: join(root, 'x') } });
  assert.equal(ptBr.code, 2, ptBr.text);
  assert.match(ptBr.text, /cadastre essa pasta como uma conta/);
});

test('round 14: a folder that cannot be created is named as the folder, not as the settings', async (t) => {
  const { root, invoke } = await fixture(t);
  const file = join(root, 'a-file');
  await fs.writeFile(file, 'x');
  for (const [locale, wanted] of [['en', /Cannot create the account folder \(E(EXIST|NOTDIR)\)/], ['pt-BR', /Não foi possível criar a pasta da conta \(E(EXIST|NOTDIR)\)/]]) {
    const result = await invoke(['add', 'codex', 'Blocked', '--config-dir', locale === 'en' ? file : join(file, 'inside'), '--locale', locale], { platform: 'linux' });
    assert.equal(result.code, 1, result.text);
    assert.match(result.text, wanted);
    assert.doesNotMatch(result.text, /settings|ajustes/);
    assert.ok(!result.text.includes(root), 'no path');
  }
  assert.equal(await fs.readFile(paths(root).config, 'utf8').catch(() => null), null, 'nothing was saved');
});
