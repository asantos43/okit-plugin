import { open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { configOf, DEFAULT_CONFIG } from '../../src/profiles.js';
import { clientDefaultRoot, homeOf } from '../../src/install/config.js';

async function sessionFiles(directory, settings) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sessionFiles(path, settings));
    else if (entry.isFile() && entry.name.startsWith(settings.filePrefix)
      && entry.name.endsWith(settings.fileSuffix)) {
      try { files.push({ path, mtime: (await stat(path)).mtimeMs }); } catch { /* disappeared */ }
    }
  }
  return files;
}

const finite = (value) => typeof value === 'number' && Number.isFinite(value);

function eventQuota(line, fields) {
  try {
    const event = JSON.parse(line);
    const payload = event[fields.payload];
    if (event[fields.type] !== fields.event || payload?.[fields.type] !== fields.tokenCount) return null;
    const limits = payload[fields.rateLimits];
    const recordedAt = event[fields.timestamp];
    if (!Number.isFinite(Date.parse(recordedAt))) return null;
    const windows = [fields.primary, fields.secondary].flatMap((key) => {
      const window = limits?.[key];
      if (!window) return [];
      const used = window[fields.usedPercent], minutes = window[fields.windowMinutes];
      const reset = window[fields.resetsAt];
      if (!finite(used) || used < 0 || used > 100 || !finite(minutes) || minutes <= 0
        || !finite(reset) || !Number.isFinite(new Date(reset * 1000).getTime())) return [];
      return [{ windowMinutes: minutes, remainingPct: 100 - used,
        resetsAt: new Date(reset * 1000).toISOString() }];
    });
    return windows.length ? { recordedAt, windows,
      remainingPct: Math.min(...windows.map((window) => window.remainingPct)) } : null;
  } catch { return null; }
}

async function readTail(path, settings, openFile) {
  const file = await openFile(path, 'r');
  try {
    const { size } = await file.stat();
    let length = Math.min(size, settings.tailBytes);
    for (;;) {
      const start = size - length;
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await file.read(buffer, 0, length, start);
      const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n');
      if (start > 0) lines.shift(); // Never parse a truncated first line.
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const quota = eventQuota(lines[index], settings.fields);
        if (quota) return quota;
      }
      if (length >= size || length >= settings.maxTailBytes) return null;
      length = Math.min(size, settings.maxTailBytes, length * 2);
    }
  } finally { await file.close(); }
}

/** Read-only, bounded tail reads. Missing, stale or unreadable data means no reading. */
export async function readCodexSessionQuota({ config, env = process.env, platform = process.platform, now = Date.now,
  openFile = open } = {}) {
  try {
    const settings = configOf(config).codexQuota;
    const home = homeOf(env, platform) || env?.HOME || env?.USERPROFILE;
    // The folder of the default account: the one the install options of the person name, under the home. The
    // variable of the client in the environment is an override of the folder, never the folder itself.
    const defaultFolder = clientDefaultRoot('codex', { install: config?.install, env, platform, home });
    const defaultSessions = defaultFolder ? join(defaultFolder, 'sessions') : null;
    // The folder the person configured wins; the default of the setting is the folder of the default account,
    // which follows the install options.
    const configuredSessions = settings.sessionsDirectory === DEFAULT_CONFIG.codexQuota.sessionsDirectory
      ? defaultSessions ?? settings.sessionsDirectory : settings.sessionsDirectory;
    const configured = env?.[settings.sessionsEnv]
      || (env?.CODEX_HOME ? join(env.CODEX_HOME, 'sessions') : configuredSessions);
    const directory = configured.startsWith('~/')
      ? (home ? join(home, configured.slice(2)) : null)
      : configured;
    if (!directory) return null;
    const files = (await sessionFiles(directory, settings))
      .sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path)).slice(0, settings.recentFiles);
    for (const { path } of files) {
      let quota;
      try { quota = await readTail(path, settings, openFile); } catch { continue; }
      if (!quota) continue;
      const ageMinutes = Math.max(0, now() - Date.parse(quota.recordedAt)) / 60_000;
      return ageMinutes <= settings.maxAgeMinutes ? { ...quota, source: 'automatic', ageMinutes } : null;
    }
  } catch { /* A session reading is optional. */ }
  return null;
}
