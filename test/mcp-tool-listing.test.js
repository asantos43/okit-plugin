// The list of tools the server announces: the names, the descriptions and the
// schemas a client reads before it calls anything. The fixture records the
// list as it is today, so a tool that is moved, renamed or reshaped shows up
// here and nowhere else.
//
// The order of the list is not part of the contract (a tool can move in the
// table); the names, the descriptions and the schemas are. The bytes of the
// list are compared too: it is what every client reads into its context.

import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { toolListing } from '../src/mcp/server.js';
import { TOOLS } from '../src/mcp/tools.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, 'fixtures', 'mcp-tool-listing.json');
const UPDATE = process.env.TOOL_LISTING_UPDATE === '1';

const listing = toolListing(TOOLS);

// The list as a map by name: what each tool says, without the order.
const byName = Object.fromEntries(listing.map((tool) => [tool.name, {
  description: tool.description,
  inputSchema: tool.inputSchema,
}]));

// The bytes the list takes in the context of a client.
const bytes = Buffer.byteLength(JSON.stringify({ tools: listing }), 'utf8');

test('the list of tools holds the same names, descriptions and schemas of the fixture', async () => {
  if (UPDATE) {
    await mkdir(dirname(FIXTURE), { recursive: true });
    await writeFile(FIXTURE, `${JSON.stringify(byName, null, 2)}\n`, 'utf8');
    return;
  }
  const expected = JSON.parse(await readFile(FIXTURE, 'utf8'));
  const actual = Object.fromEntries(listing.map((tool) => [tool.name, {
    description: tool.description,
    inputSchema: tool.inputSchema,
  }]));

  assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), 'the same names');
  for (const [name, entry] of Object.entries(expected)) {
    assert.deepEqual(actual[name], entry, `the tool ${name} changed`);
  }
});

test('the fixture holds one entry per tool of the table', async () => {
  const expected = JSON.parse(await readFile(FIXTURE, 'utf8'));
  assert.equal(Object.keys(expected).length, TOOLS.length);
  for (const tool of listing) {
    assert.equal(typeof expected[tool.name].description, 'string');
    assert.equal(expected[tool.name].inputSchema.type, 'object');
  }
});

test('the list of tools takes the same bytes of the fixture', async () => {
  const expected = JSON.parse(await readFile(FIXTURE, 'utf8'));
  const recorded = Object.entries(expected).map(([name, tool]) => ({ name, ...tool }));
  assert.equal(bytes, Buffer.byteLength(JSON.stringify({ tools: recorded }), 'utf8'));
});
