// The call of one tool, taken out of the server: the answer of a tool that
// works, the refusal of one that does not, and the name the table does not
// hold.

import assert from 'node:assert/strict';
import test from 'node:test';

import { callTool, respond } from '../src/mcp/server.js';

const CTX = { root: '/tmp/okit-root' };

// A table of two tools: one that answers and one that refuses.
const TOOLS = [
  {
    name: 'first',
    description: 'a tool that answers',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async (args) => JSON.stringify({ ok: true, args }),
  },
  {
    name: 'second',
    description: 'a tool that refuses',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => {
      throw new Error('the second tool refused');
    },
  },
];

test('a known tool answers with its text and no error', async () => {
  const result = await callTool(TOOLS, CTX, 'first', { a: 1 });
  assert.equal(result.isError, false);
  assert.deepEqual(JSON.parse(result.text), { ok: true, args: { a: 1 } });
});

test('a tool that refuses answers with the message and the flag', async () => {
  const result = await callTool(TOOLS, CTX, 'second', {});
  assert.equal(result.isError, true);
  assert.equal(result.text, 'the second tool refused');
});

test('a name the table does not hold is thrown', async () => {
  await assert.rejects(() => callTool(TOOLS, CTX, 'x', {}), /unknown tool x/);
});

test('the server answers the same way it did before the call was taken out', async () => {
  const refused = await respond(
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'second', arguments: {} } },
    { tools: TOOLS, ctx: CTX, version: '0.0.0' },
  );
  assert.equal(refused.result.isError, true);
  assert.equal(refused.result.content[0].text, 'the second tool refused');

  const unknown = await respond(
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'x', arguments: {} } },
    { tools: TOOLS, ctx: CTX, version: '0.0.0' },
  );
  assert.equal(unknown.error.code, -32602);
  assert.equal(unknown.error.message, 'Invalid params: unknown tool x');
});
