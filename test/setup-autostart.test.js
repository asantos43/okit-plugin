import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { PassThrough, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { setupAutostart } from '../src/setup/autostart-step.js';
import { main } from '../src/cli.js';
import { autostartPlan, detectAutostart } from '../src/autostart.js';
import { exitCodeFor } from '../src/install/exit.js';
import { shown } from '../src/install/mcp-register.js';
import { installConfig } from '../src/install/config.js';
import { readRecords, readRecordsLenient } from '../src/install/place.js';
import { fixture } from './helpers/install-fixture.js';

async function world(t, { clients = ['codex'], platform = 'linux', installed = false } = {}) {
  const f = await fixture(t, platform);
  for (const client of clients) assert.equal(await main(['install', '--client', client], f.io), 0, f.output.join('\n'));
  const records = await readRecords(f.destination, fs, f.io.config);
  if (installed) {
    for (const record of Object.values(records)) {
      record.autostart = true;
      await fs.writeFile(join(f.destination, f.io.config.recordName.replace('{client}', record.client)), JSON.stringify(record));
    }
  }
  const first = Object.values(records)[0];
  const plan = first && autostartPlan(detectAutostart(platform), {
    root: f.root, home: f.home, node: first.settings.node,
    script: join(first.path, first.bin), command: f.io.config.command,
  });
  const before = await snapshot(f);
  const ran = [], written = [], questions = [], order = [];
  f.clear();
  Object.assign(f.io, {
    fs: { ...fs, writeFile: async (...args) => { order.push('record'); return fs.writeFile(...args); } },
    run: async (command) => { ran.push(command); order.push('run'); return { stdout: 'enabled\n' }; },
    write: async (path, content) => { written.push({ path, content }); order.push('file'); },
    ask: async (question) => {
      questions.push(question);
      assert.deepEqual(ran, []);
      assert.deepEqual(written, []);
      assert.deepEqual(order, []);
      assert.deepEqual(await snapshot(f), before);
      return 'yes';
    },
  });
  return { ...f, records, plan, before, ran, written, questions, order };
}
async function snapshot(f) {
  const files = (await fs.readdir(f.destination).catch(() => [])).filter((file) => file.endsWith('.json'));
  return Object.fromEntries(await Promise.all(files.map(async (file) => [file, await fs.readFile(join(f.destination, file), 'utf8')])));
}
const explain = (f) => [
  ...(f.plan.path === null ? [] : [`Autostart writes: ${f.plan.path}`]),
];
const stepLines = (f) => f.output.slice(f.output.findIndex((line) => /MCP env_report/.test(line)) + 1);

test('cancelled wizard never offers autostart or changes the installation', async (t) => {
  const f = await world(t);
  const configBefore = await fs.readFile(join(f.root, 'config.json'), 'utf8');
  assert.equal(Object.values(f.records)[0].autostart, false);
  f.io.setupAdapters = [{
    CLIENT: 'claude-code',
    listModels: async () => ({ client: 'claude-code', installed: true, models: ['other/model'], hidden: [], source: 'listing' }),
  }];
  f.io.ask = async (question) => {
    f.questions.push(question);
    assert.notEqual(question, 'Background service — runs waiting work while your client is closed. Start it with this machine? [y/N]:', 'cancelled setup asked about autostart');
    assert.match(question, /^(Choose a model|Save these choices\?)/);
    return ''; // Accept the recommended models, then cancel the save confirmation.
  };
  assert.equal(await main(['setup'], f.io), 0);
  assert.equal(f.questions.length, 4);
  assert.ok(f.questions.slice(0, 3).every((question) => question.startsWith('Choose a model')));
  assert.match(f.questions[3], /^Save these choices\?/);
  assert.deepEqual(f.output.slice(-2), ['Cancelled. Nothing was saved.', 'Try again when ready: okit-plugin setup']);
  assert.deepEqual(f.ran, []);
  assert.deepEqual(f.written, []);
  assert.deepEqual(f.order, []);
  assert.deepEqual(await snapshot(f), f.before);
  assert.equal(await fs.readFile(join(f.root, 'config.json'), 'utf8'), configBefore);
});

for (const answer of ['y', 'Y', ' y ', 'yes', 's']) {
  test(`affirmative answer ${JSON.stringify(answer)} installs autostart`, async (t) => {
    const f = await world(t);
    const ask = f.io.ask;
    f.io.ask = async (question) => { await ask(question); return answer; };
    assert.equal(await main(['setup'], f.io), 0);
    assert.deepEqual(f.questions, ['Background service — runs waiting work while your client is closed. Start it with this machine? [y/N]:']);
    assert.deepEqual(f.ran, f.plan.install);
    assert.deepEqual(f.written, [{ path: f.plan.path, content: f.plan.content }]);
    assert.deepEqual(await readRecords(f.destination, fs, f.io.config), {
      codex: { ...f.records.codex, autostart: true },
    });
    assert.deepEqual(stepLines(f), [...explain(f), 'Automatic start is on. Check it: okit-plugin doctor']);
  });
}

test('accepted plan uses the node executable from the installation record', async (t) => {
  const f = await world(t);
  const savedNode = join(f.home, 'custom-node');
  await fs.writeFile(savedNode, '// retained Node', { mode: 0o755 });
  const record = { ...f.records.codex, settings: { ...f.records.codex.settings, node: savedNode } };
  await fs.writeFile(join(f.destination, f.io.config.recordName.replace('{client}', record.client)), JSON.stringify(record));
  const before = await snapshot(f);
  f.io.ask = async (question) => {
    f.questions.push(question);
    assert.deepEqual(await snapshot(f), before);
    return 'yes';
  };
  const expected = autostartPlan(detectAutostart('linux'), {
    root: f.root, home: f.home, node: savedNode,
    script: join(record.path, record.bin), command: f.io.config.command,
  });
  assert.equal(await main(['setup'], f.io), 0);
  assert.deepEqual(f.questions, ['Background service — runs waiting work while your client is closed. Start it with this machine? [y/N]:']);
  assert.deepEqual(f.ran, expected.install);
  assert.deepEqual(f.written, [{ path: expected.path, content: expected.content }]);
  assert.ok(f.written[0].content.includes(savedNode));
  assert.equal(f.written[0].content.includes(process.execPath), false);
});

test('accept preserves each record and changes only autostart for both clients', async (t) => {
  const f = await world(t, { clients: ['codex', 'claude-code'] });
  const [first, second] = Object.values(f.records).map((record, index) => ({
    ...record, link: index === 0, linkDirectory: index === 0 ? '/a' : null,
  }));
  for (const record of [first, second]) {
    await fs.writeFile(join(f.destination, f.io.config.recordName.replace('{client}', record.client)), JSON.stringify(record));
  }
  const before = await snapshot(f);
  f.io.ask = async (question) => {
    f.questions.push(question);
    assert.deepEqual(await snapshot(f), before);
    return 'yes';
  };
  assert.equal(await main(['setup'], f.io), 0);
  assert.deepEqual(f.questions, ['Background service — runs waiting work while your client is closed. Start it with this machine? [y/N]:']);
  assert.deepEqual(f.ran, f.plan.install);
  assert.deepEqual(f.written, [{ path: f.plan.path, content: f.plan.content }]);
  assert.deepEqual(await readRecords(f.destination, fs, f.io.config), {
    [first.client]: { ...first, autostart: true },
    [second.client]: { ...second, autostart: true },
  });
});

for (const platform of ['linux', 'darwin', 'win32']) {
  test(`accept applies the exact ${platform} plan before saving both clients`, async (t) => {
    const f = await world(t, { clients: ['codex', 'claude-code'], platform });
    assert.equal(await main(['setup'], f.io), 0);
    assert.deepEqual(f.questions, ['Background service — runs waiting work while your client is closed. Start it with this machine? [y/N]:']);
    // The scheduled task of Windows has no file: the step asks the platform whether the task is there (read-only) first.
    const asked = f.plan.kind === 'schtasks' ? [{ command: 'schtasks', args: ['/Query', '/TN', 'okit-daemon'], timeoutMs: undefined }] : [];
    assert.deepEqual(f.ran, [...asked, ...f.plan.install]);
    assert.deepEqual(f.written, f.plan.path === null ? [] : [{ path: f.plan.path, content: f.plan.content }]);
    assert.deepEqual(f.order, [...asked.map(() => 'run'), ...(f.plan.path === null ? [] : ['file']), ...f.plan.install.map(() => 'run'), 'record', 'record']);
    const records = await readRecords(f.destination, fs, f.io.config);
    assert.deepEqual(records, Object.fromEntries(Object.entries(f.records).map(([client, record]) => [client, { ...record, autostart: true }])));
    assert.deepEqual(stepLines(f), [...explain(f), 'Automatic start is on. Check it: okit-plugin doctor']);
  });
}
for (const answer of ['', 'n', undefined, 'throw']) {
  test(`decline (${String(answer)}) leaves records and machine untouched`, async (t) => {
    const f = await world(t);
    f.io.ask = async (question) => { f.questions.push(question); if (answer === 'throw') throw new Error('closed'); return answer; };
    assert.equal(await main(['setup'], f.io), 0);
    assert.deepEqual(f.questions, ['Background service — runs waiting work while your client is closed. Start it with this machine? [y/N]:']);
    assert.deepEqual(f.ran, []);
    assert.deepEqual(f.written, []);
    assert.deepEqual(f.order, []);
    assert.deepEqual(await snapshot(f), f.before);
    assert.deepEqual(stepLines(f), [...explain(f), 'Automatic start is off. To enable it later: okit-plugin setup']);
  });
}
test('--defaults never offers or installs autostart', async (t) => {
  const f = await world(t);
  f.io.ask = async () => { assert.fail('asked'); };
  f.io.run = async () => { assert.fail('ran'); };
  assert.equal(await main(['setup', '--defaults'], f.io), 0);
  assert.equal(f.output.length, 4);
  assert.doesNotMatch(f.output.join('\n'), /autostart/i);
  assert.deepEqual(f.written, []);
  assert.deepEqual(f.order, []);
  assert.deepEqual(await snapshot(f), f.before);
});
test('a machine that has the autostart prints only the information and never asks', async (t) => {
  const f = await world(t, { clients: ['codex', 'claude-code'], installed: true });
  // The machine has the service of the plan: the record and the machine agree.
  await fs.mkdir(dirname(f.plan.path), { recursive: true });
  await fs.writeFile(f.plan.path, f.plan.content);
  assert.equal(await main(['setup'], f.io), 0);
  assert.deepEqual(stepLines(f), ['Automatic start is on. Check it: okit-plugin doctor']);
  assert.deepEqual(f.questions, []);
  // The step asks the machine whether the service is enabled: it reads, it does not change anything.
  assert.ok(f.ran.every((command) => command.args?.includes('is-enabled')), JSON.stringify(f.ran));
  assert.deepEqual(f.written, []);
  assert.deepEqual(await snapshot(f), f.before);
});

test('a record that says the autostart is on while the machine does not have it offers the step again', async (t) => {
  // The record says the autostart is on, but the service of the machine is gone: the step offers itself again, so the
  // setup repairs what the doctor found.
  const f = await world(t, { clients: ['codex', 'claude-code'], installed: true });
  assert.equal(await main(['setup'], f.io), 0);
  assert.deepEqual(f.questions, ['Background service — runs waiting work while your client is closed. Start it with this machine? [y/N]:']);
  assert.deepEqual(f.ran, f.plan.install);
  assert.deepEqual(f.written, [{ path: f.plan.path, content: f.plan.content }]);
  assert.deepEqual(stepLines(f), [...explain(f), 'Automatic start is on. Check it: okit-plugin doctor']);
});
test('without records the step is silent', async (t) => {
  const f = await world(t, { clients: [] });
  assert.equal(await main(['setup'], f.io), 0);
  assert.deepEqual(stepLines(f), []);
  assert.deepEqual(f.questions, []);
  assert.deepEqual(f.ran, []);
  assert.deepEqual(f.written, []);
  assert.deepEqual(await snapshot(f), f.before);
});
for (const failure of ['apply', 'write', 'save']) {
  test(`${failure} failure prints one reason and exits operationally`, async (t) => {
    const f = await world(t);
    const errors = [];
    f.io.stderr = (line) => errors.push(line);
    if (failure === 'apply') f.io.run = async (command) => { f.ran.push(command); throw new Error('permission denied'); };
    else if (failure === 'write') f.io.write = async () => { throw new Error('permission denied'); };
    else f.io.fs = { ...fs, writeFile: async () => { throw new Error('permission denied'); } };
    assert.equal(await main(['setup'], f.io), 1);
    assert.deepEqual(f.questions, ['Background service — runs waiting work while your client is closed. Start it with this machine? [y/N]:']);
    // A save that fails after the service is installed takes the service back.
    assert.deepEqual(f.ran, failure === 'write' ? [] : failure === 'apply' ? f.plan.install.slice(0, 1)
      : [...f.plan.install, ...f.plan.uninstall]);
    assert.deepEqual(f.written, failure === 'write' ? [] : [{ path: f.plan.path, content: f.plan.content }]);
    assert.deepEqual(await snapshot(f), f.before);
    assert.deepEqual(stepLines(f), explain(f));
    assert.deepEqual(errors, [failure === 'save'
      ? 'Automatic start could not be configured.\nthe autostart was taken back: permission denied\nTry again after fixing the cause: okit-plugin setup'
      : 'Automatic start could not be configured.\npermission denied\nTry again after fixing the cause: okit-plugin setup']);
    assert.doesNotMatch(f.output.join('\n'), /Could not install autostart|permission denied/);
    assert.doesNotMatch(f.output.join('\n'), /\n\s+at |Error:/);
  });
}
test('Portuguese explains, asks and confirms entirely in Portuguese', async (t) => {
  const f = await world(t);
  f.io.ask = async (question) => { f.questions.push(question); return 'sim'; };
  assert.equal(await main(['setup', '--locale', 'pt-BR'], f.io), 0);
  assert.deepEqual(f.questions, ['Serviço em segundo plano — executa trabalhos em espera enquanto o cliente está fechado. Iniciar com esta máquina? [s/N]:']);
  assert.deepEqual(stepLines(f), [
    `A inicialização automática grava: ${f.plan.path}`,
    'Início automático ligado. Verifique: okit-plugin doctor',
  ]);
  assert.deepEqual(f.ran, f.plan.install);
  assert.deepEqual(f.written, [{ path: f.plan.path, content: f.plan.content }]);
  assert.equal((await readRecords(f.destination, fs, f.io.config)).codex.autostart, true);
});
test('uninstall removes the autostart accepted in setup', async (t) => {
  const f = await world(t);
  assert.equal(await main(['setup'], f.io), 0);
  f.ran.length = 0;
  f.written.length = 0;
  delete f.io.autostart;
  assert.equal(await main(['uninstall', '--client', 'codex'], f.io), 0, f.output.join('\n'));
  assert.deepEqual(f.ran.filter((command) => command.command !== 'codex'), f.plan.uninstall);
  assert.deepEqual(f.written, []);
  assert.deepEqual(await snapshot(f), {});
});

test('the terminal reader stays open through the final step', async (t) => {
  const f = await world(t);
  const stdin = new PassThrough();
  t.after(() => stdin.destroy());
  delete f.io.ask;
  f.io.stdin = stdin;
  f.io.output = new Writable({ write(_chunk, _encoding, done) { done(); } });
  f.io.stdout = (line) => {
    f.output.push(line);
    if (line === explain(f)[0]) stdin.end('yes\n');
  };
  assert.equal(await main(['setup'], f.io), 0);
  assert.deepEqual(f.ran, f.plan.install);
  assert.deepEqual(f.written, [{ path: f.plan.path, content: f.plan.content }]);
  assert.deepEqual(stepLines(f), [...explain(f), 'Automatic start is on. Check it: okit-plugin doctor']);
  assert.equal((await readRecords(f.destination, fs, f.io.config)).codex.autostart, true);
});

test('mixed autostart flags still offer once and update all records', async (t) => {
  const f = await world(t, { clients: ['claude-code', 'codex'] });
  const first = Object.values(f.records)[0];
  await fs.writeFile(join(f.destination, f.io.config.recordName.replace('{client}', first.client)), JSON.stringify({ ...first, autostart: true }));
  f.io.ask = async (question) => { f.questions.push(question); return 's'; };
  assert.equal(await main(['setup'], f.io), 0);
  assert.deepEqual(f.questions, ['Background service — runs waiting work while your client is closed. Start it with this machine? [y/N]:']);
  assert.deepEqual(f.ran, f.plan.install);
  assert.deepEqual(f.written, [{ path: f.plan.path, content: f.plan.content }]);
  assert.deepEqual(await readRecords(f.destination, fs, f.io.config),
    Object.fromEntries(Object.entries(f.records).map(([client, record]) => [client, { ...record, autostart: true }])));
});

test('a record that the save cannot read stops the step before the service is installed', async (t) => {
  const f = await world(t, { clients: ['codex', 'claude-code'] });
  // The record of the other client is not a JSON object: the lenient reader leaves it out, the save would refuse it.
  const other = join(f.destination, f.io.config.recordName.replace('{client}', 'claude-code'));
  await fs.writeFile(other, '[]');
  const errors = [];
  f.io.stderr = (line) => errors.push(line);
  const before = await snapshot(f);
  assert.equal(await main(['setup'], f.io), 1);
  // Nothing was installed, and the machine is as it was.
  assert.deepEqual(f.ran, []);
  assert.deepEqual(f.written, []);
  assert.deepEqual(await snapshot(f), before);
  assert.equal(errors.length, 1, errors.join('\n'));
  assert.match(errors[0], /^Automatic start could not be configured\.\n/, errors[0]);
});

test('a save that fails after the service is installed takes the service back', async (t) => {
  const f = await world(t);
  const errors = [];
  f.io.stderr = (line) => errors.push(line);
  // The record cannot be written: the service is installed and the record is not.
  f.io.fs = { ...fs, writeFile: async () => { throw new Error('permission denied'); } };
  assert.equal(await main(['setup'], f.io), 1);
  // The service was installed and then taken back.
  assert.deepEqual(f.ran, [...f.plan.install, ...f.plan.uninstall]);
  assert.deepEqual(f.written, [{ path: f.plan.path, content: f.plan.content }]);
  assert.equal(errors.length, 1, errors.join('\n'));
  assert.match(errors[0], /^Automatic start could not be configured\.\nthe autostart was taken back: permission denied\nTry again after fixing the cause: okit-plugin setup$/, errors[0]);
});


for (const [failAt, restoreFails] of [[1, false], [2, false], [2, true]]) {
  test(`record write ${failAt}, restore failure=${restoreFails}: restores records before uninstalling`, async () => {
    const config = (await import('../src/install/config.js')).installConfig();
    const destination = fileURLToPath(new URL('../configured', import.meta.url));
    const files = new Map(['claude-code', 'codex'].map((client) => [
      join(destination, config.recordName.replace('{client}', client)),
      ` { "client": "${client}", "autostart": false, "link": false }\r\n`,
    ]));
    const before = new Map(files), actions = [], errors = [], atUninstall = [];
    let writes = 0;
    const fake = {
      readFile: async (file) => {
        if (files.has(file)) return files.get(file);
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      },
      writeFile: async (file, text) => {
        if (file.endsWith('.tmp') && ++writes === failAt) throw new Error('save denied');
        if (restoreFails && file.endsWith('install.claude-code.json')) throw new Error('restore denied');
        files.set(file, text);
      },
      rename: async (from, to) => { files.set(to, files.get(from)); files.delete(from); },
      rm: async (file) => { files.delete(file); },
    };
    const code = await setupAutostart({ fs: fake, platform: 'linux', env: {}, home: 'home', command: config.command,
      out: () => {}, err: (line) => errors.push(line),
      run: async ({ command }) => {
        actions.push(command);
        if (command === 'uninstall') atUninstall.push(new Map(files));
      },
    }, { config: { ...config, destination }, locale: 'en', ask: async () => 'yes',
      plan: () => ({ kind: 'test', path: null, install: [{ command: 'install' }], uninstall: [{ command: 'uninstall' }] }) });
    assert.equal(code, 1);
    if (restoreFails) {
      assert.equal(JSON.parse(files.get(join(destination, 'install.claude-code.json'))).autostart, true);
      assert.equal(files.get(join(destination, 'install.codex.json')), before.get(join(destination, 'install.codex.json')));
    } else assert.deepEqual(files, before);
    assert.deepEqual(actions, ['install', 'uninstall']);
    assert.equal(atUninstall.length, 1);
    assert.deepEqual(atUninstall[0], files);
    assert.deepEqual(errors, ['Automatic start could not be configured.\nthe autostart was taken back: save denied'
      + (restoreFails ? `; ${join(destination, 'install.claude-code.json')}: restore denied` : '') + '\nTry again after fixing the cause: okit-plugin setup']);
  });
}

test('autostart saves only in the discovered running installation destination', async () => {
  const config = (await import('../src/install/config.js')).installConfig({ destination: 'configured' });
  const pkg = fileURLToPath(new URL('../', import.meta.url)).replace(/[\\/]$/, '');
  const destination = dirname(pkg), file = join(destination, 'install.codex.json');
  const files = new Map([[file, JSON.stringify({ client: 'codex', path: pkg, destination, autostart: false })]]);
  const writes = [], errors = [], reads = [];
  const fake = {
    readFile: async (name) => {
      reads.push(name);
      if (files.has(name)) return files.get(name);
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    },
    writeFile: async (name, text) => { writes.push(name); files.set(name, text); },
    rename: async (from, to) => { files.set(to, files.get(from)); files.delete(from); },
    rm: async (name) => { files.delete(name); },
  };
  assert.equal(await setupAutostart({ fs: fake, platform: 'linux', env: {}, home: 'home', command: config.command,
    out: () => {}, err: (line) => errors.push(line), run: async () => {},
  }, { config, locale: 'en', ask: async () => {
      assert.equal(reads.filter((name) => name === join(destination, 'install.json')).length, 2);
      return 'yes';
    },
    plan: () => ({ kind: 'test', path: null, install: [], uninstall: [] }) }), 0, errors.join('\n'));
  assert.equal(JSON.parse(files.get(file)).autostart, true);
  assert.equal(reads.filter((name) => name === join(destination, 'install.json')).length, 4);
  assert.deepEqual(writes, [file + '.tmp']);
  assert.equal([...files.keys()].some((name) => name.startsWith('configured')), false);
});

// D109 step 7: the rollback of a failed save never takes away a service that was already there: the records that
// survive the rollback still say the autostart is on, and a service that is gone contradicts them.

/**
 * The world of the rollback: the records of the clients in a map, the file of the service of the machine (when it is
 * already there) and every action of the machine recorded.
 *
 * @param {object} options the records, the service of the machine and whether the save fails
 * @returns {object} the world of the test
 */
function rollbackWorld({ records, service = null, failSave = true, task = null, kind = 'test', crontab = null }) {
  const config = installConfig();
  const destination = fileURLToPath(new URL('../rollback-destination', import.meta.url));
  const servicePath = join(destination, 'okit-daemon.service');
  const files = new Map(Object.entries(records).map(([client, record]) => [
    join(destination, config.recordName.replace('{client}', client)), `${JSON.stringify(record)}\n`,
  ]));
  if (service !== null) files.set(servicePath, service);
  const actions = [], errors = [], outputs = [], written = [];
  const fake = {
    readFile: async (file) => {
      if (files.has(file)) return files.get(file);
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    },
    writeFile: async (file, text) => {
      // The record is saved through a file of its own: that is the write that fails.
      if (failSave && file.endsWith('.tmp')) throw new Error('save denied');
      files.set(file, text);
    },
    rename: async (from, to) => { files.set(to, files.get(from)); files.delete(from); },
    rm: async (file) => { files.delete(file); },
    access: async (file) => { if (!files.has(file)) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
  };
  const ctx = { fs: fake, platform: 'linux', env: {}, home: 'home', command: config.command,
    out: (line) => outputs.push(line), err: (line) => errors.push(line),
    run: async ({ command }) => {
      // The query of the scheduled task of Windows: it answers when the task is there and throws when it is not.
      if (command === 'schtasks') {
        actions.push('query');
        if (task === 'present') return {};
        throw Object.assign(new Error('not found'), { code: 1 });
      }
      // The query of the crontab of the user: it answers with the lines of the user.
      if (command === 'crontab') {
        actions.push('query');
        return { stdout: crontab ?? '' };
      }
      actions.push(command);
      return {};
    },
    write: async (path, content) => { written.push(path); files.set(path, content); } };
  const plan = { kind: task === null ? kind : 'schtasks', path: task === null ? servicePath : null, content: '[Service]\nExecStart=okit-plugin daemon start\n',
    install: [{ command: 'install' }], uninstall: [{ command: 'uninstall' }] };
  return { config: { ...config, destination }, destination, servicePath, files, actions, errors, outputs, written, ctx, plan };
}

/** The records of the world, as they are on the disk: the bytes of every file of a client. */
const recordFiles = (files) => Object.fromEntries([...files.entries()].filter(([file]) => file.endsWith('.json')));

const runRollback = (world) => setupAutostart(world.ctx, {
  config: world.config, locale: 'en', ask: async () => 'yes', plan: () => world.plan,
});

test('a stale unit that is there is kept when the save fails', async () => {
  // The unit of the machine is there, but it does not hold the content of the plan (it is stale): the rollback keeps it,
  // because it is a service of the person and the save of the record is what failed.
  const w = rollbackWorld({ records: {
    'claude-code': { client: 'claude-code', autostart: false, link: false },
  }, kind: 'systemd', service: '[Service]\nExecStart=/other/node daemon start\n' });
  assert.equal(await runRollback(w), 1);
  assert.deepEqual(w.actions, ['install'], w.actions.join(', '));
  assert.deepEqual(w.errors, ['Automatic start could not be configured.\nthe service that was already installed was kept: save denied\nTry again after fixing the cause: okit-plugin setup']);
});

test('the line of ours in the crontab is kept when the save fails', async () => {
  // The crontab of the user holds our line: the rollback keeps it.
  const w = rollbackWorld({ records: {
    'claude-code': { client: 'claude-code', autostart: false, link: false },
  }, kind: 'cron', crontab: '@reboot /usr/bin/node /repo/src/cli.js daemon start # okit-daemon\n' });
  assert.equal(await runRollback(w), 1);
  assert.deepEqual(w.actions, ['query', 'install'], w.actions.join(', '));
  assert.deepEqual(w.errors, ['Automatic start could not be configured.\nthe service that was already installed was kept: save denied\nTry again after fixing the cause: okit-plugin setup']);
});

test('a stale record does not keep a service that was never there', async () => {
  // The record of the other client says the autostart is on, but the machine has no service: the rollback takes the
  // service back and does not claim that it kept one.
  const w = rollbackWorld({ records: {
    'claude-code': { client: 'claude-code', autostart: false, link: false },
    codex: { client: 'codex', autostart: true, link: false },
  } });
  assert.equal(await runRollback(w), 1);
  assert.deepEqual(w.actions, ['install', 'uninstall'], w.actions.join(', '));
  assert.deepEqual(w.errors, ['Automatic start could not be configured.\nthe autostart was taken back: save denied\nTry again after fixing the cause: okit-plugin setup']);
});

test('a save that fails does not take away a service that was already on the disk', async () => {
  const w = rollbackWorld({ records: {
    'claude-code': { client: 'claude-code', autostart: false, link: false },
  }, service: '[Service]\nExecStart=okit-plugin daemon start\n' });
  const before = recordFiles(w.files);
  assert.equal(await runRollback(w), 1);
  assert.deepEqual(w.actions, ['install'], w.actions.join(', '));
  assert.deepEqual(w.errors, ['Automatic start could not be configured.\nthe service that was already installed was kept: save denied\nTry again after fixing the cause: okit-plugin setup']);
  assert.deepEqual(recordFiles(w.files), before);
});

test('a save that fails does not take away a scheduled task that was already there (Windows has no file)', async () => {
  const w = rollbackWorld({ records: {
    'claude-code': { client: 'claude-code', autostart: false, link: false },
  }, task: 'present' });
  const before = recordFiles(w.files);
  assert.equal(await runRollback(w), 1);
  // The platform was asked first, the task was kept: no uninstall ran.
  assert.deepEqual(w.actions, ['query', 'install'], w.actions.join(', '));
  assert.deepEqual(w.errors, ['Automatic start could not be configured.\nthe service that was already installed was kept: save denied\nTry again after fixing the cause: okit-plugin setup']);
  assert.deepEqual(recordFiles(w.files), before);
});

test('a save that fails on a Windows machine without the task takes the task back', async () => {
  const w = rollbackWorld({ records: {
    'claude-code': { client: 'claude-code', autostart: false, link: false },
  }, task: 'absent' });
  assert.equal(await runRollback(w), 1);
  assert.deepEqual(w.actions, ['query', 'install', 'uninstall'], w.actions.join(', '));
  assert.deepEqual(w.errors, ['Automatic start could not be configured.\nthe autostart was taken back: save denied\nTry again after fixing the cause: okit-plugin setup']);
});

test('a crontab without our line is a clean machine: the line is taken back when the save fails', async () => {
  const w = rollbackWorld({ records: {
    'claude-code': { client: 'claude-code', autostart: false, link: false },
  }, kind: 'cron', crontab: '0 * * * * /usr/bin/other-job\n' });
  assert.equal(await runRollback(w), 1);
  assert.deepEqual(w.actions, ['query', 'install', 'uninstall'], w.actions.join(', '));
  assert.deepEqual(w.errors, ['Automatic start could not be configured.\nthe autostart was taken back: save denied\nTry again after fixing the cause: okit-plugin setup']);
});

test('a save that fails on a clean machine takes the service back', async () => {
  const w = rollbackWorld({ records: {
    'claude-code': { client: 'claude-code', autostart: false, link: false },
  } });
  const before = recordFiles(w.files);
  assert.equal(await runRollback(w), 1);
  // Nothing was there before: the service that this run installed is taken back.
  assert.deepEqual(w.actions, ['install', 'uninstall'], w.actions.join(', '));
  assert.deepEqual(w.errors, ['Automatic start could not be configured.\nthe autostart was taken back: save denied\nTry again after fixing the cause: okit-plugin setup']);
  assert.deepEqual(recordFiles(w.files), before);
});

test('a save that works keeps the service and records the autostart', async () => {
  const w = rollbackWorld({ records: {
    'claude-code': { client: 'claude-code', autostart: false, link: false },
  }, failSave: false });
  assert.equal(await runRollback(w), 0, w.errors.join('\n'));
  assert.deepEqual(w.actions, ['install'], w.actions.join(', '));
  assert.deepEqual(w.errors, []);
  assert.equal(JSON.parse(w.files.get(join(w.destination, 'install.claude-code.json'))).autostart, true);
  assert.deepEqual(w.written, [w.servicePath]);
});


test('all client plans are considered and the matching later client is retained', async (t) => {
  const f = await world(t, { clients: ['claude-code', 'codex'], installed: true });
  const record = f.records.codex;
  const current = autostartPlan('systemd', { root: f.root, home: f.home,
    node: record.settings.node, script: join(record.path, record.bin), command: f.io.config.command });
  assert.notEqual(current.content, f.plan.content);
  await fs.mkdir(dirname(current.path), { recursive: true });
  await fs.writeFile(current.path, current.content);
  assert.equal(await main(['setup'], f.io), 0);
  assert.deepEqual(f.questions, []);
  assert.deepEqual(stepLines(f), ['Automatic start is on. Check it: okit-plugin doctor']);
  assert.deepEqual(await snapshot(f), f.before);
  // A missing flag offers the same working plan and updates every covered client without copying link settings.
  const first = f.records['claude-code'];
  await fs.writeFile(join(f.destination, 'install.claude-code.json'), JSON.stringify({ ...first, autostart: false, link: false }));
  f.io.ask = async () => 'yes';
  f.ran.length = 0;
  assert.equal(await main(['setup'], f.io), 0);
  assert.deepEqual(f.written, [{ path: current.path, content: current.content }]);
  const saved = await readRecords(f.destination, fs, f.io.config);
  assert.equal(saved['claude-code'].autostart, true);
  assert.equal(saved.codex.autostart, true);
  assert.equal(saved['claude-code'].link, false);
  assert.equal(saved.codex.link, record.link);
});

for (const locale of ['en', 'pt-BR']) {
  for (const failure of ['preflight', 'apply', 'write', 'save', 'kept', 'restore']) {
    test(`failure ${failure} is localized in ${locale}`, async (t) => {
      const f = await world(t);
      const errors = [];
      f.io.stderr = (line) => errors.push(line);
      if (failure === 'preflight') {
        f.io.fs = { ...fs, readFile: async () => { throw new Error('No installation record found'); } };
      } else if (failure === 'apply') f.io.run = async () => { throw new Error('permission denied'); };
      else if (failure === 'write') f.io.write = async () => { throw new Error('permission denied'); };
      else {
        if (failure === 'kept') {
          await fs.mkdir(dirname(f.plan.path), { recursive: true });
          await fs.writeFile(f.plan.path, f.plan.content);
        }
        if (failure === 'restore') {
          const original = fs.writeFile;
          let failed = false;
          f.io.fs = { ...fs, writeFile: async (...args) => {
            if (args[0].endsWith('.tmp')) {
              // Simulate a partially completed save that rollback must restore.
              await original(args[0].slice(0, -4), '{}');
              failed = true;
            }
            if (failed) throw new Error('permission denied');
            return original(...args);
          } };
        } else f.io.fs = { ...fs, writeFile: async () => { throw new Error('permission denied'); } };
      }
      f.io.ask = async () => 'yes';
      assert.equal(await main(['setup', '--locale', locale], f.io), 1);
      assert.equal(errors.length, 1);
      const reason = failure === 'preflight'
        ? (locale === 'en' ? 'No installation record found' : 'Nenhuma instalação encontrada')
        : (locale === 'en' ? 'permission denied' : 'permissão negada');
      assert.ok(errors[0].includes(reason), errors[0]);
      if (locale === 'pt-BR') {
        assert.match(errors[0], /^Não foi possível configurar o início automático\.\n/);
        assert.doesNotMatch(errors[0], /permission denied|No installation record found|was kept|taken back/);
      }
    });
  }
}

test('setup and doctor use the installed package bin and absolute node for a legacy record', async (t) => {
  const f = await world(t);
  const record = { ...f.records.codex, settings: { node: 'node' } };
  delete record.bin;
  await fs.writeFile(join(record.path, 'package.json'), JSON.stringify({ bin: { [f.io.config.command]: 'legacy-cli.js' } }));
  await fs.writeFile(join(record.path, 'legacy-cli.js'), '// installed CLI');
  await fs.writeFile(join(f.destination, f.io.config.recordName.replace('{client}', record.client)), JSON.stringify(record));
  f.io.ask = async () => 'yes';
  assert.equal(await main(['setup'], f.io), exitCodeFor('ok'), JSON.stringify(f.output));
  const expected = autostartPlan('systemd', { root: f.root, home: f.home, node: process.execPath,
    script: join(record.path, 'legacy-cli.js'), command: f.io.config.command });
  assert.deepEqual(f.written, [{ path: expected.path, content: expected.content }]);
  const { diagnose } = await import('../src/doctor/diagnose.js');
  const { createPresenter } = await import('../src/install/present.js');
  const plans = [];
  const result = await diagnose({ root: f.root, home: f.home, config: f.io.config, records: [{ ...record, autostart: true }],
    command: f.io.config.command, platform: 'linux', fs, ui: createPresenter({ locale: 'en', write: () => {} }),
    readers: { readText: (path) => fs.readFile(path, 'utf8'), selfCheck: async () => [],
      mcpEntry: async () => ({ state: 'registered' }), servers: async () => [], daemon: async () => ({ running: true }),
      autostartPresent: async (plan) => { plans.push(plan); return plan.content === expected.content; } } });
  assert.deepEqual(plans, [expected]);
  assert.equal(result.rows.find((row) => row.id === 'autostart').status, 'ok');
});

test('an unusable old record does not hide the working first service', async (t) => {
  const f = await world(t, { clients: ['codex', 'claude-code'], installed: true });
  const second = f.records['claude-code'];
  delete second.settings;
  await fs.writeFile(join(f.destination, f.io.config.recordName.replace('{client}', second.client)), JSON.stringify(second));
  await fs.mkdir(dirname(f.plan.path), { recursive: true });
  await fs.writeFile(f.plan.path, f.plan.content);
  const config = f.io.config;
  const lines = [], errors = [];
  const code = await setupAutostart({ ...f.io, root: f.root, home: f.home, env: f.io.env, platform: 'linux',
    command: config.command, out: (line) => lines.push(line), err: (line) => errors.push(line) },
  { config, locale: 'en', ask: async () => { throw new Error('must not ask'); },
    plan: (record) => { if (!record.settings) throw new TypeError('old record'); return f.plan; } });
  assert.equal(code, exitCodeFor('ok'), errors.join('\n'));
  assert.deepEqual(lines, ['Automatic start is on. Check it: okit-plugin doctor']);
  f.clear();
  assert.equal(await main(['setup'], f.io), exitCodeFor('ok'));
  assert.ok(f.output.includes('Automatic start is on. Check it: okit-plugin doctor'));
});

test('when no installation can supply an autostart plan, the setup says so and fails', async (t) => {
  const f = await world(t, { clients: ['codex'], installed: true });
  const lines = [], errors = [];
  const code = await setupAutostart({ ...f.io, root: f.root, home: f.home, env: f.io.env, platform: 'linux',
    command: f.io.config.command, out: (line) => lines.push(line), err: (line) => errors.push(line) },
  { config: f.io.config, locale: 'en', ask: async () => { throw new Error('must not ask'); }, plan: () => null });
  assert.equal(code, exitCodeFor('operational'));
  assert.deepEqual(errors, ['Automatic start could not be configured.\nno installation can supply an autostart plan\nTry again after fixing the cause: okit-plugin setup']);
  assert.deepEqual(lines, []);
});

test('an installation whose daemon script cannot be identified does not run an autostart plan for it', async (t) => {
  const f = await world(t, { clients: ['codex'], installed: true });
  const record = { ...f.records.codex, autostart: true, link: false };
  delete record.bin;
  await fs.writeFile(join(record.path, 'package.json'), '{}');
  await fs.writeFile(join(f.destination, f.io.config.recordName.replace('{client}', record.client)), JSON.stringify(record));
  f.clear();
  f.ran.length = 0;
  delete f.io.autostart; // the real lifecycle plans the autostart of the record
  const code = await main(['uninstall', '--client', 'codex'], f.io);
  assert.notEqual(code, exitCodeFor('ok'), f.output.join('\n'));
  assert.deepEqual(f.ran.filter((command) => /systemctl|crontab|launchctl|schtasks/.test(command.command ?? command[0] ?? '')), []);
  assert.match(f.output.join('\n'), /could not be identified/);
});

for (const damage of ['deleted', 'empty']) {
  test(`uninstall removes the service of an installation whose daemon script is ${damage}`, async (t) => {
    const f = await world(t, { clients: ['codex'], installed: true });
    const record = { ...f.records.codex, autostart: true, link: false };
    const script = join(record.path, record.bin);
    if (damage === 'deleted') await fs.rm(script); else await fs.writeFile(script, '');
    await fs.writeFile(join(f.destination, f.io.config.recordName.replace('{client}', record.client)), JSON.stringify(record));
    f.clear();
    f.ran.length = 0;
    delete f.io.autostart; // the real lifecycle plans the autostart of the record
    delete f.io.stopDaemon; // and the real stop, which removes the service once
    const code = await main(['uninstall', '--client', 'codex'], f.io);
    assert.equal(code, exitCodeFor('ok'), f.output.join('\n'));
    assert.ok(f.ran.some((command) => /systemctl|crontab|launchctl|schtasks/.test(command.command ?? command[0] ?? '')), JSON.stringify(f.ran));
    assert.equal(f.ran.filter((command) => JSON.stringify(command).includes('disable')).length, 1, JSON.stringify(f.ran));
  });
}

test('uninstall of one client removes the service when no surviving client has a runnable daemon script', async (t) => {
  const f = await world(t, { clients: ['claude-code', 'codex'], installed: true });
  for (const client of ['claude-code', 'codex']) {
    const record = { ...f.records[client], autostart: true, link: false };
    await fs.writeFile(join(f.destination, f.io.config.recordName.replace('{client}', client)), JSON.stringify(record));
  }
  await fs.rm(join(f.records.codex.path, f.records.codex.bin));
  f.clear();
  f.ran.length = 0;
  delete f.io.autostart; // the real lifecycle plans the autostart of the record
  delete f.io.stopDaemon; // and the real stop removes the departing client's service
  const code = await main(['uninstall', '--client', 'claude-code'], f.io);
  assert.equal(code, exitCodeFor('ok'), f.output.join('\n'));
  // The departing client is gone, the survivor stays, and the service did not stay pointing at the deleted payload.
  await assert.rejects(fs.access(f.records['claude-code'].path));
  await fs.access(f.records.codex.path);
  assert.ok(f.ran.some((command) => /systemctl|crontab|launchctl|schtasks/.test(command.command ?? command[0] ?? '')), JSON.stringify(f.ran));
  assert.equal(f.ran.some((command) => JSON.stringify(command).includes(f.records.codex.path)), false, JSON.stringify(f.ran));
  // The service is removed once: the stop already took it away, and a second removal fails on a manager that errors on a missing one.
  const removals = f.ran.filter((command) => JSON.stringify(command).includes('disable'));
  assert.equal(removals.length, 1, JSON.stringify(f.ran));
});

test('uninstall does not hide a failure of the service itself while handing it to a surviving client', async (t) => {
  const f = await world(t, { clients: ['claude-code', 'codex'], installed: true });
  for (const client of ['claude-code', 'codex']) {
    const record = { ...f.records[client], autostart: true, link: false };
    await fs.writeFile(join(f.destination, f.io.config.recordName.replace('{client}', client)), JSON.stringify(record));
  }
  f.clear();
  f.io.autostart = async (record, action) => { if (action === 'install') throw new Error('the service manager refused'); };
  const code = await main(['uninstall', '--client', 'claude-code'], f.io);
  assert.notEqual(code, exitCodeFor('ok'), f.output.join('\n'));
  await fs.access(f.records['claude-code'].path);
});

for (const metadata of ['malformed', 'missing']) {
  for (const locale of ['en', 'pt-BR']) {
    test(`unknown legacy bin with ${metadata} metadata preserves the service (${locale})`, async (t) => {
      const f = await world(t, { installed: true });
      const record = { ...f.records.codex };
      delete record.bin;
      await fs.writeFile(join(f.destination, f.io.config.recordName.replace('{client}', record.client)), JSON.stringify(record));
      if (metadata === 'malformed') await fs.writeFile(join(record.path, 'package.json'), '{');
      else await fs.unlink(join(record.path, 'package.json'));
      const expected = autostartPlan('systemd', { root: f.root, home: f.home, node: record.settings.node,
        script: join(record.path, 'legacy-cli.js'), command: f.io.config.command });
      await fs.mkdir(dirname(expected.path), { recursive: true });
      await fs.writeFile(expected.path, expected.content);
      const before = await snapshot(f);
      const errors = [];
      f.io.stderr = (line) => errors.push(line);
      f.io.ask = async () => 'yes';
      assert.equal(await main(['setup', '--locale', locale], f.io), exitCodeFor('operational'));
      const { createPresenter } = await import('../src/cli-present.js');
      const ui = createPresenter({ locale, write: () => {} });
      assert.deepEqual(errors, [ui.text('autostartFailed', { command: f.io.config.command, reason: ui.text('autostartNoPlan') })]);
      assert.deepEqual(f.written, []);
      assert.deepEqual(f.ran, []);
      assert.deepEqual(f.order, []);
      assert.deepEqual(await snapshot(f), before);
      assert.equal(await fs.readFile(expected.path, 'utf8'), expected.content);
      const { diagnose } = await import('../src/doctor/diagnose.js');
      const plans = [];
      const result = await diagnose({ root: f.root, home: f.home, config: f.io.config, records: [record],
        command: f.io.config.command, platform: 'linux', fs, ui,
        readers: { readText: (path) => fs.readFile(path, 'utf8'), selfCheck: async () => [],
          mcpEntry: async () => ({ state: 'registered' }), servers: async () => [], daemon: async () => ({ running: true }),
          autostartPresent: async (plan) => { plans.push(plan); return plan.content === expected.content; } } });
      const row = result.rows.find((row) => row.id === 'autostart');
      assert.deepEqual(plans, []);
      assert.equal(row.status, 'skipped');
      assert.equal(row.detail, ui.text('doctorAutostartUnknown'));
      assert.equal(row.fix.includes('daemon start'), false);
      assert.equal(row.fix, ui.text('doctorFixAutostart', { command: shown([process.execPath,
        fileURLToPath(new URL('../src/cli.js', import.meta.url))], 'linux') }));
    });
  }
}

for (const state of ['executable', 'removed', 'directory', 'nonexecutable']) {
  test(`saved Node ${state} in setup and doctor plans`, { skip: state === 'nonexecutable' && process.platform === 'win32' }, async (t) => {
    const f = await world(t);
    const savedNode = join(f.home, 'saved-node');
    await fs.writeFile(savedNode, '// saved executable', { mode: 0o755 });
    if (state === 'removed' || state === 'directory') await fs.unlink(savedNode);
    if (state === 'directory') await fs.mkdir(savedNode);
    if (state === 'nonexecutable') await fs.chmod(savedNode, 0o644);
    const record = { ...f.records.codex, settings: { ...f.records.codex.settings, node: savedNode } };
    await fs.writeFile(join(f.destination, 'install.codex.json'), JSON.stringify(record));
    f.io.ask = async () => 'yes';
    const node = state === 'executable' ? savedNode : process.execPath;
    const script = join(record.path, record.bin);
    const expected = autostartPlan('systemd', { root: f.root, home: f.home, node, script, command: f.io.config.command });
    assert.equal(await main(['setup'], f.io), exitCodeFor('ok'));
    assert.deepEqual(f.written, [{ path: expected.path, content: expected.content }]);
    const { diagnose } = await import('../src/doctor/diagnose.js');
    const { createPresenter } = await import('../src/install/present.js');
    const plans = [];
    const result = await diagnose({ ...f.io, records: [{ ...record, autostart: true }],
      ui: createPresenter({ locale: 'en', write: () => {} }), readers: {
        selfCheck: async () => [], mcpEntry: async () => ({ state: 'registered' }), servers: async () => [],
        daemon: async () => ({ running: true }),
        autostartPresent: async (plan) => { plans.push(plan); return false; },
      } });
    assert.equal(plans[0].content, expected.content);
    const row = result.rows.find((row) => row.id === 'autostart');
    assert.equal(row.status, 'failed');
    assert.ok(row.fix.includes(shown([node, script, 'daemon', 'start'], 'linux')), row.fix);
  });
}

for (const binSource of ['record', 'package']) {
  for (const scriptState of ['missing', 'empty']) {
    test(`setup and doctor reject ${scriptState} installed script from ${binSource}`, async (t) => {
      const f = await world(t, { installed: true });
      const record = { ...f.records.codex };
      const script = join(record.path, record.bin);
      if (binSource === 'package') delete record.bin;
      await fs.writeFile(join(f.destination, 'install.codex.json'), JSON.stringify(record));
      if (scriptState === 'missing') await fs.unlink(script);
      else await fs.writeFile(script, '');
      f.io.ask = async () => { throw new Error('must not ask without a plan'); };
      const errors = [];
      f.io.stderr = (line) => errors.push(line);
      assert.equal(await main(['setup'], f.io), exitCodeFor('operational'));
      assert.deepEqual(errors, ['Automatic start could not be configured.\nno installation can supply an autostart plan\nTry again after fixing the cause: okit-plugin setup']);
      assert.deepEqual(f.written, []);
      assert.deepEqual(f.ran, []);
      const { diagnose } = await import('../src/doctor/diagnose.js');
      const { createPresenter } = await import('../src/install/present.js');
      const ui = createPresenter({ locale: 'en', write: () => {} });
      const plans = [];
      const result = await diagnose({ ...f.io, records: [record], ui, readers: {
        selfCheck: async () => [], mcpEntry: async () => ({ state: 'registered' }), servers: async () => [],
        daemon: async () => ({ running: true }), autostartPresent: async (plan) => { plans.push(plan); return false; },
      } });
      const row = result.rows.find((row) => row.id === 'autostart');
      assert.deepEqual(plans, []);
      assert.equal(row.fix.includes('daemon start'), false);
      if (binSource === 'record') {
        // The script is known and gone: the service cannot start, so the row fails and the Fix restores the payload.
        assert.equal(row.status, 'failed');
        assert.equal(row.detail, ui.text('doctorAutostartScriptGone'));
        assert.match(row.fix, /install$/);
        assert.equal(result.rows.some((item) => item.status === 'failed'), true);
      } else {
        assert.equal(row.status, 'skipped');
        assert.equal(row.detail, ui.text('doctorAutostartUnknown'));
      }
    });
  }
}

test('doctor does not fail the autostart of an installation that never enabled it when its script is gone', async (t) => {
  const f = await world(t, { installed: true });
  const record = { ...f.records.codex, autostart: false };
  await fs.unlink(join(record.path, record.bin));
  const { diagnose } = await import('../src/doctor/diagnose.js');
  const { createPresenter } = await import('../src/install/present.js');
  const ui = createPresenter({ locale: 'en', write: () => {} });
  const result = await diagnose({ ...f.io, records: [record], ui, readers: {
    selfCheck: async () => [], mcpEntry: async () => ({ state: 'registered' }), servers: async () => [],
    daemon: async () => ({ running: true }), autostartPresent: async () => false,
  } });
  assert.equal(result.rows.find((row) => row.id === 'autostart').status, 'skipped');
});

test('setup resolves a legacy record without path to the retained version payload', async (t) => {
  const f = await world(t);
  const record = { ...f.records.codex };
  delete record.path;
  delete record.bin;
  delete record.destination;
  await fs.unlink(join(f.destination, 'install.codex.json'));
  await fs.writeFile(join(f.destination, 'install.json'), JSON.stringify(record));
  f.io.ask = async () => 'yes';
  assert.equal(await main(['setup'], f.io), exitCodeFor('ok'));
  assert.deepEqual(f.written, [{ path: f.plan.path, content: f.plan.content }]);
  assert.deepEqual(f.ran, f.plan.install);
});

test('a legacy record that setup enabled the autostart for can be uninstalled with its service', async (t) => {
  const f = await world(t);
  const record = { ...f.records.codex };
  delete record.path;
  delete record.destination;
  await fs.unlink(join(f.destination, 'install.codex.json'));
  await fs.writeFile(join(f.destination, 'install.json'), JSON.stringify(record));
  f.io.ask = async () => 'yes';
  assert.equal(await main(['setup'], f.io), exitCodeFor('ok'));
  const saved = JSON.parse(await fs.readFile(join(f.destination, f.io.config.recordName.replace('{client}', 'codex')), 'utf8'));
  assert.equal(saved.autostart, true);
  assert.equal(saved.path, f.records.codex.path);
  f.clear();
  f.ran.length = 0;
  delete f.io.autostart; // the real lifecycle plans the autostart of the record
  delete f.io.stopDaemon;
  const code = await main(['uninstall', '--client', 'codex'], f.io);
  assert.equal(code, exitCodeFor('ok'), f.output.join('\n'));
  assert.ok(f.ran.some((command) => JSON.stringify(command).includes('disable')), JSON.stringify(f.ran));
});

test('doctor resolves a legacy record against the folder its records were found in, not the default one', async (t) => {
  const f = await world(t, { installed: true });
  const record = { ...f.records.codex };
  delete record.path;
  delete record.destination;
  const { diagnose } = await import('../src/doctor/diagnose.js');
  const { createPresenter } = await import('../src/install/present.js');
  const ui = createPresenter({ locale: 'en', write: () => {} });
  const readers = { selfCheck: async () => [], mcpEntry: async () => ({ state: 'registered' }), servers: async () => [],
    daemon: async () => ({ running: true }), autostartPresent: async () => true };
  const elsewhere = { ...f.io, config: { ...f.io.config, destination: '' }, home: join(f.home, 'elsewhere'), env: { ...f.io.env, HOME: join(f.home, 'elsewhere'), XDG_DATA_HOME: undefined } };
  const failed = (result) => result.rows.filter((row) => row.status === 'failed').map((row) => row.id);
  const found = await diagnose({ ...elsewhere, destination: f.destination, records: [record], ui, readers });
  const guessed = await diagnose({ ...elsewhere, destination: undefined, records: [record], ui, readers });
  assert.deepEqual(failed(found), failed(await diagnose({ ...f.io, records: [f.records.codex], ui, readers })));
  assert.notDeepEqual(failed(guessed), failed(found));
});

test('discovery finds the running installation from a legacy record that names no path or destination', async () => {
  const { discoverRecords } = await import('../src/install/place.js');
  const config = installConfig();
  const runtimeFolder = join(tmpdir(), 'okit-discovery');
  const running = join(runtimeFolder, '1.0.0-codex');
  const legacy = JSON.stringify({ client: 'codex', version: '1.0.0', autostart: true });
  const runtimeFs = { readFile: async (file) => {
    if (file === join(runtimeFolder, 'install.json')) return legacy;
    throw Object.assign(new Error('not there'), { code: 'ENOENT' });
  } };
  const found = await discoverRecords('/nowhere/else', { fs: runtimeFs, config, lenient: true, running });
  assert.equal(found.destination, runtimeFolder);
  assert.deepEqual(Object.keys(found.records), ['codex']);
  const emptyFs = { readFile: async (file) => {
    if (file === join(runtimeFolder, 'install.json')) return JSON.stringify({ client: 'codex', version: '1.0.0', destination: '' });
    throw Object.assign(new Error('not there'), { code: 'ENOENT' });
  } };
  // An empty destination names nothing: the folder the records were read from is the one.
  assert.equal((await discoverRecords('/nowhere/else', { fs: emptyFs, config, lenient: true, running })).destination, runtimeFolder);
  const other = await discoverRecords('/nowhere/else', { fs: runtimeFs, config, lenient: true, running: join(runtimeFolder, '2.0.0-codex') });
  assert.deepEqual(Object.keys(other.records), []);
});

test('setup saves the resolved folders of a legacy record whose service is already installed', async (t) => {
  const f = await world(t);
  const record = { ...f.records.codex, autostart: true };
  delete record.path;
  delete record.destination;
  await fs.unlink(join(f.destination, 'install.codex.json'));
  await fs.writeFile(join(f.destination, 'install.json'), JSON.stringify(record));
  await fs.mkdir(dirname(f.plan.path), { recursive: true });
  await fs.writeFile(f.plan.path, f.plan.content);
  assert.equal(await main(['setup'], f.io), exitCodeFor('ok'));
  assert.deepEqual(stepLines(f), ['Automatic start is on. Check it: okit-plugin doctor']);
  const saved = JSON.parse(await fs.readFile(join(f.destination, f.io.config.recordName.replace('{client}', 'codex')), 'utf8'));
  assert.equal(saved.path, f.records.codex.path);
  f.clear();
  f.ran.length = 0;
  delete f.io.autostart; // the real lifecycle plans the autostart of the record
  delete f.io.stopDaemon;
  const code = await main(['uninstall', '--client', 'codex'], f.io);
  assert.equal(code, exitCodeFor('ok'), f.output.join('\n'));
  assert.ok(f.ran.some((command) => JSON.stringify(command).includes('disable')), JSON.stringify(f.ran));
});

test('uninstall works with the folders of a legacy record that names none, and hands the service to a legacy survivor', async (t) => {
  const f = await world(t, { clients: ['claude-code', 'codex'], installed: true });
  for (const client of ['claude-code', 'codex']) {
    const record = { ...f.records[client], autostart: true, link: false };
    delete record.path;
    delete record.destination;
    await fs.writeFile(join(f.destination, f.io.config.recordName.replace('{client}', client)), JSON.stringify(record));
  }
  f.clear();
  f.ran.length = 0;
  delete f.io.autostart; // the real lifecycle plans the autostart of the record
  delete f.io.stopDaemon;
  const code = await main(['uninstall', '--client', 'claude-code'], f.io);
  assert.equal(code, exitCodeFor('ok'), f.output.join('\n'));
  assert.equal(f.ran.filter((command) => JSON.stringify(command).includes('disable')).length, 1, JSON.stringify(f.ran));
  // The service now belongs to the survivor: its unit names the survivor's script.
  assert.ok(f.written.some((item) => item.content.includes(join(f.records.codex.path, f.records.codex.bin))), JSON.stringify(f.written));
  await assert.rejects(fs.access(f.records['claude-code'].path));
});

test('uninstall removes the payload and the record of a legacy record that names no folder, with its retained version', async (t) => {
  const f = await world(t, { installed: true });
  const { path, destination, ...legacy } = f.records.codex;
  const retained = join(f.destination, `0.9.0-${legacy.client}`);
  await fs.mkdir(retained, { recursive: true });
  const record = { ...legacy, link: false, previous: { client: legacy.client, version: '0.9.0', previous: null } };
  await fs.writeFile(join(f.destination, f.io.config.recordName.replace('{client}', legacy.client)), JSON.stringify(record));
  delete f.io.stopDaemon;
  const code = await main(['uninstall', '--client', legacy.client], f.io);
  assert.equal(code, exitCodeFor('ok'), f.output.join('\n'));
  await assert.rejects(fs.access(f.records.codex.path));
  await assert.rejects(fs.access(retained));
  await assert.rejects(fs.access(join(f.destination, f.io.config.recordName.replace('{client}', legacy.client))));
});

test('every reader gets a legacy record and its retained versions with their folders filled in', async (t) => {
  const f = await world(t, { installed: true });
  const { path, destination, ...legacy } = f.records.codex;
  const record = { ...legacy, previous: { client: legacy.client, version: '0.9.0', previous: { client: legacy.client, version: '0.8.0', previous: null } } };
  await fs.writeFile(join(f.destination, f.io.config.recordName.replace('{client}', legacy.client)), JSON.stringify(record));
  for (const read of [readRecords, async (...args) => (await readRecordsLenient(...args)).records]) {
    const { [legacy.client]: found } = await read(f.destination, fs, f.io.config);
    assert.equal(found.destination, f.destination);
    assert.equal(found.path, join(f.destination, `${legacy.version}-${legacy.client}`));
    assert.equal(found.previous.path, join(f.destination, `0.9.0-${legacy.client}`));
    assert.equal(found.previous.previous.path, join(f.destination, `0.8.0-${legacy.client}`));
  }
});

test('a version or a client with a separator names no folder of the installer', async () => {
  const { installationOf } = await import('../src/install/where.js');
  assert.equal(installationOf({ version: '1.0.0', client: 'codex' }, '/data'), join('/data', '1.0.0-codex'));
  assert.equal(installationOf({ version: '../x', client: 'codex' }, '/data'), undefined);
  assert.equal(installationOf({ version: '1.0.0', client: 'a/b' }, '/data'), undefined);
});
