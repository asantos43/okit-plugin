import { join } from 'node:path';
import { extract } from './extract.js';
import { installConfig, renderName } from './config.js';

const recordPath = (destination, client, config) => join(destination, renderName({ template: config.recordName, values: { client } }));
async function legacyRecord(destination, fs) {
  try { return JSON.parse(await fs.readFile(join(destination, 'install.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
export async function readRecords(destination, fs, config = installConfig()) {
  const records = {};
  const legacy = await legacyRecord(destination, fs);
  if (legacy) records[legacy.client] = legacy;
  for (const client of Object.keys(config.clients)) {
    try { records[client] = JSON.parse(await fs.readFile(recordPath(destination, client, config), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
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
    await removeLegacy(destination, record.client, deps.fs);
    return;
  }
  const temp = `${path}.tmp`;
  try {
    await deps.fs.writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' });
    await deps.fs.rename(temp, path);
    await removeLegacy(destination, record.client, deps.fs);
  } finally { await deps.fs.rm(temp, { force: true }); }
}
async function removeLegacy(destination, client, fs) {
  if ((await legacyRecord(destination, fs))?.client === client) await fs.rm(join(destination, 'install.json'), { force: true });
}
export async function removeRecord(destination, client, deps) {
  await deps.fs.rm(recordPath(destination, client, deps.config), { force: true });
  await removeLegacy(destination, client, deps.fs);
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
