import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, readdir, writeFile, readFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { record, exportTelemetry, check, status, validateEndpoint, configure } from '../src/telemetry/index.js';
import { privateField, redact } from '../src/telemetry/catalog.js';
import { settings } from '../src/telemetry/config.js';
import { inboxAdd, inboxSetStatus } from '../src/inbox.js';
import { writeArtifacts } from '../src/smoke/report.js';
import { main } from '../src/cli.js';
import { TOOLS } from '../src/mcp/tools.js';

async function rootOf(t, telemetry) {
  const root = await mkdtemp(join(tmpdir(), 'plugin-telemetry-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  if (telemetry) await writeFile(join(root, 'config.json'), JSON.stringify({ telemetry: {
    enabled: true, kitExecutable: 'missing-telemetry-test-kit', ...telemetry } }));
  return root;
}
const exportsOf = root => readdir(join(root, 'telemetry'));

test('off by default writes nothing, including export, and defaults never enable sending', async t => {
  const root = await rootOf(t);
  assert.equal(await record(root, 'demand.status', { state: 'pending' }), false);
  assert.equal((await exportTelemetry(root)).count, 0);
  assert.equal((await settings(root)).rede.ligado, false);
  assert.deepEqual(await readdir(root), []);
  await configure(root, 'enabled', true);
  await record(root, 'quota.check', { count: 1 });
  // An absent endpoint must never be touched while the independent switch is off.
  assert.deepEqual((await exportTelemetry(root)).network, { count: 0, statusCode: null });
});

// | corpus | must pass | must refuse |
// | fields | finite counts; known state; model names | private keys, objects, paths |
// | URL | HTTPS; loopback HTTP | public HTTP, credentials, other protocols |
test('private keys, demand content, prompts and paths are dropped', () => {
  const fields = { count: 2, durationMs: 4, state: 'pending', model: 'provider/model',
    prompt: 'PRIVATE', prompts: 'PRIVATE', content: 'PRIVATE', body: 'PRIVATE',
    title: 'PRIVATE', path: 'PRIVATE', files: { text: 'PRIVATE' }, demand: 'PRIVATE',
    headers: 'PRIVATE', project: 'PRIVATE', endpoint: 'PRIVATE', privateField: 'PRIVATE' };
  for (const key of ['prompt', 'content', 'body', 'path', 'headers']) assert.equal(privateField(key), true);
  assert.deepEqual(redact('demand.status', fields), { count: 2, durationMs: 4, state: 'pending', model: 'provider/model' });
});

test('enabled records an actual lifecycle and smoke report without their contents', async t => {
  const root = await rootOf(t, {});
  const item = await inboxAdd(root, { title: 'SECRET_TITLE', body: 'SECRET_BODY', client: 'codex' });
  for (const state of ['delegated', 'criticised', 'consolidated']) await inboxSetStatus(root, item.id, state);
  await writeArtifacts(root, 'test', { client: 'codex' }, [], {});
  const result = await exportTelemetry(root);
  assert.equal(result.count, 5);
  assert.doesNotMatch(JSON.stringify(result), /SECRET|inboxId|\/tmp\/|\.okwork/);
  const metrics = result.resourceMetrics.map(r => r.scopeMetrics[0].metrics[0]);
  assert.equal(metrics.filter(m => m.name.endsWith('demand.status')).length, 4);
  assert.ok(metrics.some(m => m.name.endsWith('smoke.report')));
  for (const resource of result.resourceMetrics) assert.match(resource.resource.attributes[1].value.stringValue, /^[a-f0-9]{64}$/);
  assert.equal((await check(root)).ok, true);
  assert.equal((await status(root)).lastExport.count, 5);
});

test('untrusted values cannot cross the file boundary', async t => {
  const root = await rootOf(t, {});
  await record(root, 'demand.status', { count: Infinity, state: 'secret', client: '/private/file', prompt: 'SECRET' });
  assert.equal(await record(root, 'unknown.event', { count: 1 }), false);
  assert.doesNotMatch(JSON.stringify(await exportTelemetry(root)), /SECRET|private|secret|Infinity/);
});

test('retention removes old files and storage stays below its configured cap', async t => {
  const root = await rootOf(t, { retentionDays: 1, maxBytes: 1400 });
  await record(root, 'quota.check', { count: 1 });
  const old = (await exportsOf(root)).find(n => n.endsWith('.json'));
  await utimes(join(root, 'telemetry', old), new Date(0), new Date(0));
  await record(root, 'quota.check', { count: 2 });
  assert.ok(!(await exportsOf(root)).includes(old));
  for (let i = 0; i < 5; i++) await record(root, 'quota.check', { count: i });
  assert.ok((await status(root)).sizeBytes <= 1400);
  assert.ok((await status(root)).sizeBytes > 0);
});

test('retention by age prunes an expired file while a fresh file stays under the size cap', async t => {
  const root = await rootOf(t, { retentionDays: 1, maxBytes: 10_000_000 });
  await record(root, 'quota.check', { count: 1 });
  const old = (await exportsOf(root)).find(name => name.endsWith('.json'));
  await utimes(join(root, 'telemetry', old), new Date(0), new Date(0));
  await record(root, 'quota.check', { count: 2 });
  const remaining = (await exportsOf(root)).filter(name => name.endsWith('.json'));
  assert.equal(remaining.length, 1);
  assert.equal(remaining.includes(old), false);
  assert.match(remaining[0], /^okit-plugin-/);
});

test('file and total size caps refuse oversized measurements without writing a JSON file', async t => {
  for (const limits of [{ maxFileBytes: 10 }, { maxBytes: 10 }]) {
    const root = await rootOf(t, limits);
    assert.equal(await record(root, 'quota.check', { count: 1 }), false);
    assert.deepEqual((await readdir(root)).filter(name => name.startsWith('okit-plugin-') && name.endsWith('.json')), []);
  }
});

test('kit file destination and retention are reused without inheriting consent or network', async t => {
  const root = await rootOf(t, {});
  const file = join(root, 'kit.json');
  await writeFile(file, JSON.stringify({ telemetry: { enabled: true, destination: 'file', dir: 'shared',
    retentionDays: 2, rede: { ligado: true, endpoint: 'http://public.invalid' } } }));
  await writeFile(join(root, 'config.json'), JSON.stringify({ telemetry: { enabled: true, kitConfigFile: file } }));
  assert.equal((await settings(root)).dir, join(root, 'shared'));
  assert.equal((await settings(root)).retentionDays, 2);
  assert.equal((await settings(root)).rede.ligado, false);
  assert.equal(await record(root, 'quota.check'), true);
});

test('kit command destination and retention are reused unless plugin values override them', async t => {
  const root = await rootOf(t);
  const fake = join(root, 'fake-kit');
  const kitConfig = { enabled: true, destination: 'file', dir: 'kit-measurements', retentionDays: 3 };
  await writeFile(fake, `#!/bin/sh\nprintf '%s' '${JSON.stringify(kitConfig)}'\n`, { mode: 0o755 });
  await writeFile(join(root, 'config.json'), JSON.stringify({ telemetry: { enabled: true, kitExecutable: fake } }));
  let config = await settings(root);
  assert.equal(config.dir, join(root, kitConfig.dir));
  assert.equal(config.retentionDays, kitConfig.retentionDays);

  await writeFile(join(root, 'config.json'), JSON.stringify({ telemetry: { enabled: true,
    kitExecutable: fake, dir: 'plugin-measurements', retentionDays: 8 } }));
  config = await settings(root);
  assert.equal(config.dir, join(root, 'plugin-measurements'));
  assert.equal(config.retentionDays, 8);
});

test('export --since filters timestamps; check flags corrupted or injected files', async t => {
  const root = await rootOf(t, {});
  const now = Date.now();
  await record(root, 'quota.check', {}, { now: now - 10000 });
  await record(root, 'quota.check', {}, { now });
  assert.equal((await exportTelemetry(root, { since: new Date(now - 1000).toISOString() })).count, 1);
  await assert.rejects(exportTelemetry(root, { since: 'yesterday' }));
  const file = join(root, 'telemetry', 'okit-plugin-corrupt.json');
  await writeFile(file, '{');
  assert.equal((await check(root)).corrupted, 1);
  await assert.rejects(exportTelemetry(root));
  const valid = (await exportsOf(root)).find(n => n !== 'okit-plugin-corrupt.json' && n.endsWith('.json'));
  const injected = JSON.parse(await readFile(join(root, 'telemetry', valid), 'utf8'));
  injected.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.dataPoints[0].attributes.push({ key: 'prompt', value: { stringValue: 'SECRET' } });
  await writeFile(file, JSON.stringify(injected));
  assert.equal((await check(root)).corrupted, 1);
});

test('endpoint corpus permits secure transport and refuses public HTTP', () => {
  for (const url of ['https://example.test/v1/metrics', 'http://localhost:1234', 'http://127.0.0.1', 'http://[::1]']) assert.ok(validateEndpoint(url));
  for (const url of ['http://example.test', 'http://127.0.0.1.evil.test', 'file:///tmp/x', 'https://user:pass@example.test']) assert.throws(() => validateEndpoint(url));
});

test('fake localhost sees no request by default and only aggregate counts after opt-in', async t => {
  const received = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    received.push({ body: JSON.parse(body), headers: req.headers }); res.writeHead(200); res.end();
  });
  try { server.listen(0, '127.0.0.1'); await once(server, 'listening'); }
  catch (err) { if (err.code === 'EPERM') { t.skip('not run in sandbox: listen EPERM'); return; } throw err; }
  t.after(() => new Promise(resolve => server.close(resolve)));
  const root = await rootOf(t, { rede: { endpoint: `http://127.0.0.1:${server.address().port}`, cabecalhos: { 'x-secret': 'SECRET' } } });
  await record(root, 'profile.choice', { model: 'private-model', client: 'codex' });
  await exportTelemetry(root);
  assert.equal(received.length, 0);
  await configure(root, 'network', true);
  const result = await exportTelemetry(root);
  assert.deepEqual(result.network, { count: 1, statusCode: 200 });
  assert.equal(received.length, 1);
  assert.equal(received[0].headers['x-secret'], 'SECRET');
  assert.equal(received[0].body.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.dataPoints[0].asInt, '1');
  assert.doesNotMatch(JSON.stringify(received[0].body), /private-model|codex|project|SECRET|endpoint|headers/);
});

test('network opt-in rejects a public HTTP destination without leaking it', async t => {
  const root = await rootOf(t, { rede: { ligado: true, endpoint: 'http://private.example', cabecalhos: { secret: 'TOKEN' } } });
  await record(root, 'quota.check');
  await assert.rejects(exportTelemetry(root), err => !/private.example|TOKEN/.test(err.message));
});

test('CLI and MCP expose status, consent, filtering and corruption checks', async t => {
  const root = await rootOf(t, {}), output = [];
  const io = { root, stdout: text => output.push(text), stderr: text => output.push(text) };
  assert.equal(await main(['telemetry', 'on'], io), 0);
  assert.match(output.pop(), /no messages.*sem mensagens/);
  await record(root, 'quota.check');
  assert.equal(await main(['telemetry', 'export', '--since', new Date(0).toISOString()], io), 0);
  assert.equal(JSON.parse(output.pop()).count, 1);
  assert.equal(await main(['telemetry', 'check'], io), 0);
  assert.equal(await main(['telemetry', 'rede', 'off'], io), 0);
  assert.equal(await main(['telemetry', 'nonsense'], io), 2);
  for (const name of ['telemetry_status', 'telemetry_export']) {
    const reply = await TOOLS.find(tool => tool.name === name).handler({}, { root });
    assert.ok(JSON.parse(reply));
  }
  assert.equal(await main(['telemetry', 'off'], io), 0);
  assert.equal((await status(root)).enabled, false);
});
