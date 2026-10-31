// The cost in context of the list of tools: the bytes a client reads before it
// calls anything. The budget only goes up with a conscious decision: a new
// tool, a longer description or a bigger schema is a change someone weighs,
// not a change a test accepts quietly.

import assert from 'node:assert/strict';
import test from 'node:test';

import { toolListing } from '../src/mcp/server.js';
import { TOOLS } from '../src/mcp/tools.js';

// The bytes of the list, measured by `node scripts/measure-tools.js` and
// rounded up to the next multiple of 500. Raising it means the list grew on
// purpose: write down why here before the number moves.
const BUDGET_BYTES = 14500;

// The number of tools the budget was measured for. A tool added or removed
// changes the list the client reads, so the count moves with the budget.
const EXPECTED_TOOLS = 29;

const listing = toolListing(TOOLS);
const payload = JSON.stringify({ tools: listing });
const bytes = Buffer.byteLength(payload, 'utf8');

test('the list of tools stays inside the budget of bytes', () => {
  assert.ok(bytes <= BUDGET_BYTES,
    `the list of tools is ${bytes} bytes, over the ${BUDGET_BYTES} bytes of the budget`);
});

test('the list of tools holds the number of tools the budget was measured for', () => {
  assert.equal(TOOLS.length, EXPECTED_TOOLS,
    `the list of tools holds ${TOOLS.length} tools, not the ${EXPECTED_TOOLS} of the budget`);
});

test('the list of tools announces a name, a description and a schema for each tool', () => {
  assert.equal(listing.length, TOOLS.length);
  for (const tool of listing) {
    assert.equal(typeof tool.name, 'string');
    assert.ok(tool.name.trim().length > 0);
    assert.equal(typeof tool.description, 'string');
    assert.ok(tool.description.length > 0);
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(tool.inputSchema.additionalProperties, false);
  }
});
