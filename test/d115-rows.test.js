import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile, rm, readdir, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loginState } from '../src/accounts-login.js';
import { environmentSnapshot } from '../src/env/snapshot.js';
import { readiness, readyLine } from '../src/env/ready.js';
import { readinessRows } from '../src/doctor/ready-rows.js';
import { listActors } from '../src/actors.js';
import { statusTable } from '../src/status.js';
import { formatEnvironmentReport } from '../src/env/report.js';
import { respond } from '../src/mcp/server.js';
import { TOOLS } from '../src/mcp/tools.js';

const missing = () => Object.assign(new Error('missing'), { code: 'ENOENT' });
function disk({ absent = [], config = '', denied = false } = {}) {
  const calls = [];
  return { calls, async stat(path) { calls.push(['stat', path]);
    if (denied) throw Object.assign(new Error('denied'), { code: 'EACCES' });
    if (absent.some((part) => path.includes(part))) throw missing();
    return { isFile: () => true }; },
  async readFile(path) { calls.push(['readFile', path]);
    assert.ok(!/auth\.json|\.credentials\.json/.test(path), 'credential content must never be read');
    if (path.endsWith('config.toml')) return config;
    throw missing(); } };
}

// Must pass: marker present, unknown Keychain/keyring, isolated cache and slots.
// Must refuse: absent marker, cross-account cache reuse, secrets in output.
test('login corpus: platform, store, missing home and no credential reads', async () => {
  for (const platform of ['linux', 'win32', 'darwin']) {
    for (const client of ['claude-code', 'codex']) {
      for (const present of [true, false]) {
        const fs = disk({ absent: present ? [] : ['auth.json', '.credentials.json'] });
        const result = await loginState({ client, platform, env: {}, home: '', fs });
        assert.equal(result, platform === 'darwin' && client === 'claude-code' ? 'unknown' : present ? 'logged-in' : 'logged-out');
        assert.ok(fs.calls.every(([method, path]) => method === 'stat' || path.endsWith('config.toml')));
      }
    }
  }
  for (const store of ['keyring', 'auto', 'other']) {
    const fs = disk({ config: `cli_auth_credentials_store = "${store}"` });
    assert.equal(await loginState({ client: 'codex', fs, home: '', env: {} }), 'unknown');
    assert.equal(fs.calls.length, 1);
  }
  assert.equal(await loginState({ client: 'codex', fs: disk({ denied: true }), env: {}, home: '' }), 'unknown');
  const fs = disk();
  await loginState({ client: 'claude-code', fs, platform: 'linux', home: '', env: { CLAUDE_CONFIG_DIR: 'configured' } });
  assert.deepEqual(fs.calls, [['stat', join('configured', '.credentials.json')]]);
});

function deps({ single = false, fs = disk(), env = {}, quota, limits = {} } = {}) {
  return { env, home: '', platform: 'linux', fs, now: () => 1800000000000, record: false,
    config: { accounts: single ? {} : { 'claude-code': [{ id: 'work', label: 'Producer', configDir: '/work' }] },
      profiles: { 'claude-code': { simple: { model: 'm' }, normal: { model: 'm' }, hard: { model: 'm' } } } },
    client: 'claude-code', plugin: { onPath: true, path: 'plugin' },
    versions: { 'claude-code': { installed: true, version: '1' } },
    detectClients: async () => ({ clients: [{ client: 'claude-code', installed: true, models: ['m'], source: 'listing' }] }),
    limits: { byClient: limits }, cache: new Map(),
    readQuota: quota ?? (async (_client, account) => ({ source: 'manual', remainingPct: account === 'work' ? 80 : 1 })) };
}

test('snapshot isolates quota cache, slots, candidates and default fields', async () => {
  const calls = [];
  const input = deps({ limits: { 'claude-code': 1, 'claude-code:work': 0 }, quota: async (client, account) => {
    calls.push([client, account ?? 'default']); return { source: 'manual', remainingPct: account === 'work' ? 80 : 1 };
  } });
  const snapshot = await environmentSnapshot(input);
  await environmentSnapshot(input);
  const row = snapshot.clients[0], [personal, work] = row.accounts;
  assert.deepEqual(calls, [['claude-code', 'default'], ['claude-code', 'work']]);
  assert.equal(input.cache.size, 2);
  assert.equal(personal.quota.remainingPct, 1);
  assert.equal(work.quota.remainingPct, 80);
  assert.equal(work.slots.available, personal.slots.available + 1);
  for (const key of ['quota', 'slots', 'candidates', 'actors', 'sizeCoverage', 'reading', 'quotaReadAt', 'slotEvidence']) assert.deepEqual(row[key], personal[key]);
  assert.ok(work.candidates.some((actor) => actor.canLaunch));
  assert.equal(readiness(snapshot).ready, true);
  assert.deepEqual(readiness(snapshot).accounts, [{ client: 'claude-code', ready: 1, total: 2 }]);
});

test('logged-out account restricts candidates and environment warning never exposes its value', async () => {
  const snapshot = await environmentSnapshot(deps({ fs: disk({ absent: ['/work'] }),
    env: { ANTHROPIC_API_KEY: 'secret-value', CLAUDE_CODE_OAUTH_TOKEN: 'other-secret' } }));
  const [personal, work] = snapshot.clients[0].accounts;
  assert.equal(work.login, 'logged-out');
  // A credential variable in the environment authenticates the run whatever the marker says: no login restriction.
  assert.ok(work.candidates.every((actor) => !actor.restrictions.includes('not-logged-in')));
  assert.ok(work.candidates.some((actor) => actor.canLaunch));
  // The warnings of the environment belong to the client: they ride on the default's row, once.
  assert.deepEqual(work.warnings, []);
  assert.deepEqual(personal.warnings.map((warning) => warning.variable), ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']);
  assert.equal(readiness(snapshot).accounts[0].ready, 1);
  for (const locale of ['en', 'pt-BR']) {
    const text = formatEnvironmentReport(snapshot, locale);
    assert.match(text, /ANTHROPIC_API_KEY/);
    assert.ok(!text.includes('secret'));
  }
});

test('logged-out account without a credential variable restricts its candidates', async () => {
  const snapshot = await environmentSnapshot(deps({ fs: disk({ absent: ['/work'] }), env: {} }));
  const [, work] = snapshot.clients[0].accounts;
  assert.equal(work.login, 'logged-out');
  assert.ok(work.candidates.every((actor) => !actor.canLaunch && actor.restrictions.includes('not-logged-in')));
  assert.equal(readiness(snapshot).accounts[0].ready, 0);
});

test('two accounts and implicit default: doctor, actors, status, env_report and ready in both locales', async () => {
  for (const single of [true, false]) {
    const snapshot = await environmentSnapshot(deps({ single }));
    for (const locale of ['en', 'pt-BR']) {
      const doctor = readinessRows({ snapshot, ui: { locale }, program: 'okit-plugin' });
      assert.equal(doctor.rows.filter((row) => row.id === 'quota').length, single ? 1 : 2);
      const actors = await listActors({ snapshot, locale, all: true });
      const status = await statusTable('', { snapshot, locale, all: true, demands: [] });
      assert.equal(status.rows.length, single ? 1 : 2);
      const report = formatEnvironmentReport(snapshot, locale);
      for (const text of [actors.markdown, status.markdown, report]) {
        assert.equal(text.includes('Producer (work)'), !single);
      }
      assert.equal(readyLine(doctor, locale).includes('1/2'), !single);
      if (single) {
        const legacy = { ...snapshot, clients: snapshot.clients.map(({ accounts: _accounts, ...row }) => row) };
        assert.equal(report, formatEnvironmentReport(legacy, locale));
        assert.equal(actors.markdown, (await listActors({ snapshot: legacy, locale, all: true })).markdown);
        assert.equal(status.markdown, (await statusTable('', { snapshot: legacy, locale, all: true, demands: [] })).markdown);
        assert.deepEqual(doctor, readinessRows({ snapshot: legacy, ui: { locale }, program: 'okit-plugin' }));
      }
    }
  }
});

test('MCP golden for two accounts, kept separate from the existing contract', async () => {
  const snapshot = await environmentSnapshot(deps());
  const actual = {};
  actual.accountTools = TOOLS.filter((tool) => ['quota_set', 'quota_show', 'acquire_slot', 'limits_status'].includes(tool.name))
    .map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
  for (const locale of ['en', 'pt-BR']) for (const name of ['status', 'actors_list', 'env_report']) {
    const frame = await respond({ jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name, arguments: { locale, client: 'claude-code' } } },
    { tools: TOOLS, ctx: { snapshot, config: snapshot.config, root: '', demands: [], orders: [] }, version: 'test' });
    assert.equal(frame.result.isError, false);
    actual[`${name}/${locale}`] = frame;
  }
  const file = new URL('./fixtures/d115-mcp-golden.json', import.meta.url);
  if (process.env.GOLDEN_UPDATE === '1') await writeFile(file, `${JSON.stringify(actual, null, 2)}\n`);
  assert.deepEqual(actual, JSON.parse(await readFile(file, 'utf8')));
});

test('quota.check records account only for non-default accounts', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'd115-rows-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'config.json'), JSON.stringify({ telemetry: { enabled: true, kitExecutable: 'missing-d115-kit' } }));
  await environmentSnapshot({ ...deps(), root, record: true });
  const files = (await readdir(join(root, 'telemetry'))).filter((file) => file.endsWith('.json'));
  const events = await Promise.all(files.map(async (file) => JSON.parse(await readFile(join(root, 'telemetry', file), 'utf8'))));
  const serialized = JSON.stringify(events);
  assert.match(serialized, /quota.check/);
  const attributes = events.flatMap((event) => event.resourceMetrics.flatMap((resource) => resource.scopeMetrics
    .flatMap((scope) => scope.metrics.flatMap((metric) => metric.sum.dataPoints.flatMap((point) => point.attributes)))));
  assert.deepEqual(attributes.filter((attribute) => attribute.key === 'account'), [{ key: 'account', value: { stringValue: 'work' } }]);
});

test('the snapshot reads each account through the real quota reader (the reader takes the id, never the account)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'd115-real-reader-'));
  try {
    const now = 1800000000000;
    const quota = join(root, 'quota');
    await mkdir(quota, { recursive: true });
    for (const [file, remainingPct] of [['claude-code.json', 12], ['claude-code.work.json', 88]]) {
      await writeFile(join(quota, file), JSON.stringify({ remainingPct, windowMinutes: 300, recordedAt: new Date(now - 1000).toISOString() }));
    }
    const input = { ...deps(), root, readQuota: undefined, cache: new Map() };
    const [personal, work] = (await environmentSnapshot(input)).clients[0].accounts;
    assert.equal(personal.quota.remainingPct, 12);
    assert.equal(work.quota.remainingPct, 88);
    assert.equal(input.cache.size, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('round 14: an uninstalled client with several accounts gets one note in actors', async () => {
  const snapshot = await environmentSnapshot(deps());
  const uninstalled = { ...snapshot, clients: snapshot.clients.map((row) => ({ ...row, installed: false,
    accounts: row.accounts?.map((account) => ({ ...account, installed: false })) })) };
  assert.ok((uninstalled.clients[0].accounts?.length ?? 0) > 1, 'the fixture has more than one account');
  const actors = await listActors({ snapshot: uninstalled, locale: 'en', all: true });
  const notes = actors.markdown.split('\n').filter((line) => line.includes('not installed (optional)'));
  assert.equal(notes.length, 1, actors.markdown);
});
