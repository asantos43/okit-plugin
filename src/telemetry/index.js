import { readdir, stat, rm, readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { readJson, writeJsonAtomic, withLock } from '../state.js';
import { paths } from '../store.js';
import { storedRootOf } from '../profiles.js';
import { settings } from './config.js';
import { UsageError } from '../install/exit.js';
import { projectHash, redact } from './catalog.js';

export const explanation = 'Records only counts, durations, states, role, model and app names, effort settings and an anonymous project reference; no messages, files or work text. Sending requires separate consent. / Registra somente contagens, durações, estados, nomes de papel, modelo e aplicativo, ajustes de esforço e uma referência anônima ao projeto; sem mensagens, arquivos ou textos de trabalho. O envio exige uma escolha separada.';
const prefix = 'okit-plugin-';
const nanos = ms => String(BigInt(Math.trunc(ms)) * 1000000n);
const error = () => new Error('Saved measurements are invalid / As medições salvas são inválidas');

async function files(config) {
  try {
    return (await readdir(config.dir)).filter(name => name.startsWith(prefix) && name.endsWith('.json'));
  } catch (err) { if (err.code === 'ENOENT') return []; throw err; }
}
const attributes = fields => Object.entries(fields).map(([key, value]) => ({ key,
  value: typeof value === 'number' ? { doubleValue: value } : { stringValue: value } }));

function envelope(event, fields, project, now) {
  return { resourceMetrics: [{ resource: { attributes: attributes({ 'service.name': 'okit-plugin',
    'project.id': projectHash(project) }) }, scopeMetrics: [{ scope: { name: 'okit-plugin' },
    metrics: [{ name: `okit.plugin.${event}`, sum: { aggregationTemporality: 1, isMonotonic: true,
      dataPoints: [{ timeUnixNano: nanos(now), asInt: '1', attributes: attributes(fields) }] } }] }] }] };
}

export async function prune(config, now = Date.now()) {
  const entries = await Promise.all((await files(config)).map(async name => ({ name,
    ...(await stat(join(config.dir, name))) })));
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));
  let bytes = 0;
  for (const entry of entries) {
    bytes += entry.size;
    if (entry.mtimeMs < now - config.retentionDays * 86400000 || bytes > config.maxBytes) {
      await rm(join(config.dir, entry.name), { force: true });
    }
  }
}

export async function record(root, event, fields = {}, { project = process.cwd(), now = Date.now() } = {}) {
  try {
    const config = await settings(root);
    if (config.enabled !== true) return false;
    const safe = redact(event, fields);
    if (!safe) return false;
    const data = envelope(event, safe, project, now);
    if (Buffer.byteLength(`${JSON.stringify(data, null, 2)}\n`) > Math.min(config.maxFileBytes, config.maxBytes)) return false;
    const file = join(config.dir, `${prefix}${now}-${randomUUID()}.json`);
    await mkdir(config.dir, { recursive: true });
    await withLock(join(config.dir, 'okit-plugin-retention'), async () => {
      await writeJsonAtomic(file, data);
      await prune(config);
    });
    return true;
  } catch { return false; } // Optional measurements never interrupt the underlying work.
}

export function validateEndpoint(endpoint) {
  let url;
  try { url = new URL(endpoint); } catch { throw error(); }
  if (url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:'
    && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw error();
  return url;
}

function validated(data) {
  try {
    const resource = data.resourceMetrics[0];
    const hash = resource.resource.attributes[1].value.stringValue;
    const metric = resource.scopeMetrics[0].metrics[0];
    const event = metric.name.replace(/^okit\.plugin\./, '');
    const point = metric.sum.dataPoints[0];
    if (!/^[a-f0-9]{64}$/.test(hash) || !/^\d+$/.test(point.timeUnixNano)) throw error();
    const fields = Object.fromEntries(point.attributes.map(({ key, value }) =>
      [key, value.stringValue ?? value.doubleValue]));
    const expected = envelope(event, redact(event, fields), '', Number(BigInt(point.timeUnixNano) / 1000000n));
    expected.resourceMetrics[0].resource.attributes[1].value.stringValue = hash;
    if (!isDeepStrictEqual(data, expected)) throw error();
    return { data, event, time: Number(BigInt(point.timeUnixNano) / 1000000n) };
  } catch { throw error(); }
}

async function readExports(config) {
  const good = [], bad = [];
  for (const name of await files(config)) {
    try {
      const info = await stat(join(config.dir, name));
      if (info.size > config.maxFileBytes) throw error();
      good.push(validated(JSON.parse(await readFile(join(config.dir, name), 'utf8'))));
    } catch { bad.push(name); }
  }
  return { good, bad };
}

async function send(config, counts) {
  if (config.rede.ligado !== true) return { count: 0, statusCode: null };
  const url = validateEndpoint(config.rede.endpoint);
  const body = JSON.stringify({ resourceMetrics: [{ resource: { attributes: attributes({ 'service.name': 'okit-plugin' }) },
    scopeMetrics: [{ scope: { name: 'okit-plugin' }, metrics: Object.entries(counts).map(([event, count]) => ({
      name: `okit.plugin.${event}`, sum: { aggregationTemporality: 1, isMonotonic: true,
        dataPoints: [{ timeUnixNano: nanos(Date.now()), asInt: String(count) }] } })) }] }] });
  return sendRequest(url, config, body, Object.values(counts).reduce((a, b) => a + b, 0));
}

function sendRequest(url, config, body, count) {
  return new Promise(resolve => {
    let req;
    try {
      req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
        method: 'POST', headers: { ...config.rede.cabecalhos, 'content-type': 'application/json',
          'content-length': Buffer.byteLength(body) } }, response => {
        response.resume();
        resolve({ count, statusCode: response.statusCode });
      });
      const deadline = setTimeout(() => req.destroy(), config.rede.timeoutMs);
      req.once('close', () => clearTimeout(deadline));
      req.on('error', () => resolve({ count: 0, statusCode: null }));
      req.end(body);
    } catch { req?.destroy(); resolve({ count: 0, statusCode: null }); }
  });
}

export async function check(root) {
  const { good, bad } = await readExports(await settings(root));
  return { ok: bad.length === 0, count: good.length, corrupted: bad.length,
    message: bad.length ? 'Damaged measurements found / Medições danificadas encontradas' : 'Measurements checked / Medições conferidas' };
}

export async function exportTelemetry(root, { since } = {}) {
  if (since !== undefined && (typeof since !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(since)
    || !Number.isFinite(Date.parse(since)))) {
    throw new UsageError('Use --since with an ISO date such as 2026-10-01T00:00:00Z / Use --since com uma data ISO como 2026-10-01T00:00:00Z');
  }
  const config = await settings(root);
  if (config.enabled !== true) return { count: 0, resourceMetrics: [], network: { count: 0, statusCode: null } };
  await prune(config);
  const { good, bad } = await readExports(config);
  if (bad.length) throw error();
  const selected = good.filter(item => since === undefined || item.time >= Date.parse(since));
  const counts = {};
  for (const item of selected) counts[item.event] = (counts[item.event] ?? 0) + 1;
  const network = selected.length ? await send(config, counts) : { count: 0, statusCode: null };
  await writeJsonAtomic(join(root, 'telemetry-export.json'), { at: new Date().toISOString(), count: selected.length });
  return { count: selected.length, resourceMetrics: selected.flatMap(item => item.data.resourceMetrics), network };
}

export async function status(root) {
  const config = await settings(root);
  const names = await files(config);
  const sizes = await Promise.all(names.map(name => stat(join(config.dir, name))));
  return { enabled: config.enabled === true, network: config.rede.ligado === true,
    what: explanation, where: config.dir, sizeBytes: sizes.reduce((sum, item) => sum + item.size, 0),
    lastExport: await readJson(join(root, 'telemetry-export.json'), null) };
}

export async function configure(root, key, enabled) {
  await mkdir(paths(root).locks, { recursive: true });
  return withLock(join(paths(root).locks, 'config'), async () => {
  const file = paths(root).config;
  const config = storedRootOf(await readJson(file, {}));
  config.telemetry = { ...config.telemetry };
  if (key === 'network') config.telemetry.rede = { ...config.telemetry.rede, ligado: enabled };
  else config.telemetry.enabled = enabled;
  await writeJsonAtomic(file, config);
  return enabled ? explanation : 'Recording or sending turned off / Gravação ou envio desligado';
  });
}
