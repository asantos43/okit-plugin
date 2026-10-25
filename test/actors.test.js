import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { listActors, formatActors } from '../src/actors.js';
import { main } from '../src/cli.js';
import { TOOLS } from '../src/mcp/tools.js';
import { DEFAULT_CONFIG } from '../src/profiles.js';
import { limitsStatus } from '../src/limits.js';
import { orderAdd, orderList } from '../src/orders.js';
import { statusTable } from '../src/status.js';

async function fixture(t) {
  await mkdir('.delegate/tmp', { recursive: true });
  const root = await mkdtemp('.delegate/tmp/actors-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const profiles = Object.fromEntries(['claude-code', 'codex', 'opencode'].map((client) => [client,
    { simple: { model: `${client}-small`, effort: 'low' }, normal: { model: `${client}-medium`, effort: 'medium' },
      hard: { model: `${client}-large`, effort: 'high' }, critic: { model: `${client}-critic`, effort: 'high' } }]));
  const config = { profiles };
  await writeFile(join(root, 'config.json'), JSON.stringify(config));
  return { root, config, env: {}, readQuota: async () => ({ source: 'user', remainingPct: 80 }), cache: new Map() };
}

for (const client of ['claude-code', 'codex', 'opencode']) test(`injected profiles for ${client}`, async (t) => {
  const deps = await fixture(t);
  const result = await listActors({ ...deps, client });
  assert.equal(result.actors.length, 4);
  assert.ok(result.actors.every((actor) => actor.client === client && actor.freeSlots === 3 && actor.canLaunch));
  assert.deepEqual(result.actors.flatMap((actor) => actor.sizes), ['S', 'M', 'L']);
  assert.equal(result.actors[3].critic, true);
  assert.match(formatActors(result), new RegExp(`${client}-critic`));
  const json = formatActors(result, { json: true });
  assert.equal(json, JSON.stringify(JSON.parse(json)));
  assert.deepEqual(JSON.parse(json).clients, [client]);
});

test('merged sizes follow sizeClasses order regardless of profile order', async (t) => {
  const deps = await fixture(t);
  deps.config.profiles.codex = {
    normal: { model: 'shared', effort: 'low' },
    simple: { model: 'shared', effort: 'low' },
  };
  const result = await listActors({ ...deps, client: 'codex' });
  assert.deepEqual(result.actors[0].sizes, ['S', 'M']);
  assert.equal(result.actors[0].cells[3], 'S, M');
});

test('configured size map, deduplication and nearest missing-size alternative', async (t) => {
  const deps = await fixture(t);
  deps.config.profiles.codex.normal = deps.config.profiles.codex.simple;
  delete deps.config.profiles.codex.hard;
  const result = await listActors({ ...deps, client: 'codex' });
  assert.deepEqual(result.actors[0].sizes, ['S', 'M']);
  assert.match(result.notes.join('\n'), /L; nearest alternative: M/);
  deps.config.actors = { sizeClasses: { tiny: 'simple', big: 'hard' } };
  const custom = await listActors({ ...deps, client: 'codex' });
  assert.deepEqual(custom.actors[0].sizes, ['tiny']);
  assert.match(custom.notes.join('\n'), /big; nearest alternative: tiny/);
});

test('configured profile outside size and critic classes remains visible', async (t) => {
  const deps = await fixture(t);
  deps.config.profiles.codex.medium = { model: 'unused-medium', effort: 'medium' };
  const result = await listActors({ ...deps, client: 'codex' });
  assert.equal(result.actors.length, 5);
  const actor = result.actors.find(({ model }) => model === 'unused-medium');
  assert.deepEqual(actor.sizes, []);
  assert.equal(actor.critic, false);
  assert.equal(actor.cells[3], DEFAULT_CONFIG.actors.messages.en.missing);
  assert.ok(result.markdown.includes(`| codex | unused-medium | medium | ${actor.cells[3]} |`));
});

test('pair identity includes effort and merges sizes only for identical pairs', async (t) => {
  const deps = await fixture(t);
  deps.config.profiles.codex = {
    simple: { model: 'shared-model', effort: 'low' },
    normal: { model: 'shared-model', effort: 'high' },
    hard: { model: 'shared-model', effort: 'high' },
  };
  const result = await listActors({ ...deps, client: 'codex' });
  assert.equal(result.actors.length, 2);
  assert.deepEqual(result.actors.map(({ model, effort, sizes }) => ({ model, effort, sizes })), [
    { model: 'shared-model', effort: 'low', sizes: ['S'] },
    { model: 'shared-model', effort: 'high', sizes: ['M', 'L'] },
  ]);
});

test('unknown client and empty profiles give actionable explanations', async (t) => {
  const deps = await fixture(t);
  await assert.rejects(listActors({ ...deps, client: 'xyz' }), /claude-code, codex, opencode/);
  for (const locale of ['en', 'pt-BR']) {
    const messages = DEFAULT_CONFIG.actors.messages[locale];
    const result = await listActors({ ...deps, profiles: {}, client: 'codex', locale });
    assert.equal(result.actors.length, 0);
    assert.deepEqual(result.notes, [messages.empty.replace('{client}', 'codex')]);
    assert.match(messages.empty, locale === 'en' ? /guided command.*person who maintains okit/ : /comando guiado.*pessoa que mantém o okit/);
    assert.doesNotMatch(JSON.stringify(messages), /D50|O30|Producer|Produtor/);
    assert.doesNotMatch(result.markdown, /D50|O30|Producer|Produtor/);
  }
});

test('actors descriptions provide Portuguese configuration and one bilingual MCP listing', () => {
  const messages = DEFAULT_CONFIG.actors.messages;
  assert.match(messages['pt-BR'].description, /Somente leitura: atores.*modelo \+ esforço/);
  assert.doesNotMatch(messages['pt-BR'].description, /Read-only|actors|executors|remedies/);
  assert.equal(TOOLS.find((tool) => tool.name === 'actors_list').description, messages.en.description);
});

test('quota column shows the lowest remaining percentage across windows', async (t) => {
  const deps = await fixture(t);
  const result = await listActors({ ...deps, client: 'codex', readQuota: async () => ({ source: 'user',
    windows: [{ minutes: 300, remainingPct: 80 }, { minutes: 10080, remainingPct: 12 }] }) });
  assert.ok(result.actors.length > 0);
  for (const actor of result.actors) {
    assert.match(actor.cells[5], /; 12%;/);
    assert.doesNotMatch(actor.cells[5], /80%/);
  }
});

test('low quota uses the tightest window and supplies reason and remedy', async (t) => {
  const deps = await fixture(t);
  const result = await listActors({ ...deps, client: 'codex', readQuota: async () => ({ source: 'user',
    windows: [{ minutes: 300, remainingPct: 80 }, { minutes: 10080, remainingPct: 2 }] }) });
  assert.ok(result.actors.every((actor) => !actor.canLaunch && actor.quota.status === 'red'));
  assert.match(result.actors[0].reasons.join(' '), /below the floor.*Wait for quota reset/);
  const off = await listActors({ ...deps, client: 'codex', cache: new Map(), readQuota: async () => ({ source: 'off' }) });
  assert.ok(off.actors.every((actor) => actor.canLaunch));
});

for (const blockedBy of ['quota', 'slots']) test(`blocked L actor is not an alternative (${blockedBy})`, async (t) => {
  const deps = await fixture(t);
  deps.config.profiles.codex = { hard: { model: 'large-only', effort: 'high' } };
  const blocked = blockedBy === 'quota'
    ? { readQuota: async () => ({ source: 'user', remainingPct: 2 }) }
    : { limits: { limits: { global: 1, clients: {} }, byClient: { codex: 1 } } };
  const result = await listActors({ ...deps, ...blocked, client: 'codex' });
  assert.equal(result.actors.length, 1);
  assert.equal(result.actors[0].canLaunch, false);
  assert.deepEqual(result.actors[0].sizes, ['L']);
  assert.ok(result.notes.includes(DEFAULT_CONFIG.actors.messages.en.gap
    .replace('{client}', 'codex').replace('{size}', 'L')
    .replace('{alternative}', DEFAULT_CONFIG.actors.messages.en.none)));
  assert.doesNotMatch(result.notes.join('\n'), /nearest alternative: L\./);
});

test('listing occupied slots leaves all run files unchanged', async (t) => {
  const deps = await fixture(t);
  deps.config.limits = { global: 1, clients: {} };
  await mkdir(join(deps.root, 'runs'));
  const file = join(deps.root, 'runs', 'live.json');
  await writeFile(file, JSON.stringify({ client: 'codex', status: 'live', startedAt: Date.now() }));
  const before = await readFile(file, 'utf8');
  const limits = await limitsStatus(deps.root, deps.config);
  const result = await listActors({ ...deps, client: 'codex', limits });
  assert.ok(result.actors.every((actor) => actor.freeSlots === 0 && !actor.canLaunch));
  assert.match(result.markdown, /occupied.*Wait for a running executor/);
  assert.equal(await readFile(file, 'utf8'), before);
  assert.deepEqual(await readdir(join(deps.root, 'runs')), ['live.json']);
  assert.deepEqual(await limitsStatus(deps.root, deps.config), limits);
});

test('markdown cells escape model pipes and flatten newlines', async (t) => {
  const deps = await fixture(t);
  deps.config.profiles.codex = { simple: { model: 'model|variant\nnext', effort: 'low' } };
  const result = await listActors({ ...deps, client: 'codex' });
  const row = result.markdown.split('\n').find((line) => line.startsWith('| codex |'));
  assert.ok(row);
  assert.ok(row.includes(' | model\\|variant next | low | S | '), row);
  assert.equal(result.actors[0].model, 'model|variant\nnext');
});

// Must pass: detection, all, explicit client, JSON. Must refuse: unknown client/flag.
test('CLI and MCP share selection, JSON and validation', async (t) => {
  const deps = await fixture(t);
  const tool = TOOLS.find((entry) => entry.name === 'actors_list');
  for (const [args, clients] of [[[], ['claude-code']], [['--all'], ['claude-code', 'codex', 'opencode']],
    [['--all', '--client', 'codex'], ['codex']]]) {
    const out = [];
    const err = [];
    const code = await main(['actors', ...args, '--json'], { ...deps, env: { CLAUDECODE: '1' },
      stdout: (line) => out.push(line), stderr: (line) => err.push(line) });
    assert.equal(code, 0, err.join('\n'));
    assert.equal(out.length, 1);
    assert.equal(out[0], JSON.stringify(JSON.parse(out[0])));
    assert.deepEqual(JSON.parse(out[0]).clients, clients);
    const input = args.includes('--client') ? { all: true, client: 'codex' } : args.length ? { all: true } : {};
    const mcp = JSON.parse(await tool.handler(input, { ...deps, env: { CLAUDECODE: '1' } }));
    assert.deepEqual(mcp.clients, clients);
  }
  const errors = [];
  assert.equal(await main(['actors', '--client', 'xyz'], { ...deps, stderr: (line) => errors.push(line) }), 2);
  assert.match(errors.join('\n'), /^usage:/);
  await assert.rejects(tool.handler({ client: 'xyz' }, deps), /claude-code/);
  await assert.rejects(tool.handler({ all: 'yes' }, deps), /boolean/);
  await assert.rejects(tool.handler({ extra: true }, deps), /unknown argument/);
});

test('red quota never exposes active order text in markdown or JSON', async (t) => {
  const deps = await fixture(t);
  await orderAdd(deps.root, { text: 'Keep quota above the floor for D50' });
  const orders = await orderList(deps.root);
  assert.match(await readFile(join(deps.root, 'orders.json'), 'utf8'), /D50/);
  const now = () => Date.parse('2026-10-25T12:00:29.600Z');
  const readQuota = async () => ({ source: 'user', remainingPct: 2, recordedAt: '2026-10-25T12:00:00Z' });
  const status = await statusTable(deps.root, { ...deps, orders, now, readQuota, client: 'codex' });
  assert.match(status.markdown, /D50/);
  assert.ok(status.rows[0].cells.at(-1).endsWith('(30s)'));
  for (const locale of ['en', 'pt-BR']) {
    for (const json of [false, true]) {
      const out = [];
      assert.equal(await main(['actors', '--client', 'codex', '--locale', locale, ...(json ? ['--json'] : [])],
        { ...deps, now, readQuota, stdout: (line) => out.push(line) }), 0);
      assert.doesNotMatch(out.join('\n'), /D50/);
      const expected = locale === 'en' ? 'red; 2%; age 30s' : 'vermelho; 2%; idade 30s';
      if (json) assert.equal(JSON.parse(out[0]).actors[0].cells[5], expected);
      else assert.ok(out.some((line) => line.includes(expected)));
    }
  }
});

test('CLI markdown emits one collector call per table line', async (t) => {
  const deps = await fixture(t);
  const out = [];
  const code = await main(['actors', '--client', 'codex'], {
    ...deps, stdout: (line) => out.push(line),
  });
  assert.equal(code, 0);
  assert.equal(out.length, 6);
  assert.ok(out.every((line) => !line.includes('\n')));
  assert.match(out[0], /^\| Client \|/);
  assert.equal(out.filter((line) => line.startsWith('| codex |')).length, 4);
});
