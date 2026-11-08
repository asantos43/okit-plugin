import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { clipText, frameLines, textWidth, wrapText } from '../adapters/claude-code/panel/frame.js';
import { elapsed, formatHm, localTime, quotaBar, quotaRows, quotaTone } from '../adapters/claude-code/panel/formatters.js';
import { COMMAND, PROCESS_OPTIONS, boardLines, boardTones, loadState, parseState, viewModel } from '../adapters/claude-code/panel/panel.js';
import { createRefresh } from '../adapters/claude-code/panel/refresh.js';
import { register } from '../adapters/claude-code/panel/register.js';

const empty = JSON.parse(await readFile(new URL('./fixtures/panel-state-v1.json', import.meta.url), 'utf8'));
const populated = JSON.parse(await readFile(new URL('./fixtures/panel-state-v1-populated.json', import.meta.url), 'utf8'));
const response = state => ({ exitCode: 0, stdout: JSON.stringify(state) });
const text = result => viewModel(result, Date.parse('2026-11-06T12:00:00Z'), 'UTC').flatMap(b => [b.title, ...b.rows]).join('\n');
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

// | Source corpus | Must pass | Must refuse |
// | engine access | $.noun.event(), lexical closures | assignments and argument passing of $ |
test('entry keeps the host engine lexical to each handler', async () => {
  const source = await readFile(new URL('../adapters/claude-code/panel/register.js', import.meta.url), 'utf8');
  const escapes = /(?:=\s*\$(?![\w.])|\(\s*\$\s*\)|\(\s*\$\s*,|,\s*\$\s*[,)]|\.\.\.\$\b|return\s+\$(?![\w.]))/;
  // Handler declarations bind the host-supplied parameter; they do not pass it.
  const callSites = source.replace(/(?:async\s*)?\(\$,\s*\w+(?:,\s*\w+)?\)\s*=>/g, 'handler =>');
  assert.doesNotMatch(callSites, escapes);
  for (const safe of ['$.ui.panes()', '() => $.clock.every(ms, tick)']) assert.doesNotMatch(safe, escapes);
  for (const unsafe of ['engine = $;', 'helper($)', 'helper($, e)', 'helper(e, $)', 'return $;'])
    assert.match(unsafe, escapes);
});

test('whole boards match golden output at 40 and 80 cells', async () => {
  for (const name of ['populated', 'idle', 'failed']) {
    const state = await readFile(new URL(`./fixtures/panel-state-v1-${name}.json`, import.meta.url), 'utf8');
    for (const width of [40, 80]) {
      const lines = boardLines(parseState(state), width, Date.parse('2026-11-06T12:00:00Z'), 'UTC');
      assert.equal(lines.join('\n') + '\n', await readFile(new URL(`./fixtures/panel-board-${name}-${width}.txt`, import.meta.url), 'utf8'));
      for (const line of lines) assert.ok(textWidth(line) <= width);
    }
  }
});

test('account markers and run labels follow only each run account field', () => {
  const state = structuredClone(populated);
  state.runs = ['default', 'work', 'vendor-id'].map((account, i) => ({
    ...state.runs[0], id: `unique-${i}`, demand: null, account,
  }));
  const blocks = viewModel(parseState(JSON.stringify(state)));
  assert.match(blocks[1].rows.join('\n'), /Personal · running[\s\S]*Work · running/);
  assert.match(blocks[2].rows[0], /unique-0: live · account Personal/);
  assert.match(blocks[2].rows[2], /unique-1: live · account Work/);
  assert.match(blocks[2].rows[4], /unique-2: live · account unknown account/);
  assert.doesNotMatch(blocks[1].rows.join('\n'), /unique-|vendor-id|default/);
  state.runs = [state.runs[2]];
  assert.ok(viewModel(parseState(JSON.stringify(state)))[1].rows.filter(row => / · idle$/.test(row)).length === 2);
});

test('header readiness and launchable classes use command evidence', () => {
  const state = structuredClone(populated);
  state.launchable = [
    { account: 'work', actor_classes: ['simple', 'normal'], can_launch: true },
    { account: 'default', actor_classes: ['hard', 'critic'], can_launch: false },
  ];
  let blocks = viewModel(parseState(JSON.stringify(state)));
  assert.deepEqual(blocks[4].rows, ['simple: Work', 'normal: Work', 'hard: none', 'critic: none']);
  assert.match(blocks[0].title, /2 accounts · ready: no$/);
  state.readiness = 'Ready to launch executors: yes.';
  assert.match(viewModel(parseState(JSON.stringify(state)))[0].title, /ready: yes$/);
  assert.match(viewModel(parseState(JSON.stringify(empty)))[0].title, /0 accounts · ready: no$/);
  delete state.launchable[0].actor_classes;
  assert.equal(viewModel(parseState(JSON.stringify(state)))[4].rows[0], 'simple: none');
});

test('ported elapsed and quota formatters preserve unknown, zero and reset durations', () => {
  for (const [seconds, expected] of [[7, '0:07'], [723, '12:03'], [59.999, '0:59'], [60, '1:00'], [-1, '0:00'], [null, 'unknown']])
    assert.equal(elapsed(seconds), expected);
  assert.equal(formatHm(15300), '4h15m');
  assert.equal(formatHm(176400), '2d 1h');
  assert.equal(formatHm(162900), '1d 21h');
  assert.equal(formatHm(16559.999), '4h35m');
  assert.equal(quotaBar(null, 0), 'unknown');
  assert.equal(quotaBar({ remaining_pct: 0, resets_at: null }, 0, 'UTC'), '! [░░░░░░░░░░] 0% left reset unknown');
  assert.equal(quotaBar({ remaining_pct: 100, resets_at: null }, 0, 'UTC'), '[██████████] 100% left reset unknown');
  assert.match(quotaBar({ remaining_pct: 50, resets_at: '1970-01-01T04:15:00Z' }, 0, 'UTC'), /resets 04:15 \(in 4h15m\)/);
  assert.match(quotaBar({ remaining_pct: 50, resets_at: '1970-01-01T04:15:00Z' }, 15300001), /\(passed\)$/);
  assert.match(quotaBar({ remaining_pct: 50, resets_at: '1970-01-01T04:15:00Z' }, 15300000), /\(in 0h00m\)$/);
  for (const [remaining_pct, expected] of [[33.3333333333, 33], [1e21, 100], [-5, 0]])
    assert.match(quotaBar({ remaining_pct, resets_at: null }, 0), new RegExp(` ${expected}% left`));
});

test('quota helpers use explicit local zones, day durations, rounding and a plain low marker', () => {
  const now = Date.parse('2026-11-07T15:45:00Z');
  const session = { remaining_pct: 96.6, resets_at: '2026-11-07T20:20:00Z' };
  const week = { remaining_pct: 18, resets_at: '2026-11-09T13:00:00Z' };
  assert.equal(localTime(Date.parse(session.resets_at), now, 'UTC'), '20:20');
  assert.equal(localTime(Date.parse(session.resets_at), now, 'America/Sao_Paulo'), '17:20');
  assert.match(quotaBar(session, now, 'UTC'), /97% left resets 20:20 \(in 4h35m\)/);
  assert.match(quotaBar(week, now, 'UTC'), /^! .*18% left resets Mon 13:00 \(in 1d 21h\)/);
  for (const [pct, low] of [[19.9, true], [20, false], [0, true]])
    assert.equal(quotaBar({ remaining_pct: pct, resets_at: null }, now, 'UTC').startsWith('!'), low);
  assert.equal(localTime(Date.parse('2026-11-08T00:00:00Z'), now, 'UTC'), '00:00');
  assert.equal(formatHm(86400), '1d 0h');
  assert.equal(formatHm(86399.999), '23h59m');
});

test('quota columns align across accounts and board widths 1..240 wrap safely without ISO text', () => {
  const state = structuredClone(populated), now = Date.parse('2026-11-07T15:45:00Z');
  state.accounts[0].quota = { session: { remaining_pct: 97, resets_at: '2026-11-07T20:20:00Z' },
    weekly: { remaining_pct: 18, resets_at: '2026-11-09T13:00:00Z' } };
  state.accounts[1].quota = { session: null, weekly: { remaining_pct: 100, resets_at: null } };
  state.runs[0].last_progress = 'Checked 2026-11-07T20:20:00.000Z';
  const rows = quotaRows(state.accounts, now, 'UTC');
  assert.equal(rows[0].indexOf('['), rows[1].indexOf('['));
  assert.equal(rows[0].indexOf('['), rows[3].indexOf('['));
  assert.equal(rows[0].indexOf('97%'), rows[2].indexOf('unknown'));
  assert.equal(rows[0].indexOf('resets'), rows[1].indexOf('resets'));
  assert.equal(rows[0].indexOf('resets'), rows[3].indexOf('reset unknown'));
  const result = parseState(JSON.stringify(state));
  assert.doesNotMatch(viewModel(result, now, 'UTC').flatMap(b => b.rows).join('\n'), /\d{4}-\d\d-\d\dT/);
  for (const width of [30, 40, 80, ...Array.from({ length: 240 }, (_, i) => i + 1)]) {
    const lines = boardLines(result, width, now, 'UTC');
    assert.ok(lines.every(line => textWidth(line) <= width));
    if (width >= 80) assert.ok(lines.some(line => line.includes(rows[0])), 'render keeps column padding');
    if ([30, 40, 80].includes(width)) {
      assert.match(lines.join('\n'), /97%[\s║]*left/);
      assert.match(lines.join('\n'), /unknown/);
      assert.match(lines.join('\n'), /! week/);
    }
  }
});

test('ported clipping and frames fit narrow, wide and combining text without terminal controls', () => {
  assert.equal(clipText('abcdef', 4), 'abc…');
  assert.equal(clipText('abc', 3), 'abc');
  assert.equal(clipText('abc', 0), '');
  assert.equal(clipText('abc', 1), '…');
  assert.equal(clipText('a\nb', 5), 'a b');
  assert.equal(textWidth('กิ้'), 1);
  assert.equal(textWidth('क़'), 1);
  assert.equal(clipText('a\u202eb', 10), 'ab');
  for (const code of [0x2060, 0x2061, 0x2062, 0x2063, 0x2064, 0x180e, 0xfff9, 0xfffa, 0xfffb]) {
    const input = `a${String.fromCodePoint(code)}b`;
    assert.equal(clipText(input, 10), 'ab');
    assert.deepEqual(wrapText(input, 10), ['ab']);
  }
  for (const width of [1, 12, 39, 40, 60, 80]) {
    const lines = frameLines('okit plugin', ['界😀e\u0301 ✅ '.repeat(40), 'กิ้क़'.repeat(100), '\x1b[31m\runsafe'], width);
    for (const line of lines) assert.ok(textWidth(line) <= width);
    if (width >= 40) for (const line of lines) assert.equal(textWidth(line), width);
    else assert.ok(!lines.join('').includes('╔'));
    assert.doesNotMatch(lines.join(''), /[\x00-\x1f\x7f-\x9f]/);
  }
});

// | Wrap corpus | Must pass | Must refuse |
// | Sentence with spaces | whole words on the next row | splitting a word that fits |
// | Unbroken 100-character id | hard breaks and the three-row cap | overflow or empty rows |
test('greedy wrapping preserves fitting words and hard-breaks only oversized tokens', () => {
  const sentence = 'resets soon (in 5h00m) effort high installed';
  assert.deepEqual(wrapText(sentence, 20), ['resets soon (in', '5h00m) effort high', 'installed']);
  assert.deepEqual(wrapText('one two three', 7), ['one two', 'three']);
  assert.deepEqual(wrapText('x'.repeat(100), 40), ['x'.repeat(40), 'x'.repeat(40), 'x'.repeat(20)]);
  assert.deepEqual(wrapText('  one\n two\u202e  ', 7), ['one two']);
  assert.deepEqual(wrapText('   ', 7), []);
  for (const width of [1, 7, 20, 40, 80]) {
    for (const input of [sentence, 'x'.repeat(100), '界😀e\u0301 '.repeat(100)]) {
      const rows = wrapText(input, width);
      assert.ok(rows.length <= 3);
      assert.ok(rows.every(row => row.length > 0 && textWidth(row) <= width));
    }
  }
  assert.deepEqual(wrapText('one two three four', 6), ['one', 'two', 'three…']);
});

test('CJK wrapping at widths one through three has no empty rows or overflow', () => {
  assert.deepEqual(wrapText('界', 1), ['…']);
  for (const width of [1, 2, 3]) {
    const rows = wrapText('界界界界', width);
    assert.ok(rows.every(row => row.length > 0 && textWidth(row) <= width));
    assert.equal(rows[0], width === 1 ? '…' : '界');
  }
});

test('view model shows no runs, two accounts, failed and stale runs, and both quota windows', () => {
  assert.match(text(parseState(JSON.stringify(empty))), /No accounts\.[\s\S]*No runs\./);
  const state = structuredClone(populated);
  state.accounts[0].quota.session.remaining_pct = 0;
  state.accounts[1].quota.weekly = { remaining_pct: 75, resets_at: null };
  state.runs.push({ ...state.runs[0], id: 'failure', status: 'failed', account: 'work' },
    { ...state.runs[0], id: 'old', stale: true, account: 'removed' });
  const blocks = viewModel(parseState(JSON.stringify(state)), 0);
  assert.deepEqual(blocks.slice(1).map(b => b.title), ['ACCOUNTS', 'RUNNING', 'RECENT', 'LAUNCHABLE NOW', 'Readiness']);
  assert.equal(blocks[0].title, 'okit plugin · claude · 2 accounts · ready: no');
  assert.match(blocks[1].rows.join('\n'), /Personal · running\n! session 5h .* 0%[\s\S]*week +unknown/);
  assert.match(blocks[1].rows.join('\n'), /Work · idle\n +session 5h +unknown[\s\S]*week .*75%/);
  assert.match(blocks[3].rows.join('\n'), /failure: failed .*account Work/);
  assert.match(blocks[3].rows.join('\n'), /old: live · stale .*account unknown account/);
  assert.match(blocks[2].rows.join('\n'), /actor hard · opus · effort high · elapsed 0:02/);
  assert.match(blocks[2].rows.join('\n'), /Last progress: Running checks/);
  assert.equal(blocks[5].rows[0], state.readiness);
  assert.equal(populated.accounts[0].quota.session.remaining_pct, 80);
  const older = structuredClone(populated);
  delete older.runs[0].account;
  older.runs[0].actor = older.runs[0].effort = older.runs[0].elapsed_seconds = older.runs[0].last_progress = null;
  assert.match(text(parseState(JSON.stringify(older))), /actor -[\s\S]*effort -[\s\S]*elapsed unknown/);
  assert.match(text(parseState(JSON.stringify(older))), /Last progress: unknown/);
});

// | Corpus | Must pass | Must refuse |
// | schema | v1 Claude, null windows, additive fields | other versions/clients, malformed nested data |
// | runs | objects, null/future statuses | non-object entries (skip only) |
test('ported safe parser accepts additive data and refuses malformed states without throwing', () => {
  assert.equal(parseState(JSON.stringify({ ...empty, future: true })).ok, true);
  for (const state of [null, [], {}, { ...empty, client: 'codex' }, { ...empty, accounts: [null] },
    { ...populated, accounts: [{ ...populated.accounts[0], quota: {} }] },
    { ...empty, warnings: [null] }, { ...empty, runs: null }, { ...empty, readiness: null },
    { ...populated, accounts: [{ id: 'default', label: 'A', quota: { session: { remaining_pct: null, resets_at: null }, weekly: null } }] }])
    assert.equal(parseState(JSON.stringify(state)).ok, false);
  assert.match(text(parseState('{')), /invalid JSON/);
  assert.match(text(parseState(JSON.stringify({ ...empty, schema_version: 2 }))), /unsupported schema version/);
  assert.match(text(parseState(' '.repeat(PROCESS_OPTIONS.maxOutputBytes + 1))), /output too large/);
});

test('ported command failures become messages; the sole argv and bounds are fixed', async () => {
  assert.equal((await loadState(async (args, options) => {
    assert.deepEqual(args, ['okit-plugin', 'panel-state', '--json', '--client', 'claude']);
    assert.deepEqual(args, COMMAND);
    assert.deepEqual(options, { timeoutMs: 5000, maxOutputBytes: 1048576 });
    return response(empty);
  })).ok, true);
  for (const run of [async () => { throw new Error('ENOENT'); },
    async () => { throw new Error('timeout'); }, async () => ({ exitCode: 7, stdout: '' }),
    async () => ({ exitCode: 0, stdout: '{' }), async () => response({ ...empty, schema_version: 9 })]) {
    const result = await loadState(run);
    assert.equal(result.ok, false);
    assert.match(text(result), /State unavailable:/);
  }
});

test('unreadable runs are isolated while optional run text is normalized', () => {
  const state = structuredClone(populated);
  state.runs.push({ ...state.runs[0], id: null, model: {}, actor: 7, effort: [] },
    null, 7);
  const result = parseState(JSON.stringify(state));
  assert.equal(result.ok, true);
  assert.match(text(result), /one: live/);
  assert.match(text(result), /unknown: live .*account Personal · actor - · - · effort -/);
  assert.match(text(result), /2 runs skipped \(unreadable\)/);
});

test('null, future and non-string statuses preserve run details without skips', () => {
  for (const [status, expected] of [[null, 'unknown'], ['cancelled', 'cancelled'], [7, 'unknown']]) {
    const state = structuredClone(populated);
    state.runs[0].status = status;
    const rendered = text(parseState(JSON.stringify(state)));
    assert.match(rendered, new RegExp(`one: ${expected}`));
    assert.match(rendered, /account Personal · elapsed 0:02/);
    assert.doesNotMatch(rendered, /skipped|No runs\./);
  }
  assert.match(text(parseState(JSON.stringify({ ...empty, runs: [{}] }))), /unknown: unknown/);
});

test('skipped run counts use singular or plural and suppress the empty-run message', () => {
  for (const count of [1, 2]) {
    const rendered = text(parseState(JSON.stringify({ ...empty, runs: Array(count).fill(null) })));
    assert.ok(rendered.includes(`${count} ${count === 1 ? 'run' : 'runs'} skipped (unreadable)`));
    assert.doesNotMatch(rendered, /No runs\./);
  }
  assert.match(text(parseState(JSON.stringify(empty))), /No runs\./);
});

test('readiness, warnings and progress wrap by cells to three rows with ellipsis', () => {
  const state = structuredClone(populated);
  state.warnings = ['W'.repeat(400)];
  state.runs[0].last_progress = 'กิ้'.repeat(400);
  const blocks = viewModel(parseState(JSON.stringify(state)));
  const lines = blocks.flatMap(block => frameLines(block.title, block.rows, 60));
  assert.match(lines.join('\n'), /0\/2 accounts ready/);
  assert.equal(lines.filter(line => line.includes('WWW')).length, 3);
  assert.equal(lines.filter(line => line.includes('ก')).length, 3);
  assert.equal(lines.filter(line => line.includes('…')).length, 2);
  for (const line of lines) assert.equal(textWidth(line), 60);
});

function harness(load = async () => parseState(JSON.stringify(empty)), requestedMs = 3000) {
  let tick, cancelled = 0, visible = true;
  const published = [];
  const refresh = createRefresh({ load, publish: value => published.push(value),
    visible: async () => visible,
    clock: { every(ms, callback) {
      if (ms === 15000) return { cancel() {} };
      assert.ok(ms >= 2000); tick = callback; return { cancel() { cancelled++; } };
    } },
  }, requestedMs);
  return { refresh, published, tick: () => tick(), hide: () => { visible = false; }, cancelled: () => cancelled };
}

test('RUNNING and RECENT each keep twenty newest runs and a remainder row', () => {
  const state = structuredClone(populated);
  state.runs = Array.from({ length: 1000 }, (_, i) => ({ ...state.runs[0], id: `run-${i}`,
    started_at: new Date(i * 1000).toISOString() }));
  state.runs.push(...state.runs.map(run => ({ ...run, id: `done-${run.id}`, status: 'done' })));
  const blocks = viewModel(parseState(JSON.stringify(state)));
  assert.equal(blocks[2].rows.length, 41);
  assert.match(blocks[2].rows[0], /^run-999:/);
  assert.match(blocks[2].rows[38], /^run-980:/);
  assert.equal(blocks[2].rows.at(-1), '… 980 more runs');
  assert.equal(blocks[3].rows.length, 21);
  assert.match(blocks[3].rows[0], /^done-run-999:/);
  assert.equal(blocks[3].rows.at(-1), '… 980 more runs');
});

test('refresh intervals never fall below two seconds, including invalid values', () => {
  for (const interval of [-1, 0, 1999, 2000, 2500.1, NaN, Infinity]) {
    const h = harness(undefined, interval);
    assert.ok(h.refresh.intervalMs >= 2000);
    h.refresh.open(); h.refresh.close();
    assert.equal(h.cancelled(), 1);
  }
});

test('busy guard prevents overlap and reopen immediately loads a new generation', async () => {
  const finishes = [];
  let calls = 0;
  const h = harness(() => { calls++; return new Promise(resolve => { finishes.push(resolve); }); });
  h.refresh.open();
  h.refresh.open();
  h.tick(); h.tick(); await h.refresh.refresh();
  assert.equal(calls, 1);
  h.refresh.close(); h.refresh.open(); h.tick();
  assert.equal(calls, 2);
  finishes[0](parseState(JSON.stringify(empty))); await settle();
  assert.equal(h.published.length, 0);
  h.tick(); await settle();
  assert.equal(calls, 2);
  finishes[1](parseState(JSON.stringify(empty))); await settle();
  assert.equal(h.published.length, 1);
  h.hide(); h.tick(); await settle();
  assert.equal(h.refresh.isOpen, false);
  assert.equal(calls, 2);
  assert.equal(h.cancelled(), 2);
});

test('stale visibility results cannot close a reopened generation', async () => {
  let finishVisibility, calls = 0;
  const refresh = createRefresh({
    load: async () => { calls++; return parseState(JSON.stringify(empty)); },
    visible: () => new Promise(resolve => { finishVisibility = resolve; }),
    publish() {}, clock: { every: () => ({ cancel() {} }) },
  });
  refresh.open(); await settle();
  const pending = refresh.refresh();
  refresh.close(); refresh.open(); await settle();
  finishVisibility(false); await pending;
  assert.equal(refresh.isOpen, true);
  assert.equal(calls, 2);
  refresh.close();
});

test('refresh failures are shown and release the busy guard for recovery', async () => {
  let failed = true;
  const h = harness(async () => {
    if (failed) throw new Error('unreadable');
    return parseState(JSON.stringify(empty));
  });
  h.refresh.open(); await settle();
  assert.match(text(h.published[0]), /refresh failed/);
  failed = false;
  h.tick(); await settle();
  assert.equal(h.published[1].ok, true);
  h.refresh.close(); h.tick(); await settle();
  assert.equal(h.published.length, 2);
});

test('throwing visibility publishes a failure and permits the next refresh', async () => {
  let fail = true;
  const published = [];
  const refresh = createRefresh({
    load: async () => parseState(JSON.stringify(empty)),
    visible: async () => { if (fail) throw new Error('panes unavailable'); return true; },
    publish: value => published.push(value), clock: { every: () => ({ cancel() {} }) },
  });
  refresh.open(); await settle();
  await refresh.refresh();
  assert.equal(published.at(-1).error, 'State unavailable: refresh failed.');
  fail = false;
  await refresh.refresh();
  assert.equal(published.at(-1).ok, true);
  refresh.close();
});

test('a never-settling load times out, releases busy and ignores late results', async () => {
  const timers = [], published = [], finishes = [];
  const refresh = createRefresh({ loadTimeoutMs: 25,
    load: () => new Promise(resolve => finishes.push(resolve)),
    visible: async () => true, publish: value => published.push(value),
    clock: { every(ms, tick) {
      const timer = { ms, tick, cancelled: false, cancel() { this.cancelled = true; } };
      timers.push(timer); return timer;
    } },
  });
  refresh.open(); await settle();
  assert.deepEqual(timers.map(timer => timer.ms), [3000, 25]);
  timers[1].tick(); await settle();
  assert.equal(published[0].error, 'State unavailable: refresh timed out.');
  assert.equal(timers[1].cancelled, true);
  timers[0].tick(); await settle();
  assert.equal(finishes.length, 2);
  finishes[0](parseState(JSON.stringify(empty))); await settle();
  assert.equal(published.length, 1);
  finishes[1](parseState(JSON.stringify(empty))); await settle();
  assert.equal(published[1].ok, true);
  assert.equal(timers[2].cancelled, true);
  refresh.close();
});

test('registration catches pane API rejections as plain text', async () => {
  for (const operation of ['open', 'close', 'panes']) {
    const handlers = new Map();
    register((event, ...args) => handlers.set(event, args.at(-1)));
    const reject = async () => { throw new Error(`${operation} refused`); };
    const engine = { ui: {
      panes: operation === 'panes' ? reject : async () => operation === 'close' ? [{ id: 'okit-plugin' }] : [],
      open: operation === 'open' ? reject : async () => {},
      close: operation.endsWith('close') ? reject : async () => {},
    } };
    const result = await handlers.get('command.run')(engine, {}, () => assert.fail('unexpected next'));
    assert.deepEqual(result, { text: `okit plugin panel unavailable: ${operation} refused` });
  }
});

test('session start registers and continues after close and registration rejections', async () => {
  for (const rejectRegister of [false, true]) {
    const handlers = new Map(), calls = [], event = {};
    register((name, ...args) => handlers.set(name, args.at(-1)));
    const engine = {
      ui: { close: async () => { calls.push('close'); throw new Error('pane never open'); } },
      command: { register: async command => {
        calls.push(command.name);
        if (rejectRegister) throw new Error('registration refused');
      } },
    };
    const result = await handlers.get('session.start')(engine, event, value => {
      assert.equal(value, event); calls.push('next'); return 'continued';
    });
    assert.equal(result, 'continued');
    assert.deepEqual(calls, ['close', 'okit-panel', 'next']);
  }
});

test('rejected toggle close keeps refreshing until a successful close', async () => {
  const handlers = new Map();
  let visible = false, rejectClose = true, tick, calls = 0, cancelled = 0;
  register((name, ...args) => handlers.set(name, args.at(-1)));
  const engine = {
    process: { run: async () => { calls++; return response(empty); } },
    clock: { every(ms, callback) {
      if (ms === 15000) return { cancel() {} };
      tick = callback; return { cancel() { cancelled++; } };
    } },
    ui: {
      panes: async () => visible ? [{ id: 'okit-plugin' }] : [],
      open: async () => { visible = true; }, invalidate() {},
      close: async () => { if (rejectClose) throw new Error('close refused'); visible = false; },
    },
  };
  const toggle = () => handlers.get('command.run')(engine);
  await toggle(); await settle();
  assert.deepEqual(await toggle(), { text: 'okit plugin panel unavailable: close refused' });
  assert.equal(cancelled, 0);
  tick(); await settle();
  assert.equal(calls, 2);
  rejectClose = false;
  assert.deepEqual(await toggle(), { text: 'okit plugin panel closed.' });
  assert.equal(cancelled, 1);
});

test('quota tones use exact remaining-percent boundaries and preserve the low marker', () => {
  for (const [percent, tone] of [[100, 'ok'], [50, 'ok'], [49, 'warn'], [20, 'warn'], [19.9, 'low'], [0, 'low'], [null, 'dim']]) {
    assert.equal(quotaTone(percent), tone);
    if (percent !== null) assert.equal(quotaBar({ remaining_pct: percent, resets_at: null }, 0).startsWith('!'), tone === 'low');
  }
});

test('board metadata colors only quota rows and carries tones through wrapping without escapes', () => {
  const state = structuredClone(populated);
  state.accounts[0].quota = { session: { remaining_pct: 19.9, resets_at: null }, weekly: null };
  const result = { ok: true, state };
  for (const width of [1, 20, 39, 40, 80, 240]) {
    const lines = boardLines(result, width, 0, 'UTC');
    const tones = boardTones(result, width, 0, 'UTC');
    assert.equal(tones.length, lines.length);
    assert.ok(lines.every(line => !line.includes('\x1b')));
    const session = viewModel(result, 0, 'UTC')[1].rows[1];
    const count = wrapText(session, width < 40 ? width : width - 4).length;
    assert.equal(tones.filter(tone => tone === 'low').length, count);
    assert.ok(tones.includes('dim'));
    assert.equal(tones[0], undefined);
  }
});

test('pane Text props use host theme keys only for quota rows and honor panel.color', async () => {
  const previousH = globalThis.h;
  globalThis.h = (type, props, ...children) => ({ type, props, children });
  try {
    for (const color of [true, false]) {
      const state = structuredClone(populated), handlers = new Map();
      state.panel = { color };
      state.accounts[0].quota = { session: { remaining_pct: 50, resets_at: null }, weekly: { remaining_pct: 20, resets_at: null } };
      state.accounts[1].quota = { session: { remaining_pct: 19.9, resets_at: null }, weekly: null };
      let panes = [];
      const engine = { process: { run: async () => response(state) }, command: { register: async () => {} },
        clock: { every: () => ({ cancel() {} }) },
        ui: { close: async () => { panes = []; }, open: async pane => { panes = [pane]; },
          panes: async () => panes, invalidate() {}, resolve: () => ({ Box: 'Box', Text: 'Text' }) } };
      register((event, ...args) => handlers.set(event, args.at(-1)));
      await handlers.get('session.start')(engine, {}, value => value);
      await settle();
      for (const width of [20, 80]) {
        const tree = await handlers.get('ui.render')(engine, { props: { bodyColumns: width + 2 } });
        const expected = state.accounts.flatMap(account => [account.quota.session, account.quota.weekly])
          .map(window => ({ ok: 'success', warn: 'warning', low: 'error', dim: 'inactive' })[quotaTone(window?.remaining_pct ?? null)]);
        const blocks = viewModel({ ok: true, state });
        const rowColors = [undefined, expected[0], expected[1], undefined, expected[2], expected[3]];
        const colors = blocks.flatMap((block, index) => index === 0 ? wrapText(block.title, width).map(() => undefined)
          : [undefined, ...block.rows.flatMap((row, rowIndex) => wrapText(row, width < 40 ? width : width - 4)
            .map(() => color && index === 1 ? rowColors[rowIndex] : undefined)), ...(width < 40 ? [] : [undefined])]);
        assert.deepEqual(tree.children.map(child => child.props.color), colors);
        assert.ok(tree.children.every(child => !child.children[0].includes('\x1b')));
        if (!color) assert.ok(tree.children.every(child => !Object.hasOwn(child.props, 'color')));
      }
      await handlers.get('command.run')(engine);
    }
  } finally { globalThis.h = previousH; }
});

test('session start auto-opens by default/true, respects false and silently tolerates open failure', async () => {
  for (const setting of [undefined, true, false, 'failure']) {
    const handlers = new Map(), opened = [], commands = [];
    let panes = [], timers = 0;
    const state = structuredClone(empty);
    if (setting === undefined) delete state.panel;
    else state.panel = { autoOpen: setting !== false };
    const engine = {
      process: { run: async () => response(state) },
      command: { register: async command => commands.push(command) },
      clock: { every: () => { timers++; return { cancel() {} }; } },
      ui: { panes: async () => panes, invalidate() {}, close: async () => { panes = []; },
        open: async pane => { opened.push(pane); if (setting === 'failure') throw Error('host refused'); panes = [pane]; } },
    };
    register((event, ...args) => handlers.set(event, args.at(-1)));
    assert.equal(await handlers.get('session.start')(engine, 'event', event => event), 'event');
    await settle();
    assert.equal(commands[0].name, 'okit-panel');
    assert.equal(opened.length, setting === false ? 0 : 1);
    assert.equal(timers > 0, setting !== false && setting !== 'failure');
    if (setting === 'failure') {
      assert.match((await handlers.get('command.run')(engine)).text, /unavailable: host refused/);
      continue;
    }
    const toggle = () => handlers.get('command.run')(engine);
    if (setting === false) assert.match((await toggle()).text, /opened/);
    assert.match((await toggle()).text, /closed/);
    assert.match((await toggle()).text, /opened/);
    assert.equal(panes.length, 1);
    await toggle();
  }
});

test('ported registration opens the titled pane, renders cached data and cancels on reset', async () => {
  const hooks = [], commands = [], opened = [], closed = [];
  let tick, calls = 0, cancelled = 0, invalidated = 0, finish;
  let panes = [];
  const engine = {
    command: { register: async value => { commands.push(value); } },
    process: { run: async (args, options) => {
      assert.deepEqual(args, ['okit-plugin', 'panel-state', '--json', '--client', 'claude']);
      assert.deepEqual(options, { timeoutMs: 5000, maxOutputBytes: 1048576 });
      calls++; return new Promise(resolve => { finish = resolve; });
    } },
    clock: { every(ms, callback) {
      if (ms === 15000) return { cancel() {} };
      assert.equal(ms, 3000); tick = callback; return { cancel() { cancelled++; } };
    } },
    ui: {
      open: async value => { opened.push(value); panes = [value]; },
      close: async value => { closed.push(value); panes = []; },
      panes: async () => panes, invalidate: () => { invalidated++; },
      resolve: () => ({ Box: 'Box', Text: 'Text' }),
    },
  };
  register((event, ...args) => { hooks.push({ event, filter: args.length === 2 ? args[0] : undefined, handler: args.at(-1) }); });
  const invoke = (event, bodyColumns = 60) => {
    const current = event === 'session.start'
      ? { command: engine.command, ui: { close: engine.ui.close } }
      : event === 'ui.render' ? { ui: { resolve: engine.ui.resolve } }
        : { ...engine, ui: { ...engine.ui } };
    return hooks.find(hook => hook.event === event).handler(current, { props: { bodyColumns } }, value => value);
  };
  const previousH = globalThis.h;
  globalThis.h = (type, props, ...children) => ({ type, props, children });
  try {
    await invoke('session.start');
    assert.equal(hooks.find(hook => hook.event === 'session.start').filter, undefined);
    assert.deepEqual(hooks.find(hook => hook.event === 'ui.render').filter, { component: 'Pane', requestId: 'okit-plugin' });
    assert.equal(commands[0].name, 'okit-panel');
    await invoke('command.run');
    assert.deepEqual(opened, [{ id: 'okit-plugin', title: 'okit plugin' }]);
    assert.match(JSON.stringify(await invoke('ui.render')), /Loading state/);
    assert.equal(calls, 1);
    finish(response(populated)); await settle();
    const tree = await invoke('ui.render');
    assert.match(JSON.stringify(tree), /Personal/);
    assert.match(JSON.stringify(tree), /week +unknown/);
    for (const width of [1e21, NaN, -10]) {
      const rendered = await invoke('ui.render', width);
      const max = Number.isNaN(width) ? 80 : width < 0 ? 1 : 240;
      for (const child of rendered.children) assert.ok(textWidth(child.children[0]) <= max);
    }
    await invoke('ui.render');
    assert.equal(calls, 1);
    assert.equal(invalidated, 1);
    tick(); await settle();
    assert.equal(calls, 2);
    const staleFinish = finish;
    await invoke('session.start');
    assert.equal(cancelled, 1);
    await invoke('command.run');
    assert.equal(calls, 3);
    staleFinish(response(populated)); await settle();
    assert.match(JSON.stringify(await invoke('ui.render')), /Loading state/);
    tick(); await settle();
    assert.equal(calls, 3);
    await invoke('command.run');
    assert.deepEqual(closed, Array(3).fill({ id: 'okit-plugin' }));
    assert.equal(cancelled, 2);
    finish(response(empty)); await settle();
    await invoke('command.run');
    finish(response(populated)); await settle();
    panes = []; // Simulate closing the pane by hand before the visibility tick.
    await invoke('command.run');
    assert.equal(opened.length, 4);
    assert.equal(calls, 5);
    assert.match(JSON.stringify(await invoke('ui.render')), /Loading state/);
    finish(response(empty)); await settle();
    await invoke('command.run');
    await invoke('command.run');
    finish({ exitCode: 7, stdout: '' }); await settle();
    assert.match(JSON.stringify(await invoke('ui.render')), /State unavailable:/);
    await invoke('command.run');
  } finally {
    if (previousH === undefined) delete globalThis.h;
    else globalThis.h = previousH;
  }
});
