import assert from 'node:assert/strict';
import { test } from 'node:test';

import { GLOBAL, inScope, validateAppliesTo, validateAppliesToFilter } from '../src/applies.js';

// Must pass / must refuse table:
// | case                    | must pass                       | must refuse                |
// | one project             | 'proj'                          | -                          |
// | trim                    | 'proj' from ' proj '            | -                          |
// | array of projects       | ['a','b'] deduped, in order     | []                         |
// | one-name array          | ['a'] stays an array            | ['a','']                   |
// | global default          | undefined, nothing stored      | ['global','a']             |
// | non-string value        | -                              | 42, { a: 1 }, ['a', 2]     |
// | filter one project      | 'proj' trimmed                  | '', 3, ['a']               |
// | inScope                 | absent, string, array, global  | -                          |

test('validateAppliesTo keeps one project as given', () => {
  assert.equal(validateAppliesTo('proj'), 'proj');
  assert.equal(validateAppliesTo('  /home/u/proj  '), '/home/u/proj');
  assert.equal(validateAppliesTo(GLOBAL), undefined);
  assert.equal(validateAppliesTo([GLOBAL]), undefined);
  assert.equal(validateAppliesTo(undefined), undefined);
  assert.equal(validateAppliesTo(null), undefined);
});

test('validateAppliesTo keeps an array an array and drops duplicates', () => {
  assert.deepEqual(validateAppliesTo(['solo']), ['solo']);
  assert.deepEqual(validateAppliesTo(['a', 'b', 'a']), ['a', 'b']);
  assert.deepEqual(validateAppliesTo([' a ', 'b', 'a']), ['a', 'b']);
});

test('validateAppliesTo refuses what names no project or mixes global', () => {
  assert.throws(() => validateAppliesTo(''), TypeError);
  assert.throws(() => validateAppliesTo('   '), /appliesTo must hold only non-empty strings/);
  assert.throws(() => validateAppliesTo([]), /appliesTo must name at least one project/);
  assert.throws(() => validateAppliesTo(['a', '']), TypeError);
  assert.throws(() => validateAppliesTo(['a', 2]), TypeError);
  assert.throws(() => validateAppliesTo([GLOBAL, 'a']), /global cannot be combined/);
  assert.throws(() => validateAppliesTo(42), /non-empty string or an array/);
  assert.throws(() => validateAppliesTo({ a: 1 }), /non-empty string or an array/);
});

test('validateAppliesToFilter takes one project or global', () => {
  assert.equal(validateAppliesToFilter(' proj '), 'proj');
  assert.equal(validateAppliesToFilter(GLOBAL), 'global');
  assert.equal(validateAppliesToFilter(undefined), undefined);
  assert.equal(validateAppliesToFilter(null), undefined);
  assert.throws(() => validateAppliesToFilter(''), TypeError);
  assert.throws(() => validateAppliesToFilter(3), /non-empty string when filtering/);
  assert.throws(() => validateAppliesToFilter(['a']), /non-empty string when filtering/);
});

test('inScope reads the field of a record', () => {
  const bare = { id: 1 };
  const one = { id: 2, appliesTo: 'proj' };
  const many = { id: 3, appliesTo: ['a', 'b'] };

  assert.equal(inScope(bare, 'proj'), true);
  assert.equal(inScope(bare, GLOBAL), true);
  assert.equal(inScope(one, 'proj'), true);
  assert.equal(inScope(one, 'other'), false);
  assert.equal(inScope(one, GLOBAL), false);
  assert.equal(inScope(many, 'b'), true);
  assert.equal(inScope(many, 'c'), false);
  assert.equal(inScope(many, GLOBAL), false);
});