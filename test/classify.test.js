import assert from 'node:assert/strict';
import { test } from 'node:test';

import { classify, EFFORT_CLASSES } from '../src/classify.js';

const body = (words) => Array.from({ length: words }, (_, i) => `word${i}`).join(' ');
const steps = (count) => Array.from({ length: count }, (_, i) => `${i + 1}. do the thing`).join('\n');

// One case per rule: the rule id must be the first reason and decide the
// class. Every rule is exercised, so a table edit that breaks one fails here.
const CASES = [
  ['hard-hint', 'hard', { title: 'Investigate the flaky run', body: body(10) }],
  ['easy-hint', 'simple', { title: 'Rename the index file', body: body(300) }],
  ['long-body', 'hard', { title: 'Summarise the report', body: body(400) }],
  ['many-steps', 'hard', { title: 'Prepare the release', body: steps(6) }],
  ['many-checks', 'hard', { title: 'Check the data', body: body(50), accept: ['a', 'b', 'c', 'd', 'e', 'f'] }],
  ['mid-body', 'normal', { title: 'Draft the memo', body: body(120) }],
  ['some-steps', 'normal', { title: 'Draft the memo', body: steps(3) }],
  ['some-checks', 'normal', { title: 'Check the data', body: body(50), accept: ['a', 'b', 'c'] }],
  ['short-body', 'simple', { title: 'Ask the vendor for a quote', body: 'Ask the vendor for a quote.' }],
];

for (const [rule, effort, demand] of CASES) {
  test(`rule ${rule} fires and decides ${effort}`, () => {
    const result = classify(demand);
    assert.equal(result.effort, effort);
    assert.ok(result.reasons.length > 0);
    assert.ok(
      result.reasons.some((reason) => reason.startsWith(`${rule}:`)),
      `expected reason ${rule}, got ${JSON.stringify(result.reasons)}`,
    );
  });
}
test('a demand with no signal is normal and says it defaulted', () => {
  const result = classify({ title: 'Draft the memo', body: '', accept: [] });
  assert.equal(result.effort, 'normal');
  assert.deepEqual(result.reasons, ['default: no rule matched, so normal']);
});

test('classify is deterministic and never throws on missing fields', () => {
  const demand = { title: 'Refactor the parser', body: '', kind: 'code', accept: [] };
  assert.deepEqual(classify(demand), classify(demand));
  const empty = classify();
  assert.equal(empty.effort, 'normal');
  assert.ok(EFFORT_CLASSES.includes(empty.effort));
});

test('classify does not mutate the demand', () => {
  const accept = ['a'];
  const demand = { title: 'Check the data', body: body(200), accept };
  classify(demand);
  assert.equal(accept.length, 1);
  assert.equal(demand.body, body(200));
});

// Demands are any delegable work, not only code.
const NON_CODE = [
  { title: 'Write a thank-you note to the client', body: 'Write a thank-you note to the client.' },
  { title: 'Compare three vendor plans', body: 'Compare the pricing, support and limits of three vendor plans.', kind: 'research' },
  { title: 'Design the new quarterly report layout', body: 'Design a layout a finance reader can scan in one minute.', kind: 'documents' },
  { title: 'Clean the customer list', body: 'Remove the duplicate rows and keep the oldest contact per account.', kind: 'data' },
  { title: 'Fix the spelling in the intro', body: 'Fix the spelling in the intro paragraph.', kind: 'writing' },
];

// must pass: the class a person would say out loud.
// must refuse: a demand the classifier must not call hard on a hint word alone.
for (const demand of NON_CODE) {
  test(`non-code demand "${demand.title}" classifies sensibly`, () => {
    const { effort, reasons } = classify(demand);
    assert.ok(EFFORT_CLASSES.includes(effort));
    assert.ok(reasons.length > 0);
    const expected = demand.title.startsWith('Design') ? 'hard' : 'simple';
    assert.equal(effort, expected, JSON.stringify(reasons));
  });
}

test('the hint list cannot classify an empty demand as hard', () => {
  assert.notEqual(classify({}).effort, 'hard');
  assert.notEqual(classify({ title: '', body: '', kind: '' }).effort, 'hard');
});