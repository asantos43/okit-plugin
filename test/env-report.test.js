import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { main } from '../src/cli.js';
import { environmentReadings, environmentReport, formatEnvironmentReport } from '../src/env/report.js';
import { DEFAULT_CONFIG } from '../src/profiles.js';
import { environmentSnapshot } from '../src/env/snapshot.js';
import { statusTable } from '../src/status.js';
import { listActors } from '../src/actors.js';
import { runSetup } from '../src/setup/setup.js';
import { collectStatusline, collectorArgsValid, READING_FILE } from '../src/quota/statusline-collector.js';
import { readJson } from '../src/state.js';
import claudeCode from '../adapters/claude-code/index.js';
import codex from '../adapters/codex/index.js';
import opencode from '../adapters/opencode/index.js';
import { commandWords, planStatusline } from '../src/install/statusline.js';
import { installConfig } from '../src/install/config.js';

const clients = Object.keys(DEFAULT_CONFIG.install.clients);

test('D95 R1: the same model never confirms a changed effort', async () => {
  for (const source of ['catalog', 'listing']) {
    const profiles = { codex: structuredClone(DEFAULT_CONFIG.profiles.codex) };
    const config = { profiles, setup: { done: { profiles: structuredClone(profiles) } } };
    profiles.codex.normal.effort = 'xhigh';
    const deps = readings({ client: 'codex', config,
      readQuota: async () => ({ source: 'manual', remainingPct: 80 }),
      detectClients: async () => ({ clients: [{ client: 'codex', installed: true, source,
        models: [profiles.codex.simple.model] }] }) });
    const snapshot = await environmentSnapshot(deps);
    const changed = snapshot.clients[0].candidates.find((actor) => actor.effort === 'xhigh');
    assert.equal(changed.confirmed, false, source);
    assert.equal(changed.canLaunch, false, source);
    assert.ok(snapshot.clients[0].candidates.some((actor) => actor.confirmed && actor.canLaunch));
    config.setup.done.profiles.codex.normal.effort = 'xhigh';
    const approved = await environmentSnapshot(deps);
    assert.equal(approved.clients[0].candidates.find((actor) => actor.effort === 'xhigh').canLaunch, true);
    if (source === 'listing') {
      delete config.setup;
      const unsaved = await environmentSnapshot(deps);
      assert.equal(unsaved.clients[0].candidates.find((actor) => actor.effort === 'xhigh').confirmed, false);
    }
  }
});

test('D95 R2: absent actors say optional without configuration instructions', async () => {
  const snapshot = await environmentSnapshot(readings({ client: 'codex', versions: { codex: { installed: false } } }));
  for (const locale of ['en', 'pt-BR']) {
    const result = await listActors({ snapshot, client: 'codex', locale });
    assert.deepEqual(result.notes, [locale === 'en' ? 'codex: not installed (optional).' : 'codex: não instalado (opcional).']);
    assert.doesNotMatch(result.markdown, /Check the profiles|Confira os perfis|setup/);
    assert.deepEqual(result.actors, []);
  }
});

// | Command | Must pass | Must refuse |
// | plugin executable + collector subcommand | active/idempotent | replacement |
// | echo or collector mentioned in later arguments | activation + keep bar | active |
test('D95 R3: echo statusline-collector is inactive and installation wraps it', async () => {
  const settings = DEFAULT_CONFIG.statuslineRegistration;
  for (const command of ['echo statusline-collector', 'echo okit-plugin statusline-collector',
    'okit-plugin --previous echo statusline-collector']) {
    const fs = { readFile: async () => Buffer.from(JSON.stringify({ statusLine: { type: 'command', command } })) };
    const snapshot = await environmentSnapshot(readings({ fs }));
    assert.equal(snapshot.plugin.statusline.active, false, command);
    for (const locale of ['en', 'pt-BR']) {
      assert.match(formatEnvironmentReport(snapshot, locale), /install --client claude-code --statusline/);
    }
    const plan = await planStatusline({ client: 'claude-code' }, { fs,
      config: installConfig(), statuslineConfig: settings, env: {}, home: '.', platform: 'linux' });
    assert.ok(plan, command);
    assert.match(JSON.parse(plan.bytes).statusLine.command, /statusline-collector' '--previous'/);
  }
});

test('D95 R4: absent clients contribute no launch capacity', async () => {
  const snapshot = await environmentSnapshot(readings({ versions: { 'claude-code': { installed: true },
    codex: { installed: false }, opencode: { installed: false } } }));
  for (const locale of ['en', 'pt-BR']) {
    const status = await statusTable(undefined, { snapshot, all: true, locale, demands: [] });
    assert.doesNotMatch(status.capacityLine, /codex:|opencode:/);
    assert.match(status.capacityLine, /claude-code: 0\/7/);
    assert.ok(status.markdown.includes('codex |'));
  }
});

test('D95 R5: the three review fragments include English and Portuguese on one line', async () => {
  for (const name of ['d95-optional-clients.fixed.md', 'd95-collector-report.added.md', 'd95-daemon-table-test.fixed.md']) {
    const line = (await readFile(new URL(`../changelog.d/${name}`, import.meta.url), 'utf8')).trim();
    assert.equal(line.split('\n').length, 1);
    const [en, pt] = line.split(' / ');
    assert.ok(en && pt, name);
    assert.match(en, /clients|collector|table/);
    assert.match(pt, /clientes|coletor|tabela/);
  }
});

for (const platform of ['linux', 'darwin', 'win32']) {
  test(`${platform}: absent clients are optional across environment, status, actors and setup`, async (t) => {
    const root = await mkdtemp('.delegate/optional-clients-');
    t.after(() => rm(root, { recursive: true, force: true }));
    const env = platform === 'win32' ? { USERPROFILE: root, LOCALAPPDATA: root } : { HOME: root };
    const deps = readings({ root, home: root, platform, env,
      versions: { 'claude-code': { installed: true }, codex: { installed: false }, opencode: { installed: false } } });
    const snapshot = await environmentSnapshot(deps);
    assert.ok(snapshot.plugin.missing.every((entry) => !['codex', 'opencode'].includes(entry.client)));
    for (const locale of ['en', 'pt-BR']) {
      const optional = locale === 'en' ? 'not installed (optional)' : 'não instalado (opcional)';
      const text = formatEnvironmentReport(snapshot, locale);
      const status = await statusTable(undefined, { snapshot, all: true, locale, demands: [] });
      const actors = await listActors({ snapshot, all: true, locale });
      for (const client of ['codex', 'opencode']) {
        assert.ok(text.includes(`${client}: ${optional}`));
        assert.ok(status.markdown.includes(`| ${client} | - | - | - | ${optional} |`));
        assert.ok(!actors.actors.some((actor) => actor.client === client));
      }
    }

    const setup = await runSetup({ root, snapshot, defaults: true, locale: 'en' });
    assert.ok(setup.changes.length > 0);
    assert.ok(setup.changes.every((entry) => entry.client === 'claude-code'));
    assert.ok(setup.messages.every((line) => !/codex|opencode/.test(line)));
  });
}

// Must pass / must refuse:
// | Evidence | Must pass | Must refuse |
// | saved setup + failed/unconfigured listing | chosen models | implicit defaults, later model edits |
// | live empty/hidden listing | explicit remedy | saved choices overriding the client |
// | absent client, any platform | optional, no setup changes | missing models/quota or launch |
// | registered status bar command | active | inactive from missing install record |
// | missing/unreadable/unrelated status bar | inactive/unknown + install command | active |
// | missing/invalid allowance | record command | invented allowance or launch permission |
for (const platform of ['linux', 'darwin', 'win32']) {
  for (const adapter of [claudeCode, codex, opencode]) {
    test(`${platform}/${adapter.CLIENT}: fresh setup, listing corpus and first quota`, async (t) => {
      const client = adapter.CLIENT;
      const root = await mkdtemp('.delegate/ready-state-');
      t.after(() => rm(root, { recursive: true, force: true }));
      const env = platform === 'win32'
        ? { USERPROFILE: String.raw`C:\Users\Fresh User`, LOCALAPPDATA: String.raw`C:\Users\Fresh User\AppData\Local`, PATH: String.raw`C:\Tools` }
        : { HOME: root, PATH: '/fake/bin' };
      env.CODEX_SESSIONS_DIR = join(root, 'sessions');
      const command = platform === 'win32' ? String.raw`C:\Program Files\Client\models.cmd` : `/fake/bin/${client}`;
      const models = [...new Set(Object.values(DEFAULT_CONFIG.profiles[client]).map((profile) => profile.model))];
      let mode = 'failure';
      const calls = [];
      const run = async (request) => {
        calls.push(request);
        if (mode === 'throws') throw Object.assign(new Error('fixture failure'), { code: 'EINVAL' });
        return { code: mode === 'failure' ? 1 : 0, stdout: mode === 'empty' ? (client === 'opencode' ? '' : '[]')
          : client === 'opencode' ? models.join('\r\n') : JSON.stringify({ models: models.map((slug) => ({ slug, visibility: 'list' })) }) };
      };
      const config = { profiles: { [client]: DEFAULT_CONFIG.profiles[client] },
        setup: { detect: { [client]: { command, args: ['models'],
          parse: client === 'opencode' ? 'lines' : 'json-array' } } } };
      const deps = { root, client, platform, env, run, adapters: [adapter], config,
        plugin: { onPath: true }, versions: { [client]: { installed: true } } };
      await writeFile(join(root, 'config.json'), JSON.stringify(config));
      const before = await environmentSnapshot(deps);
      assert.equal(before.clients[0].evidence.models, 'catalog');
      assert.equal(before.clients[0].actors.length, 0);
      assert.equal(before.clients[0].quota.status, 'off');
      const setup = await runSetup({ ...deps, ask: async () => 'yes', locale: 'both' });
      assert.ok(setup.changes.length > 0);
      assert.ok(setup.messages.some((line) => line.includes(`quota set ${client} <pct>`) && line.includes('Registre')));
      deps.config = await readJson(join(root, 'config.json'));
      let ready = await environmentSnapshot(deps);
      assert.ok(ready.clients[0].candidates.every((actor) => actor.confirmed && !actor.canLaunch));
      for (const locale of ['en', 'pt-BR']) {
        assert.match(formatEnvironmentReport(ready, locale), new RegExp(`quota set ${client} <pct>`));
      }
      for (const outcome of ['success', 'failure', 'throws', 'empty']) {
        mode = outcome;
        ready = await environmentSnapshot(deps);
        const confirmed = outcome !== 'empty' || client === 'opencode';
        assert.equal(ready.clients[0].candidates.every((actor) => actor.confirmed), confirmed, outcome);
      }
      assert.ok(calls.every((request) => request.command === command && request.env === env));
      mode = 'failure';
      deps.config.setup.detect[client].command = null;
      ready = await environmentSnapshot(deps);
      assert.ok(ready.clients[0].candidates.every((actor) => actor.confirmed));
      const hidden = await environmentSnapshot({ ...deps, detectClients: async () => ({ clients: [{
        client, installed: true, source: 'listing', models, hidden: models,
      }] }) });
      assert.ok(hidden.clients[0].candidates.every((actor) => !actor.confirmed));
      const absent = await environmentSnapshot({ ...deps, versions: { [client]: { installed: false } } });
      assert.ok(absent.clients[0].candidates.every((actor) => !actor.confirmed));
      const edited = structuredClone(deps.config);
      for (const profile of Object.values(edited.profiles[client])) profile.model = 'unreviewed-model';
      const changed = await environmentSnapshot({ ...deps, config: edited });
      assert.ok(changed.clients[0].candidates.every((actor) => !actor.confirmed));
      assert.match(formatEnvironmentReport(changed), /setup --again/);
      for (const locale of ['en', 'pt-BR']) {
        const blockedStatus = await statusTable(undefined, { snapshot: changed, client, locale, demands: [] });
        assert.match(blockedStatus.markdown, /okit-plugin setup --again/);
        assert.match(blockedStatus.markdown, new RegExp(`quota set ${client} <pct>`));
      }
      assert.equal(await main(['quota', 'set', client, '80'], { ...deps, stdout: () => {} }), 0);
      ready = await environmentSnapshot(deps);
      assert.equal(ready.clients[0].quota.remainingPct, 80);
      assert.ok(ready.clients[0].candidates.every((actor) => actor.canLaunch));
      const status = await statusTable(undefined, { snapshot: ready, client, demands: [] });
      assert.equal(status.rows[0].remainingPct, 80);
      if (client === 'claude-code') {
        await collectStatusline({ stateRoot: root, input: Buffer.from(JSON.stringify({
          rate_limits: { five_hour: { used_percentage: 25, resets_at: Date.now() / 1000 + 3600 } },
        })) });
        const collected = await environmentSnapshot(deps);
        assert.equal(collected.clients[0].quota.source, 'automatic');
        assert.equal(collected.clients[0].quota.remainingPct, 75);
      }
    });
  }
}

test('status bar registration is read from settings, with a command when inactive or unknown', async () => {
  const corpus = [
    [{ statusLine: { type: 'command', command: 'okit-plugin statusline-collector' } }, true],
    [{ statusLine: { type: 'command', command: '"plugin path/okit" statusline-collector --previous echo hello' } }, true],
    [{ statusLine: { type: 'command', command: String.raw`"C:\Program Files\okit-plugin.cmd" statusline-collector` } }, true],
    [{ statusLine: { type: 'command', command: 'node src/cli.js statusline-collector' } }, true],
    [{ statusLine: { type: 'command', command: 'node /old/plugin.js statusline-collector' } }, true],
    [{ statusLine: { type: 'command', command: 'echo hello' } }, false],
    [{ statusLine: { type: 'prompt', command: 'okit-plugin statusline-collector' } }, false],
    [{}, false], [null, false], ['broken JSON', null], ['EACCES', null],
  ];
  for (const platform of ['linux', 'darwin', 'win32']) {
    for (const [settings, expected] of corpus) {
      const fs = { readFile: async (path) => {
        assert.ok(path.endsWith('settings.json'));
        if (settings === null || settings === 'EACCES') throw Object.assign(new Error(), { code: settings === null ? 'ENOENT' : 'EACCES' });
        return typeof settings === 'string' ? settings : JSON.stringify(settings);
      } };
      const snapshot = await environmentSnapshot(readings({ platform, fs, home: '.delegate/collector-home' }));
      assert.equal(snapshot.plugin.statusline.active, expected);
      for (const locale of ['en', 'pt-BR']) {
        const line = formatEnvironmentReport(snapshot, locale).split('\n').find((line) => line.includes('statusline-collector'));
        assert.ok(line.includes(locale === 'en' ? expected === null ? 'unknown' : expected ? 'active' : 'inactive' : expected === null ? 'desconhecida' : expected ? 'ativo' : 'inativo'));
        assert.equal(line.includes('okit-plugin install --client claude-code --statusline'), expected !== true);
      }
    }
  }
});

test('D97: the report says when the active collector has received no reading yet', async () => {
  const quotaFile = join(resolve('/state'), 'quota', 'claude-code.json');
  const settings = (command) => JSON.stringify({ statusLine: { type: 'command', command } });
  const cases = [
    // [command, the reading file exists, expected phrase in the line]
    ['okit-plugin statusline-collector', false, true],
    ["'C:/bin/okit-plugin' 'statusline-collector'", false, true],
    ['okit-plugin statusline-collector', true, false],
    ['echo hello', false, false],
  ];
  for (const [command, exists, phrase] of cases) {
    const fs = {
      readFile: async () => settings(command),
      stat: async (path) => {
        assert.equal(path, quotaFile);
        if (!exists) throw Object.assign(new Error(), { code: 'ENOENT' });
        return { isFile: () => true };
      },
    };
    const snapshot = await environmentSnapshot(readings({ fs, root: '/state' }));
    assert.equal(snapshot.plugin.statusline.received, command === 'echo hello' ? null : !phrase, command);
    for (const [locale, text] of [['en', 'no reading received yet'], ['pt-BR', 'nenhuma leitura recebida ainda']]) {
      const line = formatEnvironmentReport(snapshot, locale).split('\n').find((item) => item.includes('(statusline-collector)'));
      assert.equal(line.includes(text), phrase, `${locale}: ${command} ${exists}`);
      assert.equal(formatEnvironmentReport(snapshot, locale).split(text).length - 1, phrase ? 1 : 0);
    }
  }
  // A file system that cannot say (not a missing file) adds nothing; so does a collector that is not registered at all.
  for (const code of ['EACCES', 'EIO']) {
    const fs = { readFile: async () => settings('okit-plugin statusline-collector'), stat: async () => { throw Object.assign(new Error(), { code }); } };
    const snapshot = await environmentSnapshot(readings({ fs, root: '/state' }));
    assert.doesNotMatch(formatEnvironmentReport(snapshot, 'en'), /no reading received yet/);
  }
  const absent = { readFile: async () => { throw Object.assign(new Error(), { code: 'ENOENT' }); }, stat: async () => { throw Object.assign(new Error(), { code: 'ENOENT' }); } };
  assert.doesNotMatch(formatEnvironmentReport(await environmentSnapshot(readings({ fs: absent, root: '/state' })), 'en'), /no reading received yet/);
});

test('D97 I10: the quota file the report looks for is the one the collector writes, whatever the registered client', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'collector-reading-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const settings = JSON.stringify({ statusLine: { type: 'command', command: 'okit-plugin statusline-collector' } });
  const fs = { readFile: async () => settings, stat };
  const received = async (client) => (await environmentSnapshot(readings({ fs, root,
    config: { ...readings().config, statuslineRegistration: { client } } }))).plugin.statusline.received;
  for (const client of ['claude-code', 'codex']) assert.equal(await received(client), false, `${client} before`);
  // The real collector writes one file under quota/, and it is the one the report looks for.
  await collectStatusline({ stateRoot: root, input: Buffer.from(JSON.stringify({
    rate_limits: { five_hour: { used_percentage: 25, resets_at: Date.now() / 1000 + 3600 } } })) });
  assert.deepEqual(await readdir(join(root, 'quota')), [READING_FILE]);
  for (const client of ['claude-code', 'codex']) assert.equal(await received(client), true, `${client} after`);
});

test('D95 R6: a status bar command that is not text is not registered', async () => {
  for (const command of [['okit-plugin', ' ', 'statusline-collector'], { run: 'okit-plugin statusline-collector' }, 7]) {
    const fs = { readFile: async () => JSON.stringify({ statusLine: { type: 'command', command } }) };
    const snapshot = await environmentSnapshot(readings({ fs }));
    assert.equal(snapshot.plugin.statusline.active, false, JSON.stringify(command));
    for (const locale of ['en', 'pt-BR']) {
      assert.match(formatEnvironmentReport(snapshot, locale), /install --client claude-code --statusline/);
    }
  }
});

test('D95 R7: a command named like the subcommand is recognized at the subcommand position', async () => {
  const settings = DEFAULT_CONFIG.statuslineRegistration;
  const command = 'statusline-collector';
  const registered = `${command} ${settings.subcommand}`;
  const fs = { readFile: async () => Buffer.from(JSON.stringify({ statusLine: { type: 'command', command: registered } })) };
  const snapshot = await environmentSnapshot(readings({ fs, command }));
  assert.equal(snapshot.plugin.statusline.active, true);
  const plan = await planStatusline({ client: 'claude-code' }, { fs,
    config: installConfig({ command }), statuslineConfig: settings, env: {}, home: '.', platform: 'linux' });
  assert.equal(plan, null);
});

test('D95 R10: arguments the collector refuses make the command not a registration', async () => {
  const settings = DEFAULT_CONFIG.statuslineRegistration;
  const cases = [
    ['okit-plugin statusline-collector --previous', false], ['okit-plugin statusline-collector --help', false],
    ['okit-plugin statusline-collector --typo', false], ['node src/cli.js statusline-collector --typo', false],
    ['okit-plugin statusline-collector --previous echo hi', true], ['okit-plugin statusline-collector', true],
    ['node src/cli.js statusline-collector --previous echo hi', true],
  ];
  for (const [command, active] of cases) {
    const fs = { readFile: async () => JSON.stringify({ statusLine: { type: 'command', command } }) };
    const snapshot = await environmentSnapshot(readings({ fs }));
    assert.equal(snapshot.plugin.statusline.active, active, command);
    for (const locale of ['en', 'pt-BR']) {
      const line = formatEnvironmentReport(snapshot, locale).split('\n').find((text) => text.includes('(statusline-collector)'));
      assert.equal(line.includes('okit-plugin install --client claude-code --statusline'), !active, `${locale}: ${command}`);
    }
    const deps = { fs, config: installConfig(), statuslineConfig: settings, env: {}, home: '.', platform: 'linux' };
    const plan = await planStatusline({ client: 'claude-code' }, deps);
    if (active) { assert.equal(plan, null, command); continue; }
    // Wrapped like a third-party command: valid, restorable and idempotent.
    const wrapped = JSON.parse(plan.bytes).statusLine.command;
    assert.ok(collectorArgsValid(commandWords(wrapped).slice(2)), wrapped);
    assert.deepEqual(plan.previous, { type: 'command', command });
    const again = await planStatusline({ client: 'claude-code', statusline: { path: plan.path } },
      { ...deps, fs: { readFile: async () => plan.bytes } });
    assert.equal(again, null, wrapped);
  }
});

test('D95 R8: models and actors of a client are confirmed by the choices setup saved', async () => {
  const profiles = { codex: structuredClone(DEFAULT_CONFIG.profiles.codex) };
  const detect = async () => ({ clients: [{ client: 'codex', installed: true, source: 'catalog',
    models: Object.values(profiles.codex).map((profile) => profile.model) }] });
  const base = readings({ client: 'codex', detectClients: detect });
  const saved = await environmentSnapshot({ ...base, config: { profiles,
    setup: { done: { profiles: structuredClone(profiles) } } } });
  const expected = [...new Set(Object.values(profiles.codex).map((profile) => profile.model))];
  assert.deepEqual(saved.clients[0].models, expected);
  assert.ok(saved.clients[0].candidates.every((actor) => actor.confirmed));
  const unsaved = await environmentSnapshot({ ...base, config: { profiles } });
  assert.deepEqual(unsaved.clients[0].models, []);
  assert.ok(unsaved.clients[0].candidates.every((actor) => !actor.confirmed));
});

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
    assert.ok(!absent.plugin.missing.some((item) => item.client === client));
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

test('D95 R9: a disabled (null) profile confirms nothing and never breaks env report or status', async () => {
  const profiles = { codex: { simple: { model: 'model-a', effort: 'low' }, normal: null,
    hard: { model: 'model-c', effort: 'high' } } };
  const saved = { simple: profiles.codex.simple, normal: { model: 'model-b', effort: 'medium' }, hard: profiles.codex.hard };
  const detect = async () => ({ clients: [{ client: 'codex', installed: true, source: 'catalog', models: [] }] });
  const snapshot = await environmentSnapshot({ ...readings({ client: 'codex', detectClients: detect }),
    config: { profiles, setup: { done: { profiles: { codex: saved } } } } });
  assert.deepEqual(snapshot.clients[0].models, ['model-a', 'model-c']);
  assert.ok(snapshot.clients[0].candidates.every((actor) => actor.model !== 'model-b' || !actor.confirmed));
  const root = await mkdtemp(join(tmpdir(), 'okit-null-profile-'));
  try {
    await writeFile(join(root, 'config.json'), JSON.stringify({ profiles: { codex: { normal: null } } }));
    for (const locale of ['en', 'pt-BR']) {
      for (const argv of [['env', 'report'], ['status']]) {
        const output = [];
        const code = await main([...argv, '--client', 'codex', '--locale', locale], {
          ...readings({ detectClients: detect }), config: undefined, root, home: root,
          stdout: (text) => output.push(text), stderr: (text) => output.push(text) });
        assert.equal(code, 0, `${argv} ${locale}: ${output.join('\n')}`);
        assert.doesNotMatch(output.join('\n'), /Cannot read properties/);
      }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('D102: formatEnvironmentReport names an ignored installation record, in both languages', async () => {
  const snapshot = await environmentSnapshot(readings({ plugin: { path: 'p', onPath: true, unreadableRecords: ['/data/install.claude-code.json'] } }));
  assert.match(formatEnvironmentReport(snapshot, 'en'), /Installation record ignored \(not a JSON object\): \/data\/install\.claude-code\.json\./);
  assert.match(formatEnvironmentReport(snapshot, 'pt-BR'), /Registro de instalação ignorado \(não é um objeto JSON\): \/data\/install\.claude-code\.json\./);
  for (const body of ['null', '[]', '1', '"x"']) {
    const root = await mkdtemp(join(tmpdir(), 'okit-bad-record-'));
    try {
      const destination = join(root, 'data');
      const file = join(destination, 'install.claude-code.json');
      await mkdir(destination, { recursive: true });
      await writeFile(file, body);
      // The record is read from install.destination of the saved configuration; the readings are injected except the plugin's own.
      for (const locale of ['en', 'pt-BR']) {
        await writeFile(join(root, 'config.json'), JSON.stringify({ language: locale, install: { destination } }));
        const output = [];
        const code = await main(['env', 'report', '--client', 'codex'], {
          ...readings({ plugin: undefined }), config: undefined, root, home: root, env: { HOME: root },
          stdout: (text) => output.push(text), stderr: (text) => output.push(text) });
        const text = output.join('\n');
        assert.equal(code, 0, `${body} ${locale}: ${text}`);
        assert.doesNotMatch(text, /Cannot read properties/);
        assert.ok(text.includes(file), `${body} ${locale}: the file path\n${text}`);
        assert.match(text, locale === 'pt-BR' ? /Registro de instalação ignorado/ : /Installation record ignored/);
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  }
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
  const root = '.delegate/env-report-test-state';
  await mkdir(root, { recursive: true });
  for (const [locale, language, expected] of [
    ['en', undefined, 'en'], ['pt-BR', undefined, 'pt-BR'],
    ['en', 'pt-BR', 'en'], [null, undefined, 'en'], [null, 'pt-BR', 'pt-BR'],
  ]) {
    const output = [];
    const deps = readings();
    await writeFile(join(root, 'config.json'), JSON.stringify(language ? { language } : {}));
    const code = await main(['env', 'report', '--client', 'codex', ...(locale ? ['--locale', locale] : [])], {
      ...deps, root, home: '.delegate/env-report-test-home',
      env: { LANG: 'pt_BR.UTF-8', CODEX_THREAD_ID: 'session' },
      stdout: (text) => output.push(text), stderr: (text) => output.push(text),
    });
    assert.equal(code, 0, output.join('\n'));
    assert.match(output.join('\n'), expected === 'en' ? /codex \(in use\)/ : /codex \(em uso\)/);
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
