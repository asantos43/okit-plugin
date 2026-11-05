import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { diagnose } from '../src/doctor/diagnose.js';
import { installNodes, problemOf } from '../src/config-schema.js';
import { installConfig } from '../src/install/config.js';
import { createPresenter, localizeReason, REASONS } from '../src/install/present.js';
import { RULE_PHRASES } from '../src/install/rules.js';
import { registerMcp } from '../src/install/mcp-register.js';
import { executionPolicyStep } from '../src/install/policy.js';
import { mcpStep, register } from '../src/install/register.js';
import { selfCheck } from '../src/install/selfcheck.js';
import { runClientSmoke } from '../src/smoke/client.js';
import { runDemo } from '../src/smoke/demo/index.js';
import { reportText } from '../src/smoke/demo/report.js';
import { readJson } from '../src/state.js';
import { offerSetup } from '../src/setup/offer.js';
import { configOf, CONFIG_MESSAGES } from '../src/profiles.js';
import { actorPairs } from '../src/env/snapshot.js';
import { fixture } from './helpers/install-fixture.js';
import { readySnapshot } from './helpers/ready-snapshot.js';

// D122: the reason of a caught error is told in the language of the run.
//
// One helper (`localizeReason`, src/install/present.js) and one class of place: a reason
// that is put into a localized message. A reason that the catalog knows is translated; a
// system error that it does not know stays as the system said it; the English output is the
// same as before, byte for byte.
//
// | case | must pass | must refuse |
// | a known reason, in pt-BR | 'permissão negada' | the English reason in the same text |
// | the same reason, in en | 'permission denied' | the Portuguese reason |
// | a system error that is not a reason | the text of the system | a translation of it |
//
// Every site is reached without a network and without a real credential: the failure is
// injected through the seams the modules already have (the reader of the question, the
// runner of the process, the file system of the module and the adapter of the client).

const CONFIG = installConfig({});
const RECORD = { client: 'claude-code', path: join('/opt', 'okit-plugin', '1.0.0-claude-code') };
const REPO = fileURLToPath(new URL('../', import.meta.url));
const DENIED = 'permission denied';
const PT = 'permissão negada';
const ADAPTERS = [{ CLIENT: 'codex',
  listModels: async () => ({ client: 'codex', installed: true, models: ['sol', 'astra'], source: 'listing' }) }];
/** The process of the probe of the MCP server (the one of the installation, never the shell of a check). */
const isProbe = (spec) => (spec.args ?? []).some((argument) => String(argument).endsWith('selfcheck-probe.js'));

/** A presenter of the run and the lines it wrote. */
function presenter(locale, { verbose = false } = {}) {
  const lines = [];
  const ui = createPresenter({ locale, verbose, write: (line) => lines.push(line) });
  return { ui, lines, text: () => lines.join('\n') };
}

/** A folder of the state for one run of the offer, removed at the end. */
async function withRoot(fn) {
  const root = await fs.mkdtemp(join(tmpdir(), 'd122-offer-'));
  try { return await fn(root); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}

/** The offer of the setup without the presenter (the text of the run). */
async function offerText(locale, root, ask, adapters) {
  const lines = [];
  await offerSetup({ root, locale, command: 'okit-plugin', tty: true, ask, adapters,
    out: (line) => lines.push(line) });
  return lines.join('\n');
}

/** The offer of the setup through the presenter (the row of the run). */
async function offerRowText(locale, root, ask) {
  const { ui, lines } = presenter(locale);
  await offerSetup({ root, locale, command: 'okit-plugin', tty: true, ask, ui });
  return lines.join('\n');
}

/** A reader that answers once and then refuses: the setup is asked again and fails. */
function asking(refuse) {
  let asked = 0;
  return async () => {
    asked += 1;
    if (asked === 1) return 'yes';
    throw refuse();
  };
}

/** The settings of an installer whose MCP block cannot be read at all. */
const brokenConfig = () => ({ ...CONFIG, get mcp() { throw new Error(DENIED); } });

/** The row of the session of the doctor: the detail of a control failure (`controlReason`). */
async function doctorSessionText(locale, t) {
  const f = await fixture(t);
  const result = await diagnose({ ...f.io, root: f.root, records: [],
    ui: createPresenter({ locale, write: () => {} }),
    readers: { nodeVersion: () => 'v99.0.0', readText: (file) => fs.readFile(file, 'utf8'),
      servers: async () => [{ pid: 1, startedAt: 0 }],
      callRead: async () => ({ ok: false, code: 'failed', error: DENIED }),
      daemon: async () => ({ running: false }), snapshot: async () => readySnapshot(),
      kit: async () => ({ state: 'absent' }) } });
  return result.rows.find((row) => row.id === 'session').detail;
}

/** The row of the probe of the MCP server: the reason of a probe that could not start (`probeReason`). */
async function probeReasonText(locale, t, error = { code: 'start-failed', why: DENIED }) {
  const home = await fs.mkdtemp(join(tmpdir(), 'd122-probe-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const temporary = join(home, 'tmp');
  await fs.mkdir(temporary);
  const answer = { mcp: { ok: false, tools: 0, error }, api: { ok: false, error: null } };
  const deps = { config: installConfig({}), fs,
    run: async (spec) => (isProbe(spec) ? { stdout: `${JSON.stringify(answer)}\n` } : { stdout: '' }),
    env: { HOME: home, OKWORK_HOME: join(home, 'real-state') }, platform: 'linux', out: () => {},
    statuslineConfig: configOf({}).statuslineRegistration, collectorConfig: configOf({}).statuslineCollector,
    destination: join(home, 'data'), home, bin: join(home, 'bin'), temporary, root: join(home, 'state'),
    clientRoot: join(home, 'client'), now: () => 1700000000000,
    ui: createPresenter({ locale, write: () => {} }) };
  const record = { client: 'claude-code', path: REPO, version: '1.0.0', destination: deps.destination, link: true };
  const rows = await selfCheck(record, '1.0.0', deps);
  return rows.find((row) => row.id === 'mcp').reason;
}

// The places where a reason of a caught error reaches a message of the run.
const SITES = [
  { name: 'src/setup/offer.js:95 — the question of the offer',
    run: (locale) => withRoot(async (root) => offerText(locale, root,
      async () => { throw new Error(DENIED); })) },
  { name: 'src/setup/offer.js:119 — the setup of the offer',
    run: (locale) => withRoot(async (root) => offerText(locale, root,
      asking(() => new Error(DENIED)), ADAPTERS)) },
  { name: 'src/setup/offer.js:173 — the row of the offer',
    run: (locale) => withRoot(async (root) => offerRowText(locale, root,
      async () => { throw new Error(DENIED); })) },
  { name: 'src/install/mcp-register.js:601 — the failure of the MCP step',
    run: async (locale) => {
      const { ui } = presenter(locale);
      const result = await registerMcp(RECORD, { config: CONFIG, ui,
        run: async () => { throw new Error(DENIED); } }, 'install');
      return result.detail;
    } },
  { name: 'src/install/register.js:117 — the warning of the MCP step',
    run: async (locale) => {
      const { ui, text } = presenter(locale);
      await mcpStep(RECORD, { config: brokenConfig(), ui, out: () => {},
        run: async () => ({}) }, 'install');
      return text();
    } },
  { name: 'src/install/register.js:162 — the role that could not be loaded',
    run: async (locale) => {
      const { ui, text } = presenter(locale, { verbose: true });
      await register(RECORD, { config: CONFIG, ui, platform: 'linux', env: {},
        detect: async () => true, run: async () => ({}),
        loadAdapter: async () => { throw new Error(DENIED); } }, 'install');
      return text();
    } },
  { name: 'src/install/policy.js:40 — the policy that could not be read',
    run: async (locale) => {
      const { ui, text } = presenter(locale, { verbose: true });
      await executionPolicyStep(ui, {}, { config: CONFIG, platform: 'win32', env: {},
        policyExecute: async () => { throw new Error(DENIED); } });
      return text();
    } },
  { name: 'src/install/policy.js:56 — the policy that could not be changed',
    run: async (locale) => {
      const { ui, text } = presenter(locale);
      await executionPolicyStep(ui, { 'set-execution-policy': true }, { config: CONFIG, platform: 'win32', env: {},
        policyExecute: async (_file, args) => {
          if (args.some((word) => word.includes('Set-ExecutionPolicy'))) throw new Error(DENIED);
          return { stdout: 'LocalMachine=Restricted\n' };
        } });
      return text();
    } },
  { name: 'src/smoke/demo/report.js:4 — the reasons of the demo',
    run: async (locale) => reportText({ mode: 'real', events: [], reasons: [DENIED],
      demands: [], status: 'partial' }, locale) },
  { name: 'src/smoke/demo/report.js:20 — the reason of a demand that was skipped',
    run: async (locale) => reportText({ mode: 'test', events: [], reasons: [], status: 'partial',
      demands: [{ title: 'A task', verdict: 'skipped', reworkRounds: 0, costKnown: true, costUsd: 0,
        skipReason: DENIED }] }, locale) },
  { name: 'src/install/present.js:485 — the detail of a control failure (the row of the session)',
    run: (locale, t) => doctorSessionText(locale, t) },
  { name: 'src/install/selfcheck.js:526 — the reason of the probe of the MCP server',
    run: (locale, t) => probeReasonText(locale, t) },
  { name: 'src/install/selfcheck.js:520 — the error of a probe that answered with a text',
    run: (locale, t) => probeReasonText(locale, t, DENIED) },
  { name: 'src/install/selfcheck.js:527 — the code of a probe that is not known',
    run: (locale, t) => probeReasonText(locale, t, { code: DENIED }) },
];

for (const site of SITES) {
  for (const locale of ['en', 'pt-BR']) {
    test(`${site.name} (${locale})`, async (t) => {
      const text = await site.run(locale, t);
      assert.ok(text.length > 0, `${site.name}: nothing was told`);
      if (locale === 'pt-BR') {
        assert.ok(text.includes(PT), `${site.name}: ${text}`);
        assert.ok(!text.includes(DENIED), `${site.name}: ${text}`);
      } else {
        assert.ok(text.includes(DENIED), `${site.name}: ${text}`);
        assert.ok(!text.includes(PT), `${site.name}: ${text}`);
      }
    });
  }
}

test('a system error that is not a reason stays as the system said it', async () => {
  for (const locale of ['en', 'pt-BR']) {
    const { ui } = presenter(locale);
    const result = await registerMcp(RECORD, { config: CONFIG, ui,
      run: async () => { throw new Error('spawn claude ENOENT'); } }, 'install');
    assert.ok(result.detail.includes('spawn claude ENOENT'), result.detail);
    assert.ok(!result.detail.includes('permissão'), result.detail);
  }
});

test('the offer of the two languages tells the reason in the language of each side', async () => {
  const text = await withRoot(async (root) => offerText('both', root,
    async () => { throw new Error(DENIED); }));
  assert.ok(text.includes(`Setup could not run: ${DENIED}.`), text);
  assert.ok(text.includes(`O setup não pôde rodar: ${PT}.`), text);
});

// The demo with helpers of its own: the snapshot of the client, the executor and the critic that answer as the
// test wants. The ledger, the preflight and the run are the real ones (`runDemo` runs them).
function demoWorld({ run, review, quota = { source: 'user', remainingPct: 80, status: 'green', readAt: 1000, ageMinutes: 0 },
  smoke = {} } = {}) {
  const config = configOf({ limits: { global: 1 }, profiles: { codex: {
    simple: { model: 'small', effort: 'low' }, normal: { model: 'medium', effort: 'medium' },
    hard: { model: 'large', effort: 'high' }, critic: { model: 'reviewer', effort: 'high' } } },
    smoke: { ...configOf().smoke, ...smoke } });
  const snapshot = { config, now: 1000, inUse: 'codex', plugin: { missing: [] }, clients: [{
    client: 'codex', quota, reading: {}, slots: { available: 2 }, sizeCoverage: { gaps: [] },
    candidates: actorPairs(config, 'codex').map((pair) => ({ ...pair, confirmed: true, canLaunch: true, restrictions: [] })) }] };
  const usage = { costUsd: 0, tokens: 0, turns: 1 };
  const actor = { maxCostUsd: 0, async run(briefing) {
    if (run) return run(briefing);
    return { status: 'completed', summary: 'done',
      artifacts: briefing.demand.files.map((file, index) => ({ path: briefing.allowedOutputPaths[index], content: file.content })),
      usage };
  } };
  const critic = { maxCostUsd: 0, async review({ briefing, checks }) {
    if (review) return review({ briefing, checks });
    return { verdict: checks.every((check) => check.passed) ? 'approved' : 'rejected', criteria: checks, feedback: '', usage };
  } };
  return { snapshot, actor, critic, clock: () => 1000 };
}

/** The text of the demo in the language of the run: the reasons of the run are told as a real run tells them. */
const demoText = (result, locale) => reportText({ ...result, mode: 'real' }, locale);

test('the demo says the ceiling of the real ledger in the language of the run', async () => {
  for (const locale of ['en', 'pt-BR']) {
    // The real ledger: the tokens of the first work reach the ceiling, so the next reservation refuses.
    const world = demoWorld({ smoke: { maxTokens: 10 },
      run: async (briefing) => ({ status: 'completed', summary: 'done',
        artifacts: briefing.demand.files.map((file, index) => ({ path: briefing.allowedOutputPaths[index], content: file.content })),
        usage: { costUsd: 0, tokens: 10, turns: 1 } }) });
    const result = await runDemo({ ...world, locale });
    const text = demoText(result, locale);
    if (locale === 'pt-BR') {
      assert.ok(text.includes('teto de orçamento ou de voltas'), text);
      assert.ok(!text.includes('budget or turn ceiling'), text);
    } else {
      assert.ok(text.includes('budget or turn ceiling'), text);
    }
  }
});

test('the demo says the refusal of the quota in the language of the run', async () => {
  for (const locale of ['en', 'pt-BR']) {
    // The real preflight: the quota of the client is below the floor of the configuration.
    const world = demoWorld({ quota: { source: 'user', remainingPct: 5, status: 'red', readAt: 1000, ageMinutes: 0 } });
    const result = await runDemo({ ...world, locale });
    assert.ok(result.reasons.includes('quota-below-floor'), result.reasons.join(' / '));
    const text = demoText(result, locale);
    if (locale === 'pt-BR') {
      assert.ok(text.includes('cota abaixo do piso'), text);
      assert.ok(!text.includes('quota-below-floor'), text);
    } else {
      assert.ok(text.includes('quota-below-floor'), text);
    }
  }
});

test('the demo says that the executor did not finish in the language of the run', async () => {
  for (const locale of ['en', 'pt-BR']) {
    // The real run: the helper answers that it did not complete the work.
    const world = demoWorld({ run: async () => ({ status: 'failed', summary: 'not done', artifacts: [],
      usage: { costUsd: 0, tokens: 0, turns: 1 } }) });
    const result = await runDemo({ ...world, locale });
    const text = demoText(result, locale);
    if (locale === 'pt-BR') {
      assert.ok(text.includes('o executor não completou'), text);
      assert.ok(!text.includes('executor did not complete'), text);
    } else {
      assert.ok(text.includes('executor did not complete'), text);
    }
  }
});

test('the demo says the failure of the helper in the language of the run, not the whole bilingual phrase', async () => {
  const phrase = 'The helper exceeded the text allowance. / O ajudante ultrapassou o limite de texto.';
  for (const locale of ['en', 'pt-BR']) {
    // The real driver: the helper answers with the failure it raised.
    const world = demoWorld({ run: async () => { throw new Error(phrase); } });
    const result = await runDemo({ ...world, locale });
    const text = demoText(result, locale);
    if (locale === 'pt-BR') {
      assert.ok(text.includes('O ajudante ultrapassou o limite de texto.'), text);
      assert.ok(!text.includes('The helper exceeded the text allowance'), text);
    } else {
      assert.ok(text.includes('The helper exceeded the text allowance.'), text);
      assert.ok(!text.includes('O ajudante ultrapassou o limite de texto'), text);
    }
  }
});

test('the smoke client says the refusal of the client in the language of the run', async (t) => {
  for (const locale of ['en', 'pt-BR']) {
    const root = await fs.mkdtemp(join(tmpdir(), 'd122-smoke-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await fs.writeFile(join(root, 'config.json'), JSON.stringify({ profiles: { 'claude-code': {
      simple: { model: 's', effort: 'medium' } } }, smoke: {} }));
    const lines = [];
    const result = await runClientSmoke(['--client', 'claude-code'], { root, locale,
      env: { HOME: root, OKWORK_HOME: root, CLAUDE_CONFIG_DIR: join(root, 'real-config') },
      out: (line) => lines.push(line), err: (line) => lines.push(line), now: () => 1700000000000,
      readQuota: async () => ({ source: 'user', remainingPct: 80 }), run: async () => ({ stdout: '1.0.0' }),
      client: async () => { throw new Error(DENIED); } });
    assert.equal(result.code, 2);
    assert.equal(result.reason, 'client-refused');
    const text = lines.join('\n');
    if (locale === 'pt-BR') {
      assert.ok(text.includes(PT), text);
      assert.ok(!text.includes(DENIED), text);
    } else {
      assert.ok(text.includes(DENIED), text);
      assert.ok(!text.includes(PT), text);
    }
  }
});

test('translating a reason twice gives the same text, and a text the catalog does not know is kept', () => {
  const reasons = ['budget or turn ceiling', 'quota needs refresh', 'executor did not complete',
    'run interrupted', 'slot unavailable', 'time ceiling', 'profile turn ceiling', 'rework ceiling',
    'blocked dependencies', 'unsafe artifact', 'quota-unknown', 'quota-below-floor', DENIED];
  for (const reason of reasons) {
    const once = localizeReason(reason, 'pt-BR');
    assert.notEqual(once, reason, `${reason}: no pt-BR text`);
    assert.equal(localizeReason(once, 'pt-BR'), once, `${reason}: translating twice changes the text`);
    assert.equal(localizeReason(reason, 'en'), reason, `${reason}: the English text changed`);
  }
  // A text the catalog does not know stays as it was raised.
  const unknown = 'spawn claude ENOENT: the helper is not on this machine';
  assert.equal(localizeReason(unknown, 'pt-BR'), unknown);
});

// The corpus of the critic: a name of a person that begins with "invalid" is not a reason, and the reason behind a
// label of the demo is told only when the catalog knows it. Translating twice gives the same text, always.
//
// | reason | must pass | must refuse |
// | a name that begins with "invalid" | the name as it was raised | a translation of the name |
// | a reason behind a label | the label and the reason in pt-BR | the reason in English |
// | a text behind a label that is not a reason | the text as it was raised | a translation of it |
test('a name that begins with "invalid" is not a reason and stays as it was raised', () => {
  for (const text of ['Invalid JSON in invalid settings.json', 'Unknown client invalid bob', 'invalid settings.json']) {
    const translated = localizeReason(text, 'pt-BR');
    assert.ok(!translated.includes('valor inválido'), `${text}: ${translated}`);
    assert.ok(translated.includes('invalid'), `${text}: ${translated}`);
    assert.equal(localizeReason(translated, 'pt-BR'), translated, `${text}: translating twice changes the text`);
    assert.equal(localizeReason(text, 'en'), text);
  }
  // The settings the demo refuses by their value (src/smoke/demo/budget.js) are reasons of ours and are told.
  for (const key of ['maxUsd', 'maxMinutes', 'checkTimeoutMs', 'quotaFloorPct', 'quotaMaxAgeMinutes',
    'quotaExpireMinutes', 'maxTurns', 'maxTokens']) {
    assert.notEqual(localizeReason(`invalid ${key}`, 'pt-BR'), `invalid ${key}`, `invalid ${key}: no pt-BR text`);
  }
});

test('the reason behind a label of the demo is told only when the catalog knows that exact text', () => {
  // The catalog knows the phrase: it is told in the language of the run.
  const known = localizeReason('narration: budget or turn ceiling', 'pt-BR');
  assert.ok(known.includes('teto de orçamento ou de voltas'), known);
  assert.ok(!known.includes('budget or turn ceiling'), known);
  // The text behind the label is a name and a message of the system: the name stays as it was raised, byte for byte,
  // and the message of the system is told when it is an exact phrase of the catalog.
  const reason = 'narration: Cannot read invalid settings.json: permission denied';
  const once = localizeReason(reason, 'pt-BR');
  assert.ok(once.includes('invalid settings.json'), once);
  assert.equal(localizeReason(once, 'pt-BR'), once, 'translating twice changes the text');
  assert.equal(localizeReason(reason, 'en'), reason);
});

// The rule of the path that could not be read: only a prefix with the shape of a path is a path. A name of a person
// that ends with ": permission denied" is not a path and stays as it was raised.
//
// | reason | must pass | must refuse |
// | a path that could not be read | the path as it was raised and the reason in Portuguese | the path translated |
// | a text that is not a path | the text as it was raised | a translation of the text |
test('the rule of the path that could not be read takes only a prefix with the shape of a path', () => {
  for (const path of ['/record.json', '~/state/record.json', './record.json', '../state/record.json',
    'C:\\state\\record.json', 'C:/state/record.json']) {
    const reason = `${path}: permission denied`;
    assert.equal(localizeReason(reason, 'pt-BR'), `${path}: ${PT}`, reason);
    assert.equal(localizeReason(reason, 'en'), reason, reason);
  }
  for (const text of ['maria: permission denied', 'Maria: permission denied', 'okit: permission denied',
    'e: permission denied']) {
    assert.equal(localizeReason(text, 'pt-BR'), text, text);
    assert.equal(localizeReason(text, 'en'), text, text);
  }
});

test('a reason inside a reason is told when it is one of the exact phrases of the catalog', () => {
  // The capture is a whole reason of the catalog: both parts are said in the language of the run.
  const reason = 'Invalid --from package: Missing CLI';
  assert.equal(localizeReason(reason, 'pt-BR'), 'Pacote de --from inválido: CLI ausente');
  assert.equal(localizeReason(reason, 'en'), reason);
});

test('translating twice gives the same text for every reason of the catalog', () => {
  for (const [, , sample] of REASONS) {
    const once = localizeReason(sample, 'pt-BR');
    assert.notEqual(once, sample, `${sample}: no pt-BR text`);
    assert.equal(localizeReason(once, 'pt-BR'), once, `${sample}: translating twice changes the text`);
  }
  // The refusals of the settings are a catalog too: the same promise, with the parameters in place.
  for (const [code, entry] of Object.entries(CONFIG_MESSAGES)) {
    const text = entry.en.replace(/\{(\w+)\}/g, 'sample');
    const once = localizeReason(text, 'pt-BR');
    assert.notEqual(once, text, `${code}: no pt-BR text`);
    assert.equal(localizeReason(once, 'pt-BR'), once, `${code}: translating twice changes the text`);
  }
});

test('the reasons of the validation of the scenario are in the catalog', () => {
  for (const reason of ['unsafe symlink', 'unsafe path', 'duplicate or unsafe key', 'unexpected class',
    'missing or cyclic dependency', 'unsafe acceptance', 'unsafe fault', 'invalid scenario',
    'invalid files or acceptance']) {
    const translated = localizeReason(reason, 'pt-BR');
    assert.notEqual(translated, reason, `${reason}: no pt-BR text`);
    assert.equal(localizeReason(translated, 'pt-BR'), translated, `${reason}: translating twice changes the text`);
    assert.equal(localizeReason(reason, 'en'), reason, `${reason}: the English text changed`);
  }
});

test('the demo says the refusal of a symlink in the language of the run', async () => {
  for (const locale of ['en', 'pt-BR']) {
    // The real refusal: the helper leaves a symbolic link where a file of the practice root was expected.
    const world = demoWorld({ run: async (briefing) => {
      const sentinel = join(briefing.root, 'home/untouched.txt');
      await fs.writeFile(sentinel, 'untouched');
      const target = join(briefing.root, briefing.allowedOutputPaths[0]);
      await fs.unlink(target);
      await fs.symlink(sentinel, target);
      return { status: 'completed', summary: 'done',
        artifacts: briefing.demand.files.map((file, index) => ({ path: briefing.allowedOutputPaths[index], content: file.content })),
        usage: { costUsd: 0, tokens: 0, turns: 1 } };
    } });
    const result = await runDemo({ ...world, locale });
    assert.ok(result.reasons.includes('unsafe symlink'), result.reasons.join(' | '));
    const text = reportText(result, locale);
    if (locale === 'pt-BR') {
      assert.ok(text.includes('link simbólico inseguro'), text);
      assert.ok(!text.includes('unsafe symlink'), text);
    } else {
      assert.ok(text.includes('unsafe symlink'), text);
    }
  }
});

test('a reason that carries a path with " / " in it is shown whole, in the language of the run', async () => {
  const path = join(tmpdir(), 'd122-absent / file');
  for (const locale of ['en', 'pt-BR']) {
    // The real ENOENT of the system: the narration reads a file whose path holds the delimiter of the languages.
    const world = demoWorld();
    const result = await runDemo({ ...world, locale, mode: 'real', confirmed: true,
      onNarration: () => readFileSync(path) });
    const reason = result.reasons.find((one) => one.startsWith('narration: '));
    assert.ok(reason, result.reasons.join(' | '));
    assert.ok(reason.includes(path), reason);
    const text = reportText(result, locale);
    assert.ok(text.includes(reason), text);
  }
});

// A capture is a name, a path or a message of the system: it is told in the language of the run only when it is, whole,
// one of the exact phrases of the catalog. A name that looks like a reason is a name, and it stays as it was raised.
//
// | reason | must pass | must refuse |
// | a name of a client that is not a reason | the name as it was raised | a translation of the name |
// | a file whose name is not a reason | the name of the file as it was raised | a translation of the name |
// | a reason inside a reason, exact phrase | both parts in pt-BR | the reason in English |
// | every reason of the catalog, translated twice | the same text | a second, different text |
test('a name of a client that is not a reason stays as it was raised', async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), 'd122-client-name-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const lines = [];
  // The real refusal of the smoke client: the name of the client is not a client of ours.
  const result = await runClientSmoke(['--client', 'invalid maxUsd'], { root, locale: 'pt-BR',
    env: { HOME: root, OKWORK_HOME: root }, out: (line) => lines.push(line), err: (line) => lines.push(line),
    now: () => 1700000000000 });
  assert.equal(result.code, 2);
  const text = lines.join('\n');
  assert.ok(text.includes('invalid maxUsd'), text);
  assert.ok(!text.includes('valor inválido'), text);
});

test('the name of a file that is not a reason stays as it was raised', async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), 'd122-file-name-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = join(root, 'invalid maxUsd');
  await fs.writeFile(file, '{not json');
  // The real refusal of the state: the file holds no JSON, and its name is not a reason of the catalog.
  await assert.rejects(readJson(file, null), (error) => {
    const shown = localizeReason(error.message, 'pt-BR');
    assert.ok(shown.includes('invalid maxUsd'), shown);
    assert.ok(!shown.includes('valor inválido'), shown);
    return true;
  });
  // The same refusal with the name of the file alone (the message of the critic).
  assert.equal(localizeReason('Invalid JSON in invalid maxUsd', 'pt-BR'), 'JSON inválido em invalid maxUsd');
});

// The rule of a refusal of a setting is fixed text of the catalog (the rule of the schema, with the values of the node
// it names), so it is told in the language of the run; the name or the value of the person is not a rule and stays as
// it was raised.
//
// | reason | must pass | must refuse |
// | the rule of a refused setting | the rule in pt-BR | the rule in English |
// | a name that is not a rule | the name as it was raised | a translation of the name |
// | every rule the schema can name | the phrase in the table | a phrase missing from it |
test('the rule of a refused setting is told in the language of the run', () => {
  const reason = 'Invalid install.kit.executables: a non-empty list of a name without slashes';
  assert.equal(localizeReason(reason, 'pt-BR'), 'install.kit.executables inválido: uma lista não vazia de um nome sem barras');
  assert.equal(localizeReason(reason, 'en'), reason);
  // The name of the person is not a rule: it stays as it was raised, byte for byte.
  const name = 'Invalid install.kit.executables: the name of the person';
  assert.equal(localizeReason(name, 'pt-BR'), 'install.kit.executables inválido: the name of the person');
  assert.equal(localizeReason(name, 'en'), name);
});

test('every rule the schema of the settings can name is a phrase of the catalog', () => {
  // The rules the schema can build, one by one: the phrase of each of them is in the table of the rules.
  const phrases = new Set();
  for (const { node } of installNodes()) {
    const found = problemOf(node, Symbol('not a value'));
    if (found) phrases.add(found.rule);
  }
  assert.ok(phrases.size > 20, `${phrases.size} rules`);
  for (const rule of phrases) {
    assert.ok(RULE_PHRASES.has(rule), `${rule}: no pt-BR text`);
    const once = localizeReason(`Invalid install.aKey: ${rule}`, 'pt-BR');
    assert.ok(!once.includes(rule), `${rule}: the rule stayed in English`);
    assert.equal(localizeReason(once, 'pt-BR'), once, `${rule}: translating twice changes the text`);
  }
});

