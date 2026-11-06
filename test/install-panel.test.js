import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { main } from '../src/cli.js';
import { readRecord } from '../src/install/place.js';
import { panelManifest, payloadEntries } from '../src/release/payload.js';
import { DEFAULT_CONFIG } from '../src/profiles.js';
import { fixture } from './helpers/install-fixture.js';

const CLIENT = 'claude-code';
const ID = 'okit-plugin-panel@okit-plugin';
const PANEL = 'adapters/claude-code/panel';
// | Input | Must pass | Must refuse |
// | --panel | scoped ownership and idempotence | touching main registration |
// | --dry-run | no writes or client calls | claiming ownership |
// | another client | localized refusal | running a client |
// | existing user panel | keep unowned | deleting it with --panel |
// | lifecycle panel failure | main operation and warning | propagating panel failure |
// | explicit removal | clear absent ownership | clearing ownership after a real failure |
// | --panel flags | client/account/dry-run/locale/verbose | every other flag |

async function world(t) {
  const f = await fixture(t);
  const fake = join(f.home, 'claude');
  const source = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const root = process.env.CLAUDE_CONFIG_DIR;
fs.mkdirSync(root, {recursive:true});
const file = path.join(root, 'fake-plugins.json');
let entries = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
const [, verb, id] = process.argv.slice(2);
if (verb === 'list') { console.log(JSON.stringify(entries.map(id => ({id})))); }
else {
  if (verb === 'install' && !entries.includes(id)) entries.push(id);
  if (verb === 'uninstall') entries = entries.filter(item => item !== id);
  fs.writeFileSync(file, JSON.stringify(entries));
}
`;
  await fs.writeFile(fake, source, { mode: 0o755 });
  const original = f.io.run;
  f.io.run = async (command) => {
    if (command.args?.[0] !== 'plugin') return original(command);
    f.commands.push(command);
    const env = { ...f.io.env, CLAUDE_CONFIG_DIR: f.io.clientRoot, ...command.env };
    const result = spawnSync(fake, command.args, { encoding: 'utf8', env });
    if (result.error?.code === 'EPERM') {
      t.diagnostic('Fake Claude subprocess not run in sandbox: spawnSync EPERM; exercising the same script in memory.');
      const lines = [];
      runInNewContext(source.replace(/^#![^\n]*\n/, ''), { require: createRequire(import.meta.url),
        process: { env, argv: ['node', fake, ...command.args] }, console: { log: (line) => lines.push(line) } });
      return { stdout: lines.join('\n') };
    }
    if (result.error || result.status !== 0) throw result.error ?? new Error(result.stderr);
    return { stdout: result.stdout };
  };
  f.record = () => readRecord(f.destination, CLIENT, fs, f.io.config);
  f.call = (command, ...flags) => main([command, '--client', CLIENT, ...flags], f.io);
  f.entries = async (root = f.io.clientRoot) => JSON.parse(await fs.readFile(join(root, 'fake-plugins.json'), 'utf8'));
  f.seed = async (...flags) => {
    assert.equal(await f.call('install', '--no-statusline', ...flags), 0, f.output.join('\n'));
    const folder = join((await f.record()).path, PANEL, '.claude-plugin');
    await fs.mkdir(folder, { recursive: true });
    await fs.copyFile(`${PANEL}/.claude-plugin/plugin.json`, join(folder, 'plugin.json'));
  };
  return f;
}

test('panel install is additive and idempotent; panel uninstall preserves the main plugin', async (t) => {
  const f = await world(t);
  await f.seed();
  const settings = join(f.io.clientRoot, 'settings.json');
  const originalSettings = '{"hooks":{"SessionStart":[{"command":"user-hook"}]},"statusLine":{"command":"user-bar"}}';
  await fs.writeFile(settings, originalSettings);
  const before = await f.record();
  const mcp = f.mcp.entry('claude', 'okit');
  f.commands.length = 0;
  assert.equal(await main(['install', '--panel'], f.io), 0, f.output.join('\n'));
  assert.deepEqual(f.commands.map(({ args }) => args), [
    ['plugin', 'list', '--json'], ['plugin', 'install', ID, '--scope', 'user'],
  ]);
  assert.deepEqual((await f.record()).panel, { identity: ID });
  const installed = await f.record();
  f.commands.length = 0;
  assert.equal(await f.call('install', '--panel'), 0);
  assert.deepEqual(f.commands, []);
  assert.deepEqual(await f.record(), installed);
  assert.match(f.output.join('\n'), /already installed; nothing changed/);
  assert.equal(await f.call('uninstall', '--panel'), 0);
  assert.deepEqual(await f.record(), before);
  assert.deepEqual(await f.entries(), ['okit-plugin@okit-plugin']);
  assert.deepEqual(f.mcp.entry('claude', 'okit'), mcp);
  assert.equal(await fs.readFile(settings, 'utf8'), originalSettings);
  f.commands.length = 0;
  assert.equal(await f.call('uninstall', '--panel'), 0);
  assert.deepEqual(f.commands, []);
});

test('plain uninstall removes the owned panel and its payload', async (t) => {
  const f = await world(t);
  await f.seed();
  assert.equal(await f.call('install', '--panel'), 0);
  const record = await f.record();
  assert.equal(await f.call('uninstall'), 0, f.output.join('\n'));
  assert.deepEqual(await f.entries(), []);
  assert.equal(await f.record(), null);
  await assert.rejects(fs.stat(record.path), { code: 'ENOENT' });
  assert.equal(await f.call('uninstall', '--panel'), 0);
});

test('dry runs leave records, plugins and commands unchanged', async (t) => {
  const f = await world(t);
  await f.seed();
  for (const installed of [false, true]) {
    if (installed) assert.equal(await f.call('install', '--panel'), 0);
    const before = await f.record(), entries = await f.entries();
    f.commands.length = 0;
    assert.equal(await f.call('install', '--panel', '--dry-run'), 0);
    assert.equal(await f.call('uninstall', '--panel', '--dry-run'), 0);
    assert.equal(await f.call('uninstall', '--dry-run'), 0);
    assert.deepEqual(await f.record(), before);
    assert.deepEqual(await f.entries(), entries);
    assert.deepEqual(f.commands, []);
  }
});

test('panel ownership is scoped by account alias and keeps other accounts intact', async (t) => {
  const f = await world(t);
  const work = join(f.home, 'work');
  const file = join(f.root, 'config.json');
  const user = JSON.parse(await fs.readFile(file, 'utf8'));
  user.accounts = { [CLIENT]: [{ id: 'work', label: 'Work', configDir: work }] };
  await fs.writeFile(file, JSON.stringify(user));
  await f.seed();
  await f.seed('--account', 'work');
  const before = await f.record(), defaults = await f.entries();
  assert.equal(await f.call('install', '--panel', '--account', 'work'), 0, f.output.join('\n'));
  const record = await f.record();
  assert.deepEqual(record.accounts.work.panel, { identity: ID });
  assert.equal(record.panel, undefined);
  assert.deepEqual(await f.entries(), defaults);
  assert.ok((await f.entries(work)).includes(ID));
  assert.equal(await f.call('uninstall', '--panel'), 0);
  assert.ok((await f.entries(work)).includes(ID));
  assert.equal(await f.call('uninstall', '--panel', '--account', 'work'), 0);
  assert.deepEqual(await f.record(), before);
  assert.deepEqual(await f.entries(work), ['okit-plugin@okit-plugin']);
});

test('user-owned panel is never claimed or removed by --panel', async (t) => {
  const f = await world(t);
  await f.seed();
  await fs.writeFile(join(f.io.clientRoot, 'fake-plugins.json'), JSON.stringify(['okit-plugin@okit-plugin', ID]));
  const before = await f.record();
  assert.equal(await f.call('install', '--panel'), 0);
  assert.deepEqual(await f.record(), before);
  assert.equal(await f.call('uninstall', '--panel'), 0);
  assert.ok((await f.entries()).includes(ID));
});

test('panel requires an existing main registration and refuses other clients in both locales', async (t) => {
  const f = await world(t);
  assert.equal(await f.call('install', '--panel'), 2);
  for (const command of ['install', 'uninstall']) {
    for (const client of ['codex', 'opencode']) {
      for (const locale of ['en', 'pt-BR']) {
        f.clear();
        assert.equal(await main([command, '--panel', '--client', client, '--locale', locale], f.io), 2);
        assert.match(f.output.join('\n'), locale === 'en' ? /only for Claude Code/ : /apenas para Claude Code/);
      }
    }
  }
  assert.deepEqual(f.commands, []);
});

test('update refreshes the owned panel and retains ownership', async (t) => {
  const f = await world(t);
  await f.seed();
  assert.equal(await f.call('install', '--panel'), 0);
  f.setVersion('2.0.0');
  f.commands.length = 0;
  assert.equal(await f.call('update'), 0, f.output.join('\n'));
  assert.ok(f.commands.some(({ args }) => args.join(' ') === `plugin update ${ID} --scope user`));
  assert.deepEqual((await f.record()).panel, { identity: ID });
  assert.equal(await f.call('uninstall', '--panel'), 0);
  assert.ok(!(await f.entries()).includes(ID));
});

test('generated Claude payload ships the panel manifest golden, hooks and both marketplace entries', async () => {
  const packageJson = JSON.parse(await fs.readFile('package.json', 'utf8'));
  const expected = { name: 'okit-plugin-panel', version: packageJson.version,
    description: 'Optional Claude Code board for okit plugin accounts and runs', license: 'MIT' };
  assert.deepEqual(panelManifest(packageJson), expected);
  assert.deepEqual(JSON.parse(await fs.readFile(`${PANEL}/.claude-plugin/plugin.json`, 'utf8')), expected);
  const { entries, refusal } = await payloadEntries({ root: '.', config: DEFAULT_CONFIG.release,
    packageJson: { ...packageJson, version: '9.8.7' }, pair: { client: CLIENT, system: 'linux', arch: 'x64' } });
  assert.equal(refusal, null);
  const read = (path) => JSON.parse(entries.find((entry) => entry.path === path).data.toString());
  assert.deepEqual(read(`${PANEL}/.claude-plugin/plugin.json`), { ...expected, version: '9.8.7' });
  assert.deepEqual(read(`${PANEL}/hooks/hooks.json`), { modules: ['../register.js'] });
  assert.ok(entries.some((entry) => entry.path === `${PANEL}/register.js`));
  const marketplace = read('.claude-plugin/marketplace.json');
  assert.deepEqual(marketplace.plugins.map(({ name }) => name), ['okit-plugin', 'okit-plugin-panel']);
  assert.equal(marketplace.plugins[1].source, `./${PANEL}`);
});

function failPanel(f, action, reason) {
  const run = f.io.run;
  f.io.run = async (command) => {
    if (command.args?.[1] === action && command.args[2] === ID) {
      f.commands.push(command);
      throw Object.assign(new Error('Panel command failed'), { stderr: reason });
    }
    return run(command);
  };
}

test('update refreshes extra-account ownership in its own client environment', async (t) => {
  const f = await world(t);
  const work = join(f.home, 'work');
  const file = join(f.root, 'config.json');
  const user = JSON.parse(await fs.readFile(file, 'utf8'));
  user.accounts = { [CLIENT]: [{ id: 'work', label: 'Work', configDir: work }] };
  await fs.writeFile(file, JSON.stringify(user));
  await f.seed();
  await f.seed('--account', 'work');
  assert.equal(await f.call('install', '--panel', '--account', 'work'), 0);
  f.setVersion('2.0.0');
  f.commands.length = 0;
  assert.equal(await f.call('update'), 0, f.output.join('\n'));
  const refreshes = f.commands.filter(({ args }) => args?.[1] === 'update' && args[2] === ID);
  assert.equal(refreshes.length, 1);
  assert.equal(refreshes[0].env.CLAUDE_CONFIG_DIR, work);
  const record = await f.record();
  assert.deepEqual(record.accounts.work.panel, { identity: ID });
  assert.equal(record.panel, undefined);
});

test('panel rejects unrelated flags by name in both locales', async (t) => {
  const f = await world(t);
  await f.seed();
  const before = await f.record();
  for (const locale of ['en', 'pt-BR']) {
    for (const [command, flag, value] of [['uninstall', '--purge'], ['install', '--yes'],
      ['install', '--dest', f.destination], ['install', '--from', '.'], ['install', '--no-link'],
      ['install', '--statusline'], ['install', '--set-execution-policy']]) {
      f.clear();
      assert.equal(await f.call(command, '--panel', '--locale', locale, flag, ...(value ? [value] : [])), 2);
      assert.ok(f.output.join('\n').includes(flag));
      if (locale === 'en') assert.match(f.output.join('\n'), /cannot be used with --panel/);
      assert.deepEqual(await f.record(), before);
    }
    assert.equal(await f.call('install', '--panel', '--locale', locale, '--verbose', '--dry-run'), 0);
  }
});

test('invalid panel list refuses install and removal without writing', async (t) => {
  const f = await world(t);
  await f.seed();
  const run = f.io.run;
  for (const command of ['install', 'uninstall']) {
    if (command === 'uninstall') {
      f.io.run = run;
      assert.equal(await f.call('install', '--panel'), 0);
    }
    const before = await f.record(), entries = await f.entries();
    f.io.run = async (item) => item.args?.[1] === 'list' ? { stdout: '{broken' } : run(item);
    f.clear();
    assert.equal(await f.call(command, '--panel'), 1);
    assert.match(f.output.join('\n'), /Could not read the Claude Code plugin list/);
    assert.deepEqual(await f.record(), before);
    assert.deepEqual(await f.entries(), entries);
  }
});

test('explicit panel removal clears absent ownership but retains it on listed uninstall failure', async (t) => {
  for (const listed of [false, true]) {
    const f = await world(t);
    await f.seed();
    assert.equal(await f.call('install', '--panel'), 0);
    const before = await f.record();
    if (!listed) await fs.writeFile(join(f.io.clientRoot, 'fake-plugins.json'), JSON.stringify(['okit-plugin@okit-plugin']));
    failPanel(f, 'uninstall', 'real uninstall failure');
    f.commands.length = 0;
    const code = await f.call('uninstall', '--panel');
    assert.equal(code, listed ? 1 : 0, f.output.join('\n'));
    assert.deepEqual(f.commands[0].args, ['plugin', 'list', '--json']);
    if (listed) assert.deepEqual(await f.record(), before);
    else {
      assert.equal((await f.record()).panel, undefined);
      assert.equal(f.commands.length, 1);
      assert.match(f.output.join('\n'), /Panel removed/);
    }
  }
});

test('update and rollback tolerate panel failure; absent ownership is dropped', async (t) => {
  for (const reason of ['temporary failure', 'Plugin not installed']) {
    const f = await world(t);
    await f.seed();
    assert.equal(await f.call('install', '--panel'), 0);
    f.setVersion('2.0.0');
    failPanel(f, 'update', reason);
    f.clear();
    assert.equal(await f.call('update'), 0, f.output.join('\n'));
    assert.equal((await f.record()).version, '2.0.0');
    assert.equal(Boolean((await f.record()).panel), reason === 'temporary failure');
    assert.match(f.output.join('\n'), /warn.*Panel update failed/);
    f.clear();
    assert.equal(await f.call('update', '--rollback'), 0, f.output.join('\n'));
    assert.equal((await f.record()).version, '1.0.0');
    assert.equal(Boolean((await f.record()).panel), reason === 'temporary failure');
    if (reason === 'temporary failure') assert.match(f.output.join('\n'), /warn.*Panel update failed/);
  }
});

test('plain uninstall tolerates panel failure and missing Claude', async (t) => {
  for (const missing of [false, true]) {
    const f = await world(t);
    await f.seed();
    assert.equal(await f.call('install', '--panel'), 0);
    failPanel(f, 'uninstall', 'panel already removed');
    f.commands.length = 0;
    f.clear();
    if (missing) f.io.detect = async () => false;
    assert.equal(await f.call('uninstall'), 0, f.output.join('\n'));
    assert.equal(await f.record(), null);
    if (missing) {
      assert.equal(f.commands.some(({ args }) => args?.[0] === 'plugin'), false);
      assert.match(f.output.join('\n'), /Unregister from Claude Code: claude not found, so nothing was registered/);
    } else {
      assert.ok(f.commands.some(({ args }) => args.join(' ') === 'plugin uninstall okit-plugin@okit-plugin'));
      assert.match(f.output.join('\n'), /warn.*Panel uninstall failed/);
    }
  }
});
