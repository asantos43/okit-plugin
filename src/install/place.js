import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { destinationOf, installationOf, missingFile, resolvedRecord } from './where.js';
import { extract } from './extract.js';
import { installConfig, renderName } from './config.js';
import { OperationalError, UsageError } from './exit.js';
import { recordProblem } from '../config-schema.js';

// The folder of the package that is running: the records of the installation it belongs to are in the folder above
// it (an installation is `<destination>/<version>-<client>`, and its records are in `<destination>`).
const packageDirectory = fileURLToPath(new URL('../../', import.meta.url));

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
// A record of an old shape may name neither its folder nor the folder of its records: every reader gets them filled in
// (`resolvedRecord`), the retained versions too, so no caller works from an `undefined` path.
function resolvedRecords(records, destination) {
  return Object.fromEntries(Object.entries(records).map(([client, record]) => [client,
    record !== null && typeof record === 'object' ? resolvedRecord(record, destination) : record]));
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
  return resolvedRecords(records, destination);
}
export async function readRecord(destination, client, fs, config = installConfig()) {
  if (typeof client !== 'string') { fs = client; client = null; }
  const records = await readRecords(destination, fs, config);
  return client ? records[client] ?? null : Object.values(records)[0] ?? null;
}

/**
 * The records of the installation, read leniently: a record that cannot be read is named, never thrown.
 *
 * The doctor needs this: a record of the wrong shape (a file that is not JSON, a JSON that is not an object, a field
 * of the wrong type) is a row of the diagnosis, not a refusal that stops the whole run. Every other client is still
 * diagnosed. `readRecords` keeps its own behaviour for the callers that change the installation: a bad record there
 * is still a refusal of usage.
 *
 * @param {string} destination the folder of the records
 * @param {object} fs the file system
 * @param {object} [config] the settings of the installer
 * @returns {Promise<{records: object, invalid: {file: string, client: string, reason: string}[]}>} the records that
 * could be read and the ones that could not
 */
export async function readRecordsLenient(destination, fs, config = installConfig()) {
  const records = {};
  const invalid = [];
  const why = (error) => (error instanceof Error ? error.message : String(error));
  const read = async (file, client) => {
    let text;
    try { text = await fs.readFile(file, 'utf8'); }
    catch (error) {
      // A file that is not there is no record at all; a file that cannot be read is a record that could not be
      // read: a row of the diagnosis, never a refusal that stops the whole run.
      if (error.code === 'ENOENT') return;
      invalid.push({ file, client, reason: why(error) });
      return;
    }
    let value;
    try { value = JSON.parse(text); } catch {
      invalid.push({ file, client, reason: `Cannot read installation record: ${file}` });
      return;
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      invalid.push({ file, client, reason: `Installation record is not a JSON object: ${file}` });
      return;
    }
    const found = typeof value.client === 'string' && value.client ? recordProblem(value) : { path: 'client' };
    if (found) {
      invalid.push({ file, client, reason: `Invalid installation record: ${file} (${found.path})` });
      return;
    }
    records[client] = value;
  };
  const legacy = join(destination, 'install.json');
  let legacyText;
  try { legacyText = await fs.readFile(legacy, 'utf8'); }
  catch (error) {
    // Only a file that is not there means there is no legacy record; a file that cannot be read is a record that
    // could not be read.
    if (error.code !== 'ENOENT') invalid.push({ file: legacy, client: '', reason: why(error) });
    legacyText = null;
  }
  if (legacyText !== null) {
    let value;
    try { value = JSON.parse(legacyText); } catch { value = undefined; }
    if (value !== null && typeof value === 'object' && !Array.isArray(value) && typeof value.client === 'string') {
      const found = recordProblem(value);
      if (!found) records[value.client] = value;
      else invalid.push({ file: legacy, client: value.client, reason: `Invalid installation record: ${legacy} (${found.path})` });
    } else {
      invalid.push({ file: legacy, client: '', reason: `Cannot read installation record: ${legacy}` });
    }
  }
  for (const client of Object.keys(config.clients)) {
    const file = recordPath(destination, client, config);
    await read(file, client);
  }
  return { records: resolvedRecords(records, destination), invalid };
}

/**
 * The records of the installation, and the folder they are in.
 *
 * The destination is where the records are looked for first. When it has none, and the caller did not name a
 * destination of its own, the records of the installation that is running are looked for in the folder above the
 * package directory: an installation is `<destination>/<version>-<client>` and keeps its records in `<destination>`,
 * so the doctor (or the installer) that runs from inside one finds them there.
 *
 * With `lenient`, a record that cannot be read is named in `invalid` and never thrown: the caller decides what a
 * record it cannot read means (the doctor: a row of the diagnosis; the install: no usable record for that client).
 *
 * @param {string} destination the folder the records are looked for in
 * @param {{fs: object, config?: object, explicitDestination?: boolean, lenient?: boolean, running?: string}} options (`running`: the folder of the running package, for tests)
 * @returns {Promise<{records: object, invalid: object[], destination: string}>}
 */
export async function discoverRecords(destination, { fs, config = installConfig(), explicitDestination = false, lenient = false, running = packageDirectory } = {}) {
  const read = async (folder) => (lenient
    ? await readRecordsLenient(folder, fs, config)
    : { records: await readRecords(folder, fs, config), invalid: [] });
  const found = await read(destination);
  if (Object.keys(found.records).length || explicitDestination) return { ...found, destination };
  // The installation that is running: its records are in the folder above the package directory, and the record of it
  // names its folder or is the one that places it there (`<destination>/<version>-<client>`).
  const packageFolder = running.replace(/[\\/]$/, '');
  const runtimeFolder = dirname(packageFolder);
  const runtime = await read(runtimeFolder);
  const installed = Object.values(runtime.records).find((record) => installationOf(record, runtimeFolder) === packageFolder);
  if (!installed) return { ...found, destination };
  // Every record that could not be read is named: the one of the destination and the one of the installation
  // that is running. A legacy record names no destination: the folder its records were read from is the one.
  return { records: runtime.records, invalid: [...found.invalid, ...runtime.invalid],
    destination: destinationOf(installed, runtimeFolder) };
}

// Include the legacy file: saving a modern record can remove it.
export async function snapshotRecords(destination, fs, config = installConfig()) {
  const snapshot = new Map();
  const capture = async (file) => {
    try { snapshot.set(file, await fs.readFile(file, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; snapshot.set(file, null); }
  };
  for (const file of new Set([join(destination, 'install.json'),
    ...Object.keys(config.clients).map((client) => recordPath(destination, client, config))])) await capture(file);
  // A legacy record (or a changed client field) can name a client outside the configured list.
  for (const text of [...snapshot.values()]) {
    let record;
    try { record = JSON.parse(text); } catch { continue; }
    if (typeof record?.client !== 'string' || !record.client) continue;
    const file = recordPath(destination, record.client, config);
    if (!snapshot.has(file)) await capture(file);
  }
  return snapshot;
}

/** Puts every file back as it was; returns the files that could not be restored (empty: all are). */
export async function restoreRecords(snapshot, fs) {
  const failures = [];
  for (const [file, text] of snapshot) {
    try {
      if (text === null) await fs.rm(file, { force: true });
      else {
        const current = await fs.readFile(file, 'utf8').catch((error) => {
          if (error.code !== 'ENOENT') throw error;
          return null;
        });
        if (current !== text) await fs.writeFile(file, text);
      }
    } catch (error) { failures.push(`${file}: ${error.message}`); }
  }
  return failures;
}

export async function saveRecord(destination, record, deps) {
  // The records are read leniently: a record of another client that cannot be read is left as it is (its file is
  // untouched), and the record of the client being saved replaces the one that is there, readable or not.
  const { records } = await readRecordsLenient(destination, deps.fs, deps.config);
  await writeRecord(destination, record, deps);
  for (const other of Object.values(records)) {
    if (other.client === record.client) continue;
    await writeRecord(destination, { ...other, link: record.link, linkDirectory: record.linkDirectory,
      autostart: record.autostart }, deps);
  }
}

/**
 * Whether a record is stored without its folders (an old shape, or the legacy `install.json`): the records are read
 * with the folders filled in, so only the file says it.
 */
export async function recordsStoredIncomplete(destination, records, fs, config = installConfig()) {
  for (const record of records) {
    let stored = null;
    try { stored = JSON.parse(await fs.readFile(recordPath(destination, record.client, config), 'utf8')); } catch { /* Not stored by itself. */ }
    const named = (value) => typeof value === 'string' && value !== '';
    if (!stored || !named(stored.path) || !named(stored.destination)) return true;
  }
  return false;
}

/** Updates only autostart for all clients covered by the destination's single service. */
export async function saveAutostartRecords(destination, records, deps) {
  for (const record of records) await writeRecord(destination, { ...record, autostart: true }, deps);
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
  const file = join(destination, 'install.json');
  let legacy = null;
  try { legacy = await legacyRecord(destination, fs, config); }
  catch { legacy = null; }
  // A legacy file that cannot be read is stale: the record that was just written replaces it.
  if (!legacy || legacy.client === client) await fs.rm(file, { force: true });
}
export async function removeRecord(destination, client, deps) {
  await deps.fs.rm(recordPath(destination, client, deps.config), { force: true });
  await removeLegacy(destination, client, deps.fs, deps.config ?? installConfig());
}

/**
 * Whether every required file of the installed package and client is readable and nonempty.
 *
 * An installation whose payload was deleted (or truncated) is not the installation of that version: the installer
 * writes it again, so the fix the doctor advertises really repairs.
 *
 * @param {object} record the installation record (`path` is the retained folder)
 * @param {object} config the settings of the installer
 * @param {object} fs the file system
 * @returns {Promise<boolean>}
 */
export async function payloadComplete(record, config, fs) {
  if (!record?.path) return false;
  return await missingFile(record, config, fs) === null;
}

export async function place(selected, downloaded, details, deps) {
  const { fs, destination, config, now } = deps;
  // The record of this client is read leniently: a record that cannot be read is no usable record, and the
  // installation of this client is written again (a clean install of it).
  const { records, invalid } = await readRecordsLenient(destination, fs, config);
  // The record names its folder, or the installer's own folder for it is meant (a legacy record names none).
  const previous = records[details.client] ? resolvedRecord(records[details.client], destination) : null;
  // The file of the record of this client is there, but the record cannot be read: the folder of this
  // installation is ours (the installer wrote it), so the clean install of this client writes it again.
  const unreadable = invalid.some((one) => one.file === recordPath(destination, details.client, config));
  const same = previous?.version === selected.version && previous.client === details.client;
  // An installation of this version whose payload is whole is left as it is.
  const whole = same ? await payloadComplete(previous, config, fs) : false;
  if (same && whole) return { record: previous, unchanged: true };
  const path = join(destination, `${selected.version}-${details.client}`);
  await fs.mkdir(destination, { recursive: true });
  const staging = await fs.mkdtemp(join(destination, '.staging-'));
  try {
    if (downloaded.source) await fs.cp(downloaded.source, staging, { recursive: true });
    else await extract(downloaded.bytes, staging, { fs, format: selected.format, maxExtractBytes: config.maxExtractBytes });
    const pkg = JSON.parse(await fs.readFile(join(staging, 'package.json'), 'utf8'));
    if (pkg.version !== selected.version) throw new Error('Package metadata version differs from release');
    if (same && !whole && previous.path === path) {
      // The payload of this version is not whole: the folder of the installation is written again. Only the folder
      // the record names as this very installation is removed: a record is a file a person may have changed, and the
      // folder it names may be any folder at all. The old folder stays as it was when the download is not good.
      await fs.rm(path, { recursive: true, force: true });
      await fs.rename(staging, path);
    } else {
      const existing = await fs.stat(path).catch((error) => { if (error.code !== 'ENOENT') throw error; return null; });
      if (existing && unreadable) {
        // The record of this client cannot be read and the folder of this version is there: the folder is ours
        // (the record of this client named it), so the clean install of this client writes it again.
        await fs.rm(path, { recursive: true, force: true });
        await fs.rename(staging, path);
      } else if (existing) {
        let retained = previous;
        while (retained && retained.path !== path) retained = retained.previous;
        if (!retained || retained.sha256 !== downloaded.sha256) throw new Error(`Version destination already exists: ${path}`);
      } else await fs.rename(staging, path);
    }
    // The registrations of the accounts belong to the folders of the clients, not to a payload: a new payload keeps them.
    const accounts = previous?.accounts && Object.keys(previous.accounts).length ? { accounts: previous.accounts } : {};
    const record = { ...details, ...(previous?.panel ? { panel: previous.panel } : {}), ...(previous?.statusline ? { statusline: previous.statusline } : {}), ...accounts,
      ...(previous ? (previous.defaultRegistered === false ? { defaultRegistered: false } : {}) : {}), version: selected.version, path, destination,
      at: new Date(now()).toISOString(), sha256: downloaded.sha256, previous };
    await saveRecord(destination, record, deps);
    return { record, unchanged: false };
  } finally { await fs.rm(staging, { recursive: true, force: true }); }
}
