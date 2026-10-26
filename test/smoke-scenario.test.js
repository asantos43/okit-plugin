import assert from 'node:assert/strict';
import { test } from 'node:test';

import { classify } from '../src/classify.js';
import { TOOL_NAMES } from '../src/mcp/tools.js';
import SCENARIO, { SCENARIO as namedScenario } from '../src/smoke/scenario.js';

test('the scenario holds the 23 documented ids once each, in order', () => {
  const ids = SCENARIO.map(({ id }) => id);
  assert.deepEqual(ids, Array.from({ length: 23 }, (_, i) => `C${i + 1}`));
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(SCENARIO, namedScenario);
});

test('every step carries the data contract and a concrete verdict source', () => {
  for (const step of SCENARIO) {
    assert.deepEqual(Object.keys(step), ['id', 'name', 'resource', 'kind', 'call', 'behaviour', 'judgedFrom']);
    assert.ok(['call', 'preparation', 'reading'].includes(step.kind));
    for (const field of ['name', 'resource', 'behaviour', 'judgedFrom']) {
      assert.equal(typeof step[field], 'string', `${step.id}.${field}`);
      assert.ok(step[field].trim(), `${step.id}.${field} must not be empty`);
    }
  }
});

test('every MCP call, including follow-ups, names an exported tool', () => {
  for (const step of SCENARIO.filter(({ kind }) => kind === 'call')) {
    assert.ok(TOOL_NAMES.includes(step.call.tool), `${step.id}: ${step.call.tool}`);
    if (step.call.then) assert.ok(TOOL_NAMES.includes(step.call.then.tool));
  }
});

test('preparations and created records carry the smoke tag', () => {
  for (const step of SCENARIO) {
    if (step.kind === 'preparation') assert.equal(step.call.tag, 'okit-smoke');
    if (step.call?.preparation) assert.equal(step.call.preparation.tag, 'okit-smoke');
    if (step.call?.cleanup) assert.equal(step.call.cleanup.tag, 'okit-smoke');
  }
  assert.equal(SCENARIO.find(({ id }) => id === 'C15').call.arguments.title, 'okit-smoke');
  assert.equal(SCENARIO.find(({ id }) => id === 'C19').call.arguments.text, 'okit-smoke');
});

test('the scenario survives a JSON round trip without losing data', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(SCENARIO)), SCENARIO);
});

test('C2 requires the smoke skill alongside the actor skills', () => {
  const step = SCENARIO.find(({ id }) => id === 'C2');
  for (const name of ['okit-director', 'okit-executor', 'okit-critic', 'okit-smoke', 'okit-setup']) {
    assert.ok(step.behaviour.includes(name), `C2 must require ${name}`);
  }
});

// Must pass / must refuse (the known-input corpus):
// | input | must pass | must refuse |
// | C11   | simple, short-body | normal or hard |
// | C12   | normal, mid-body   | simple or hard |
// | C13   | hard, long-body    | simple or normal |
test('known classifier inputs exercise the exported rules after JSON loading', () => {
  const loaded = JSON.parse(JSON.stringify(SCENARIO));
  for (const [id, effort, rule] of [
    ['C11', 'simple', 'short-body'],
    ['C12', 'normal', 'mid-body'],
    ['C13', 'hard', 'long-body'],
  ]) {
    const result = classify(loaded.find((step) => step.id === id).call.arguments);
    assert.equal(result.effort, effort, id);
    assert.ok(result.reasons.some((reason) => reason.startsWith(`${rule}:`)), id);
  }
});
