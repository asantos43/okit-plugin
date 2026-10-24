import { DEFAULT_CONFIG } from '../profiles.js';
import { join, resolve } from 'node:path';

export function installConfig(user = {}) {
  const base = DEFAULT_CONFIG.install;
  const value = { ...base, ...user };
  for (const key of ['clients', 'headers', 'systems', 'architectures', 'dataRoots', 'kit']) {
    value[key] = { ...base[key], ...user[key] };
  }
  const kit = value.kit;
  const strings = (items) => Array.isArray(items) && items.every((item) => typeof item === 'string' && item.trim() && !/[\r\n\0]/.test(item));
  if (!strings(kit.executables) || !kit.executables.length || kit.executables.some((name) => /[\\/]/.test(name))) throw new TypeError('Invalid install.kit.executables');
  if (kit.path !== null && (typeof kit.path !== 'string' || !kit.path.trim() || /[\r\n\0]/.test(kit.path))) throw new TypeError('Invalid install.kit.path');
  if (!strings(kit.versionArgs)) throw new TypeError('Invalid install.kit.versionArgs');
  if (!Number.isSafeInteger(kit.timeoutMs) || kit.timeoutMs <= 0) throw new TypeError('Invalid install.kit.timeoutMs');
  if (typeof kit.require !== 'boolean') throw new TypeError('Invalid install.kit.require');
  for (const key of ['hint', 'overlap']) {
    if (typeof kit[key] !== 'string' || !kit[key].trim() || /[\r\n\0]/.test(kit[key])) throw new TypeError(`Invalid install.kit.${key}`);
  }
  for (const [name, settings] of Object.entries(value.clients)) value.clients[name] = { ...base.clients[name], ...settings };
  for (const key of ['timeoutMs', 'maxDownloadBytes', 'maxExtractBytes']) {
    if (!Number.isSafeInteger(value[key]) || value[key] <= 0) throw new TypeError(`Invalid install.${key}`);
  }
  if (typeof value.recordName !== 'string' || !value.recordName.includes('{client}') || /[\\/]/.test(value.recordName)) {
    throw new TypeError('install.recordName must be a filename containing {client}');
  }
  return value;
}

export function installPaths(config, { env, platform, home }) {
  const parts = config.dataRoots[platform];
  if (!parts) throw new TypeError(`Unsupported platform: ${platform}`);
  const data = env[parts[0]] || join(home, ...parts.slice(1));
  return {
    destination: resolve(config.destination || join(data, config.directory)),
    bin: resolve(config.linkDirectory || join(home, ...(platform === config.windowsPlatform ? config.windowsLinkParts : config.linkParts))),
  };
}

/**
 * Fills the name model with the values of one pair.
 *
 * @param {object} options
 * @param {string} options.template the name model
 * @param {object} options.values the values of the pair
 * @returns {string} the name of the artifact
 */
export function renderName({ template, values }) {
  return String(template).replace(/\{(package|version|client|system|arch|ext)\}/g, (_, key) => String(values[key] ?? ''));
}

export function clientRoot(client, deps) {
  const settings = deps.config.clients[client];
  return deps.env[settings.configEnv] || (deps.env[settings.xdgEnv]
    ? join(deps.env[settings.xdgEnv], ...settings.xdgParts)
    : join(deps.home, ...settings.rootParts));
}
