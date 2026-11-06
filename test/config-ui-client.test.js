import assert from 'node:assert/strict';
import test from 'node:test';
import { clientMain, clientSource } from '../src/config-ui/client.js';
import { labels } from '../src/config-ui/labels.js';

function fixture(responses = [], controls = [], actors = []) {
  const handlers = {}, calls = [];
  const nodes = Object.fromEntries(['error', 'review', 'changes', 'reload'].map(id => [id, { hidden: true, textContent: '' }]));
  nodes.state = { textContent: JSON.stringify({ expectedMtime: 42, actors, labels: labels.en, locale: 'en' }) };
  let reloads = 0;
  const win = { location: { search: '?token=abc%2B123&locale=en', reload: () => { reloads++; } },
    document: { getElementById: id => nodes[id], querySelectorAll: () => controls,
      addEventListener: (name, handler) => { handlers[name] = handler; },
      defaultView: { addEventListener: (name, handler) => { handlers[name] = handler; } } },
    fetch: async (path, options) => { calls.push({ path, ...options });
      const result = responses.shift() ?? { status: 200, value: {} };
      return { status: result.status, json: async () => result.value }; } };
  clientMain(win);
  const click = (action, dataset = {}) => handlers.click({ target: { closest: () => ({ dataset: { action, ...dataset } }) } });
  return { win, nodes, calls, handlers, click, reloads: () => reloads };
}

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
  assert.deepEqual(JSON.parse(f.calls.at(-1).body), { grace: true });
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
