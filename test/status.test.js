import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { main as runMain } from '../src/cli.js';
import { inboxAdd, inboxClaim, inboxList } from '../src/inbox.js';
import { createServer } from '../src/mcp/server.js';
import { TOOLS } from '../src/mcp/tools.js';
import { CLIENT_ENV_MARKERS, detectClient, shouldShowStatus, statusTable as buildStatusTable } from '../src/status.js';
import { quotaEnv } from './helpers/env.js';

const main = (argv, io) => runMain(argv, { ...io, env: quotaEnv(io.root, io.env) });
const statusTable = (root, deps = {}) => buildStatusTable(root, {
  ...deps, env: quotaEnv(root, deps.env),
});

// Scratch state lives inside the repository, never in the system temp folder.
const TMP = fileURLToPath(new URL('../.delegate/tmp/', import.meta.url));

test('status shows holder and stale age in both languages', async (t) => {
  const root = await tempRoot(t);
  const item = await inboxAdd(root, { title: 'held' });
  const held = await inboxClaim(root, item.id, { client: 'codex', session: 's', worktree: 'wt' });
  const now = () => Date.parse(held.hold.takenAt) + 61_000;
  const config = { inbox: { holdStaleMinutes: 1 } };
  assert.match((await statusTable(root, { config, now })).markdown, /taken by codex \(wt\) since .*stale/);
  assert.match((await statusTable(root, { config, now, locale: 'pt-BR' })).markdown, /em posse de codex \(wt\) desde .*obsoleta/);
});

test('status displays qualified demands and preserves the JSON id', async (t) => {
  const root = await tempRoot(t);
  const item = await inboxAdd(root, { title: 'visible demand' });
  const bare = await statusTable(root);
  assert.equal(bare.demands[0].ref, item.id);
  await writeFile(join(root, 'project.json'), JSON.stringify({ name: 'registered' }));
  const table = await statusTable(root);
  assert.equal(table.demands[0].id, item.id);
  assert.equal(table.demands[0].ref, `${item.id} (registered)`);
  assert.ok(table.markdown.includes(`| ${item.id} (registered) | pending | visible demand |`));
  const out = [];
  assert.equal(await main(['status'], { root, stdout: (line) => out.push(line) }), 0);
  assert.ok(out.some((line) => line.includes(`${item.id} (registered)`)));
  assert.equal((await inboxList(root))[0].ref, undefined);
});

const T0 = 1_760_000_000_000;
const CLIENT_CASES = [
  [{ CLAUDECODE: '1' }, 'claude-code'],
  [{ CODEX_THREAD_ID: 'session' }, 'codex'],
  [{ CODEX_CI: '1' }, 'codex'],
  [{ OPENCODE: '1' }, 'opencode'],
  [{ OPENCODE_PID: '123' }, 'opencode'],
];

test('client marker table must pass session markers and must refuse configuration alone', () => {
  assert.deepEqual(Object.keys(CLIENT_ENV_MARKERS), ['claude-code', 'codex', 'opencode']);
  for (const [env, client] of CLIENT_CASES) {
    assert.equal(detectClient(env), client);
    assert.ok(CLIENT_ENV_MARKERS[client].some((marker) => Object.hasOwn(env, marker)));
  }
  for (const env of [{}, { CLAUDECODE: '' }, { CLAUDECODE: '0' },
    { CODEX_HOME: 'configured', OPENCODE_CONFIG_DIR: 'configured' }]) {
    assert.equal(detectClient(env), null);
  }
});

const clock = (start = T0) => {
  let at = start;
  return { now: () => at, pass: (ms) => { at += ms; } };
};

async function tempRoot(t) {
  await mkdir(TMP, { recursive: true });
  const root = await mkdtemp(join(TMP, 'status-'));
  await mkdir(join(root, 'sessions'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

/** A `readQuota` that answers from a map and counts every call it took. */
function readerOf(readings) {
  const calls = [];
  const readQuota = async (client) => {
    calls.push(client);
    return readings[client] ?? { source: 'off' };
  };
  return { readQuota, calls };
}

// The server talks over two streams, so the test drives it the way a client
// does: frames in on one side, frames out on the other.
function harness(ctx) {
  const input = new PassThrough();
  const output = new PassThrough();
  const server = createServer({ tools: TOOLS, input, output,
    ctx: { ...ctx, env: quotaEnv(ctx.root, ctx.env) }, version: '9.9.9' });
  const seen = [];
  const waiters = [];
  let buffer = '';
  let id = 0;

  output.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
      const line = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 1);
      if (line !== '') {
        const frame = JSON.parse(line);
        const waiter = waiters.shift();
        if (waiter) waiter(frame);
        else seen.push(frame);
      }
    }
  });
  server.start();

  const next = () => (seen.length > 0
    ? Promise.resolve(seen.shift())
    : new Promise((resolve) => { waiters.push(resolve); }));

  return {
    call(name, args) {
      id += 1;
      input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })}\n`);
      return next();
    },
    data: (frame) => JSON.parse(frame.result.content[0].text),
    stop: () => server.stop(),
  };
}

/** The words the Status column can hold, with the floor the brief names. */
const WORDS = ['green', 'yellow', 'red', 'off'];

test('detected client filters both rows and capacity, including unconfigured clients', async (t) => {
  const root = await tempRoot(t);
  for (const [env, client] of CLIENT_CASES) {
    const { readQuota, calls } = readerOf({});
    const table = await statusTable(root, { env, readQuota, cache: new Map(),
      clients: ['claude-code'], limits: { byClient: { codex: 1, opencode: 2 } } });
    assert.deepEqual(table.rows.map((row) => row.client), [client]);
    assert.deepEqual(calls, [client]);
    assert.ok(table.capacityLine.includes(`${client}:`));
    for (const other of ['claude-code', 'codex', 'opencode'].filter((name) => name !== client)) {
      assert.ok(!table.capacityLine.includes(`${other}:`));
      assert.ok(!table.markdown.includes(`| ${other} |`));
    }
    assert.ok(!table.markdown.includes('Client not recognized'));
  }
});

test('all overrides detection, client overrides both, and unknown detection explains selection', async (t) => {
  const root = await tempRoot(t);
  const deps = { env: { CLAUDECODE: '1' }, cache: new Map() };
  assert.equal((await statusTable(root, { ...deps, all: true })).rows.length, 3);
  assert.deepEqual((await statusTable(root, { ...deps, all: true, client: 'codex' })).rows.map((r) => r.client), ['codex']);
  for (const [locale, phrase] of [['en', /Client not recognized.*--client <name>/],
    ['pt-BR', /Cliente não reconhecido.*--client <nome>/]]) {
    const table = await statusTable(root, { env: {}, locale });
    assert.equal(table.rows.length, 3);
    assert.match(table.markdown, phrase);
  }
});

test('recorded quota keeps its real value and age across cache refreshes', async (t) => {
  const root = await tempRoot(t);
  await mkdir(join(root, 'quota'), { recursive: true });
  await writeFile(join(root, 'quota', 'claude-code.json'), JSON.stringify({
    remainingPct: 37, windowMinutes: 300, recordedAt: new Date(T0 - 120_000).toISOString(),
  }));
  const time = clock();
  const io = { root, env: { CLAUDECODE: '1' }, now: time.now, quotaCache: new Map() };
  for (const [locale, age] of [['en', '120s'], ['pt-BR', '181s']]) {
    const out = [];
    assert.equal(await main(['status', '--locale', locale], { ...io, stdout: (line) => out.push(line) }), 0);
    assert.ok(out.some((line) => line.includes(`| claude-code | 37% |`) && line.includes(`(${age})`)));
    assert.ok(!out.some((line) => /\| (codex|opencode) \|/.test(line)));
    time.pass(61_000);
  }
});

test('missing quota tells how to record it in each language', async (t) => {
  const root = await tempRoot(t);
  for (const [locale, words] of [['en', 'No quota value recorded. Record it with:'],
    ['pt-BR', 'Nenhum valor de cota registrado. Registre com:']]) {
    const table = await statusTable(root, { env: { CLAUDECODE: '1' }, locale, readQuota: async () => null, cache: new Map() });
    assert.ok(table.markdown.includes(`${words} okit-plugin quota set claude-code <pct>`));
    assert.equal(table.rows[0].fiveHour, null);
    assert.equal(table.rows[0].week, null);
    assert.ok(!table.markdown.includes('0%'));
  }
});

test('the status word follows the floor: green above it, yellow at it, red below', async (t) => {
  const root = await tempRoot(t);
  const { readQuota } = readerOf({
    'claude-code': { source: 'api', remainingPct: 80, windowMinutes: 300 },
    codex: { source: 'user', remainingPct: 22, windowMinutes: 10_080 },
    opencode: { source: 'api', remainingPct: 4, windowMinutes: 300 },
    none: { source: 'off' },
  });

  const { rows } = await statusTable(root, {
    clients: ['claude-code', 'codex', 'opencode', 'none'],
    readQuota,
    now: () => T0,
    cache: new Map(),
  });
  // The floor is 15: 30 and up is green, 15 to 29 is yellow, under 15 is red.
  assert.deepEqual(rows.map((row) => row.status), WORDS);
  assert.deepEqual(rows.map((row) => row.client), ['claude-code', 'codex', 'opencode', 'none']);

  // An `off` row is not a number, and it blocks nothing: its cells stay empty.
  assert.equal(rows[3].fiveHour, null);
  assert.deepEqual(rows[3].cells.slice(1, 4), ['-', '-', '-']);
});

test('a floor set in config moves the words with it', async (t) => {
  const root = await tempRoot(t);
  const { readQuota } = readerOf({ alpha: { source: 'api', remainingPct: 60, windowMinutes: 300 } });
  const deps = { clients: ['alpha'], readQuota, now: () => T0, cache: new Map() };

  const below = await statusTable(root, { ...deps, config: { lowQuotaPct: 50 } });
  assert.equal(below.rows[0].status, 'yellow', '60 is not 15 above a floor of 50');

  const above = await statusTable(root, { ...deps, config: { lowQuotaPct: 45 } });
  assert.equal(above.rows[0].status, 'green');
});

test('a windows array fills both columns and the reset the reader gave', async (t) => {
  const root = await tempRoot(t);
  const { readQuota } = readerOf({
    alpha: {
      source: 'api',
      windows: [
        { minutes: 300, remainingPct: 64, resetsInMinutes: 42 },
        { minutes: 10_080, remainingPct: 18, resetsInMinutes: 900 },
      ],
    },
  });
  const { rows, markdown } = await statusTable(root, {
    clients: ['alpha'], readQuota, now: () => T0, cache: new Map(),
  });

  assert.equal(rows[0].fiveHour, 64);
  assert.equal(rows[0].week, 18);
  assert.equal(rows[0].resetsInMinutes, 42, 'the 5h window is the one that resets next');
  assert.equal(rows[0].status, 'yellow', 'the tightest window decides the word');
  assert.ok(markdown.includes('| alpha | 64% | 18% | 42m | yellow | api (0s) |'), markdown);
});

test('a reading without windows lands in the column its windowMinutes names', async (t) => {
  const root = await tempRoot(t);
  const { readQuota } = readerOf({
    short: { source: 'api', remainingPct: 71, windowMinutes: 300 },
    long: { source: 'api', remainingPct: 55, windowMinutes: 10_080 },
    bare: { source: 'user', remainingPct: 33 },
  });
  const { rows } = await statusTable(root, {
    clients: ['short', 'long', 'bare'], readQuota, now: () => T0, cache: new Map(),
  });

  assert.deepEqual(
    rows.map(({ fiveHour, week }) => [fiveHour, week]),
    [[71, null], [null, 55], [null, 33]],
    'no windowMinutes means the week, which is the reading that lasts longest',
  );
  assert.equal(rows[2].resetsInMinutes, null, 'a reading with no reset says so');
});

test('a number nobody measured reads off, never a colour of its own', async (t) => {
  const root = await tempRoot(t);
  const cases = [
    [{ source: 'api', remainingPct: Number.NaN }, 'off', 'NaN is not a percentage'],
    [{ source: 'api', remainingPct: Infinity }, 'off', 'an infinite percentage is not one either'],
    [{ source: 'off', remainingPct: 90 }, 'off', 'the source off wins over the number'],
    [{ source: 'user' }, 'off', 'no number and no window is nothing to show'],
    [{ source: 'api', windows: [{ minutes: 300, remainingPct: '50' }] }, 'off', 'a window of text is not a window'],
    [{ source: 'api', windows: [null, {}, 7] }, 'off', 'junk in the array is skipped, not trusted'],
  ];
  for (const [reading, want, why] of cases) {
    const { rows } = await statusTable(root, {
      clients: ['alpha'],
      readQuota: async () => reading,
      now: () => T0,
      cache: new Map(),
    });
    assert.equal(rows[0].status, want, why);
    assert.equal(rows[0].fiveHour, null, why);
  }
});

test('a red row quotes the standing order about the floor, or lowQuotaPct', async (t) => {
  const root = await tempRoot(t);
  const { readQuota } = readerOf({ alpha: { source: 'api', remainingPct: 3, windowMinutes: 300 } });
  const deps = { clients: ['alpha'], readQuota, now: () => T0, cache: new Map() };

  const bare = await statusTable(root, deps);
  assert.equal(bare.rows[0].cells[4], 'red: lowQuotaPct is 15%');

  const ordered = await statusTable(root, {
    ...deps,
    orders: [{ text: 'never push to main' }, { text: 'stop below the quota floor' }],
  });
  assert.equal(ordered.rows[0].cells[4], 'red: stop below the quota floor');

  // A green row quotes nothing: the reason only matters when the floor is hit.
  const green = await statusTable(root, {
    ...deps,
    cache: new Map(),
    readQuota: async () => ({ source: 'api', remainingPct: 90 }),
  });
  assert.equal(green.rows[0].cells[4], 'green');
});

test('the capacity line counts the room the live runs leave, never below zero', async (t) => {
  const root = await tempRoot(t);
  const { readQuota } = readerOf({ alpha: {}, beta: {} });
  const deps = {
    clients: ['alpha', 'beta'],
    readQuota,
    now: () => T0,
    cache: new Map(),
    limits: { limits: { global: 3, clients: { beta: 100 } }, live: 2, byClient: { alpha: 2 } },
  };
  const table = await statusTable(root, deps);
  // alpha leaves 3 - 2 = 1 slot, beta leaves 3 - 0 = 3; the tightest is 1.
  assert.equal(
    table.capacityLine,
    'executors that can launch now: alpha: 2/3 (default), 1 available; beta: 0/100 (client), 100 available; quota floor 15%',
  );

  const full = await statusTable(root, {
    ...deps,
    limits: { limits: { global: 2, clients: {} }, live: 4, byClient: { alpha: 2, beta: 2 } },
  });
  assert.equal(
    full.capacityLine,
    'executors that can launch now: alpha: 2/2 (default), 0 available; beta: 2/2 (default), 0 available; quota floor 15%',
    'a cap that is already crossed reads as zero, never as a negative room',
  );
});

test('status translates client sources and legacy configuration warnings', async (t) => {
  const root = await tempRoot(t);
  const deps = { clients: ['codex'], readQuota: async () => null, cache: new Map(),
    config: { limits: { global: 4, perClient: 2, clients: { codex: 100, future: 1 } } } };
  const en = await statusTable(root, deps);
  assert.match(en.capacityLine, /codex: 0\/100 \(client\)/);
  assert.match(en.capacityLine, /deprecated; used as limits.global/);
  assert.match(en.capacityLine, /unknown client: future/);
  const pt = await statusTable(root, { ...deps, locale: 'pt-BR' });
  assert.match(pt.capacityLine, /codex: 0\/100 \(própria\)/);
  assert.match(pt.capacityLine, /obsoleto; usado como limits.global/);
  assert.match(pt.capacityLine, /cliente desconhecido: future/);
});

test('a reading is read once inside the TTL and read again after it', async (t) => {
  const root = await tempRoot(t);
  const time = clock();
  const { readQuota, calls } = readerOf({ alpha: { source: 'api', remainingPct: 50, windowMinutes: 300 } });
  const deps = { clients: ['alpha'], readQuota, now: time.now, cache: new Map() };

  await statusTable(root, deps);
  time.pass(59_000);
  await statusTable(root, deps);
  assert.deepEqual(calls, ['alpha'], 'the second call inside the TTL reads nothing');

  time.pass(2_000);
  await statusTable(root, deps);
  assert.deepEqual(calls, ['alpha', 'alpha'], 'past the TTL the client is asked again');
});

test('the age of a reading is the clock, and two roots never trade one', async (t) => {
  const root = await tempRoot(t);
  const other = await tempRoot(t);
  const time = clock();
  const { readQuota, calls } = readerOf({ alpha: { source: 'user', remainingPct: 90, windowMinutes: 300 } });
  const deps = { clients: ['alpha'], readQuota, now: time.now, cache: new Map() };

  const first = await statusTable(root, deps);
  time.pass(5_000);
  const again = await statusTable(root, deps);
  assert.equal(first.rows[0].readAt, T0, 'the reading was taken once and stays that old');
  assert.equal(again.rows[0].cells[5], 'user (5s)', 'the age keeps counting while the reading is cached');

  await statusTable(other, deps);
  assert.deepEqual(calls, ['alpha', 'alpha'], 'another root reads its own number');
});

test('shouldShowStatus is true for size L, two slices or more than one executor', () => {
  const must = [
    [{ size: 'L' }, true, 'size L'],
    [{ size: 'L', slices: 1, executors: 1 }, true, 'one fact is enough'],
    [{ slices: 2 }, true, 'two slices'],
    [{ slices: 9 }, true, 'many slices'],
    [{ executors: 2 }, true, 'two executors'],
    [{ size: 'M', slices: 1, executors: 1 }, false, 'one small step on one executor'],
    [{ size: 'S' }, false, 'a small task'],
    [{ slices: 1 }, false, 'a single slice'],
    [{ slices: 0, executors: 1 }, false, 'no slice, no second executor'],
    [{ size: 's' }, false, 'a lowercase s is not the L of the scale'],
    [{}, false, 'nothing said, nothing shown'],
  ];
  for (const [input, expected, why] of must) {
    assert.equal(shouldShowStatus(input), expected, why);
  }
});

test('pt-BR translates the same table, and an unknown locale falls back to en', async (t) => {
  const root = await tempRoot(t);
  const { readQuota } = readerOf({
    alpha: { source: 'api', remainingPct: 12, windowMinutes: 300, resetsInMinutes: 3 },
  });
  const deps = { clients: ['alpha'], readQuota, now: () => T0, cache: new Map() };

  const pt = await statusTable(root, { ...deps, locale: 'pt-BR' });
  assert.ok(pt.markdown.startsWith('| Assinatura | Restante 5h | Restante semana |'), pt.markdown);
  assert.ok(pt.markdown.includes('| alpha | 12% | - | 3m | vermelho: lowQuotaPct é 15% | api (0s) |'), pt.markdown);
  assert.equal(pt.capacityLine, 'executores que podem iniciar agora: alpha: 0/3 (padrão), 3 disponíveis; piso de cota 15%');
  assert.equal(pt.rows[0].order, 'lowQuotaPct é 15%', 'the floor is quoted in the same language');

  const unknown = await statusTable(root, { ...deps, locale: 'fr' });
  const en = await statusTable(root, deps);
  assert.equal(unknown.markdown, en.markdown, 'a locale we do not have prints the English table');
});

// A Markdown row is the number of its separators; a cell holding one would lie.
const separators = (line) => (line.match(/(?<!\\)\|/g) ?? []).length;

test('a quoted order with a bar and a newline cannot break the table', async (t) => {
  const root = await tempRoot(t);
  const { readQuota } = readerOf({ alpha: { source: 'api', remainingPct: 3, windowMinutes: 300 } });
  const { markdown } = await statusTable(root, {
    clients: ['alpha'],
    readQuota,
    now: () => T0,
    cache: new Map(),
    orders: [{ text: 'keep quota | above 20\nplease' }],
  });

  const lines = markdown.split('\n').filter((line) => line.startsWith('|'));
  const expected = separators(lines[0]);
  assert.ok(markdown.includes('keep quota \\| above 20 please'), markdown);
  for (const line of lines) {
    assert.equal(separators(line), expected, `every line keeps ${expected} columns: ${line}`);
  }
  assert.equal(lines.length, 3, 'the order stays on one row instead of adding a line');
});

test('okit-plugin status prints the table and the capacity line, in either language', async (t) => {
  const root = await tempRoot(t);
  const { readQuota } = readerOf({ alpha: { source: 'api', remainingPct: 77, windowMinutes: 300 } });
  const io = { root, env: {}, readQuota, now: () => T0, clients: ['alpha'], quotaCache: new Map() };
  const cli = async (argv) => {
    const out = [];
    const code = await main(argv, { ...io, stdout: (line) => out.push(line), stderr: () => {} });
    return { code, out };
  };

  const run = await cli(['status']);
  assert.equal(run.code, 0);
  assert.deepEqual(run.out.slice(0, 2), [
    '| Subscription | 5h remaining | Week remaining | Resets in | Status | Source (age) |',
    '| --- | --- | --- | --- | --- | --- |',
  ]);
  assert.equal(run.out[2], '| alpha | 77% | - | - | green | api (0s) |');
  assert.ok(run.out.includes('executors that can launch now: alpha: 0/3 (default), 3 available; quota floor 15%'));

  const pt = await cli(['status', '--locale=pt-BR']);
  assert.ok(pt.out[0].startsWith('| Assinatura |'), pt.out[0]);
  assert.ok(pt.out.some((line) => line.startsWith('executores que podem iniciar agora:')));

  // The flag is the only argument, and an unknown one is a refusal.
  assert.equal((await cli(['status', '--nope'])).code, 2);
  assert.equal((await cli(['status', '--locale', 'fr'])).code, 2);
});

test('CLI selection must pass all/client and must refuse unknown clients and incomplete flags', async (t) => {
  const root = await tempRoot(t);
  const cases = [
    [[], ['claude-code']],
    [['--all'], ['claude-code', 'codex', 'opencode']],
    [['--client', 'codex'], ['codex']],
    [['--client=opencode'], ['opencode']],
    [['--all', '--client', 'codex'], ['codex']],
  ];
  for (const [args, clients] of cases) {
    const out = [];
    assert.equal(await main(['status', ...args], { root, env: { CLAUDECODE: '1' },
      stdout: (line) => out.push(line), quotaCache: new Map() }), 0);
    assert.deepEqual(out.filter((line) => /^\| (claude-code|codex|opencode) \|/.test(line))
      .map((line) => line.split('|')[1].trim()), clients);
  }
  for (const args of [['--client'], ['--client', 'unknown'], ['--client='], ['--all=true']]) {
    assert.equal(await main(['status', ...args], { root, env: {}, stdout: () => {}, stderr: () => {} }), 2);
  }
});

test('okit-plugin status outside a client explains how to select and record quota', async (t) => {
  const root = await tempRoot(t);
  const out = [];
  const code = await main(['status'], {
    root,
    env: {},
    now: () => T0,
    stdout: (line) => out.push(line),
    stderr: (line) => out.push(line),
  });
  assert.equal(code, 0);
  assert.ok(out[0].startsWith('| Subscription |'), out[0]);
  for (const client of ['claude-code', 'codex', 'opencode']) {
    assert.ok(out.some((line) => line.includes(`| ${client} |`)), `${client} has a row`);
  }
  assert.equal(out.filter((line) => line.includes('No quota value recorded.')).length, 3);
  assert.ok(out.some((line) => line.includes('Client not recognized.')));
  assert.ok(out.some((line) => line.includes('--client <name>')));
});

test('MCP status detects each client and accepts all/client with argument checks', async (t) => {
  const root = await tempRoot(t);
  for (const [env, client] of CLIENT_CASES) {
    const server = harness({ root, env, quotaCache: new Map() });
    t.after(() => server.stop());
    const plain = server.data(await server.call('status', {}));
    assert.deepEqual(plain.rows.map((r) => r.client), [client]);
    assert.equal((server.data(await server.call('status', { all: true }))).rows.length, 3);
    const forced = server.data(await server.call('status', { client: 'codex' }));
    assert.deepEqual(forced.rows.map((r) => r.client), ['codex']);
    assert.ok(!forced.capacityLine.includes('opencode:'));
    for (const args of [{ all: 'true' }, { all: null }, { client: 'unknown' }]) {
      assert.equal((await server.call('status', args)).result.isError, true);
    }
  }
});

test('the MCP status tool answers the table and only adds showBefore when asked', async (t) => {
  const root = await tempRoot(t);
  await mkdir(join(root, 'quota'), { recursive: true });
  await writeFile(join(root, 'quota', 'claude-code.json'), JSON.stringify({ remainingPct: 41, windowMinutes: 300 }), 'utf8');
  await writeFile(join(root, 'config.json'), JSON.stringify({ lowQuotaPct: 15 }), 'utf8');
  const server = harness({ root, now: () => T0 });

  const plain = server.data(await server.call('status', {}));
  assert.equal(plain.rows[0].client, 'claude-code');
  assert.equal(plain.rows[0].fiveHour, 41, 'the number comes from the adapter reading of this root');
  assert.equal(plain.rows[0].status, 'green');
  assert.equal(plain.showBefore, undefined, 'no showBefore without the three facts');
  assert.equal(plain.capacityLine, 'executors that can launch now: claude-code: 0/3 (default), 3 available; codex: 0/3 (default), 3 available; opencode: 0/3 (default), 3 available; quota floor 15%');

  const big = server.data(await server.call('status', { size: 'L' }));
  assert.equal(big.showBefore, true);
  const small = server.data(await server.call('status', { slices: 1, executors: 1, locale: 'pt-BR' }));
  assert.equal(small.showBefore, false);
  assert.ok(small.markdown.startsWith('| Assinatura |'), small.markdown);

  assert.equal((await server.call('status', { nope: 1 })).result.isError, true);
  assert.equal((await server.call('status', { size: 'XL' })).result.isError, true);
  assert.equal((await server.call('status', { slices: -1 })).result.isError, true);
  await server.stop();
  assert.ok(root);
});
