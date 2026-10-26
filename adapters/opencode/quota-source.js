import { open } from 'node:fs/promises';
import process from 'node:process';
import { configOf } from '../../src/profiles.js';
import { execRun } from '../../src/spawn-process.js';

async function fileOutput(path, limit) {
  const file = await open(path, 'r');
  try {
    if (!(await file.stat()).isFile()) return null;
    const buffer = Buffer.alloc(limit + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    return bytesRead <= limit ? buffer.subarray(0, bytesRead).toString('utf8') : null;
  } finally { await file.close(); }
}

function parseReading(output, settings, now) {
  const data = JSON.parse(output), fields = settings.fields;
  if (!data || data[fields.error] !== undefined || data[fields.version] !== settings.version
    || ![fields.company, fields.source].every((key) => typeof data[key] === 'string' && data[key].trim())) return null;
  const timestamp = data[fields.readAt];
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)
    || !Number.isFinite(new Date(timestamp * 1000).getTime())) return null;
  const ageMinutes = Math.max(0, now() - timestamp * 1000) / 60_000;
  if (ageMinutes > settings.maxAgeMinutes) return null;
  const windows = [];
  for (const [key, windowMinutes] of Object.entries(settings.windows)) {
    const window = data[key];
    if (window == null) continue;
    const remainingPct = window[fields.remainingPercent], reset = window[fields.resetAt];
    if (!Number.isInteger(remainingPct) || remainingPct < 0 || remainingPct > 100
      || (reset !== null && (typeof reset !== 'number' || !Number.isFinite(reset)
        || !Number.isFinite(new Date(reset * 1000).getTime())))) return null;
    windows.push({ windowMinutes, remainingPct,
      resetsAt: reset === null ? null : new Date(reset * 1000).toISOString() });
  }
  if (!windows.length) return null;
  const tightest = windows.reduce((a, b) => a.remainingPct <= b.remainingPct ? a : b);
  return { source: 'automatic', ...tightest, windows, ageMinutes,
    recordedAt: new Date(timestamp * 1000).toISOString() };
}

/** Optional sources never read credentials or prevent a manual reading. */
export async function readOpencodeSource({ config, env = process.env, now = Date.now } = {}) {
  try {
    const settings = configOf(config).opencodeQuota;
    const readings = await Promise.all(Object.entries(settings.sources).map(async ([provider, source]) => {
      try {
        let output;
        if (source.file) output = await fileOutput(source.file, settings.maxOutputBytes);
        else {
          const [command, ...args] = source.command;
          const result = await execRun({ command, args, env, timeoutMs: settings.timeoutMs,
            maxOutputBytes: settings.maxOutputBytes });
          if (result.code !== 0) return null;
          output = result.stdout;
        }
        if (!output) return null;
        const reading = parseReading(output, settings, now);
        return reading ? { ...reading, provider } : null;
      } catch { return null; }
    }));
    return readings.filter(Boolean).sort((a, b) => a.remainingPct - b.remainingPct)[0] ?? null;
  } catch { return null; }
}
