import assert from 'node:assert/strict';
import test from 'node:test';
import { clientMain, clientSource } from '../src/config-ui/client.js';
import { labels } from '../src/config-ui/labels.js';

function fixture(responses = [], controls = [], actors = [], hash = '', summaries = []) {
  const handlers = {}, calls = [];
  const nodes = Object.fromEntries(['error', 'review', 'changes', 'reload'].map(id => [id, { hidden: true, textContent: '' }]));
  nodes.review.scrolls = []; nodes.review.focuses = [];
  nodes.review.scrollIntoView = options => { nodes.review.scrolls.push(options); };
  nodes.review.focus = options => { nodes.review.focuses.push(options); };
  nodes.state = { textContent: JSON.stringify({ expectedMtime: 42, actors, labels: labels.en, locale: 'en', instance: 'page-instance' }) };
  let reloads = 0;
  const tabs = ['actors', 'limits', 'language', 'profiles', 'telemetry', 'todo'].map(id => ({
    dataset: { tab: id }, attributes: {}, classList: { toggle(name, value) { this[name] = value; } },
    setAttribute(name, value) { this.attributes[name] = value; },
    getAttribute: () => `panel-${id}`, focus() { this.focused = true; },
  }));
  const panels = tabs.map(tab => (nodes[`panel-${tab.dataset.tab}`] = {
    id: `panel-${tab.dataset.tab}`, contains: control => control.panel === tab.dataset.tab,
  }));
  const win = { location: { hash, search: '?token=abc%2B123&locale=en', reload: () => { reloads++; } },
    history: { replaceState: (_state, _title, value) => { win.location.hash = value; } },
    document: { getElementById: id => nodes[id], querySelectorAll: selector =>
      selector === '[role="tab"]' ? tabs : selector === '[role="tabpanel"]' ? panels
        : selector === 'details.section > summary' ? summaries : controls,
      addEventListener: (name, handler) => { handlers[name] = handler; },
      defaultView: { addEventListener: (name, handler) => { handlers[name] = handler; } } },
    fetch: async (path, options) => { calls.push({ path, ...options });
      const result = (path === '/api/keepalive' ? undefined : responses.shift()) ?? { status: 200, value: {} };
      return { status: result.status, json: async () => result.value }; } };
  clientMain(win);
  const startup = calls.splice(0);
  const click = (action, dataset = {}) => handlers.click({ target: { closest: () => ({ dataset: { action, ...dataset } }) } });
  const tabClick = index => handlers.click({ target: { closest: () => tabs[index] } });
  return { win, nodes, calls, startup, handlers, click, tabs, panels, tabClick, reloads: () => reloads };
}

test('keepalive registers the instance on start and only persisted pageshow', () => {
  const f = fixture();
  assert.equal(f.startup.length, 1);
  const check = call => {
    assert.equal(call.path, '/api/keepalive');
    assert.equal(call.method, 'POST');
    assert.equal(call.keepalive, true);
    assert.equal(call.headers['x-okit-token'], 'abc+123');
    assert.deepEqual(JSON.parse(call.body), { instance: 'page-instance' });
  };
  check(f.startup[0]);
  f.handlers.pageshow({ persisted: false });
  assert.equal(f.calls.length, 0);
  f.handlers.pageshow({ persisted: true });
  assert.equal(f.calls.length, 1);
  check(f.calls[0]);
});

test('tabs select one panel, persist the hash and follow keyboard navigation', async () => {
  const f = fixture();
  const selected = index => {
    assert.deepEqual(f.panels.map(panel => panel.hidden), f.panels.map((_, i) => i !== index));
    assert.deepEqual(f.tabs.map(tab => tab.attributes['aria-selected']), f.tabs.map((_, i) => String(i === index)));
    assert.deepEqual(f.tabs.map(tab => tab.tabIndex), f.tabs.map((_, i) => i === index ? 0 : -1));
    assert.equal(f.win.location.hash, `#tab=${f.tabs[index].dataset.tab}`);
  };
  selected(0);
  await f.tabClick(1); selected(1);
  for (const [from, key, to] of [[1, 'ArrowRight', 2], [2, 'End', 5], [5, 'ArrowRight', 0],
    [0, 'ArrowLeft', 5], [5, 'Home', 0]]) {
    let prevented = false;
    f.handlers.keydown({ target: f.tabs[from], key, preventDefault: () => { prevented = true; } });
    selected(to); assert.equal(prevented, true); assert.equal(f.tabs[to].focused, true);
  }
  for (const [hash, expected] of [['#tab=telemetry', 4], ['#tab=unknown', 0], ['', 0]]) {
    const g = fixture([], [], [], hash);
    assert.equal(g.panels[expected].hidden, false);
    assert.equal(g.panels.filter(panel => !panel.hidden).length, 1);
  }
});

test('only changed controls are sent with token and mtime; save refreshes state', async () => {
  const a = { dataset: { path: 'language', type: 'string' }, value: 'en' };
  const b = { dataset: { path: 'limits.global', type: 'integer' }, value: '2' };
  const f = fixture([], [a, b]);
  b.value = '3';
  await f.click('review');
  assert.match(f.nodes.changes.textContent, /Before: 2\nAfter: 3/);
  await f.click('apply');
  assert.deepEqual(JSON.parse(f.calls[0].body), { expectedMtime: 42, changes: [{ path: 'limits.global', value: 3 }] });
  assert.equal(f.calls[0].headers['x-okit-token'], 'abc+123');
  assert.equal(f.calls[0].credentials, 'same-origin');
  assert.equal(f.calls[1].path, '/api/state?locale=en');
  assert.equal(f.reloads(), 1);
  assert.match(clientSource(), /^\(function clientMain/);
});

test('hidden tab edits keep dots, review changes and saved values across tab switches', async () => {
  const control = { dataset: { path: 'limits.global', type: 'integer' }, value: '2', panel: 'limits' };
  const f = fixture([], [control]);
  assert.equal(f.panels[1].hidden, true);
  control.value = '3'; f.handlers.input({ target: control });
  assert.equal(f.tabs[1].classList['has-edits'], true);
  control.value = '2'; f.handlers.change({ target: control });
  assert.equal(f.tabs[1].classList['has-edits'], false);
  await f.tabClick(1);
  control.value = '4'; f.handlers.change({ target: control });
  await f.tabClick(2);
  assert.equal(f.panels[1].hidden, true);
  assert.equal(f.tabs[1].classList['has-edits'], true);
  await f.click('review');
  assert.match(f.nodes.changes.textContent, /limits.global\nBefore: 2\nAfter: 4/);
  await f.click('apply');
  assert.deepEqual(JSON.parse(f.calls[0].body).changes, [{ path: 'limits.global', value: 4 }]);
  assert.equal(f.reloads(), 1);
  assert.equal(f.win.location.hash, '#tab=language');
  const restored = fixture([], [], [], f.win.location.hash);
  assert.equal(restored.panels[2].hidden, false);
});

test('untouched empty number and text controls yield no changes', async () => {
  const controls = ['number', 'integer', 'string'].map(type => ({
    dataset: { path: `future.${type}`, type }, value: '',
    type: type === 'string' ? 'text' : 'number',
  }));
  const f = fixture([], controls);
  await f.click('review');
  assert.equal(f.nodes.changes.textContent, '');
  await f.click('apply');
  assert.deepEqual(JSON.parse(f.calls[0].body).changes, []);
});

test('validation reason, conflict reload and explicit model confirmation', async () => {
  for (const status of [422, 409]) {
    const f = fixture([{ status, value: { reason: 'disk or validation reason' } }]);
    await f.click('review'); await f.click('apply');
    assert.equal(f.nodes.error.textContent, 'disk or validation reason');
    assert.equal(f.nodes.reload.hidden, status !== 409);
  }
  const control = { dataset: { actorPath: 'profiles.codex.simple.model', type: 'string' }, value: 'old' };
  const confirmed = { dataset: { actorPath: 'profiles.codex.hard.model', type: 'string' }, value: 'old' };
  const other = { dataset: { path: 'language', type: 'string' }, value: 'en' };
  const actors = [{ client: 'codex', classes: ['simple', 'hard'].map(name => ({ path: `profiles.codex.${name}`,
    modelChoices: [{ model: 'listed', confirmed: true }, { model: 'new', confirmed: false }] })) }];
  const f = fixture([{ status: 422, value: { reason: 'Model is not confirmed by the client; confirm this change explicitly.' } }],
    [confirmed, control, other], actors);
  control.value = 'new'; confirmed.value = 'listed'; other.value = 'pt-BR';
  await f.click('review'); await f.click('apply');
  assert.equal(f.calls.length, 1);
  assert.equal(f.nodes.error.textContent, labels.en.confirmModel);
  await f.click('apply');
  const changes = JSON.parse(f.calls[1].body).changes;
  assert.deepEqual(changes, [{ path: 'profiles.codex.hard.model', value: 'listed' },
    { path: 'profiles.codex.simple.model', value: 'new', confirm: true }, { path: 'language', value: 'pt-BR' }]);
});

test('enabling precedes row edits; disabling writes null; pagehide uses keepalive grace', async () => {
  const on = { dataset: { actor: 'profiles.codex.simple' }, type: 'checkbox', checked: false };
  const model = { dataset: { actorPath: 'profiles.codex.simple.model', type: 'string' }, value: '' };
  const f = fixture([], [on, model]);
  on.checked = true; model.value = 'new';
  await f.click('review'); await f.click('apply');
  assert.deepEqual(JSON.parse(f.calls[0].body).changes, [
    { path: 'profiles.codex.simple', unset: true }, { path: 'profiles.codex.simple.model', value: 'new' }]);
  const off = { dataset: { actor: 'profiles.codex.hard' }, type: 'checkbox', checked: true };
  const g = fixture([], [off]); off.checked = false;
  await g.click('review'); await g.click('apply');
  assert.deepEqual(JSON.parse(g.calls[0].body).changes, [{ path: 'profiles.codex.hard', value: null }]);
  f.handlers.pagehide();
  assert.equal(f.calls.at(-1).path, '/api/close');
  assert.equal(f.calls.at(-1).keepalive, true);
  assert.deepEqual(JSON.parse(f.calls.at(-1).body), { grace: true, instance: 'page-instance' });
  await f.click('close');
  assert.equal(f.nodes.error.textContent, labels.en.closed);
});

test('shared account and critic controls stay synchronized; reset emits unset', async () => {
  const path = 'profiles.codex.hard.model';
  const a = { dataset: { actorPath: path, type: 'string' }, value: 'old' };
  const b = { dataset: { actorPath: path, type: 'string' }, value: 'old' };
  const field = { dataset: { path: 'language', type: 'string' }, value: 'en' };
  const f = fixture([], [a, b, field]);
  a.value = 'new'; f.handlers.change({ target: a });
  assert.equal(b.value, 'new');
  await f.click('reset', { reset: 'language' });
  await f.click('review'); await f.click('apply');
  assert.deepEqual(JSON.parse(f.calls[0].body).changes, [{ path, value: 'new' }, { path: 'language', unset: true }]);
});

test('review scrolls to and focuses the review panel, also for model confirmation', async () => {
  const f = fixture();
  await f.click('review');
  assert.equal(f.nodes.review.hidden, false);
  assert.deepEqual(f.nodes.review.scrolls, [{ block: 'nearest' }]);
  assert.deepEqual(f.nodes.review.focuses, [{ preventScroll: true }]);
  const model = { dataset: { path: 'limits.model', type: 'string' }, value: 'old' };
  const g = fixture([{ status: 422, value: { reason: 'Model is not confirmed by the client; confirm this change explicitly.' } }], [model]);
  model.value = 'new';
  await g.click('review'); g.nodes.review.scrolls.length = 0; g.nodes.review.focuses.length = 0;
  await g.click('apply');
  assert.equal(g.nodes.review.scrolls.length, 1);
  assert.equal(g.nodes.review.focuses.length, 1);
  const bare = fixture();
  delete bare.nodes.review.scrollIntoView; delete bare.nodes.review.focus;
  await bare.click('review');
  assert.equal(bare.nodes.review.hidden, false);
});

test('tab keys with modifiers are ignored so browser shortcuts keep working', () => {
  const f = fixture();
  for (const modifier of ['altKey', 'ctrlKey', 'metaKey', 'shiftKey']) {
    let prevented = false;
    f.handlers.keydown({ target: f.tabs[0], key: 'ArrowRight', [modifier]: true, preventDefault: () => { prevented = true; } });
    assert.equal(prevented, false);
    assert.equal(f.tabs[0].attributes['aria-selected'], 'true');
    assert.equal(f.tabs[1].attributes['aria-selected'], 'false');
  }
  let prevented = false;
  f.handlers.keydown({ target: f.tabs[0], key: 'ArrowRight', preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(f.tabs[1].attributes['aria-selected'], 'true');
});

test('collapsed section edits and resets mark ancestor summaries and tab, then clear', async () => {
  const field = { dataset: { path: 'codexQuota.fields.used', type: 'string' }, value: 'old', panel: 'limits' };
  const summaries = [true, true, false].map(contains => ({
    parentElement: { open: false, contains: control => contains && control === field },
    classList: { toggle(name, value) { this[name] = value; } },
  }));
  const f = fixture([], [field], [], '', summaries);
  const check = dirty => {
    assert.equal(f.tabs[1].classList['has-edits'], dirty);
    assert.deepEqual(summaries.map(summary => summary.classList['has-edits']), [dirty, dirty, false]);
    assert.ok(summaries.every(summary => !summary.parentElement.open));
  };
  field.value = 'new'; f.handlers.input({ target: field }); check(true);
  field.value = 'old'; f.handlers.change({ target: field }); check(false);
  await f.click('reset', { reset: field.dataset.path }); check(true);
  await f.click('review'); await f.click('apply');
  assert.deepEqual(JSON.parse(f.calls[0].body).changes, [{ path: field.dataset.path, unset: true }]);
  f.handlers.change({ target: field }); check(false);
});

test('clicking Reset marks the tab of that field as edited', async () => {
  const field = { dataset: { path: 'limits.global', type: 'integer' }, value: '2', panel: 'limits' };
  const f = fixture([], [field]);
  assert.notEqual(f.tabs[1].classList['has-edits'], true);
  await f.click('reset', { reset: 'limits.global' });
  assert.equal(f.tabs[1].classList['has-edits'], true);
  assert.notEqual(f.tabs[0].classList['has-edits'], true);
});
