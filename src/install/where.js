import { delimiter, join } from 'node:path';
import * as filesystem from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONFIG } from '../profiles.js';
import { commandInPath } from '../env/path.js';

// Where an installation is. One place, so the doctor and the self-check can never diagnose a folder that is not the
// one the installer wrote.
//
// The record of an installation names the folder it was placed in (`path`) and the folder its records live in
// (`destination`). A record of an old shape may name neither: the installer places an installation in
// `<destination>/<version>-<client>`, so that is where it is, and the record of it is where the record says.

/**
 * The folder where the records of an installation live: the one the record names, or the one of the configuration
 * when the record names none (a custom `--dest` or a moved installation is the record's own folder).
 *
 * @param {object} record the installation record
 * @param {string} fallback the folder of the configuration (the default)
 * @returns {string} the folder of the records
 */
export function destinationOf(record, fallback) {
  const named = record?.destination;
  return typeof named === 'string' && named !== '' ? named : fallback;
}

/**
 * The folder of an installation: the one the record names, or the one the installer places it in
 * (`<destination>/<version>-<client>`), when the record names none.
 *
 * @param {object} record the installation record
 * @param {string} destination the folder where the records live
 * @returns {string|undefined} the folder of the installation, or undefined when it cannot be told
 */
export function installationOf(record, destination) {
  const named = record?.path;
  if (typeof named === 'string' && named !== '') return named;
  const { version, client } = record ?? {};
  if (typeof version === 'string' && version !== '' && typeof client === 'string' && client !== '' && destination) {
    return join(destination, `${version}-${client}`);
  }
  return undefined;
}

/**
 * The record of an installation with the folder of the installation and the folder of its records filled in: the
 * doctor and the self-check diagnose the installation that is really there.
 *
 * @param {object} record the installation record (as written)
 * @param {string} fallback the folder of the configuration (the default)
 * @returns {object} the record with its folders
 */
export function resolvedRecord(record, fallback) {
  const destination = destinationOf(record, fallback);
  const path = installationOf(record, destination);
  return { ...record, destination, ...(path === undefined ? {} : { path }) };
}

/**
 * The file of the probe of the check, inside an installation: the installer writes it and the check runs it.
 */
export const PROBE_FILE = 'src/mcp/selfcheck-probe.js';

/**
 * The files the payload of an installation must have: the ones the installed package lists (the commands of its
 * `bin`) and the ones the product reads by name (the configured MCP server, the probe and the client module).
 * `missingFile` reads the metadata first, so the metadata is required too.
 *
 * The list is read from the installed package, never written here: a package that names another command has another
 * list; the files the product reads by name are always required.
 *
 * @param {object} pkg the metadata of the installed package (its `package.json`)
 * @param {object} config the settings of the installer
 * @param {string} client the installed client
 * @returns {string[]} the paths, relative to the installation
 */
export function requiredFiles(pkg, config, client) {
  const files = [];
  const bin = pkg?.bin;
  if (typeof bin === 'string') files.push(bin);
  else if (bin && typeof bin === 'object') {
    for (const path of Object.values(bin)) if (typeof path === 'string' && path !== '') files.push(path);
  }
  files.push(config.mcp.server, PROBE_FILE);
  const module = config.clients?.[client]?.module;
  if (module) files.push(module);
  return files;
}

/**
 * The first file of the payload of an installation that is not there (or that is empty), or null when the payload is
 * whole. The file is named whole: the row says which one is missing.
 *
 * @param {object} record the installation record (`path` is the retained folder)
 * @param {object} config the settings of the installer
 * @param {object} fs the file system
 * @returns {Promise<string|null>} the file that is missing, or null
 */
export async function missingFile(record, config, fs) {
  if (!record?.path) return null;
  // The metadata of the installed package is the list of the files it requires: without it, the payload is not whole.
  const metadata = join(record.path, 'package.json');
  const pkg = await fs.readFile(metadata, 'utf8')
    .then((text) => { try { return JSON.parse(text); } catch { return null; } }, () => null);
  if (pkg === null || typeof pkg !== 'object' || Array.isArray(pkg)) return metadata;
  for (const file of requiredFiles(pkg, config, record.client)) {
    const content = await fs.readFile(join(record.path, file), 'utf8').catch(() => null);
    if (content === null || content.trim() === '') return join(record.path, file);
  }
  return null;
}

/** A repair needs both launcher and Node on PATH; only the package default may stay a bare name. */
export async function programWords({ config, platform, env, fs = filesystem }) {
  const windows = platform === config.windowsPlatform;
  const path = windows ? Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] : env.PATH;
  // A PATH that cannot be probed (an unreadable folder, a loop of links) proves nothing: the running CLI is the program.
  const found = await commandInPath({ fs, config, windows, path: path ?? '', separator: windows ? ';' : delimiter }).catch(() => undefined);
  const node = await commandInPath({ fs, config: { ...config, command: 'node' }, windows, path: path ?? '', separator: windows ? ';' : delimiter }).catch(() => undefined);
  if (found && node) return [config.command === DEFAULT_CONFIG.install.command ? config.command : found];
  return [process.execPath, fileURLToPath(new URL('../cli.js', import.meta.url))];
}
