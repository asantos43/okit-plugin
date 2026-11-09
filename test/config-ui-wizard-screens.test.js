import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { wizardFlow } from '../src/config-ui/wizard-flow.js';
import { wizardMain, wizardSource } from '../src/config-ui/wizard-client.js';
import { renderWizardPage } from '../src/config-ui/wizard-page.js';
import { renderPage } from '../src/config-ui/page.js';
import { labels } from '../src/config-ui/labels.js';
import { TEXTS } from '../src/install/present.js';
import { buildState } from '../src/config-ui/state.js';
import { wizardDom } from './helpers/wizard-dom.js';
import { wizardServer } from './helpers/wizard-server.js';

const boot = (locale = 'en') => ({ ...buildState(), locale, catalogs: labels, instance: 'view-one',
  wizard: { clients: ['codex'], options: {}, detection: [{ client: 'codex', installed: true, executable: '/bin/codex', version: '1.0' }],
    requirements: [{ key: 'node', ok: true }], recovery: [], platform: 'linux', activationMessage: 'Open a terminal' } });
const plan = { planId: 'plan-one', plan: { reviewable: true, mutations: [], deferred: [], conflicts: [] } };
const job = { jobId: 'job-one', state: 'applying', seq: 1, events: [], question: null, completed: [], remaining: ['codex:register'], followups: [], result: null };
const success = { ...job, state: 'succeeded', result: { clients: [{ client: 'codex', state: 'ok' }] } };
function flowFixture(responses = []) {
  const calls = [], states = [];
  const flow = wizardFlow(boot(), async (path, method, input) => {
    calls.push({ path, method, input }); return responses.shift() ?? { status: 200, value: { ok: true } };
  }, (state, focus) => states.push({ screen: state.screen, focus }));
  return { flow, calls, states };
}
// Must pass / must refuse:
// | Typed review + explicit checkbox | Apply without consent or after any changed choice |
// | Cursor replay, partial outcomes, inert text | Duplicate apply on reconnect, HTML event insertion, token URLs |
test('consent gates Apply and every pre-apply choice invalidates review', async () => {
  const { flow, calls } = flowFixture([{ status: 200, value: plan }]);
  await flow.review(); await flow.apply(); assert.equal(calls.length, 1);
  for (const [name, value] of [['options', { noPath: true }], ['clients', ['codex']], ['locale', 'pt-BR']]) {
    flow.state.plan = plan; flow.consent(true); flow.change(name, value);
    assert.equal(flow.state.plan, null); assert.equal(flow.state.consent, false);
    await flow.apply();
  }
  assert.equal(calls.length, 1);
});

test('409 starts a fresh review and cannot retain prior consent', async () => {
  const { flow, calls } = flowFixture([{ status: 200, value: plan }, { status: 200, value: { ok: true } },
    { status: 409, value: { code: 'stale-plan' } }, { status: 200, value: { ...plan, planId: 'fresh' } }]);
  await flow.review(); flow.consent(true); await flow.apply();
  assert.equal(flow.state.screen, 'review'); assert.equal(flow.state.plan.planId, 'fresh');
  assert.equal(flow.state.consent, false);
  assert.equal(calls.filter((call) => call.path === '/api/install/apply').length, 1);
});

test('cursor reconnect offers takeover, caps events, retains cancellation boundaries and stale answers poll again', async () => {
  const events = Array.from({ length: 200 }, (_, seq) => ({ seq: seq + 1, messageKey: 'output', params: { message: String(seq) } }));
  const { flow, calls } = flowFixture([{ status: 200, value: { ...job, seq: 200, fullSnapshot: true, events,
    question: { questionId: 'old', preview: { path: 'file' } }, completed: ['codex:files'] } },
    { status: 200, value: { ok: true } }, { status: 409, value: {} },
    { status: 200, value: { ...job, state: 'cancelled', seq: 201, events: [], completed: ['codex:files'] } }]);
  await flow.poll(); assert.equal(flow.state.takeover, true); assert.equal(flow.state.events.length, 128);
  flow.take(); await flow.answer(true);
  assert.equal(calls.at(-1).path, '/api/install/job?after=200');
  assert.deepEqual(flow.state.job.completed, ['codex:files']);
  assert.deepEqual(flow.state.job.remaining, ['codex:register']);
  assert.equal(calls.some((call) => call.path === '/api/install/apply'), false);
});

test('followups require their reviewed preview and consent; unknown-model errors preserve choices', async () => {
  const { flow, calls } = flowFixture([{ status: 200, value: { ok: true } }, { status: 422, value: { reason: 'confirm model' } }]);
  flow.state.job = success; flow.go('models'); flow.state.modelClient = 'codex';
  await flow.preview('setup', 'codex', { profiles: [{ class: 'normal', model: 'unknown', effort: 'high' }] });
  assert.equal(flow.state.error, 'confirm model'); assert.equal(flow.state.modelClient, 'codex');
  await flow.followup(); assert.equal(calls.some((call) => call.path === '/api/install/followup'), false);
  flow.go('panel'); flow.go('accounts'); assert.equal(flow.state.job.jobId, success.jobId);
});

test('rendering reuses controls, has no external resources or handlers, and locales share keys', () => {
  assert.deepEqual(Object.keys(labels.en.wizard), Object.keys(labels['pt-BR'].wizard));
  for (const locale of ['en', 'pt-BR']) {
    const data = boot(locale), html = renderWizardPage(data, { locale, nonce: 'nonce', token: 'private-token', instance: data.instance, wizard: data.wizard });
    assert.match(html, /id="wizard-heading" tabindex="-1"/);
    assert.match(html, /aria-live="polite"/); assert.match(html, /prefers-reduced-motion/);
    assert.equal((html.match(/ data-actor-path=/g) ?? []).length, (renderPage(data, { locale, nonce: 'nonce', token: '' }).match(/ data-actor-path=/g) ?? []).length);
    assert.doesNotMatch(html, /(?:src|href)="https?:|\son\w+=|private-token/);
    assert.match(html, /data-account-add/);
    assert.doesNotMatch(renderPage(data, { locale, nonce: 'nonce', token: '' }), /id="wizard-heading"/);
  }
});

test('DOM screens move heading focus only on transitions, keep hostile event text inert and token off URLs', async () => {
  for (const locale of ['en', 'pt-BR']) {
    const data = boot(locale), f = wizardDom(data);
    const flow = wizardMain(f.win, wizardFlow, () => ({}), () => {});
    await new Promise(setImmediate);
    assert.equal(f.win.location.search, '');
    const attack = '<img onerror=alert(1)>';
    flow.state.job = { ...success, result: { clients: [{ client: 'codex', state: 'ok' }, { client: 'claude-code', state: 'failed' }, { client: 'opencode', state: 'skipped' }] } };
    flow.state.events = [{ seq: 1, messageKey: 'output', status: 'warning', params: { message: attack } }];
    for (const screen of ['requirements', 'review', 'applying', 'models', 'panel', 'accounts', 'reload', 'result', 'config']) {
      flow.go(screen);
      assert.equal(f.document.activeElement.id, 'wizard-heading');
      if (screen === 'result') { assert.ok(f.nodes.get('wizard-body').textContent.includes(labels[locale].wizard.partial));
        assert.ok(f.nodes.get('wizard-body').textContent.includes(labels[locale].wizard.pending)); }
    }
    assert.ok(f.nodes.get('wizard-events').textContent.includes(attack));
    assert.equal(f.nodes.get('wizard-events').children.length, 0);
    assert.equal(f.calls.some((call) => call.path.includes('token')), false);
    assert.equal(f.calls[0].headers['x-okit-token'], 'private-token');
  }
});

test('serialized browser bundle boots with the existing config client and polling does not steal focus', async () => {
  const data = boot(); data.labels = labels.en;
  const f = wizardDom(data);
  runInNewContext(wizardSource(), { window: f.win });
  await new Promise(setImmediate);
  assert.equal(f.document.activeElement.id, 'wizard-heading');
  assert.equal(f.calls.some((call) => call.path === '/api/keepalive'), true);
  assert.equal(f.calls.some((call) => call.path.includes('token=')), false);
  const focused = f.add('typing', 'input'); focused.focus();
  assert.equal(f.document.activeElement, focused);
  assert.doesNotMatch(wizardSource(), /\.innerHTML\s*=/);
});

test('a missing selected client or failed requirement blocks even a reviewable plan', async () => {
  const data = boot(); data.wizard.detection[0].installed = false;
  let requests = 0;
  const flow = wizardFlow(data, async () => { requests++; }, () => {});
  flow.state.plan = plan; flow.consent(true); await flow.apply(); await flow.review();
  assert.equal(requests, 0);
  data.wizard.detection[0].installed = true; data.wizard.requirements[0].ok = false;
  await flow.review(); assert.equal(requests, 0);
});

test('only a first-run server serves wizard markup; auth and instance-preserving refresh remain enforced', async (t) => {
  const normal = await wizardServer(t);
  const page = await normal.request('/?wizard=1');
  assert.equal(page.status, 200); assert.doesNotMatch(page.text, /id="wizard-heading"/);
  const session = await wizardServer(t, { operation: 'install', options: {} });
  const initial = await session.request(); assert.equal(initial.status, 200);
  assert.match(initial.text, /id="wizard-heading"/);
  assert.match(initial.headers['Content-Security-Policy'], /connect-src 'self'/);
  const data = JSON.parse(initial.text.match(/id="state"[^>]*>(.*?)<\/script>/s)[1]);
  const refresh = await session.request('/?locale=pt-BR', 'GET', { 'x-okit-instance': data.instance });
  assert.equal(refresh.status, 200);
  assert.equal(JSON.parse(refresh.text.match(/id="state"[^>]*>(.*?)<\/script>/s)[1]).instance, data.instance);
  assert.equal((await session.request('/', 'GET', { 'x-okit-instance': 'old' })).status, 409);
  for (const headers of [{ host: 'foreign.test' }, { origin: 'null' }, { 'x-okit-token': '' }]) {
    assert.equal((await session.request('/', 'GET', headers)).status, 403);
  }
  assert.equal((await session.request(`/api/install/job?token=${session.token}`, 'GET', { 'x-okit-token': '' })).status, 403);
  assert.equal((await session.request('/api/install/plan', 'POST', {}, '{')).status, 400);
  assert.equal((await session.request('/api/install/apply', 'POST', {}, 'x'.repeat(65537))).status, 413);
});

// Must pass: Skip leaves the base install intact and reaches Accounts; setup stays pending in both locales.
// Must refuse: any wording that claims setup finished without evidence, Apply for an unknown model unconfirmed.
test('skipping the panel keeps the install, setup is never reported as done, query leaves the address', async () => {
  for (const locale of ['en', 'pt-BR']) {
    const data = boot(locale), f = wizardDom(data);
    const flow = wizardMain(f.win, wizardFlow, () => ({}), () => {});
    await new Promise(setImmediate);
    assert.equal(f.win.location.search, '');
    flow.state.job = success; flow.go('panel');
    const skip = f.nodes.get('wizard-actions').children.find((node) => node.dataset.wizard === 'accounts');
    assert.ok(skip, 'the panel screen offers Skip');
    await skip.click();
    assert.equal(flow.state.screen, 'accounts'); assert.equal(flow.state.job.jobId, success.jobId);
    flow.go('result');
    const body = f.nodes.get('wizard-body').textContent;
    assert.ok(body.includes(labels[locale].wizard.pending));
    assert.doesNotMatch(body, /setup (is )?(done|complete)|configuração (concluída|completa)/i); // locale:pt-BR
    assert.equal(f.nodes.get('wizard-body').textContent.includes(labels[locale].wizard.partial), false);
  }
});

test('unknown models need explicit confirmation and install labels cover both locales', async () => {
  const { flow } = flowFixture([]);
  flow.state.job = success; flow.go('models');
  assert.equal(flow.state.unknown ?? false, false);
  flow.change('unknown', true); assert.equal(flow.state.unknown, true);
  flow.consent(true); flow.go('panel'); assert.equal(flow.state.consent, false, 'a new screen needs a new consent');
  const html = renderWizardPage(boot('pt-BR'), { locale: 'pt-BR', nonce: 'n', token: 't', instance: 'view-one', wizard: boot().wizard });
  assert.doesNotMatch(html, /(?:src|href|action)="https?:|url\(https?:/);
});

// Must pass: {placeholders} filled from params (flat, `values` or `args`), readable text, hostile values inert.
// Must refuse: raw JSON of the params in the line; an object value rendered as "[object Object]" (it is empty).
const renderedLabels = () => Object.fromEntries(['en', 'pt-BR'].map((lang) => [lang,
  Object.fromEntries(Object.entries(TEXTS).map(([key, value]) => [key, value[lang] ?? value.en]))]));
test('event lines fill placeholders from params and never show raw params JSON', async () => {
  for (const locale of ['en', 'pt-BR']) {
    const data = boot(locale); data.installLabels = renderedLabels();
    const f = wizardDom(data);
    const flow = wizardMain(f.win, wizardFlow, () => ({}), () => {});
    await new Promise(setImmediate);
    const attack = '<img onerror=alert(1)>';
    flow.state.events = [
      { seq: 1, client: 'codex', status: 'info', messageKey: 'header', params: { args: [{ package: 'okit-plugin', version: '0.4.0', client: 'Codex', system: 'Linux', arch: attack }], values: {} } },
      { seq: 2, status: 'warning', messageKey: 'output', params: { message: attack } },
      { seq: 3, status: 'info', messageKey: 'header', params: { args: [], values: { package: 'p', version: { nested: 1 } } } }];
    flow.go('applying');
    const lines = f.nodes.get('wizard-events').textContent.split('\n');
    assert.match(lines[0], locale === 'en' ? /^codex info: okit-plugin 0\.4\.0 for Codex \(Linux <img onerror=alert\(1\)>\)$/
      : /^codex info: okit-plugin 0\.4\.0 para Codex \(Linux <img onerror=alert\(1\)>\)$/);
    assert.ok(lines[1].includes(attack));
    assert.match(lines[2], /p {2}/, 'a missing or non-text value is empty');
    assert.doesNotMatch(f.nodes.get('wizard-events').textContent, /[{}]|"args"|"values"|\[object/);
    assert.equal(f.nodes.get('wizard-events').children.length, 0);
  }
});
