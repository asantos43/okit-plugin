import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { main } from '../src/cli.js';
import { environmentReadings, environmentReport, formatEnvironmentReport } from '../src/env/report.js';
import { DEFAULT_CONFIG } from '../src/profiles.js';
import { environmentSnapshot } from '../src/env/snapshot.js';
import { statusTable } from '../src/status.js';
import { listActors } from '../src/actors.js';

const clients = Object.keys(DEFAULT_CONFIG.install.clients);

test('one injected snapshot agrees across env, status and actors without rereading', async () => {
  let reads = 0;
  const now = () => Date.parse('2026-10-26T12:05:00Z');
  const deps = readings({ client: 'codex', env: { CODEX_THREAD_ID: 'session' }, now,
    limits: { limits: { global: 7 }, byClient: { codex: 2 } },
    readQuota: async () => { reads += 1; return { source: 'automatic', remainingPct: 72,
      provider: 'fixture', recordedAt: '2026-10-26T12:00:00Z' }; } });
  const snapshot = await environmentSnapshot(deps);
  const refuse = () => { throw new Error('must not reread'); };
  for (const locale of ['en', 'pt-BR']) {
    const shared = { snapshot, locale, client: 'codex', demands: [],
      readQuota: refuse, detectClients: refuse, run: refuse };
    const env = await environmentReport(shared);
    const status = await statusTable(undefined, shared);
    const actors = await listActors(shared);
    assert.equal(env.inUse, 'codex');
    assert.deepEqual(status.rows[0].models, env.clients[0].models);
    assert.deepEqual(actors.actors.filter((actor) => actor.confirmed).map((actor) => actor.model), env.clients[0].actors.map((actor) => actor.model));
    assert.deepEqual(status.missing, env.plugin.missing);
    assert.deepEqual(actors.missing, env.plugin.missing);
    assert.equal(actors.actors[0].freeSlots, status.rows[0].slots.available);
    assert.equal(status.rows[0].slots.available, env.clients[0].slots.available);
    for (const quota of [env.clients[0].quota, status.rows[0], actors.actors[0].quota]) {
      assert.equal(quota.source, 'automatic');
      assert.equal(quota.ageMinutes, 5);
    }
    const age = locale === 'en' ? /5 minutes ago/ : /há 5 minutos/;
    assert.match(formatEnvironmentReport(env, locale), age);
    assert.match(status.markdown, age);
    assert.match(actors.markdown, age);
    const catalog = actors.actors.find((actor) => actor.model === 'hidden-model');
    assert.equal(catalog.confirmed, false);
    assert.equal(catalog.canLaunch, false);
  }
  assert.equal(reads, 1);
});

test('unknown and expired quota never authorize confirmed actors', async () => {
  for (const quota of [{ source: 'off' }, { source: 'manual', remainingPct: 90,
    recordedAt: '2026-10-26T10:00:00Z' }]) {
    const snapshot = await environmentSnapshot(readings({ client: 'codex',
      now: () => Date.parse('2026-10-26T12:00:00Z'), readQuota: async () => quota }));
    const actors = await listActors({ snapshot });
    assert.ok(actors.actors.some((actor) => actor.confirmed));
    assert.ok(actors.actors.every((actor) => !actor.canLaunch));
  }
});

test('version and model observations reuse an identical injected probe', async () => {
  let probes = 0;
  const snapshot = await environmentSnapshot({ client: 'codex', env: {}, plugin: {},
    config: { install: { clients: { codex: { executable: 'fixture', versionArgs: ['models'] } } } },
    fs: { readFile: async () => { throw Object.assign(new Error(), { code: 'ENOENT' }); } },
    run: async () => { probes += 1; return { code: 0, stdout: 'active-model' }; },
    detectClients: async ({ run, env }) => {
      const result = await run({ command: 'fixture', args: ['models'], env });
      return { clients: [{ client: 'codex', installed: true, source: 'listing', models: [result.stdout] }] };
    } });
  assert.equal(probes, 1);
  assert.deepEqual(snapshot.clients[0].models, ['active-model']);
});

test('quota set refreshes the injected cache and show consumes its sample', async (t) => {
  const root = await mkdtemp('.delegate/quota-snapshot-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const now = () => Date.parse('2026-10-26T12:00:00Z');
  const quotaCache = new Map([[`${root}\ncodex`, { at: now(), reading: { source: 'manual', remainingPct: 10 } }]]);
  const output = [];
  const io = { root, quotaCache, now, env: { HOME: root, CODEX_HOME: `${root}/codex` },
    plugin: {}, versions: {}, detectClients: async () => ({ clients: [] }),
    stdout: (text) => output.push(text) };
  assert.equal(await main(['quota', 'set', 'codex', '73'], io), 0);
  assert.equal(quotaCache.get(`${root}\ncodex`).reading.remainingPct, 73);
  output.length = 0;
  assert.equal(await main(['quota', 'show', 'codex'], io), 0);
  assert.match(output[0], /"remainingPct":73/);
  assert.match(output[0], /manual.*0 minutes ago/);
});

test('shared runtime readings use configured version commands and the selected client', async () => {
  const calls = [];
  const report = await environmentReadings({ config: { install: { clients: {
    codex: { executable: 'chosen-executable', versionArgs: ['chosen-version-flag'] },
  } } }, client: 'codex', env: {}, home: '.', plugin: { path: 'chosen-plugin' },
  fs: { readFile: async () => { throw Object.assign(new Error(), { code: 'ENOENT' }); } },
  run: async (command) => { calls.push(command); return { code: 0, stdout: 'read-version\n' }; } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'chosen-executable');
  assert.deepEqual(calls[0].args, ['chosen-version-flag']);
  assert.deepEqual(report.versions, { codex: { installed: true, version: 'read-version' } });
  assert.deepEqual(report.plugin, { path: 'chosen-plugin' });
});
function readings(extra = {}) {
  return { root: 'state-from-settings', env: {},
    config: { profiles: Object.fromEntries(clients.map((client) => [client, {
      simple: { model: 'active-model', effort: 'low' }, normal: { model: 'hidden-model', effort: 'medium' },
      hard: { model: 'active-model', effort: 'low' },
    }])), limits: { global: 7 } },
    detectClients: async () => ({ clients: clients.map((client) => ({ client, installed: true,
      models: ['active-model'], hidden: ['hidden-model'], source: 'listing' })) }),
    versions: Object.fromEntries(clients.map((client) => [client, { version: 'read-version' }])),
    plugin: { path: 'plugin-from-reading', onPath: true },
    readQuota: async () => ({ source: 'off' }),
    ...extra };
}

// Must pass / must refuse:
// | Reading | Must pass | Must refuse |
// | active listing | active models, configured sizes | hidden/catalog models |
// | hidden model also listed | visible models and actors | hidden model in either list |
// | occupied slots above cap | zero free slots | negative free slots |
// | partially covered sizes | missing sizes and bilingual remedy | silent missing sizes |
// | current client | first row even if unconfigured | dropping that client |
// | missing reading | unknown and remedy | invented quota/version or error codes |

for (const client of clients) {
  test(`${client}: installed and absent readings`, async () => {
    const report = await environmentReport(readings({ client }));
    assert.equal(report.clients.length, 1);
    const row = report.clients[0];
    assert.equal(row.installed, true);
    assert.equal(row.version, 'read-version');
    assert.deepEqual(row.models, ['active-model']);
    assert.deepEqual(row.actors.map((actor) => actor.sizes), [['S', 'L']]);
    assert.deepEqual(row.slots, { total: 7, available: 7 });
    const absent = await environmentReport(readings({ client,
      detectClients: async () => ({ clients: [{ client, installed: false, models: [], source: 'catalog' }] }),
      versions: {},
    }));
    assert.equal(absent.clients[0].installed, false);
    assert.deepEqual(absent.clients[0].actors, []);
    assert.match(formatEnvironmentReport(absent), /not installed/);
    assert.ok(absent.plugin.missing.some((item) => item.client === client && item.command === 'okit-plugin setup'));
  });
}

test('hidden models in an injected listing are excluded from models and actors', async () => {
  const report = await environmentReport(readings({ client: 'codex',
    detectClients: async () => ({ clients: [{ client: 'codex', installed: true,
      models: ['active-model', 'hidden-model'], hidden: ['hidden-model'], source: 'listing' }] }),
  }));
  assert.deepEqual(report.clients[0].models, ['active-model']);
  assert.deepEqual(report.clients[0].actors.map((actor) => actor.model), ['active-model']);
});

test('all three clients remain visible, with the current unconfigured client first', async () => {
  for (const [client, marker] of [['claude-code', 'CLAUDECODE'], ['codex', 'CODEX_THREAD_ID'], ['opencode', 'OPENCODE']]) {
    const deps = readings({ env: { [marker]: 'session' } });
    deps.config.profiles = { [clients.find((name) => name !== client)]: deps.config.profiles[client] };
    const report = await environmentReport(deps);
    assert.equal(report.clients[0].client, client);
    assert.equal(report.clients[0].inUse, true);
    assert.deepEqual(new Set(report.clients.map((row) => row.client)), new Set(clients));
  }
});

test('plain bilingual text shows unknown quota, locations and commands for missing items', async () => {
  const report = await environmentReport(readings({ plugin: { path: 'read-plugin', onPath: false } }));
  for (const [locale, unknown, missing] of [['en', 'unknown', 'Missing'], ['pt-BR', 'desconhecida', 'Falta']]) {
    const text = formatEnvironmentReport(report, locale);
    assert.ok(text.includes(unknown));
    assert.ok(text.includes(missing));
    assert.match(text, /okit-plugin setup/);
    assert.match(text, /read-plugin/);
    assert.match(text, /state-from-settings/);
    assert.match(text, /okit-plugin install --client/);
    assert.doesNotMatch(text, /ENOENT|D\d+|lowQuotaPct|source|catalog|hidden-model|undefined|NaN/);
  }
});

test('quota, renewal and occupied slots reuse the status readings', async () => {
  let reads = 0;
  const report = await environmentReport(readings({ client: 'codex',
    limits: { limits: { global: 9, clients: { codex: 5 } }, byClient: { codex: 2 } },
    readQuota: async () => { reads += 1; return { remainingPct: 62, resetsInMinutes: 17, source: 'manual' }; },
  }));
  assert.equal(reads, 1);
  assert.deepEqual(report.clients[0].slots, { total: 5, available: 3 });
  assert.match(formatEnvironmentReport(report), /62%; renews in: 17 minutes/);
});

test('occupied slots above the cap leave zero available slots', async () => {
  const report = await environmentReport(readings({ client: 'codex',
    limits: { limits: { global: 9, clients: { codex: 5 } }, byClient: { codex: 8 } },
  }));
  assert.deepEqual(report.clients[0].slots, { total: 5, available: 0 });
  assert.match(formatEnvironmentReport(report, 'en'), /Free slots: 0 of 5\./);
});

test('missing items are natural sentences in both languages without changing the object', async () => {
  const report = await environmentReport(readings({ client: 'codex', plugin: { onPath: false },
    detectClients: async () => ({ clients: [] }) }));
  const before = structuredClone(report);
  assert.match(formatEnvironmentReport(report, 'en'), /Missing: the command is not in PATH\. Run okit-plugin install --client codex\./);
  assert.match(formatEnvironmentReport(report, 'en'), /Missing: no active model confirmed for codex\. Run okit-plugin setup\./);
  assert.match(formatEnvironmentReport(report, 'pt-BR'), /Falta: o comando não está no PATH\. Rode okit-plugin install --client codex\./);
  assert.match(formatEnvironmentReport(report, 'pt-BR'), /Falta: nenhum modelo ativo confirmado para codex\. Rode okit-plugin setup\./);
  assert.match(formatEnvironmentReport(report, 'pt-BR'), /Falta: a escolha de modelos ainda não foi salva\./);
  assert.deepEqual(report, before);
});

test('partially covered sizes have a remedy in the object and both languages', async () => {
  const deps = readings({ client: 'codex', command: 'chosen-command' });
  deps.config.actors = { sizeClasses: { S: 'simple', M: 'normal', L: 'hard', XL: 'normal' } };
  const report = await environmentReport(deps);
  assert.deepEqual(report.clients[0].models, ['active-model']);
  assert.deepEqual(report.clients[0].actors.map((actor) => actor.sizes), [['S', 'L']]);
  assert.deepEqual(report.plugin.missing.find((entry) => entry.item === 'sizes'), {
    item: 'sizes', client: 'codex', sizes: ['M', 'XL'], command: 'chosen-command setup',
  });
  assert.match(formatEnvironmentReport(report, 'en'),
    /Missing: no model configured for sizes M, XL in codex\. Run chosen-command setup\./);
  assert.match(formatEnvironmentReport(report, 'pt-BR'),
    /Falta: nenhum modelo configurado para os tamanhos M, XL em codex\. Rode chosen-command setup\./);
});

test('catalog fallback never claims active models; saved setup and command are respected', async () => {
  const deps = readings({ command: 'chosen-command',
    detectClients: async () => ({ clients: clients.map((client) => ({ client,
      installed: null, models: ['active-model'], source: 'catalog' })) }),
  });
  const pending = await environmentReport(deps);
  assert.ok(pending.clients.every((row) => row.models.length === 0 && row.actors.length === 0));
  assert.equal(pending.plugin.missing[0].command, 'chosen-command setup');
  deps.config.setup = { done: true };
  const done = await environmentReport(deps);
  assert.ok(done.plugin.configured.includes('setup'));
  assert.ok(!done.plugin.missing.some((item) => item.item === 'setup'));
});

test('CLI reports both locales and system language with injected readings', async () => {
  for (const locale of ['en', 'pt-BR', null]) {
    const output = [];
    const deps = readings();
    const code = await main(['env', 'report', '--client', 'codex', ...(locale ? ['--locale', locale] : [])], {
      ...deps, root: '.delegate/env-report-test-state', home: '.delegate/env-report-test-home',
      env: { LANG: 'pt_BR.UTF-8', CODEX_THREAD_ID: 'session' },
      stdout: (text) => output.push(text), stderr: (text) => output.push(text),
    });
    assert.equal(code, 0, output.join('\n'));
    assert.match(output.join('\n'), locale === 'en' ? /codex \(in use\)/ : /codex \(em uso\)/);
    assert.doesNotMatch(output.join('\n'), /claude-code:|opencode:/);
  }
});

test('unknown client gets a simple sentence and exit code one in either language', async () => {
  for (const locale of ['en', 'pt-BR']) {
    const output = [];
    const code = await main(['env', 'report', '--client', 'unknown', '--locale', locale], {
      root: '.delegate/env-report-test-state', env: {}, stdout: (text) => output.push(text), stderr: (text) => output.push(text),
    });
    assert.equal(code, 1);
    assert.equal(output.length, 1);
    assert.equal(output[0], formatEnvironmentReport(await environmentReport({ client: 'unknown' }), locale));
    assert.doesNotMatch(output[0], /Usage|TypeError|D\d+|ENOENT/);
  }
});
