import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { PassThrough, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { setupAutostart } from '../src/setup/autostart-step.js';
import { main } from '../src/cli.js';
import { autostartPlan, detectAutostart } from '../src/autostart.js';
import { installConfig } from '../src/install/config.js';
import { readRecords } from '../src/install/place.js';
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
    run: async (command) => { ran.push(command); order.push('run'); return {}; },
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
  `Start the daemon with this machine using ${f.plan.kind}.`,
  ...(f.plan.path === null ? [] : [`Autostart writes: ${f.plan.path}`]),
];
const stepLines = (f) => f.output.slice(1); // No detected models: the existing setup emits exactly one line.

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
    assert.notEqual(question, 'Install autostart? [y/N]', 'cancelled setup asked about autostart');
    assert.match(question, /^(Choose a model|Save these model settings\?)/);
    return ''; // Accept the recommended models, then cancel the save confirmation.
  };
  assert.equal(await main(['setup'], f.io), 0);
  assert.equal(f.questions.length, 4);
  assert.ok(f.questions.slice(0, 3).every((question) => question.startsWith('Choose a model')));
  assert.match(f.questions[3], /^Save these model settings\?/);
  assert.deepEqual(f.output, ['Setup was cancelled and nothing was saved.']);
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
    assert.deepEqual(f.questions, ['Install autostart? [y/N]']);
    assert.deepEqual(f.ran, f.plan.install);
    assert.deepEqual(f.written, [{ path: f.plan.path, content: f.plan.content }]);
    assert.deepEqual(await readRecords(f.destination, fs, f.io.config), {
      codex: { ...f.records.codex, autostart: true },
    });
    assert.deepEqual(stepLines(f), [...explain(f), 'Autostart installed; okit-plugin uninstall removes it.']);
  });
}

test('accepted plan uses the node executable from the installation record', async (t) => {
  const f = await world(t);
  const record = { ...f.records.codex, settings: { ...f.records.codex.settings, node: '/opt/custom/node' } };
  await fs.writeFile(join(f.destination, f.io.config.recordName.replace('{client}', record.client)), JSON.stringify(record));
  const before = await snapshot(f);
  f.io.ask = async (question) => {
    f.questions.push(question);
    assert.deepEqual(await snapshot(f), before);
    return 'yes';
  };
  const expected = autostartPlan(detectAutostart('linux'), {
    root: f.root, home: f.home, node: '/opt/custom/node',
    script: join(record.path, record.bin), command: f.io.config.command,
  });
  assert.equal(await main(['setup'], f.io), 0);
  assert.deepEqual(f.questions, ['Install autostart? [y/N]']);
  assert.deepEqual(f.ran, expected.install);
  assert.deepEqual(f.written, [{ path: expected.path, content: expected.content }]);
  assert.ok(f.written[0].content.includes('/opt/custom/node'));
  assert.equal(f.written[0].content.includes(process.execPath), false);
});

test('accept saves the whole first record and propagates its link settings to both clients', async (t) => {
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
  assert.deepEqual(f.questions, ['Install autostart? [y/N]']);
  assert.deepEqual(f.ran, f.plan.install);
  assert.deepEqual(f.written, [{ path: f.plan.path, content: f.plan.content }]);
  assert.deepEqual(await readRecords(f.destination, fs, f.io.config), {
    [first.client]: { ...first, autostart: true },
    [second.client]: { ...second, autostart: true, link: true, linkDirectory: '/a' },
  });
});

for (const platform of ['linux', 'darwin', 'win32']) {
  test(`accept applies the exact ${platform} plan before saving both clients`, async (t) => {
    const f = await world(t, { clients: ['codex', 'claude-code'], platform });
    assert.equal(await main(['setup'], f.io), 0);
    assert.deepEqual(f.questions, ['Install autostart? [y/N]']);
    // The scheduled task of Windows has no file: the step asks the platform whether the task is there (read-only) first.
    const asked = f.plan.kind === 'schtasks' ? [{ command: 'schtasks', args: ['/Query', '/TN', 'okit-daemon'], timeoutMs: undefined }] : [];
    assert.deepEqual(f.ran, [...asked, ...f.plan.install]);
    assert.deepEqual(f.written, f.plan.path === null ? [] : [{ path: f.plan.path, content: f.plan.content }]);
    assert.deepEqual(f.order, [...asked.map(() => 'run'), ...(f.plan.path === null ? [] : ['file']), ...f.plan.install.map(() => 'run'), 'record', 'record']);
    const records = await readRecords(f.destination, fs, f.io.config);
    assert.deepEqual(records, Object.fromEntries(Object.entries(f.records).map(([client, record]) => [client, { ...record, autostart: true }])));
    assert.deepEqual(stepLines(f), [...explain(f), 'Autostart installed; okit-plugin uninstall removes it.']);
  });
}
for (const answer of ['', 'n', undefined, 'throw']) {
  test(`decline (${String(answer)}) leaves records and machine untouched`, async (t) => {
    const f = await world(t);
    f.io.ask = async (question) => { f.questions.push(question); if (answer === 'throw') throw new Error('closed'); return answer; };
    assert.equal(await main(['setup'], f.io), 0);
    assert.deepEqual(f.questions, ['Install autostart? [y/N]']);
    assert.deepEqual(f.ran, []);
    assert.deepEqual(f.written, []);
    assert.deepEqual(f.order, []);
    assert.deepEqual(await snapshot(f), f.before);
    assert.deepEqual(stepLines(f), [...explain(f), 'Autostart not installed; to do it later ask the user to run: okit-plugin setup']);
  });
}
test('--defaults never offers or installs autostart', async (t) => {
  const f = await world(t);
  f.io.ask = async () => { assert.fail('asked'); };
  f.io.run = async () => { assert.fail('ran'); };
  assert.equal(await main(['setup', '--defaults'], f.io), 0);
  assert.equal(f.output.length, 1);
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
  assert.deepEqual(stepLines(f), ['Autostart is already installed.']);
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
  assert.deepEqual(f.questions, ['Install autostart? [y/N]']);
  assert.deepEqual(f.ran, f.plan.install);
  assert.deepEqual(f.written, [{ path: f.plan.path, content: f.plan.content }]);
  assert.deepEqual(stepLines(f), [...explain(f), 'Autostart installed; okit-plugin uninstall removes it.']);
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
    assert.deepEqual(f.questions, ['Install autostart? [y/N]']);
    // A save that fails after the service is installed takes the service back.
    assert.deepEqual(f.ran, failure === 'write' ? [] : failure === 'apply' ? f.plan.install.slice(0, 1)
      : [...f.plan.install, ...f.plan.uninstall]);
    assert.deepEqual(f.written, failure === 'write' ? [] : [{ path: f.plan.path, content: f.plan.content }]);
    assert.deepEqual(await snapshot(f), f.before);
    assert.deepEqual(stepLines(f), explain(f));
    assert.deepEqual(errors, [failure === 'save'
      ? 'Could not install autostart: the autostart was taken back: permission denied'
      : 'Could not install autostart: permission denied']);
    assert.doesNotMatch(f.output.join('\n'), /Could not install autostart|permission denied/);
    assert.doesNotMatch(f.output.join('\n'), /\n\s+at |Error:/);
  });
}
test('Portuguese explains, asks and confirms entirely in Portuguese', async (t) => {
  const f = await world(t);
  f.io.ask = async (question) => { f.questions.push(question); return 'sim'; };
  assert.equal(await main(['setup', '--locale', 'pt-BR'], f.io), 0);
  assert.deepEqual(f.questions, ['Instalar a inicialização automática? [s/N]']);
  assert.deepEqual(stepLines(f), [
    'Iniciar o daemon com esta máquina usando systemd.',
    `A inicialização automática grava: ${f.plan.path}`,
    'Inicialização automática instalada; okit-plugin uninstall a remove.',
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
  assert.deepEqual(stepLines(f), [...explain(f), 'Autostart installed; okit-plugin uninstall removes it.']);
  assert.equal((await readRecords(f.destination, fs, f.io.config)).codex.autostart, true);
});

test('mixed autostart flags still offer once and use the first record', async (t) => {
  const f = await world(t, { clients: ['claude-code', 'codex'] });
  const first = Object.values(f.records)[0];
  await fs.writeFile(join(f.destination, f.io.config.recordName.replace('{client}', first.client)), JSON.stringify({ ...first, autostart: true }));
  f.io.ask = async (question) => { f.questions.push(question); return 's'; };
  assert.equal(await main(['setup'], f.io), 0);
  assert.deepEqual(f.questions, ['Install autostart? [y/N]']);
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
  assert.match(errors[0], /^Could not install autostart: /, errors[0]);
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
  assert.match(errors[0], /^Could not install autostart: the autostart was taken back: permission denied$/, errors[0]);
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
    assert.deepEqual(errors, ['Could not install autostart: the autostart was taken back: save denied'
      + (restoreFails ? `; ${join(destination, 'install.claude-code.json')}: restore denied` : '')]);
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
  assert.equal(reads.filter((name) => name === join(destination, 'install.json')).length, 5);
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
function rollbackWorld({ records, service = null, failSave = true, task = null }) {
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
      actions.push(command);
      return {};
    },
    write: async (path, content) => { written.push(path); files.set(path, content); } };
  const plan = { kind: task === null ? 'test' : 'schtasks', path: task === null ? servicePath : null, content: '[Service]\nExecStart=okit-plugin daemon start\n',
    install: [{ command: 'install' }], uninstall: [{ command: 'uninstall' }] };
  return { config: { ...config, destination }, destination, servicePath, files, actions, errors, outputs, written, ctx, plan };
}

/** The records of the world, as they are on the disk: the bytes of every file of a client. */
const recordFiles = (files) => Object.fromEntries([...files.entries()].filter(([file]) => file.endsWith('.json')));

const runRollback = (world) => setupAutostart(world.ctx, {
  config: world.config, locale: 'en', ask: async () => 'yes', plan: () => world.plan,
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
  assert.deepEqual(w.errors, ['Could not install autostart: the autostart was taken back: save denied']);
});

test('a save that fails does not take away a service that was already on the disk', async () => {
  const w = rollbackWorld({ records: {
    'claude-code': { client: 'claude-code', autostart: false, link: false },
  }, service: '[Service]\nExecStart=okit-plugin daemon start\n' });
  const before = recordFiles(w.files);
  assert.equal(await runRollback(w), 1);
  assert.deepEqual(w.actions, ['install'], w.actions.join(', '));
  assert.deepEqual(w.errors, ['Could not install autostart: the service that was already installed was kept: save denied']);
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
  assert.deepEqual(w.errors, ['Could not install autostart: the service that was already installed was kept: save denied']);
  assert.deepEqual(recordFiles(w.files), before);
});

test('a save that fails on a Windows machine without the task takes the task back', async () => {
  const w = rollbackWorld({ records: {
    'claude-code': { client: 'claude-code', autostart: false, link: false },
  }, task: 'absent' });
  assert.equal(await runRollback(w), 1);
  assert.deepEqual(w.actions, ['query', 'install', 'uninstall'], w.actions.join(', '));
  assert.deepEqual(w.errors, ['Could not install autostart: the autostart was taken back: save denied']);
});

test('a save that fails on a clean machine takes the service back', async () => {
  const w = rollbackWorld({ records: {
    'claude-code': { client: 'claude-code', autostart: false, link: false },
  } });
  const before = recordFiles(w.files);
  assert.equal(await runRollback(w), 1);
  // Nothing was there before: the service that this run installed is taken back.
  assert.deepEqual(w.actions, ['install', 'uninstall'], w.actions.join(', '));
  assert.deepEqual(w.errors, ['Could not install autostart: the autostart was taken back: save denied']);
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
