import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readQuota } from '../adapters/opencode/index.js';
import { readOpencodeSource } from '../adapters/opencode/quota-source.js';
import { DEFAULT_CONFIG, configOf } from '../src/profiles.js';
import { main } from '../src/cli.js';
import { statusTable } from '../src/status.js';
import { writeJsonAtomic } from '../src/state.js';

const time = Date.parse('2026-10-26T12:00:00Z');
const sample = (pct = 65) => ({ version: 1, company: 'example', source: 'test', read_at: time / 1000,
  five_hour: { remaining_percent: pct, reset_at: time / 1000 + 3600 },
  weekly: { remaining_percent: 40, reset_at: null } });
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'okit-quota-source-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeJsonAtomic(join(root, 'quota/opencode.json'), { remainingPct: 87 });
  const file = join(root, 'source.json');
  await writeFile(file, JSON.stringify(sample()));
  return { root, file, opts: { stateRoot: root, env: { HOME: '', TEST_QUOTA: 'present' }, now: () => time + 60_000 } };
}

test('file and command sources choose the tightest provider and window, with inherited environment', async (t) => {
  const { file, opts } = await fixture(t);
  const script = join(opts.stateRoot, 'source');
  const commandFile = join(opts.stateRoot, 'command.json');
  await writeFile(commandFile, JSON.stringify(sample(12)));
  await writeFile(script, '#!/bin/sh\n[ "$TEST_QUOTA" = present ] && [ "$HOME" = "" ] || exit 1\ncat "$1"\n', { mode: 0o700 });
  const command = [script, commandFile];
  const config = { opencodeQuota: { sources: { fileProvider: { file }, commandProvider: { command } } } };
  const reading = await readQuota({ ...opts, config });
  assert.equal(reading.source, 'automatic');
  assert.equal(reading.provider, 'commandProvider');
  assert.equal(reading.remainingPct, 12);
  assert.equal(reading.windowMinutes, 300);
  assert.equal(reading.ageMinutes, 1);
  assert.equal(reading.windows.length, 2);
  const fileReading = await readQuota({ ...opts, config: { opencodeQuota: { sources: { fileProvider: { file } } } } });
  assert.equal(fileReading.remainingPct, 40);
  assert.equal(fileReading.windowMinutes, 10080);
  assert.equal(fileReading.windows[1].resetsAt, null);
  assert.equal((await readQuota(opts)).remainingPct, 87);
});

// | Must pass | Must refuse |
// | valid version and at least one valid window | bad JSON/version/percent/error/old/oversized/slow |
test('invalid or unavailable sources fall back to the manual reading', async (t) => {
  const { file, opts } = await fixture(t);
  const cases = ['bad json', { ...sample(), version: undefined }, { ...sample(), version: 2 },
    sample(-1), sample(101), sample(2.5), { ...sample(), error: 'unavailable' },
    { ...sample(), read_at: time / 1000 - 121 * 60 },
    { ...sample(), five_hour: null, weekly: null },
    { ...sample(), five_hour: { remaining_percent: 50 } }];
  for (const value of cases) {
    await writeFile(file, typeof value === 'string' ? value : JSON.stringify(value));
    const result = await readQuota({ ...opts, config: { opencodeQuota: { sources: { example: { file } } } } });
    assert.equal(result.source, 'user', JSON.stringify(value));
    assert.equal(result.remainingPct, 87);
  }
});

test('commands are killed on timeout and excessive output; failures never throw', async (t) => {
  const { file, opts } = await fixture(t);
  const scripts = ['exec sleep 5', 'printf "%010000d" 0', 'exit 1', 'printf "bad json"'];
  const commands = [];
  for (const [index, content] of scripts.entries()) {
    const script = join(opts.stateRoot, `fake-${index}`);
    await writeFile(script, `#!/bin/sh\n${content}\n`, { mode: 0o700 });
    commands.push({ command: [script] });
  }
  for (const source of [
    ...commands,
    { command: [join(opts.stateRoot, 'missing')] }, { file }, { file: `${file}.missing` },
  ]) {
    const result = await readQuota({ ...opts, config: { opencodeQuota: {
      sources: { example: source }, timeoutMs: 200, maxOutputBytes: 100 } } });
    assert.equal(result.source, 'user');
    assert.equal(result.remainingPct, 87);
  }
});

// | Must pass | Must refuse |
// | recent complete high-quota JSON, exit 0 | same JSON, exit 1 |
test('valid output from a failed command is refused and uses the manual quota', async (t) => {
  const { opts } = await fixture(t);
  const json = JSON.stringify({ ...sample(95), weekly: { remaining_percent: 90, reset_at: null } });
  const config = { opencodeQuota: { sources: { example: {
    command: ['sh', '-c', 'printf "%s" "$1"; exit "$2"', 'quota', json, '0'],
  } } } };
  assert.equal((await readOpencodeSource({ ...opts, config })).remainingPct, 90);
  config.opencodeQuota.sources.example.command[5] = '1';
  assert.equal(await readOpencodeSource({ ...opts, config }), null);
  const result = await readQuota({ ...opts, config });
  assert.equal(result.source, 'user');
  assert.equal(result.remainingPct, 87);
});

// | Must pass | Must refuse |
// | valid JSON and prompt exit | valid JSON followed by sleep beyond timeout |
test('valid output before sleep still obeys the command timeout and leaves no process', async (t) => {
  const { root, opts } = await fixture(t);
  const pidFile = join(root, 'sleep.pid');
  const json = JSON.stringify({ ...sample(95), weekly: { remaining_percent: 90, reset_at: null } });
  const killSleeper = async () => {
    const pid = Number(await readFile(pidFile, 'utf8'));
    try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  const watchdog = setTimeout(() => { killSleeper().catch(() => {}); }, 2000);
  t.after(() => clearTimeout(watchdog));
  const config = { opencodeQuota: { timeoutMs: 200, sources: { example: {
    command: ['sh', '-c', 'echo $$ > "$2"; printf "%s" "$1"; exec sleep 5', 'quota', json, pidFile],
  } } } };
  const start = performance.now();
  const result = await readOpencodeSource({ ...opts, config });
  clearTimeout(watchdog);
  assert.equal(result, null);
  assert.ok(performance.now() - start < 1500, 'configured 200 ms timeout must beat the 2 s cleanup watchdog');
  const pid = Number(await readFile(pidFile, 'utf8'));
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

// | Must pass | Must refuse |
// | bilingual reason with configured invalid sources | reason without configured sources |
test('fallback reason is bilingual with and without a saved manual value, only for configured sources', async (t) => {
  const { root, file, opts } = await fixture(t);
  await writeFile(file, 'bad json');
  const config = { opencodeQuota: { sources: { example: { file } } } };
  for (const saved of [true, false]) {
    if (!saved) await rm(join(root, 'quota/opencode.json'));
    const result = await readQuota({ ...opts, config });
    assert.equal(result.source, 'user');
    assert.equal(result.remainingPct, saved ? 87 : undefined);
    assert.match(result.reason, /The sources provided no recent valid reading; using the manual value when available\./);
    assert.match(result.reason, /As fontes não forneceram leitura válida recente; usando o valor manual quando disponível\./);
    for (const unconfigured of [undefined, { opencodeQuota: { sources: {} } }]) {
      assert.equal(Object.hasOwn(await readQuota({ ...opts, config: unconfigured }), 'reason'), false);
    }
  }
});

test('contract fields and window lengths come from configuration', async (t) => {
  const { file, opts } = await fixture(t);
  await writeFile(file, JSON.stringify({ v: 1, company: 'test', source: 'test', at: time / 1000,
    short: { left: 22, reset: null } }));
  const result = await readQuota({ ...opts, config: { opencodeQuota: {
    sources: { example: { file } }, fields: { version: 'v', readAt: 'at', remainingPercent: 'left', resetAt: 'reset' },
    windows: { short: 17 } } } });
  assert.equal(result.remainingPct, 22);
  assert.equal(result.windowMinutes, 17);
});

test('configuration rejects invalid limits, sources, fields and windows', () => {
  assert.deepEqual(configOf().opencodeQuota.sources, {});
  for (const setting of [{ timeoutMs: 0 }, { maxOutputBytes: -1 }, { maxAgeMinutes: 0 },
    { sources: [] }, { sources: { example: { command: [] } } },
    { sources: { example: { file: 'x', command: ['x'] } } },
    { fields: { version: '' } }, { windows: {} }, { windows: { short: -1 } }]) {
    assert.throws(() => configOf({ opencodeQuota: setting }));
  }
  assert.equal(DEFAULT_CONFIG.opencodeQuota.version, 1);
});

test('quota show and status display automatic source, age and provider in both languages', async (t) => {
  const { root, file, opts } = await fixture(t);
  const config = { configuredClients: ['opencode'], opencodeQuota: { sources: { example: { file } } } };
  await writeJsonAtomic(join(root, 'config.json'), config);
  const output = [];
  assert.equal(await main(['quota', 'show', 'opencode'], { root, env: opts.env, now: opts.now,
    stdout: (line) => output.push(line) }), 0);
  assert.match(output.join('\n'), /automatic.*1 minute ago.*provider: example.*automática.*há 1 minuto.*provedor: example/);
  for (const locale of ['en', 'pt-BR']) {
    const { adapterQuotaReader } = await import('../src/status.js');
    const report = await statusTable(root, { config, clients: ['opencode'], locale, now: opts.now,
      readQuota: adapterQuotaReader({ ...opts, config }), cache: new Map() });
    assert.match(report.markdown, /example/);
    assert.match(report.markdown, locale === 'en' ? /automatic.*1 minute ago/ : /automática.*há 1 minuto/);
  }
});
