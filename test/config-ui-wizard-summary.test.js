import test from 'node:test';
import assert from 'node:assert/strict';
import { planSummary, previewSummary } from '../src/config-ui/wizard-summary.js';
import { wizardFlow } from '../src/config-ui/wizard-flow.js';
import { wizardMain } from '../src/config-ui/wizard-client.js';
import { labels } from '../src/config-ui/labels.js';
import { buildState } from '../src/config-ui/state.js';
import { wizardDom } from './helpers/wizard-dom.js';

// D156. The wizard shows words, never the plan's JSON. Must pass: a readable summary per client without the package's
// test fixtures and the installer's bookkeeping, a visible progress line while the plan is calculated, and no JSON,
// null, undefined, NaN or unfilled {placeholder} in the visible text of any screen (the collapsed details may hold JSON).
// Must refuse: JSON.stringify output on a screen outside "View details", a second plan request while one is running.
const PROBLEM = /[{}\[\]]|\bnull\b|undefined|NaN|\[object|\{\w+\}/;
const home = '/home/me/.local/share/okit-plugin/0.4.0-codex';
const mutations = [
  { client: 'codex', kind: 'directory', path: home },
  ...Array.from({ length: 5 }, (_, index) => ({ client: 'codex', kind: 'payload', path: `${home}/src/file${index}.js` })),
  ...Array.from({ length: 40 }, (_, index) => ({ client: 'codex', kind: 'payload', path: `${home}/test/fixtures/case${index}.json` })),
  { client: 'codex', kind: 'staging', path: `${home}.staging` },
  { client: 'codex', kind: 'record', path: '/home/me/.local/share/okit-plugin/codex.json' },
  { client: 'codex', kind: 'record', path: '/home/me/.local/share/okit-plugin/codex.json' },
  { client: 'codex', kind: 'record-temporary', path: '/home/me/.local/share/okit-plugin/codex.json.tmp' },
  { client: 'codex', kind: 'quota-slot', path: '/home/me/.okwork/slot' },
  { client: 'codex', kind: 'command-link', path: '/home/me/.local/bin/okit-plugin' },
  { kind: 'statusline', path: '/home/me/.claude/settings.json' },
];
const plan = { planId: 'plan-1', plan: { reviewable: true, clients: [{ client: 'codex', upToDate: false }], checksum: null, mutations, conflicts: [], deferred: [] } };
const boot = (locale = 'en', extra = {}) => ({ ...buildState(), locale, catalogs: labels, instance: 'view-one',
  installLabels: { en: {}, 'pt-BR': {} },
  wizard: { clients: ['codex'], options: {}, installed: {}, platform: 'linux', activationMessage: 'Open a terminal',
    detection: [{ client: 'claude-code', installed: true, executable: '/bin/claude', version: '2.0' },
      { client: 'codex', installed: true, executable: '/bin/codex', version: '1.0' }, { client: 'opencode', installed: false, executable: null, version: null }],
    requirements: [{ key: 'node', ok: true, actual: '22.1.0', required: '>=20' }, { key: 'permissions', ok: true, path: '/home/me' }],
    recovery: [{ command: 'okit-plugin', args: ['doctor'] }], ...extra } });

// Text a person sees: everything except a collapsed "View details" block, hidden nodes and the script state.
const visible = (node) => (node.hidden || node.tagName === 'DETAILS' ? '' : `${node.text ?? ''} ${node.children.map(visible).join(' ')}`);
const screenText = (f) => ['heading', 'status', 'error', 'existing', 'choices', 'body', 'boundaries', 'preview', 'question', 'actions']
  .map((id) => visible(f.nodes.get(`wizard-${id}`))).join(' ');

test('planSummary drops the package fixtures and the bookkeeping, counts files and lists the changes once', () => {
  const summary = planSummary(plan.plan);
  const codex = summary.clients.find((row) => row.client === 'codex');
  assert.equal(codex.files, 5, 'the 40 fixture files are not counted');
  assert.deepEqual(codex.items.map((item) => item.kind), ['record', 'command-link']);
  assert.ok(summary.clients.some((row) => row.client === '' && row.items[0].kind === 'statusline'), 'a change with no client is shared');
  assert.equal(JSON.stringify(summary).includes('fixtures'), false);
  assert.equal(summary.total, 4);
  const many = planSummary({ clients: [{ client: 'codex' }], mutations: Array.from({ length: 9 }, (_, i) => ({ client: 'codex', kind: 'record', path: `/p/${i}` })) });
  assert.equal(many.clients[0].shown.length, 6); assert.equal(many.clients[0].more, 3);
  assert.deepEqual(planSummary(undefined), { clients: [], total: 0, conflicts: 0 });
});

test('previewSummary turns setup, panel and policy previews into short lines of data', () => {
  assert.deepEqual(previewSummary({ kind: 'setup', changes: [{ path: 'profiles.codex.normal.model', value: 'gpt-x' },
    { path: 'profiles.codex.normal.effort', value: 'high' }] }), [{ kind: 'profile', a: 'normal', b: 'gpt-x', c: 'high' }]);
  assert.deepEqual(previewSummary({ kind: 'panel', skipped: true }), [{ kind: 'panelSkipped' }]);
  assert.equal(previewSummary({ kind: 'panel', writes: [{ kind: 'installation-record', path: '/r' }, { kind: 'record-temporary', path: '/r.tmp' }] }).length, 1);
  assert.deepEqual(previewSummary({ kind: 'policy', scope: 'CurrentUser', after: 'RemoteSigned' }), [{ kind: 'policy', a: 'CurrentUser', b: 'RemoteSigned' }]);
  assert.deepEqual(previewSummary(null), []);
});

test('no screen shows JSON, null, undefined, NaN or an unfilled placeholder outside the collapsed details', async () => {
  for (const locale of ['en', 'pt-BR']) {
    const f = wizardDom(boot(locale));
    const flow = wizardMain(f.win, wizardFlow, () => ({}), () => {});
    await new Promise(setImmediate);
    const done = { jobId: 'j', state: 'succeeded', seq: 3, followups: [], completed: ['codex:get', 'codex:files'], remaining: ['codex:register'],
      events: [], result: { clients: [{ client: 'claude-code', state: 'ok' }, { client: 'codex', state: 'failed', reason: 'Permission denied' }] } };
    const shots = {};
    shots.detect = screenText(f);
    flow.state.plan = plan; flow.go('review'); shots.review = screenText(f);
    flow.state.job = { ...done, state: 'applying' }; flow.state.active = true; flow.go('applying'); shots.applying = screenText(f);
    flow.state.job = done; flow.state.active = false; flow.go('result'); shots.result = screenText(f);
    flow.state.preview = { followupId: 'f', preview: { kind: 'panel', skipped: false, writes: [{ kind: 'client-plugin-registration', scope: 'user' }] } };
    flow.state.followupKind = 'panel'; flow.go('review'); flow.state.preview = { followupId: 'f', preview: { kind: 'setup', changes: [{ path: 'profiles.codex.normal.model', value: 'm' }, { path: 'profiles.codex.normal.effort', value: 'high' }] } };
    flow.go('result'); flow.state.preview = flow.state.preview; shots.models = screenText(f);
    for (const [name, text] of Object.entries(shots)) {
      assert.ok(text.trim().length > 10, `${locale} ${name} is not empty`);
      assert.doesNotMatch(text, PROBLEM, `${locale} ${name}: ${text}`);
    }
    assert.match(shots.review, /\b4\b/);
    assert.doesNotMatch(shots.review, /fixtures/);
    assert.match(shots.result, /Permission denied/);
    // The JSON is still reachable, in the collapsed block of the review.
    flow.state.job = done; flow.go('review');
    const block = f.nodes.get('wizard-preview').querySelectorAll('details');
    assert.ok(block.length >= 1 && block[0].querySelectorAll('pre').length === 1, `${locale}: the plan JSON is in one collapsed details block`);
  }
});

test('while the plan is calculated the screen says so, the preview button waits and asking again does not restart it', async () => {
  const f = wizardDom(boot('en'));
  const requests = [];
  const flow = wizardFlow(f.win && boot('en'), (path) => { requests.push(path); return new Promise(() => {}); }, () => {});
  void flow.review(); void flow.review(); void flow.review();
  assert.equal(requests.filter((path) => path === '/api/install/plan').length, 1);
  assert.equal(flow.state.planning, true);
  for (const locale of ['en', 'pt-BR']) {
    const dom = wizardDom(boot(locale));
    const main = wizardMain(dom.win, wizardFlow, () => ({}), () => {});
    await new Promise(setImmediate);
    main.state.planning = true; main.state.plan = null; main.go('review');
    const text = screenText(dom);
    assert.match(text, locale === 'en' ? /Calculating/ : /Calculando/);
    assert.match(text, /\d+ s/);
    const preview = dom.nodes.get('wizard-actions').children.find((node) => node.dataset.wizard === 'review');
    assert.equal(preview.disabled, true, 'the preview button is disabled while the plan is calculated');
    assert.doesNotMatch(text, PROBLEM);
  }
});

test('with no installed client the first screen has no boxes, says why and cannot continue', async () => {
  for (const locale of ['en', 'pt-BR']) {
    const data = boot(locale); data.wizard.detection.forEach((row) => { row.installed = false; }); data.wizard.clients = [];
    const f = wizardDom(data); wizardMain(f.win, wizardFlow, () => ({}), () => {});
    await new Promise(setImmediate);
    assert.equal(f.nodes.get('wizard-choices').querySelectorAll('input').length, 0);
    const next = f.nodes.get('wizard-actions').children.find((node) => node.dataset.wizard === 'review');
    assert.equal(next.disabled, true);
    assert.ok(screenText(f).includes(labels[locale].wizard.missing));
    assert.doesNotMatch(screenText(f), PROBLEM);
  }
});

test('the wizard bundle shows JSON.stringify only inside the collapsed details helper', async () => {
  const { wizardSource } = await import('../src/config-ui/wizard-client.js');
  const source = wizardSource();
  const drawn = source.split('\n').filter((line) => /element\(/.test(line) && line.includes('JSON.stringify'));
  assert.equal(drawn.length, 1, drawn.join('\n'));
  assert.ok(drawn[0].includes("element('summary', text().details, block)"), 'only inside the "View details" block');
});

test('a requirement that fails is said once, with its folder, and Next stays disabled', async () => {
  for (const locale of ['en', 'pt-BR']) {
    const data = boot(locale);
    data.wizard.requirements = [{ key: 'permissions', ok: false, path: '/home/me', remedyKey: 'writePermission' },
      { key: 'permissions', ok: false, path: '/home/me', remedyKey: 'writePermission' }];
    const f = wizardDom(data); wizardMain(f.win, wizardFlow, () => ({}), () => {});
    await new Promise(setImmediate);
    const text = screenText(f);
    const line = `${labels[locale].wizard.permissions} (/home/me): ${labels[locale].wizard.writePermission}`;
    assert.equal(text.split(line).length - 1, 1, `${locale}: the failing requirement is said once: ${text}`);
    assert.equal(f.nodes.get('wizard-actions').children.find((node) => node.dataset.wizard === 'review').disabled, true);
  }
});

test('the done screen says how to reach the command and to restart in one sentence, in the language on screen, with no "pending" line', async () => {
  const activationMessages = { en: 'Open a new terminal and the command will work there',
    'pt-BR': 'Abra um terminal novo e o comando funcionará lá' }; // locale:pt-BR
  const f = wizardDom(boot('en', { activationMessages }));
  const flow = wizardMain(f.win, wizardFlow, () => ({}), () => {});
  await new Promise(setImmediate);
  flow.state.job = { jobId: 'j', state: 'succeeded', seq: 3, followups: [], events: [], result: { clients: [{ client: 'codex', state: 'ok' }] } };
  for (const locale of ['en', 'pt-BR']) {
    flow.change('locale', locale); flow.go('result');
    const text = screenText(f), t = labels[locale].wizard;
    const sentence = `${activationMessages[locale]}. ${t.restartAfter}`;
    assert.ok(text.includes(sentence), `${locale}: one sentence "${sentence}" in: ${text}`);
    assert.equal(text.split(/terminal/i).length - 1, 1, `${locale}: "terminal" is said once`);
    assert.equal(text.includes(t.restart), false, `${locale}: the stand-alone restart sentence is not repeated`);
    assert.equal(text.includes(activationMessages[locale === 'en' ? 'pt-BR' : 'en']), false, `${locale}: no text of the other language`);
    assert.doesNotMatch(text, /Setup pending|Setup pendente/, `${locale}: no "pending" line after a good install`);
  }
  // With nothing to activate the restart sentence stands alone.
  const bare = wizardDom(boot('en')); const bareFlow = wizardMain(bare.win, wizardFlow, () => ({}), () => {});
  await new Promise(setImmediate);
  bareFlow.state.job = { jobId: 'j', state: 'succeeded', seq: 3, followups: [], events: [], result: { clients: [{ client: 'codex', state: 'ok' }] } };
  bareFlow.go('result');
  assert.ok(screenText(bare).includes(labels.en.wizard.restart));
});
