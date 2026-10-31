// The cost in context of the list of tools: how many tools the MCP server
// announces, how many bytes that list takes and how many tokens it costs
// (four bytes per token, the usual rough count). The heaviest tools are named
// too, so the next description that grows shows its name.
//
// The numbers are the ones the budget of `test/mcp-tools-budget.test.js`
// watches: a tool that grows past the budget has to be a decision, not a
// surprise.

import { toolListing } from '../src/mcp/server.js';
import { TOOLS } from '../src/mcp/tools.js';

const BYTES_PER_TOKEN = 4;
const HEAVIEST = 5;

const listing = toolListing(TOOLS);
const payload = JSON.stringify({ tools: listing });
const bytes = Buffer.byteLength(payload, 'utf8');

const heaviest = listing
  .map((tool) => ({ name: tool.name, bytes: Buffer.byteLength(JSON.stringify(tool), 'utf8') }))
  .sort((left, right) => right.bytes - left.bytes || left.name.localeCompare(right.name))
  .slice(0, HEAVIEST);

process.stdout.write(`tools: ${listing.length}\n`);
process.stdout.write(`bytes: ${bytes}\n`);
process.stdout.write(`estimated tokens: ${Math.ceil(bytes / BYTES_PER_TOKEN)}\n`);
process.stdout.write('heaviest:\n');
for (const tool of heaviest) {
  process.stdout.write(`  ${tool.name}: ${tool.bytes} bytes\n`);
}
