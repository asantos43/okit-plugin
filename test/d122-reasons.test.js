import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { diagnose } from '../src/doctor/diagnose.js';
import { installConfig } from '../src/install/config.js';
import { createPresenter } from '../src/install/present.js';
import { registerMcp } from '../src/install/mcp-register.js';
import { executionPolicyStep } from '../src/install/policy.js';
import { mcpStep, register } from '../src/install/register.js';
import { selfCheck } from '../src/install/selfcheck.js';
import { reportText } from '../src/smoke/demo/report.js';
import { offerSetup } from '../src/setup/offer.js';
import { configOf } from '../src/profiles.js';
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
