import { basename, join } from 'node:path';
import { extract } from './extract.js';
import { installConfig, renderName } from './config.js';
import { OperationalError, UsageError } from './exit.js';
import { recordProblem } from '../config-schema.js';

const recordPath = (destination, client, config) => join(destination, renderName({ template: config.recordName, values: { client } }));
// The record is a file the installer wrote and a person may have changed: text that is not JSON is a file that cannot be
// read (a failure of the work, exit 1); JSON of the wrong shape (a field of the wrong type, at any depth) is a refusal of
// usage (exit 2) that names the field and says how to regenerate the file, never a TypeError later.
// `skipped` (only for `status` and `env report`, which only look): a record that is not a JSON object is no record, told to
// the caller by its file name and never a failure; the commands that change the installation keep refusing it.
function checked(text, file, command, skipped) {
  let record;
  try { record = JSON.parse(text); } catch { throw new OperationalError(`Cannot read installation record: ${file}`); }
  if (record === null || (skipped && (typeof record !== 'object' || Array.isArray(record)))) { skipped?.(file); return null; }
  const found = !Array.isArray(record) && typeof record === 'object' && typeof record.client === 'string' && record.client ? recordProblem(record) : { path: 'client' };
  if (found) throw new UsageError(`Invalid installation record: ${file} (${found.path}); remove it and run ${command} install`);
  return record;
}
async function legacyRecord(destination, fs, config, skipped) {
  try { return checked(await fs.readFile(join(destination, 'install.json'), 'utf8'), 'install.json', config.command, skipped); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
/**
 * The records of the installation, by client. With `options.unreadable` (an array), a record that is not a JSON object
 * (null, a list, a number, text) is left out and its file path is pushed there, so a caller that only looks (`status`,
 * `env report`) can say so; without it a record is read exactly as before (`null` stays as a null entry, any other wrong shape is a refusal of usage).
 */
export async function readRecords(destination, fs, config = installConfig(), options = {}) {
  const records = {};
  const lenient = options.unreadable ? (file) => { options.unreadable.push(join(destination, file)); } : null;
  const legacy = await legacyRecord(destination, fs, config, lenient);
  if (legacy) records[legacy.client] = legacy;
  for (const client of Object.keys(config.clients)) {
    try {
      const record = checked(await fs.readFile(recordPath(destination, client, config), 'utf8'), basename(recordPath(destination, client, config)), config.command, lenient);
      // As before: a strict read keeps a `null` record in the map; only a read that only looks leaves it out.
      if (record || !lenient) records[client] = record;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return records;
}
export async function readRecord(destination, client, fs, config = installConfig()) {
  if (typeof client !== 'string') { fs = client; client = null; }
  const records = await readRecords(destination, fs, config);
  return client ? records[client] ?? null : Object.values(records)[0] ?? null;
}

export async function saveRecord(destination, record, deps) {
  const records = await readRecords(destination, deps.fs, deps.config);
  await writeRecord(destination, record, deps);
  for (const other of Object.values(records)) {
    if (other.client === record.client) continue;
    await writeRecord(destination, { ...other, link: record.link, linkDirectory: record.linkDirectory,
      autostart: record.autostart }, deps);
  }
}

async function writeRecord(destination, record, deps) {
  const path = recordPath(destination, record.client, deps.config ?? installConfig());
  if (deps.writeJsonAtomic) {
    await deps.writeJsonAtomic(path, record);
    await removeLegacy(destination, record.client, deps.fs, deps.config ?? installConfig());
    return;
  }
  const temp = `${path}.tmp`;
  try {
    await deps.fs.writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' });
    await deps.fs.rename(temp, path);
    await removeLegacy(destination, record.client, deps.fs, deps.config ?? installConfig());
  } finally { await deps.fs.rm(temp, { force: true }); }
}
async function removeLegacy(destination, client, fs, config) {
  if ((await legacyRecord(destination, fs, config))?.client === client) await fs.rm(join(destination, 'install.json'), { force: true });
}
export async function removeRecord(destination, client, deps) {
  await deps.fs.rm(recordPath(destination, client, deps.config), { force: true });
  await removeLegacy(destination, client, deps.fs, deps.config ?? installConfig());
}

export async function place(selected, downloaded, details, deps) {
  const { fs, destination, config, now } = deps;
  const previous = await readRecord(destination, details.client, fs, config);
  if (previous?.version === selected.version && previous.client === details.client) return { record: previous, unchanged: true };
  const path = join(destination, `${selected.version}-${details.client}`);
  await fs.mkdir(destination, { recursive: true });
  const staging = await fs.mkdtemp(join(destination, '.staging-'));
  try {
    if (downloaded.source) await fs.cp(downloaded.source, staging, { recursive: true });
    else await extract(downloaded.bytes, staging, { fs, format: selected.format, maxExtractBytes: config.maxExtractBytes });
    const pkg = JSON.parse(await fs.readFile(join(staging, 'package.json'), 'utf8'));
    if (pkg.version !== selected.version) throw new Error('Package metadata version differs from release');
    const existing = await fs.stat(path).catch((error) => { if (error.code !== 'ENOENT') throw error; return null; });
    if (existing) {
      let retained = previous;
      while (retained && retained.path !== path) retained = retained.previous;
      if (!retained || retained.sha256 !== downloaded.sha256) throw new Error(`Version destination already exists: ${path}`);
    } else await fs.rename(staging, path);
    const record = { ...details, ...(previous?.statusline ? { statusline: previous.statusline } : {}), version: selected.version, path, destination,
      at: new Date(now()).toISOString(), sha256: downloaded.sha256, previous };
    await saveRecord(destination, record, deps);
    return { record, unchanged: false };
  } finally { await fs.rm(staging, { recursive: true, force: true }); }
}
