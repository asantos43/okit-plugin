import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { buildInstallPlan, compareInstallFingerprints } from '../src/install/plan.js';
import { installerCommand } from '../src/install/index.js';
import { createPresenter, createStructuredPresenter, renderPlanEvents, localizeReason } from '../src/install/present.js';
import { pathProposal } from '../src/install/link.js';
import { panelProposal } from '../src/install/panel.js';
import { initializeDetectedConfig, proposeDetectedConfig } from '../src/setup/setup.js';
import { configOf } from '../src/profiles.js';
import { record as recordTelemetry } from '../src/telemetry/index.js';
import { fixture } from './helpers/install-fixture.js';

// Must pass / must refuse:
// | Must pass | Must refuse |
// | install/update/account/multiple-client rows match the plan | any preview write or client launch |
// | unchanged inputs have stable fingerprints | edited config, record, profile or release |
// | JSON serialisation and translated refusal | plaintext secrets in diffs |
// | exact kit argv through the preview adapter | different argv or executable (M2) |
// | clean review with resolved observations | conflicts or pending observations (M4) |
// | preview fs reads | every write capability, including write-mode open (M6) |
// | initialization records observations | proposal telemetry/config/lock writes (M8) |
// | useful settings/profile diffs | nested sensitive keys or token lines (M10) |
const context = (f) => ({ root: f.root, env: f.io.env, platform: f.io.platform,
  now: f.io.now, command: 'okit-plugin', out: (line) => f.output.push(line) });
async function snapshot(root) {
  const result = {};
  const walk = async (path) => {
    const info = await fs.lstat(path);
    result[path] = { mtime: info.mtimeMs, mode: info.mode, size: info.size,
      content: info.isFile() ? (await fs.readFile(path)).toString('base64') : null };
    if (info.isDirectory()) for (const name of (await fs.readdir(path)).sort()) await walk(join(path, name));
  };
  await walk(root);
  return result;
}

const WRITES = /^(?:writeFile|appendFile|mkdir|mkdtemp|rename|rm|rmdir|unlink|cp|copyFile|symlink|link|chmod|chown|lchmod|lchown|utimes|lutimes|truncate|open)$/;
function recordingFs(writes) {
  return new Proxy(fs, { get(target, key) {
    if (!WRITES.test(String(key))) return target[key];
    return async (...args) => {
      const destinations = ['rename'].includes(key) ? args.slice(0, 2)
        : ['cp', 'copyFile', 'symlink', 'link'].includes(key) ? [args[1]] : [args[0]];
      writes.push(...destinations.map(String));
      const result = await target[key](...args);
      if (key === 'mkdtemp') writes.push(result);
      return result;
    };
  } });
}
function inventoryCovers(plan, path) {
  return plan.mutations.some((item) => {
    if (!item.path) return false;
    if (item.path === path) return true;
    if (item.path.includes('*') && item.temporary) {
      const pattern = item.path.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
      return new RegExp(`^${pattern}(?:/.*)?$`).test(path);
    }
    return item.recursive === true && path.startsWith(item.path + '/');
  });
}

// Capture the actual dependencies delivered to chooseClient. No test-only
// production export or recreated capability wrapper can mask a regression.
async function previewOf(f, options = {}, args = ['--client', 'codex']) {
  let preview;
  const plan = await buildInstallPlan('install', args, context(f), { ...f.io, ...options,
    detect: (_command, deps) => { preview ??= deps; return true; } });
  assert.equal(plan.exitCode, 0);
  assert.equal(preview.dryRun, true);
  return { plan, preview };
}
function isPreviewRefusal(error) {
  assert.equal(error.name, 'PreviewCapabilityError');
  assert.equal(error.kind, 'operational');
  assert.equal(error.message, 'Install preview cannot write or start processes.');
  return true;
}

test('M2: preview run refuses different kit argv and executable before calling the adapter', async (t) => {
  const f = await fixture(t);
  const executable = join(f.home, 'kit-detector');
  await fs.writeFile(executable, '#!/bin/sh\n', { mode: 0o755 });
  const saved = JSON.parse(await fs.readFile(join(f.root, 'config.json'), 'utf8'));
  saved.install.kit.path = executable;
  await fs.writeFile(join(f.root, 'config.json'), JSON.stringify(saved));
  const calls = [];
  const { plan, preview } = await previewOf(f, { run: async (request) => {
    calls.push(request); return { stdout: 'kit 1.2.3\n' };
  } });
  assert.equal(calls.length, 1, 'the real detector must run during preview');
  assert.ok(plan.events.some((event) => event.stage === 'row' && event.params.args[2]?.includes('1.2.3')));
  const request = { command: executable, args: saved.install.kit.versionArgs };
  assert.deepEqual(await preview.run(request), { stdout: 'kit 1.2.3\n' });
  assert.equal(calls.length, 2);
  for (const refused of [{ ...request, args: [...request.args, '--unexpected'] },
    { ...request, command: executable + '-other' }]) {
    await assert.rejects(() => preview.run(refused), isPreviewRefusal);
    assert.equal(calls.length, 2, 'refused requests must not reach the adapter');
  }
});

test('M6: the actual preview filesystem refuses every write capability without delegating', async (t) => {
  const f = await fixture(t);
  const calls = [];
  const spy = new Proxy(fs, { get(target, key) {
    if (!WRITES.test(String(key))) return target[key];
    return async (...args) => { calls.push({ method: key, args }); };
  } });
  const before = await snapshot(f.home);
  const { preview } = await previewOf(f, { fs: spy });
  const file = join(f.home, 'must-not-be-written');
  const methods = ['writeFile', 'appendFile', 'mkdir', 'rename', 'rm', 'rmdir', 'unlink',
    'copyFile', 'cp', 'symlink', 'link', 'chmod', 'chown', 'lchmod', 'lchown', 'utimes', 'lutimes', 'truncate', 'mkdtemp'];
  for (const method of methods) {
    await assert.rejects(async () => preview.fs[method](file, file), isPreviewRefusal, method);
    assert.deepEqual(calls, [], `${method} reached the underlying filesystem`);
  }
  for (const flag of ['w', 'wx', 'w+', 'a', 'ax', 'a+', 'r+']) {
    await assert.rejects(async () => preview.fs.open(file, flag), isPreviewRefusal, `open(${flag})`);
    assert.deepEqual(calls, [], `open(${flag}) reached the underlying filesystem`);
  }
  assert.ok((await preview.fs.readFile(join(f.root, 'config.json'), 'utf8')).includes('install'));
  assert.deepEqual(await snapshot(f.home), before);
});

test('M4: reviewability independently requires no conflicts and no pending observations', async (t) => {
  const f = await fixture(t);
  assert.equal(await installerCommand('install', ['--client', 'claude-code'], context(f), f.io), 0);
  const path = join(f.destination, 'install.claude-code.json');
  const record = JSON.parse(await fs.readFile(path, 'utf8'));
  record.panel = { identity: 'okit-plugin-panel@okit-plugin' };
  await fs.writeFile(path, JSON.stringify(record));
  const cases = [
    { conflict: null, pending: false, expected: true },
    { conflict: 'foreign-profile-block', pending: false, expected: false },
    { conflict: 'foreign-command', pending: false, expected: false },
    { conflict: 'unreadable-role', pending: false, expected: false },
    { conflict: null, pending: true, expected: false },
  ];
  // An already registered panel needs no further observation. Feed each gate
  // independently through the real detection boundary, so one cannot mask another.
  for (const entry of cases) {
    let observed;
    const plan = await buildInstallPlan('install', ['--panel'], context(f), { ...f.io,
      detect: (_command, deps) => {
        if (!observed) {
          observed = deps.previewPlan;
          if (entry.conflict) observed.conflicts.push({ kind: entry.conflict, path: join(f.home, '.profile') });
          if (entry.pending) observed.deferred.push({ kind: 'mcp-ownership', requiresObservation: true });
        }
        return true;
      } });
    assert.equal(plan.exitCode, 0);
    assert.equal(plan.conflicts.length, entry.conflict ? 1 : 0);
    assert.equal(plan.deferred.length, entry.pending ? 1 : 0);
    assert.equal(plan.reviewable, entry.expected, JSON.stringify(entry));
  }
  f.io.env.PATH = f.io.env.PATH.replace(f.bin + ':', '');
  await fs.writeFile(join(f.home, '.profile'), `${f.io.config.path.begin}\nforeign block\n${f.io.config.path.end}\n`);
  const foreign = await buildInstallPlan('install', ['--client', 'codex'], context(f), f.io);
  assert.equal(foreign.exitCode, 0);
  assert.ok(foreign.conflicts.some((item) => item.kind === 'foreign-profile-block'));
  assert.equal(foreign.reviewable, false);
});

test('M8: setup proposal never records enabled telemetry while initialization still records', async (t) => {
  const f = await fixture(t);
  const configPath = join(f.root, 'config.json');
  const saved = JSON.parse(await fs.readFile(configPath, 'utf8'));
  const kitConfig = join(f.root, 'kit-telemetry.json');
  await fs.writeFile(kitConfig, JSON.stringify({ telemetry: { enabled: false } }));
  saved.telemetry = { enabled: true, dir: 'measurements', kitConfigFile: kitConfig };
  await fs.writeFile(configPath, JSON.stringify(saved));
  const models = [...new Set(Object.values(configOf(saved).profiles.codex).filter(Boolean).map((entry) => entry.model))];
  const records = [], configWrites = [];
  const options = { root: f.root, env: f.io.env, clients: ['codex'], readQuota: f.io.readQuota,
    run: () => assert.fail('setup observation started a process'),
    adapters: [{ CLIENT: 'codex', listModels: async () => ({ client: 'codex', installed: true, models, source: 'listing' }) }],
    recordTelemetry: async (...args) => {
      records.push(args);
      return recordTelemetry(...args);
    },
    write: async (path, value) => { configWrites.push(path); await fs.writeFile(path, JSON.stringify(value)); },
  };
  const before = await snapshot(f.home);
  const proposal = await proposeDetectedConfig(options);
  assert.equal(proposal.written, false);
  assert.ok(proposal.detected?.profiles.codex, 'the observation must have real proposals to initialize');
  assert.deepEqual(records, [], 'proposal must not call the telemetry writer, even when enabled');
  assert.deepEqual(configWrites, [], 'proposal must not save config');
  assert.deepEqual(await snapshot(f.home), before, 'proposal must not create measurements or locks');
  const initialized = await initializeDetectedConfig(options);
  assert.equal(initialized.written, true);
  assert.ok(records.some(([root, event, fields]) => root === f.root && event === 'quota.check' && fields.client === 'codex'));
  assert.deepEqual(configWrites, [configPath]);
  assert.ok((await fs.readdir(join(f.root, 'measurements'))).some((name) => name.endsWith('.json')));
  assert.equal((await fs.stat(join(f.root, 'locks'))).isDirectory(), true);
});

test('M10: settings before/after redact nested sensitive keys and profiles redact token assignments', async (t) => {
  const f = await fixture(t);
  f.io.env.CLAUDE_CONFIG_DIR = f.io.clientRoot;
  f.io.env.PATH = f.io.env.PATH.replace(f.bin + ':', '');
  const secrets = ['live-api-value-938', 'private-password-572', 'profile-value-681'];
  await fs.mkdir(f.io.clientRoot, { recursive: true });
  await fs.writeFile(join(f.io.clientRoot, 'settings.json'), JSON.stringify({
    apiToken: secrets[0], nested: { password: secrets[1], theme: 'dark' }, unrelated: 'keep-settings',
  }));
  await fs.writeFile(join(f.home, '.profile'), `export token=${secrets[2]}\nexport COLOR=blue\n`);
  const plan = await buildInstallPlan('install', ['--client', 'claude-code', '--statusline'], context(f), f.io);
  assert.equal(plan.exitCode, 0);
  const bar = plan.mutations.find((item) => item.kind === 'statusline');
  const profile = plan.mutations.find((item) => item.kind === 'profile');
  assert.ok(bar && profile, 'both sensitive input paths must reach the mutation inventory');
  for (const field of ['before', 'after']) {
    const settings = JSON.parse(bar[field]);
    assert.equal(settings.apiToken, '[redacted]');
    assert.equal(settings.nested.password, '[redacted]');
    assert.equal(settings.nested.theme, 'dark');
    assert.equal(settings.unrelated, 'keep-settings');
    assert.ok(profile[field].includes('[redacted]'));
    assert.ok(profile[field].includes('COLOR=blue'));
    for (const secret of secrets) assert.ok(!bar[field].includes(secret) && !profile[field].includes(secret));
  }
  for (const secret of secrets) assert.ok(!JSON.stringify(plan).includes(secret));
});

test('plan and terminal dry-run have the same rows and details for every selection', async (t) => {
  const f = await fixture(t);
  for (const args of [['--client', 'codex'], ['--client', 'claude-code', '--no-link'], ['--client', 'all']]) {
    const plan = await buildInstallPlan('install', args, context(f), f.io);
    assert.equal(plan.exitCode, 0);
    assert.ok(plan.mutations.some((item) => item.kind === 'payload-tree'));
    assert.ok(plan.releases.every((release) => release.checksum === null && release.resolvedAtApply));
    const expected = [];
    renderPlanEvents(plan.events, createPresenter({ write: (line) => expected.push(line), verbose: true }), (line) => expected.push(line));
    f.clear();
    assert.equal(await installerCommand('install', [...args, '--dry-run', '--verbose'], context(f), f.io), 0);
    assert.deepEqual(f.output, expected);
    assert.deepEqual(JSON.parse(JSON.stringify(plan)), plan);
  }
});

test('plan and dry-run cannot call injected write or process capabilities and preserve all mtimes', async (t) => {
  const f = await fixture(t);
  f.io.env = { ...f.io.env, OKWORK_HOME: f.root, CLAUDE_CONFIG_DIR: join(f.home, '.claude'), CODEX_HOME: join(f.home, '.codex') };
  await fs.writeFile(join(f.home, '.profile'), 'export COLOR=blue\n');
  const calls = [];
  const forbidden = (...args) => { calls.push(args); throw new Error('unexpected capability'); };
  const guarded = new Proxy(fs, { get(target, key) {
    return /^(write|mkdir|mkdtemp|rm|unlink|rename|cp|copy|symlink|link|chmod|chown|utimes|open|append)/.test(key) ? forbidden : target[key];
  } });
  const io = { ...f.io, fs: guarded, run: forbidden, spawn: forbidden, pathExecute: forbidden,
    policyExecute: forbidden, write: forbidden, startDaemon: forbidden, stopDaemon: forbidden, autostart: forbidden };
  const requests = [];
  io.fetch = async (url, options) => {
    requests.push(url);
    assert.ok(url.endsWith('/latest') || url.endsWith('/releases'), `preview downloaded ${url}`);
    return f.io.fetch(url, options);
  };
  const before = await snapshot(f.home);
  assert.equal((await buildInstallPlan('install', ['--client', 'all'], context(f), io)).exitCode, 0);
  assert.equal(await installerCommand('install', ['--client', 'all', '--dry-run'], context(f), io), 0);
  assert.deepEqual(await snapshot(f.home), before);
  assert.deepEqual(calls, []);
  assert.ok(requests.length > 0);
});

test('fingerprints detect profile, config and release drift without exposing contents', async (t) => {
  const f = await fixture(t);
  f.io.env.PATH = f.io.env.PATH.replace(f.bin + ':', '');
  const profile = join(f.home, '.profile');
  await fs.writeFile(profile, 'export SECRET_TOKEN=never-show-this\n');
  const configPath = join(f.root, 'config.json');
  const saved = JSON.parse(await fs.readFile(configPath, 'utf8'));
  saved.install.headers.Authorization = 'Bearer hidden-config-token';
  await fs.writeFile(configPath, JSON.stringify(saved));
  const plan = await buildInstallPlan('install', ['--client', 'codex'], context(f), f.io);
  const compare = () => compareInstallFingerprints(plan, { fs, env: f.io.env, fetch: f.io.fetch });
  assert.equal((await compare()).matches, true);
  const assetChanged = await compareInstallFingerprints(plan, { fs, env: f.io.env, fetch: async (url, options) => {
    const response = await f.io.fetch(url, options);
    const release = await response.json();
    release.assets.forEach((asset) => { asset.browser_download_url += '/changed'; });
    return Response.json(release);
  } });
  assert.deepEqual(assetChanged.changed, ['release']);
  assert.equal((await compareInstallFingerprints(plan, { fs,
    env: Object.fromEntries(Object.entries(f.io.env).reverse()), fetch: f.io.fetch })).matches, true);
  assert.ok(!JSON.stringify(plan).includes('never-show-this'));
  assert.ok(!JSON.stringify(plan).includes('hidden-config-token'));
  await fs.appendFile(profile, '# changed\n');
  assert.equal((await compare()).matches, false);
  assert.ok((await compare()).changed.includes(profile));
  const fresh = await buildInstallPlan('install', ['--client', 'codex'], context(f), f.io);
  await fs.appendFile(join(f.root, 'config.json'), ' ');
  assert.ok((await compareInstallFingerprints(fresh, { fs, env: f.io.env, fetch: f.io.fetch })).changed.includes(join(f.root, 'config.json')));
  f.setVersion('2.0.0');
  assert.equal((await compare()).matches, false);
});

test('structured presenter preserves terminal sequence, details, questions and outcomes', async () => {
  const collect = createStructuredPresenter({ verbose: true });
  const expected = [];
  const terminal = createPresenter({ verbose: true, write: (line) => expected.push(line) });
  const run = async (ui) => {
    const next = ui.sequence(['files', 'register'], { client: 'Codex' });
    next('files').plan('/destination');
    ui.detail('codex mcp add');
    next('register').skip();
    ui.row(ui.text('upToDate'), 'ok', '1.0.0');
    await ui.confirm(async () => 'yes', { question: ui.text('panelAsk'), explain: [ui.text('panelExplain')] });
  };
  await run(collect); await run(terminal);
  const actual = [];
  renderPlanEvents(collect.events, createPresenter({ verbose: true, write: (line) => actual.push(line) }));
  assert.deepEqual(actual, expected);
  assert.ok(collect.events.every((event) => ['stage', 'client', 'status', 'messageKey', 'params'].every((key) => key in event)));
});

test('update, up-to-date and record drift share the plan contract', async (t) => {
  const f = await fixture(t);
  assert.equal(await installerCommand('install', ['--client', 'codex', '--no-statusline'], context(f), f.io), 0);
  const args = ['--client', 'codex', '--no-statusline'];
  for (const version of ['1.0.0', '2.0.0']) {
    f.setVersion(version);
    const before = await snapshot(f.home);
    const commandCount = f.commands.length;
    const plan = await buildInstallPlan('update', args, context(f), f.io);
    assert.equal(plan.exitCode, 0);
    assert.equal(plan.clients[0].upToDate, version === '1.0.0');
    const expected = [];
    renderPlanEvents(plan.events, createPresenter({ write: (line) => expected.push(line) }));
    f.clear();
    assert.equal(await installerCommand('update', [...args, '--dry-run'], context(f), f.io), 0);
    assert.deepEqual(f.output, expected);
    assert.deepEqual(await snapshot(f.home), before);
    assert.equal(f.commands.length, commandCount);
    const record = plan.fingerprints.find((item) => item.method === 'readFile' && item.path.endsWith('codex.json') && item.path.startsWith(f.destination));
    assert.ok(record);
    const original = await fs.readFile(record.path);
    await fs.appendFile(record.path, ' ');
    assert.equal((await compareInstallFingerprints(plan, { fs, env: f.io.env, fetch: f.io.fetch })).matches, false);
    await fs.writeFile(record.path, original);
  }
});

test('PATH proposal preserves foreign blocks and represents Windows PATH without running a process', async (t) => {
  const f = await fixture(t);
  f.io.env.PATH = '';
  await fs.writeFile(join(f.home, '.profile'), `${f.io.config.path.begin}\nforeign\n`);
  const changes = await pathProposal({ ...f.io, noPath: false });
  assert.ok(changes.some((item) => item.conflict && item.after === item.before));
  const windows = await pathProposal({ ...f.io, platform: 'win32', windowsUserPath: 'C:\\tools' });
  assert.equal(windows[0].before, 'C:\\tools');
  assert.ok(windows[0].after.includes(f.bin));
  assert.equal(panelProposal({ client: 'codex' }, {}, f.io), null);
  assert.deepEqual(panelProposal({ client: 'claude-code' }, {}, f.io).args.slice(-2), ['--scope', 'user']);
  assert.notEqual(localizeReason('Install preview cannot write or start processes.', 'pt-BR'), 'Install preview cannot write or start processes.');
});

test('named accounts have their own registration argv and paths without starting the client', async (t) => {
  const f = await fixture(t);
  const path = join(f.root, 'config.json');
  const saved = JSON.parse(await fs.readFile(path, 'utf8'));
  const configDir = join(f.home, 'work-account');
  saved.accounts = { 'claude-code': [{ id: 'work', label: 'Work', configDir }] };
  await fs.writeFile(path, JSON.stringify(saved));
  const args = ['--client', 'claude-code', '--account', 'work'];
  const before = await snapshot(f.home);
  const plan = await buildInstallPlan('install', args, context(f), f.io);
  assert.equal(plan.exitCode, 0);
  assert.deepEqual(plan.clients[0].accounts, [{ id: 'work', root: configDir }]);
  assert.ok(plan.mutations.some((item) => item.kind === 'client-command' && item.account === 'work' && Array.isArray(item.args)));
  const expected = [];
  renderPlanEvents(plan.events, createPresenter({ write: (line) => expected.push(line) }));
  f.clear();
  assert.equal(await installerCommand('install', [...args, '--dry-run'], context(f), f.io), 0);
  assert.deepEqual(f.output, expected);
  assert.deepEqual(await snapshot(f.home), before);
  assert.equal(f.commands.length, 0);
});

test('setup observation/proposal does not initialise config, locks or telemetry', async (t) => {
  const f = await fixture(t);
  const before = await snapshot(f.home);
  const proposal = await proposeDetectedConfig({ root: f.root, env: f.io.env, adapters: [],
    clients: ['codex'], readQuota: f.io.readQuota, run: async () => ({ stdout: '' }) });
  assert.equal(proposal.written, false);
  assert.ok(proposal.observation);
  assert.deepEqual(await snapshot(f.home), before);
});

test('inventory covers every recorded install/update write and client registration argv', async (t) => {
  for (const client of ['claude-code', 'codex', 'opencode']) {
    const f = await fixture(t);
    f.io.env.PATH = f.io.env.PATH.replace(f.bin + ':', '');
    const writes = [];
    const io = { ...f.io, fs: recordingFs(writes), loadAdapter: async () => ({
      configRoot: () => f.io.clientRoot, installRole: async () => ({ status: 'ready' }),
      removeRole: async () => ({ status: 'ready' }),
      installHooks: async (file) => {
        const path = join(f.io.clientRoot, 'plugins', 'okit-plugin.js');
        await io.fs.mkdir(join(f.io.clientRoot, 'plugins'), { recursive: true });
        await io.fs.copyFile(file, path);
        return { path, written: true };
      },
      installSkill: async (name, source) => {
        const path = join(f.io.clientRoot, 'skills', name);
        await io.fs.cp(source, path, { recursive: true });
        return { path, written: true };
      },
    }) };
    for (const [command, version] of [['install', '1.0.0'], ['update', '2.0.0']]) {
      f.setVersion(version);
      const args = ['--client', client, ...(client === 'claude-code' ? ['--statusline'] : [])];
      const plan = await buildInstallPlan(command, args, context(f), io);
      assert.equal(plan.exitCode, 0, f.output.join('\n'));
      const before = await snapshot(f.home);
      writes.length = 0; f.commands.length = 0;
      assert.equal(await installerCommand(command, args, context(f), io), 0, f.output.join('\n'));
      const after = await snapshot(f.home);
      for (const [path, value] of Object.entries(after)) {
        if (!before[path] || (value.content !== null && JSON.stringify(value) !== JSON.stringify(before[path]))) writes.push(path);
      }
      writes.push(...Object.keys(before).filter((path) => !after[path]));
      const missing = [...new Set(writes)].filter((path) => !inventoryCovers(plan, path));
      assert.deepEqual(missing, [], `${command} ${client}: unplanned writes`);
      const argv = plan.mutations.flatMap((item) => item.kind === 'mcp' ? [item.add, item.remove]
        : item.command && item.args ? [[item.command, ...item.args]] : []);
      for (const call of f.commands.filter((item) => item.args?.[0] === 'plugin' ||
        (item.args?.[0] === 'mcp' && ['add', 'remove'].includes(item.args[1])))) {
        assert.ok(argv.some((words) => JSON.stringify(words) === JSON.stringify([call.command, ...call.args])), JSON.stringify(call));
      }
    }
  }
});

test('preview permits only the configured kit detector argv and keeps the real kit row', async (t) => {
  const f = await fixture(t);
  const path = join(f.home, 'kit-detector');
  await fs.writeFile(path, '#!/bin/sh\n', { mode: 0o755 });
  const saved = JSON.parse(await fs.readFile(join(f.root, 'config.json'), 'utf8'));
  saved.install.kit.path = path;
  await fs.writeFile(join(f.root, 'config.json'), JSON.stringify(saved));
  const calls = [];
  const io = { ...f.io, run: async (request) => {
    calls.push(request);
    assert.equal(request.command, path);
    assert.deepEqual(request.args, saved.install.kit.versionArgs);
    return { stdout: 'kit 1.2.3\n' };
  }, spawn: () => assert.fail('preview spawned a client') };
  const before = await snapshot(f.home);
  const plan = await buildInstallPlan('install', ['--client', 'codex'], context(f), io);
  assert.equal(plan.exitCode, 0);
  assert.equal(calls.length, 1);
  assert.ok(plan.events.some((event) => event.stage === 'row' && event.params.args[2]?.includes('1.2.3')));
  assert.deepEqual(await snapshot(f.home), before);
});

test('local user-trusted sources are walked and hashed without remote acquisition', async (t) => {
  const f = await fixture(t);
  const source = join(f.home, 'local-source');
  await fs.mkdir(join(source, 'src'), { recursive: true });
  await fs.writeFile(join(source, 'package.json'), JSON.stringify({ ...f.io.pkg, version: '3.0.0' }));
  await fs.writeFile(join(source, 'src/cli.js'), '// local CLI\n');
  const io = { ...f.io, fetch: () => assert.fail('local preview fetched a release') };
  const before = await snapshot(f.home);
  const plan = await buildInstallPlan('install', ['--client', 'codex', '--from', source], context(f), io);
  assert.equal(plan.exitCode, 0);
  assert.equal(plan.releases[0].trustedLocal, true);
  assert.equal(plan.releases[0].checksum, null);
  assert.ok(plan.mutations.some((item) => item.kind === 'payload' && /^[a-f0-9]{64}$/.test(item.sha256)));
  assert.deepEqual(await snapshot(f.home), before);
  assert.equal((await compareInstallFingerprints(plan, { fs, env: f.io.env })).matches, true);
  await fs.appendFile(join(source, 'src/cli.js'), '// changed\n');
  assert.equal((await compareInstallFingerprints(plan, { fs, env: f.io.env })).matches, false);
});

test('panel-only and rollback dry-runs also consume a populated read-only plan', async (t) => {
  const f = await fixture(t);
  assert.equal(await installerCommand('install', ['--client', 'claude-code'], context(f), f.io), 0);
  assert.equal(await installerCommand('install', ['--client', 'codex'], context(f), f.io), 0);
  f.setVersion('2.0.0');
  assert.equal(await installerCommand('update', ['--client', 'codex'], context(f), f.io), 0);
  const io = { ...f.io, fetch: () => assert.fail('retained operation fetched a release') };
  for (const [command, args] of [['install', ['--panel']], ['update', ['--client', 'codex', '--rollback']]]) {
    const before = await snapshot(f.home);
    const plan = await buildInstallPlan(command, args, context(f), io);
    assert.equal(plan.exitCode, 0);
    assert.equal(plan.clients.length, 1);
    assert.ok(plan.mutations.some((item) => item.kind === 'record'));
    const expected = [];
    renderPlanEvents(plan.events, createPresenter({ write: (line) => expected.push(line) }));
    f.clear();
    assert.equal(await installerCommand(command, [...args, '--dry-run'], context(f), io), 0);
    assert.deepEqual(f.output, expected);
    assert.deepEqual(await snapshot(f.home), before);
  }
});
