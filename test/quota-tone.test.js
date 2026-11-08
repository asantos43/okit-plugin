import assert from 'node:assert/strict';
import test from 'node:test';
import { quotaTone } from '../src/quota-tone.js';
import { quotaTone as panelTone } from '../adapters/claude-code/panel/formatters.js';

// | Percent | Tone |
// | 100, 50 | ok |  | 49, 20 | warn |  | 19.9, 0 | low |  | null | dim |
test('the quota tone follows the boundaries and the panel copy agrees', () => {
  const expected = [[100, 'ok'], [50, 'ok'], [49, 'warn'], [20, 'warn'], [19.9, 'low'], [0, 'low'], [null, 'dim']];
  for (const [percent, tone] of expected) {
    assert.equal(quotaTone(percent), tone, String(percent));
    assert.equal(panelTone(percent), tone, `panel ${percent}`);
  }
});
