import { join } from 'node:path';
import { extract } from './extract.js';

export async function readRecord(destination, fs) {
  try { return JSON.parse(await fs.readFile(join(destination, 'install.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function saveRecord(destination, record, deps) {
  const path = join(destination, 'install.json');
  if (deps.writeJsonAtomic) return deps.writeJsonAtomic(path, record);
  const temp = `${path}.tmp`;
  try {
    await deps.fs.writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' });
    await deps.fs.rename(temp, path);
  } finally { await deps.fs.rm(temp, { force: true }); }
}

export async function place(selected, downloaded, details, deps) {
  const { fs, destination, config, now } = deps;
  const previous = await readRecord(destination, fs);
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
    const record = { ...details, version: selected.version, path, destination,
      at: new Date(now()).toISOString(), sha256: downloaded.sha256, previous };
    await saveRecord(destination, record, deps);
    return { record, unchanged: false };
  } finally { await fs.rm(staging, { recursive: true, force: true }); }
}
