import { DEFAULT_CONFIG } from '../profiles.js';
import { join, resolve } from 'node:path';

export function installConfig(user = {}) {
  const base = DEFAULT_CONFIG.install;
  const value = { ...base, ...user };
  for (const key of ['clients', 'headers', 'systems', 'architectures', 'dataRoots']) {
    value[key] = { ...base[key], ...user[key] };
  }
  for (const [name, settings] of Object.entries(value.clients)) value.clients[name] = { ...base.clients[name], ...settings };
  for (const key of ['timeoutMs', 'maxDownloadBytes', 'maxExtractBytes']) {
    if (!Number.isSafeInteger(value[key]) || value[key] <= 0) throw new TypeError(`Invalid install.${key}`);
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
