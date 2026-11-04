import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { listActors } from '../src/actors.js';
import { doctorCommand } from '../src/doctor/command.js';
import { diagnose } from '../src/doctor/diagnose.js';
import { createPresenter } from '../src/install/present.js';
import { formatEnvironmentReport } from '../src/env/report.js';
import { readiness, readyLine } from '../src/env/ready.js';
import { environmentSnapshot } from '../src/env/snapshot.js';
import { main } from '../src/cli.js';
import { envReportOperation } from '../src/core/status-operations.js';
import { DEFAULT_CONFIG } from '../src/profiles.js';
import { fixture } from './helpers/install-fixture.js';
import { readySnapshot } from './helpers/ready-snapshot.js';

// D96: "is it ready to launch executors?" from one snapshot, for the doctor and for env_report.
//
// | case | must pass | must refuse |
// | every size has a launchable actor on an installed client | ready yes, no gap | a gap |
// | no model confirmed / quota expired / quota not recorded | ready no, the gap names the reason | ready yes |
// | a client that is not installed | optional: never a gap | a gap for it |
// | no client installed at all | ready no, every size a gap | ready yes |
// | the doctor | no file and no telemetry event written | a quota.check record |
// | env_report | still records quota.check | a silent change of telemetry |

const NOW = Date.parse('2026-10-26T12:05:00Z');
const CLIENTS = ['claude-code', 'codex', 'opencode'];
const fresh = { source: 'manual', remainingPct: 80 };

// A real snapshot, with the models listed by the client and the quota read as given.
function readings({ listed = ['m'], small = 'm', quota = fresh, installed = { 'claude-code': true, codex: true, opencode: true } } = {}) {
  return { env: {}, home: '/nonexistent-d96-home', now: () => NOW, cache: new Map(),
    // The effort of each class is the default one: a listing of models confirms a model, and its effort only when the
    // evidence (the saved or default profile of that class) says the same.
    config: { profiles: Object.fromEntries(CLIENTS.map((client) => [client, Object.fromEntries(
      Object.entries({ simple: small, normal: 'm', hard: 'm' }).map(([name, model]) => [name,
        { model, effort: DEFAULT_CONFIG.profiles[client][name].effort }]))])) },
    detectClients: async () => ({ clients: CLIENTS.map((client) => ({ client, installed: true, models: listed, source: 'listing' })) }),
    versions: Object.fromEntries(CLIENTS.map((client) => [client, { installed: installed[client], version: '1.0' }])),
    plugin: { path: 'plugin', onPath: true }, readQuota: async () => quota };
}

const everySize = (reason) => ['S', 'M', 'L'].map((size) => ({ size, reason }));
const OFF = { 'claude-code': false, codex: false, opencode: false };

const CASES = [
  ['every size launchable', {}, true, []],
  ['no model confirmed', { listed: [] }, false, everySize('no-model')],
  ['one size without a model', { small: 'other' }, false, [{ size: 'S', reason: 'no-model' }]],
  ['quota expired', { quota: { ...fresh, expired: true } }, false, everySize('expired-quota')],
  ['quota not recorded', { quota: { source: 'off' } }, false, everySize('no-quota')],
  ['quota low', { quota: { source: 'manual', remainingPct: 1 } }, false, everySize('low')],
  ['two clients not installed are optional', { installed: { ...OFF, 'claude-code': true } }, true, []],
  ['no client installed', { installed: OFF }, false, everySize('no-client')],
];

for (const [name, options, ready, gaps] of CASES) {
  test(`readiness: ${name}`, async () => {
    const snapshot = await environmentSnapshot(readings(options));
    assert.deepEqual(readiness(snapshot), { ready, gaps });
    // The same answer as the canLaunch of the actors that status and env_report show, size by size.
    const { actors } = await listActors({ snapshot, locale: 'en' });
    const launchable = new Set(actors.filter((actor) => actor.canLaunch).flatMap((actor) => actor.sizes));
    assert.deepEqual(gaps.map(({ size }) => size), ['S', 'M', 'L'].filter((size) => !launchable.has(size)));
    for (const locale of ['en', 'pt-BR']) {
      const text = formatEnvironmentReport(snapshot, locale);
      assert.equal(text.split('\n').at(-1), readyLine({ ready, gaps }, locale));
    }
  });
}

// The doctor of an empty installation, with the readers that need a process or a session replaced and the snapshot given.
function readersOf(snapshot, kit = { state: 'absent' }) {
  return { nodeVersion: () => 'v99.0.0', readText: (file) => fs.readFile(file, 'utf8'), servers: async () => [],
    callRead: async () => ({ ok: true }), daemon: async () => ({ running: false }), snapshot, kit: async () => kit };
}

const ROWS = /^\| (Claude Code: (Models|Quota|Modelos|Cota)|Status bar collector|Coletor da barra de status|Kit|Clients|Clientes) \|/;

// The rows of the readiness and the closing line, as the doctor prints them.
async function doctorTail(t, locale, snapshot, extra = {}) {
  const f = await fixture(t);
  f.clear();
  await doctorCommand(f.io, { locale, config: f.io.config, readers: readersOf(snapshot), ...extra });
  return { rows: f.output.filter((line) => ROWS.test(line)), last: f.output.at(-1), output: f.output };
}

const GOLDEN = {
  ready: {
    snapshot: () => readySnapshot(),
    en: ['| Claude Code: Models | confirmed: model-a |', '| Claude Code: Quota | recorded |',
      '| Status bar collector | active |', '| Kit | not found (optional) |'],
    'pt-BR': ['| Claude Code: Modelos | confirmados: model-a |', '| Claude Code: Cota | registrada |',
      '| Coletor da barra de status | ativo |', '| Kit | não encontrado (opcional) |'],
    line: { en: 'Ready to launch executors: yes.', 'pt-BR': 'Pronto para lançar executores: sim.' },
  },
  half: {
    snapshot: () => readySnapshot({ clients: [{ candidates: [[['S', 'M'], []], [['L'], ['expired-quota']]] }] }),
    en: ['| Claude Code: Models | confirmed: model-a |', '| Claude Code: Quota | expired |',
      '| Status bar collector | active |', '| Kit | not found (optional) |'],
    'pt-BR': ['| Claude Code: Modelos | confirmados: model-a |', '| Claude Code: Cota | expirada |',
      '| Coletor da barra de status | ativo |', '| Kit | não encontrado (opcional) |'],
    line: { en: 'Ready to launch executors: no; gaps: L (quota expired).',
      'pt-BR': 'Pronto para lançar executores: não; faltas: L (cota expirada).' },
  },
  empty: {
    snapshot: () => readySnapshot({ clients: [{ installed: false }], collector: { active: false } }),
    en: ['| Clients | no client is installed |', '| Status bar collector | inactive |', '| Kit | not found (optional) |'],
    'pt-BR': ['| Clientes | nenhum cliente está instalado |', '| Coletor da barra de status | inativo |',
      '| Kit | não encontrado (opcional) |'],
    line: { en: 'Ready to launch executors: no; gaps: S (no client installed), M (no client installed), L (no client installed).',
      'pt-BR': 'Pronto para lançar executores: não; faltas: S (nenhum cliente instalado), M (nenhum cliente instalado), L (nenhum cliente instalado).' },
  },
};

for (const [state, golden] of Object.entries(GOLDEN)) {
  for (const locale of ['en', 'pt-BR']) {
    test(`doctor golden: ${state} (${locale})`, async (t) => {
      const { rows, last } = await doctorTail(t, locale, async () => golden.snapshot());
      assert.deepEqual(rows, golden[locale]);
      assert.equal(last, golden.line[locale]);
    });
  }
}

test('the diagnosis carries ready and gaps, and the kit is never a failure', async (t) => {
  const f = await fixture(t);
  const readers = readersOf(async () => GOLDEN.half.snapshot(), { state: 'broken', path: '/kit', reason: 'bad' });
  const result = await diagnose({ ...f.io, records: [], readers, ui: createPresenter({ locale: 'en', write: () => {} }) });
  assert.equal(result.ready, false);
  assert.deepEqual(result.gaps, [{ size: 'L', reason: 'expired-quota' }]);
  assert.equal(result.rows.find((row) => row.id === 'kit').status, 'skipped');
});

test('an empty HOME: the doctor never prompts and still ends in a coherent no with the gaps', async (t) => {
  const f = await fixture(t);
  f.clear();
  await main(['doctor'], f.io);
  assert.match(f.output.at(-1), /^Ready to launch executors: no; gaps: S \(.+\), M \(.+\), L \(.+\)\.$/, f.output.join('\n'));
});

test('doctor: a snapshot that cannot be taken is a warning row and a no, never a crash', async (t) => {
  const { output, last } = await doctorTail(t, 'en', async () => { throw new Error('boom'); });
  assert.ok(output.some((line) => line.startsWith('| Readiness |')), output.join('\n'));
  assert.equal(last, 'Ready to launch executors: no.');
});

// Everything under a folder: the path and the bytes of every file.
async function treeOf(folder) {
  const found = {};
  const walk = async (path) => {
    for (const entry of await fs.readdir(path, { withFileTypes: true }).catch(() => [])) {
      const file = join(path, entry.name);
      if (entry.isDirectory()) { found[`${file}/`] = true; await walk(file); } else found[file] = await fs.readFile(file, 'utf8');
    }
  };
  await walk(folder);
  return found;
}

test('the doctor writes no file and no telemetry event; env_report still records quota.check', async (t) => {
  const f = await fixture(t);
  const file = join(f.root, 'config.json');
  const stored = JSON.parse(await fs.readFile(file, 'utf8'));
  await fs.writeFile(file, JSON.stringify({ ...stored, telemetry: { enabled: true, kitExecutable: 'missing-telemetry-test-kit' } }));
  const before = await treeOf(f.root);
  f.clear();
  await main(['doctor'], f.io);
  await doctorCommand(f.io, { locale: 'en', config: f.io.config, readers: readersOf(async (deps) => environmentSnapshot({
    ...readings(), root: f.root, record: deps.record })) });
  assert.deepEqual(await treeOf(f.root), before, 'the doctor changed the state folder');
  assert.equal((await fs.readdir(f.root)).includes('telemetry'), false, 'the doctor recorded a telemetry event');
  // The same snapshot taken the way env_report takes it records one event per client.
  await envReportOperation(f.root, {}, { ...readings(), config: undefined, env: f.io.env });
  const events = (await fs.readdir(join(f.root, 'telemetry'))).filter((name) => name.endsWith('.json'));
  assert.ok(events.length >= 1, 'env_report no longer records quota.check');
});

test('record: false skips only the quota.check record of the snapshot', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(join(f.root, 'config.json'), JSON.stringify({ telemetry: { enabled: true, kitExecutable: 'missing-telemetry-test-kit' } }));
  await environmentSnapshot({ ...readings(), root: f.root, record: false });
  assert.equal((await fs.readdir(f.root)).includes('telemetry'), false);
  await environmentSnapshot({ ...readings(), root: f.root });
  const events = (await fs.readdir(join(f.root, 'telemetry'))).filter((name) => name.endsWith('.json'));
  assert.equal(events.length, CLIENTS.length);
});

test('readiness: the line in both languages', () => {
  const half = { ready: false, gaps: [{ size: 'L', reason: 'expired-quota' }, { size: 'S', reason: 'no-model' }] };
  assert.equal(readyLine({ ready: true, gaps: [] }), 'Ready to launch executors: yes.');
  assert.equal(readyLine({ ready: true, gaps: [] }, 'pt-BR'), 'Pronto para lançar executores: sim.');
  assert.equal(readyLine(half), 'Ready to launch executors: no; gaps: L (quota expired), S (no model confirmed).');
  assert.equal(readyLine(half, 'pt-BR'), 'Pronto para lançar executores: não; faltas: L (cota expirada), S (nenhum modelo confirmado).');
});
