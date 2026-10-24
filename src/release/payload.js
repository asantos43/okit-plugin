// The payload of one pair: the files that go into the package and the client
// metadata that the client needs to install it. The shared files come from
// the repository, the client files are generated from `package.json` and from
// the adapter of the chosen client, and nothing that the configuration
// excludes is ever read.

import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { packageName } from './config.js';

/** The JSON of a file, written with a final line break and LF endings. */
function json(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/** The text of a file, written with LF endings and a final line break. */
function text(value) {
  return Buffer.from(value.endsWith('\n') ? value : `${value}\n`, 'utf8');
}

/**
 * Whether a path is excluded. A pattern that holds a `/` is a path: it
 * matches the path itself and everything under it. A pattern that holds a `*`
 * is a glob: it matches any name of that shape. A pattern that holds neither
 * is a name: it matches any segment of the path.
 *
 * @param {string} path the path of the file or the folder
 * @param {string[]} excludes the excluded patterns
 * @returns {boolean} whether the path is excluded
 */
export function isExcluded(path, excludes) {
  const segments = path.split('/');
  const name = segments[segments.length - 1];
  return excludes.some((pattern) => {
    if (pattern.includes('*')) {
      const shape = pattern
        .split('*')
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*');
      return new RegExp(`^${shape}$`).test(name);
    }
    if (pattern.includes('/')) return path === pattern || path.startsWith(`${pattern}/`);
    return segments.includes(pattern);
  });
}

/**
 * Every file under a folder, in a stable order, with the paths written the
 * way the clients substitute them.
 *
 * @param {string} root the root of the repository
 * @param {string} folder the folder to walk
 * @param {string[]} excludes the excluded names
 * @returns {Promise<string[]>} the paths, relative to the root
 */
async function walk(root, folder, excludes) {
  const found = [];
  let entries;
  try {
    entries = await readdir(join(root, folder), { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return found;
    throw error;
  }
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const path = folder === '' ? entry.name : `${folder}/${entry.name}`;
    if (isExcluded(path, excludes)) continue;
    if (entry.isDirectory()) found.push(...await walk(root, path, excludes));
    else if (entry.isFile()) found.push(path);
  }
  return found;
}

/**
 * Every file of a path, in a stable order, with the paths written the way
 * the clients substitute them. A path that is a file is the file itself; a
 * path that is a folder is everything under it.
 *
 * @param {string} root the root of the repository
 * @param {string} path the path to read
 * @param {string[]} excludes the excluded names
 * @returns {Promise<string[]>} the paths, relative to the root
 */
async function filesUnder(root, path, excludes) {
  let info;
  try {
    info = await stat(join(root, path));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  if (info.isFile()) return [path];
  if (!info.isDirectory()) return [];
  return walk(root, path, excludes);
}

/**
 * The paths of the files `package.json` points the command at: the ones that
 * must be executable inside the payload.
 *
 * @param {object} packageJson the metadata of the package
 * @returns {string[]} the paths, relative to the root of the payload
 */
export function binPaths(packageJson) {
  const bin = packageJson?.bin;
  if (typeof bin === 'string') return [bin];
  if (bin && typeof bin === 'object') return Object.values(bin).filter((path) => typeof path === 'string');
  return [];
}

/**
 * The owner of a repository, read from its URL: `https://host/owner/name`.
 *
 * @param {string} url the URL of the repository
 * @param {string} fallback the name to use when the URL is not that shape
 * @returns {{name: string, url: string}} the owner
 */
export function repositoryOwner(url, fallback) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    return { name: fallback, url: String(url ?? '') };
  }
  const parts = parsed.pathname.split('/').filter((part) => part !== '');
  if (parts.length < 2) return { name: fallback, url: parsed.href };
  const owner = parts[0];
  return { name: owner, url: `${parsed.protocol}//${parsed.host}/${owner}` };
}

/**
 * The adapter of a client, loaded from the repository. The refusal says why
 * the adapter is not usable, so the build never writes a package that the
 * client cannot install.
 *
 * @param {object} options
 * @param {string} options.root the root of the repository
 * @param {object} options.config the resolved release configuration
 * @param {string} options.client the client of the pair
 * @returns {Promise<{module: object|null, refusal: string|null}>} the adapter
 */
export async function loadAdapter({ root, config, client }) {
  const folder = config.adapters?.[client];
  if (typeof folder !== 'string' || folder === '') {
    return { module: null, refusal: `no adapter is configured for client "${client}"` };
  }
  const entry = join(root, folder, config.adapterEntry ?? 'index.js');
  try {
    await stat(entry);
  } catch {
    return { module: null, refusal: `the adapter of client "${client}" is not implemented (${folder})` };
  }
  let module;
  try {
    module = await import(pathToFileURL(entry).href);
  } catch (error) {
    return { module: null, refusal: `the adapter of client "${client}" does not load: ${error.message}` };
  }
  return { module, refusal: null };
}

/**
 * The manifest of the plugin, from the metadata of the package.
 *
 * @param {object} options
 * @param {object} options.packageJson the metadata of the package
 * @param {object} options.clientFiles the files the client requires
 * @param {string} options.name the name of the plugin
 * @returns {object} the manifest
 */
export function pluginManifest({ packageJson, clientFiles, name }) {
  const manifest = {
    name,
    version: packageJson.version,
    description: packageJson.description ?? '',
    license: packageJson.license ?? '',
  };
  if (packageJson.repository) {
    manifest.repository = typeof packageJson.repository === 'string'
      ? packageJson.repository
      : packageJson.repository.url;
  }
  if (packageJson.homepage) manifest.homepage = packageJson.homepage;
  if (packageJson.keywords) manifest.keywords = packageJson.keywords;
  if (packageJson.author) manifest.author = packageJson.author;
  if (clientFiles?.mcp) {
    const root = clientFiles.mcp.root ?? '${CLAUDE_PLUGIN_ROOT}';
    manifest.mcpServers = {
      [packageJson.name]: {
        command: clientFiles.mcp.command ?? 'node',
        args: [`${root}/${clientFiles.mcp.server}`],
      },
    };
  }
  if (clientFiles?.hooks) manifest.hooks = `./${clientFiles.hooks}`;
  return manifest;
}

/**
 * The marketplace file of the package, with the one entry that points at the
 * package itself.
 *
 * @param {object} options
 * @param {object} options.packageJson the metadata of the package
 * @param {object} options.marketplace the identity of the marketplace
 * @param {string} options.name the name of the plugin
 * @param {string} options.system the system of the pair
 * @returns {object} the marketplace
 */
export function marketplaceFile({ packageJson, marketplace, name, system }) {
  return {
    name: marketplace.name,
    owner: { name: marketplace.owner.name, url: marketplace.owner.url },
    plugins: [{
      name,
      source: './',
      description: `${packageJson.description ?? name} (${system})`,
    }],
  };
}

/**
 * The instructions of the installation, from the steps of the configuration.
 *
 * @param {object} options
 * @param {object} options.instructions the steps of the client
 * @param {object} options.values the values the steps refer to
 * @returns {string} the text of the file
 */
export function instructionsText({ instructions, values }) {
  const fill = (step) => step.replace(/\{(\w+)\}/g, (whole, key) => (
    key in values ? String(values[key]) : whole
  ));
  const lines = [`# ${fill(instructions.title)}`, ''];
  for (const step of instructions.steps ?? []) lines.push(`- ${fill(step)}`);
  lines.push('');
  return lines.join('\n');
}

/**
 * The files of the payload of one pair: the shared files of the repository,
 * the configured shared adapters and the metadata the client requires.
 *
 * @param {object} options
 * @param {string} options.root the root of the repository
 * @param {object} options.config the resolved release configuration
 * @param {object} options.packageJson the metadata of the package
 * @param {object} options.pair the pair: `{client, system, arch}`
 * @param {object} options.userConfig the configuration of the user
 * @returns {Promise<{entries: object[], refusal: string|null}>} the entries
 */
export async function payloadEntries({ root, config, packageJson, pair, userConfig = {} }) {
  const { client, system } = pair;
  const clientFiles = config.clientFiles?.[client] ?? {};
  const excludes = config.exclude ?? [];

  const { module: adapter, refusal } = await loadAdapter({ root, config, client });
  if (refusal !== null) return { entries: [], refusal };

  const modes = config.modes ?? { executable: '0755', file: '0644' };
  const executables = new Set(binPaths(packageJson));
  const sharedAdapters = config.sharedAdapters ?? Object.values(config.adapters ?? {});
  const folders = [...(config.include ?? []), ...sharedAdapters, config.adapters?.[client]].filter(
    (folder) => typeof folder === 'string' && folder !== '',
  );
  const paths = [];
  for (const folder of folders) {
    const inside = await filesUnder(root, folder, excludes);
    paths.push(...inside);
  }

  const entries = [];
  for (const path of new Set(paths)) {
    const data = await readFile(join(root, ...path.split('/')));
    entries.push({
      path,
      data: toLf(data),
      mode: executables.has(path) ? modes.executable : modes.file,
    });
  }

  const name = packageName(packageJson.name);
  const repository = typeof packageJson.repository === 'string'
    ? packageJson.repository
    : packageJson.repository?.url ?? '';
  const owner = repositoryOwner(repository, name);
  const marketplace = {
    name: config.marketplace?.name ?? name,
    owner: {
      name: config.marketplace?.owner?.name ?? owner.name,
      url: config.marketplace?.owner?.url ?? owner.url,
    },
  };

  if (clientFiles.plugin) {
    entries.push({
      path: clientFiles.plugin,
      data: json(pluginManifest({ packageJson, clientFiles, name })),
      mode: modes.file,
    });
  }
  if (clientFiles.marketplace) {
    entries.push({
      path: clientFiles.marketplace,
      data: json(marketplaceFile({ packageJson, marketplace, name, system })),
      mode: modes.file,
    });
  }
  if (clientFiles.hooks) {
    const hook = adapter?.postCompactHooks
      ? adapter.postCompactHooks({
        config: userConfig,
        command: hookCommand({ clientFiles, packageJson }),
      })
      : {};
    entries.push({ path: clientFiles.hooks, data: json({ hooks: hook }), mode: modes.file });
  }
  const instructions = config.instructions?.[client];
  if (instructions?.file) {
    entries.push({
      path: instructions.file,
      data: text(instructionsText({
        instructions,
        values: {
          name,
          version: packageJson.version,
          engines: packageJson.engines?.node ?? '',
          command: Object.keys(packageJson.bin ?? {})[0] ?? '',
          marketplace: marketplace.name,
          // The folder the archive is extracted into is the one the client
          // reads, and the marketplace lives at its root.
          dir: name,
          bin: binPaths(packageJson)[0] ?? '',
        },
      })),
      mode: modes.file,
    });
  }

  return { entries, refusal: null };
}

/**
 * The command of the hook, with the path of the command of the package.
 *
 * @param {object} options
 * @param {object} options.clientFiles the files the client requires
 * @param {object} options.packageJson the metadata of the package
 * @returns {string} the command
 */
export function hookCommand({ clientFiles, packageJson }) {
  const template = clientFiles?.hookCommand ?? '';
  const bin = binPaths(packageJson)[0] ?? '';
  return template.replace(/\{bin\}/g, bin);
}

/**
 * The bytes of a file with the line endings of the payload: LF. A file that
 * holds a NUL byte is not text and is left as it is.
 *
 * @param {Buffer} data the bytes of the file
 * @returns {Buffer} the bytes with LF endings
 */
export function toLf(data) {
  if (data.includes(0)) return data;
  return Buffer.from(data.toString('binary').replace(/\r\n/g, '\n'), 'binary');
}
