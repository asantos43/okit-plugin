// The golden contract of D106: the answers of the old MCP tools, recorded
// literally. It changes only by decision, never by accident.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

import { respond } from '../src/mcp/server.js';
import { TOOLS } from '../src/mcp/tools.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, 'fixtures', 'mcp-golden.json');
const UPDATE = process.env.GOLDEN_UPDATE === '1';

// The clock of the golden: one instant, so nothing reads the wall clock.
const NOW = 1_750_000_000_000;
// The quota reading of the golden: one reading, always the same.
const READING = { source: 'user', remainingPct: 42, recordedAt: '2025-06-15T12:00:00.000Z' };
// The concurrency caps of the golden: the default ones, with no live run.
const LIMITS = { limits: { global: 3, clients: {} }, live: 0, byClient: {}, caps: {}, warnings: [] };
// The environment of the golden: a home of its own, with no client running.
const ENV = { HOME: '/golden/home', USERPROFILE: '/golden/home' };
// The environment of the case that needs a client in use.
const ENV_CODEX = { ...ENV, CODEX_THREAD_ID: 'golden-session' };

const roots = [];

after(async () => {
  for (const dir of roots) await rm(dir, { recursive: true, force: true });
});

async function tempRoot() {
  const dir = await mkdtemp(join(tmpdir(), 'okit-golden-'));
  roots.push(dir);
  return dir;
}

/**
 * The context every tool gets: a root of its own, the fixed clock, the fixed
 * settings, the fixed environment and the readings injected, so no handler
 * reads this machine.
 */
function context(root, overrides = {}) {
  return {
    root,
    config: {},
    env: ENV,
    now: () => NOW,
    readQuota: async () => ({ ...READING }),
    detectClients: async () => ({ clients: [] }),
    plugin: { path: '/golden/plugin', onPath: false },
    versions: {},
    limits: LIMITS,
    orders: [],
    quotaCache: new Map(),
    ...overrides,
  };
}

function toolOf(name) {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  assert.ok(tool, `the tool ${name} is not in the table`);
  return tool;
}

/**
 * Calls one tool of the table and returns what it answers: the response, or
 * the message of the refusal it threw.
 */
async function call(tool, args, ctx) {
  try {
    return { refusal: false, text: await tool.handler(args, ctx) };
  } catch (error) {
    return { refusal: true, text: error?.message ?? String(error) };
  }
}

// The golden only reads the machine through the markers below: the folder of
// the temporary root, the instants of the clock, the ids of the store and the
// separators of the paths of the system.
const DATE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;
const ABSOLUTE = /^(?:[A-Za-z]:[\\/]|[\\/])/;

function normalizeString(value, root) {
  let text = value;
  if (root) text = text.split(root).join('<root>');
  text = text.replace(DATE, '<date>');
  text = text.replace(/\bI\d{6}\b/g, '<inbox-id>');
  text = text.replace(/\bG\d{6}\b/g, '<order-id>');
  // A path is written the same way on every system, so the golden is.
  if (ABSOLUTE.test(text) || text.includes('<root>')) text = text.replace(/\\/g, '/');
  return text;
}

function normalizeValue(value, root) {
  if (typeof value === 'string') return normalizeString(value, root);
  if (Array.isArray(value)) return value.map((entry) => normalizeValue(entry, root));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, normalizeValue(entry, root)]));
  }
  return value;
}

/**
 * The answer of one case, normalized. A response is JSON, so it is read and
 * written again with the markers in place; a refusal is a plain message.
 */
function normalize(text, root) {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.stringify(normalizeValue(JSON.parse(trimmed), root));
    } catch {
      return normalizeString(text, root);
    }
  }
  return normalizeString(text, root);
}

/**
 * Every case of the golden: the tool, the name of the case, the arguments,
 * what the answer must be (a response or a refusal), and the state the case
 * needs before the call.
 */
const CASES = [
  // acquire_slot
  { tool: 'acquire_slot', case: 'good', expect: 'ok', args: { runId: 'run-1', client: 'alpha' } },
  { tool: 'acquire_slot', case: 'unknown-argument', expect: 'refusal', args: { runId: 'run-1', client: 'alpha', extra: true } },
  { tool: 'acquire_slot', case: 'wrong-type', expect: 'refusal', args: { runId: 7, client: 'alpha' } },
  { tool: 'acquire_slot', case: 'missing-required', expect: 'refusal', args: { runId: 'run-1' } },
  { tool: 'acquire_slot', case: 'null-argument', expect: 'ok', args: { runId: 'run-2', client: 'alpha', waitMs: null } },
  {
    tool: 'acquire_slot', case: 'over-the-cap', expect: 'ok', args: { runId: 'run-4', client: 'alpha' },
    prepare: async (ctx) => {
      for (const runId of ['run-1', 'run-2', 'run-3']) {
        await toolOf('acquire_slot').handler({ runId, client: 'alpha' }, ctx);
      }
    },
  },

  // release_slot
  {
    tool: 'release_slot', case: 'good', expect: 'ok', args: { runId: 'run-1' },
    prepare: async (ctx) => { await toolOf('acquire_slot').handler({ runId: 'run-1', client: 'alpha' }, ctx); },
  },
  { tool: 'release_slot', case: 'unknown-argument', expect: 'refusal', args: { runId: 'run-1', extra: true } },
  { tool: 'release_slot', case: 'missing-required', expect: 'refusal', args: {} },
  { tool: 'release_slot', case: 'unknown-run', expect: 'ok', args: { runId: 'ghost' } },

  // limits_status
  { tool: 'limits_status', case: 'good', expect: 'ok', args: {} },
  { tool: 'limits_status', case: 'unknown-argument', expect: 'refusal', args: { junk: true } },
  { tool: 'limits_status', case: 'arguments-not-an-object', expect: 'refusal', args: ['run'] },

  // status
  { tool: 'status', case: 'good', expect: 'ok', args: {} },
  { tool: 'status', case: 'unknown-argument', expect: 'refusal', args: { junk: true } },
  { tool: 'status', case: 'wrong-type', expect: 'refusal', args: { all: 'yes' } },
  { tool: 'status', case: 'unknown-client', expect: 'refusal', args: { client: 'ghost' } },
  { tool: 'status', case: 'show-before', expect: 'ok', args: { size: 'L' } },
  { tool: 'status', case: 'all-clients', expect: 'ok', args: { all: true }, env: ENV_CODEX },
  { tool: 'status', case: 'null-argument', expect: 'ok', args: { size: null } },

  // quota_notice
  { tool: 'quota_notice', case: 'good', expect: 'ok', args: { event: { type: 'quota.released', client: 'codex' } } },
  { tool: 'quota_notice', case: 'without-event', expect: 'ok', args: {} },
  { tool: 'quota_notice', case: 'null-event', expect: 'ok', args: { event: null } },
  { tool: 'quota_notice', case: 'unknown-argument', expect: 'refusal', args: { junk: true } },
  { tool: 'quota_notice', case: 'wrong-type', expect: 'refusal', args: { event: 'quota.released' } },
  { tool: 'quota_notice', case: 'locale-pt-BR', expect: 'ok', args: { locale: 'pt-BR', event: { type: 'quota.released', client: 'codex' } } },
  { tool: 'quota_notice', case: 'locale-pt-BR-wrong-type', expect: 'refusal', args: { locale: 'pt-BR', event: 'quota.released' } },

  // actors_list
  { tool: 'actors_list', case: 'good', expect: 'ok', args: {} },
  { tool: 'actors_list', case: 'unknown-argument', expect: 'refusal', args: { junk: true } },
  { tool: 'actors_list', case: 'wrong-type', expect: 'refusal', args: { client: 'ghost' } },
  { tool: 'actors_list', case: 'all-clients', expect: 'ok', args: { all: true }, env: ENV_CODEX },
  { tool: 'actors_list', case: 'one-client', expect: 'ok', args: { client: 'codex' } },

  // env_report
  { tool: 'env_report', case: 'good', expect: 'ok', args: {} },
  { tool: 'env_report', case: 'unknown-argument', expect: 'refusal', args: { junk: true } },
  { tool: 'env_report', case: 'wrong-type', expect: 'refusal', args: { client: 42 } },
  { tool: 'env_report', case: 'unknown-client', expect: 'ok', args: { client: 'ghost' } },
  { tool: 'env_report', case: 'locale-pt-BR', expect: 'ok', args: { locale: 'pt-BR' } },

  // classify
  { tool: 'classify', case: 'good', expect: 'ok', args: { title: 'migrate the inbox store', body: 'Move every record.', kind: 'code' } },
  { tool: 'classify', case: 'unknown-argument', expect: 'refusal', args: { title: 'x', ext: {} } },
  { tool: 'classify', case: 'wrong-type', expect: 'refusal', args: { title: 'x', body: 7 } },
  { tool: 'classify', case: 'missing-required', expect: 'refusal', args: { body: 'no title' } },
  { tool: 'classify', case: 'trimmed-title', expect: 'ok', args: { title: '  fix a typo  ' } },
  { tool: 'classify', case: 'null-argument', expect: 'ok', args: { title: 'fix a typo', body: null } },

  // profile_pick
  { tool: 'profile_pick', case: 'good', expect: 'ok', args: { client: 'codex', effort: 'simple' } },
  { tool: 'profile_pick', case: 'unknown-argument', expect: 'refusal', args: { client: 'codex', effort: 'simple', extra: true } },
  { tool: 'profile_pick', case: 'wrong-type', expect: 'refusal', args: { client: 'codex', effort: 'simple', quota: 'half' } },
  { tool: 'profile_pick', case: 'missing-required', expect: 'refusal', args: { client: 'codex' } },
  { tool: 'profile_pick', case: 'low-quota', expect: 'ok', args: { client: 'codex', effort: 'normal', quota: 5 } },
  { tool: 'profile_pick', case: 'quota-reading', expect: 'ok', args: { client: 'codex', effort: 'normal', quota: { source: 'user', remainingPct: 5 } } },

  // inbox_add
  { tool: 'inbox_add', case: 'good', expect: 'ok', args: { title: 'write the release note', accept: ['the file exists'], kind: 'writing', appliesTo: 'mcp-server' } },
  { tool: 'inbox_add', case: 'unknown-argument', expect: 'refusal', args: { title: 'x', accepts: ['a'] } },
  { tool: 'inbox_add', case: 'wrong-type', expect: 'refusal', args: { title: 'x', accept: 'a' } },
  { tool: 'inbox_add', case: 'missing-required', expect: 'refusal', args: {} },
  { tool: 'inbox_add', case: 'trimmed-title', expect: 'ok', args: { title: '  padded  ' } },
  { tool: 'inbox_add', case: 'null-argument', expect: 'ok', args: { title: 'x', body: null } },
  { tool: 'inbox_add', case: 'many-projects', expect: 'ok', args: { title: 'x', appliesTo: ['alpha', 'beta'] } },

  // inbox_list
  {
    tool: 'inbox_list', case: 'good', expect: 'ok', args: {},
    prepare: async (ctx) => {
      await toolOf('inbox_add').handler({ title: 'write the release note', kind: 'writing' }, ctx);
      await toolOf('inbox_add').handler({ title: 'keep the docs in step', appliesTo: 'mcp-server' }, ctx);
    },
  },
  { tool: 'inbox_list', case: 'unknown-argument', expect: 'refusal', args: { junk: true } },
  { tool: 'inbox_list', case: 'wrong-type', expect: 'refusal', args: { limit: -1 } },
  {
    tool: 'inbox_list', case: 'status-filter', expect: 'ok', args: { status: 'pending' },
    prepare: async (ctx) => { await toolOf('inbox_add').handler({ title: 'x' }, ctx); },
  },
  {
    tool: 'inbox_list', case: 'limit', expect: 'ok', args: { limit: 1 },
    prepare: async (ctx) => {
      await toolOf('inbox_add').handler({ title: 'x' }, ctx);
      await toolOf('inbox_add').handler({ title: 'y' }, ctx);
    },
  },
  {
    tool: 'inbox_list', case: 'locale-pt-BR', expect: 'ok', args: { locale: 'pt-BR' },
    prepare: async (ctx) => {
      const item = JSON.parse(await toolOf('inbox_add').handler({ title: 'x' }, ctx));
      await toolOf('inbox_claim').handler({ id: item.id, client: 'codex', session: 's', worktree: 'wt' }, ctx);
    },
  },
  {
    tool: 'inbox_list', case: 'shared-only', expect: 'ok', args: { appliesTo: 'global' },
    prepare: async (ctx) => {
      await toolOf('inbox_add').handler({ title: 'shared' }, ctx);
      await toolOf('inbox_add').handler({ title: 'scoped', appliesTo: 'mcp-server' }, ctx);
    },
  },

  // inbox_claim
  {
    tool: 'inbox_claim', case: 'good', expect: 'ok', args: (state) => ({ id: state.id, client: 'codex', session: 's', worktree: 'wt' }),
    prepare: async (ctx) => {
      const item = JSON.parse(await toolOf('inbox_add').handler({ title: 'claim me' }, ctx));
      return { id: item.id };
    },
  },
  {
    tool: 'inbox_claim', case: 'unknown-argument', expect: 'refusal', args: (state) => ({ id: state.id, client: 'codex', producer: true }),
    prepare: async (ctx) => {
      const item = JSON.parse(await toolOf('inbox_add').handler({ title: 'claim me' }, ctx));
      return { id: item.id };
    },
  },
  {
    tool: 'inbox_claim', case: 'wrong-type', expect: 'refusal', args: (state) => ({ id: state.id, client: 7 }),
    prepare: async (ctx) => {
      const item = JSON.parse(await toolOf('inbox_add').handler({ title: 'claim me' }, ctx));
      return { id: item.id };
    },
  },
  {
    tool: 'inbox_claim', case: 'missing-required', expect: 'refusal', args: (state) => ({ id: state.id }),
    prepare: async (ctx) => {
      const item = JSON.parse(await toolOf('inbox_add').handler({ title: 'claim me' }, ctx));
      return { id: item.id };
    },
  },
  {
    tool: 'inbox_claim', case: 'taken-by-another', expect: 'refusal', args: (state) => ({ id: state.id, client: 'other' }),
    prepare: async (ctx) => {
      const item = JSON.parse(await toolOf('inbox_add').handler({ title: 'claim me' }, ctx));
      await toolOf('inbox_claim').handler({ id: item.id, client: 'codex', session: 's', worktree: 'wt' }, ctx);
      return { id: item.id };
    },
  },
  { tool: 'inbox_claim', case: 'unknown-item', expect: 'refusal', args: { id: 'I999999', client: 'codex' } },

  // inbox_release
  {
    tool: 'inbox_release', case: 'good', expect: 'ok', args: (state) => ({ id: state.id, client: 'codex', session: 's' }),
    prepare: async (ctx) => {
      const item = JSON.parse(await toolOf('inbox_add').handler({ title: 'claim me' }, ctx));
      await toolOf('inbox_claim').handler({ id: item.id, client: 'codex', session: 's', worktree: 'wt' }, ctx);
      return { id: item.id };
    },
  },
  {
    tool: 'inbox_release', case: 'unknown-argument', expect: 'refusal', args: (state) => ({ id: state.id, client: 'codex', extra: true }),
    prepare: async (ctx) => {
      const item = JSON.parse(await toolOf('inbox_add').handler({ title: 'claim me' }, ctx));
      return { id: item.id };
    },
  },
  {
    tool: 'inbox_release', case: 'wrong-type', expect: 'refusal', args: (state) => ({ id: state.id, client: 7 }),
    prepare: async (ctx) => {
      const item = JSON.parse(await toolOf('inbox_add').handler({ title: 'claim me' }, ctx));
      return { id: item.id };
    },
  },
  {
    tool: 'inbox_release', case: 'missing-required', expect: 'refusal', args: (state) => ({ id: state.id }),
    prepare: async (ctx) => {
      const item = JSON.parse(await toolOf('inbox_add').handler({ title: 'claim me' }, ctx));
      return { id: item.id };
    },
  },
  { tool: 'inbox_release', case: 'unknown-item', expect: 'refusal', args: { id: 'I999999', client: 'codex' } },

  // inbox_set_status
  {
    tool: 'inbox_set_status', case: 'good', expect: 'ok', args: (state) => ({ id: state.id, status: 'delegated' }),
    prepare: async (ctx) => {
      const item = JSON.parse(await toolOf('inbox_add').handler({ title: 'move me' }, ctx));
      return { id: item.id };
    },
  },
  {
    tool: 'inbox_set_status', case: 'unknown-argument', expect: 'refusal', args: (state) => ({ id: state.id, status: 'delegated', extra: true }),
    prepare: async (ctx) => {
      const item = JSON.parse(await toolOf('inbox_add').handler({ title: 'move me' }, ctx));
      return { id: item.id };
    },
  },
  {
    tool: 'inbox_set_status', case: 'wrong-type', expect: 'refusal', args: (state) => ({ id: state.id, status: 'weird' }),
    prepare: async (ctx) => {
      const item = JSON.parse(await toolOf('inbox_add').handler({ title: 'move me' }, ctx));
      return { id: item.id };
    },
  },
  {
    tool: 'inbox_set_status', case: 'missing-required', expect: 'refusal', args: (state) => ({ id: state.id }),
    prepare: async (ctx) => {
      const item = JSON.parse(await toolOf('inbox_add').handler({ title: 'move me' }, ctx));
      return { id: item.id };
    },
  },
  {
    tool: 'inbox_set_status', case: 'holder-of-another', expect: 'refusal', args: (state) => ({ id: state.id, status: 'delegated', holder: { client: 'other' } }),
    prepare: async (ctx) => {
      const item = JSON.parse(await toolOf('inbox_add').handler({ title: 'move me' }, ctx));
      await toolOf('inbox_claim').handler({ id: item.id, client: 'codex', session: 's', worktree: 'wt' }, ctx);
      return { id: item.id };
    },
  },
  {
    tool: 'inbox_set_status', case: 'holder-wrong-type', expect: 'refusal', args: (state) => ({ id: state.id, status: 'delegated', holder: { client: 7 } }),
    prepare: async (ctx) => {
      const item = JSON.parse(await toolOf('inbox_add').handler({ title: 'move me' }, ctx));
      return { id: item.id };
    },
  },
  {
    tool: 'inbox_set_status', case: 'move-out-of-the-sequence', expect: 'refusal', args: (state) => ({ id: state.id, status: 'consolidated' }),
    prepare: async (ctx) => {
      const item = JSON.parse(await toolOf('inbox_add').handler({ title: 'move me' }, ctx));
      return { id: item.id };
    },
  },

  // order_add
  { tool: 'order_add', case: 'good', expect: 'ok', args: { text: 'never push to main', scope: 'all' } },
  { tool: 'order_add', case: 'unknown-argument', expect: 'refusal', args: { text: 'x', extra: true } },
  { tool: 'order_add', case: 'wrong-type', expect: 'refusal', args: { text: 'x', scope: 'effort:gigantic' } },
  { tool: 'order_add', case: 'missing-required', expect: 'refusal', args: {} },
  { tool: 'order_add', case: 'trimmed-text', expect: 'ok', args: { text: '  padded  ' } },
  { tool: 'order_add', case: 'until-in-the-past', expect: 'refusal', args: { text: 'x', until: '2000-01-01T00:00:00.000Z' } },
  { tool: 'order_add', case: 'one-project', expect: 'ok', args: { text: 'x', appliesTo: 'mcp-server' } },

  // order_list
  {
    tool: 'order_list', case: 'good', expect: 'ok', args: {},
    prepare: async (ctx) => { await toolOf('order_add').handler({ text: 'never push to main', scope: 'all' }, ctx); },
  },
  { tool: 'order_list', case: 'unknown-argument', expect: 'refusal', args: { activeOnly: true } },
  { tool: 'order_list', case: 'wrong-type', expect: 'refusal', args: { appliesTo: 3 } },
  {
    tool: 'order_list', case: 'one-project', expect: 'ok', args: { appliesTo: 'mcp-server' },
    prepare: async (ctx) => {
      await toolOf('order_add').handler({ text: 'shared' }, ctx);
      await toolOf('order_add').handler({ text: 'scoped', appliesTo: 'mcp-server' }, ctx);
    },
  },

  // order_remove
  {
    tool: 'order_remove', case: 'good', expect: 'ok', args: (state) => ({ id: state.id, reason: 'no longer wanted' }),
    prepare: async (ctx) => {
      const order = JSON.parse(await toolOf('order_add').handler({ text: 'never push to main' }, ctx));
      return { id: order.id };
    },
  },
  {
    tool: 'order_remove', case: 'unknown-argument', expect: 'refusal', args: (state) => ({ id: state.id, extra: true }),
    prepare: async (ctx) => {
      const order = JSON.parse(await toolOf('order_add').handler({ text: 'never push to main' }, ctx));
      return { id: order.id };
    },
  },
  { tool: 'order_remove', case: 'wrong-type', expect: 'refusal', args: { id: 7 } },
  { tool: 'order_remove', case: 'missing-required', expect: 'refusal', args: {} },
  { tool: 'order_remove', case: 'unknown-order', expect: 'refusal', args: { id: 'G999999' } },
  {
    tool: 'order_remove', case: 'default-reason', expect: 'ok', args: (state) => ({ id: state.id }),
    prepare: async (ctx) => {
      const order = JSON.parse(await toolOf('order_add').handler({ text: 'never push to main' }, ctx));
      return { id: order.id };
    },
  },

  // the same refusal, asked through the server instead of the table
  { tool: 'quota_notice', case: 'server-refusal', expect: 'refusal', via: 'server', args: { event: 'quota.released' } },
];

/**
 * The answer of one case: the tool answers, or the refusal it throws. The
 * case that goes through the server reads the frame the server sends.
 */
async function answer(entry) {
  const root = await tempRoot();
  const ctx = context(root, entry.env ? { env: entry.env } : {});
  const state = (entry.prepare ? await entry.prepare(ctx) : undefined) ?? {};
  const args = typeof entry.args === 'function' ? entry.args(state) : entry.args;
  const label = `${entry.tool}/${entry.case}`;

  if (entry.via === 'server') {
    const frame = await respond(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: entry.tool, arguments: args } },
      { tools: TOOLS, ctx, version: '0.0.0-golden' },
    );
    assert.equal(frame.result.isError, true, `${label} should be a failed call`);
    return normalize(frame.result.content[0].text, root);
  }

  const result = await call(toolOf(entry.tool), args, ctx);
  assert.equal(result.refusal, entry.expect === 'refusal', `${label} answered the wrong way`);
  return normalize(result.text, root);
}

/** Every answer of the golden, in the order of the cases. */
async function collect() {
  const golden = {};
  for (const entry of CASES) golden[`${entry.tool}/${entry.case}`] = await answer(entry);
  return golden;
}

test('the golden answers of the old tools', async () => {
  const golden = await collect();
  if (UPDATE) {
    await mkdir(dirname(FIXTURE), { recursive: true });
    await writeFile(FIXTURE, `${JSON.stringify(golden, null, 2)}\n`, 'utf8');
    return;
  }
  const expected = JSON.parse(await readFile(FIXTURE, 'utf8'));
  for (const [key, value] of Object.entries(golden)) {
    assert.deepEqual(value, expected[key], `the golden of ${key} changed`);
  }
  // The fixture and the cases are the same list: neither hides a case.
  assert.deepEqual(Object.keys(expected).sort(), Object.keys(golden).sort());
});