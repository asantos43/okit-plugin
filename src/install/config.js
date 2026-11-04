import { UsageError } from './exit.js';
import { DEFAULT_CONFIG } from '../profiles.js';
import { assertInstallSettings } from '../config-schema.js';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { homeOf } from './present.js';

const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export { homeOf };

// The defaults under what the user wrote, key by key down to the first list or value: a key the user did not write is
// the default, at any depth (a list, a text or a number written by the user replaces the default whole).
function merge(base, user) {
  if (!plain(base) || !plain(user)) return user;
  const keys = new Set([...Object.keys(base), ...Object.keys(user)]);
  return Object.fromEntries([...keys].map((key) => [key, Object.hasOwn(user, key) && user[key] !== undefined ? merge(base[key], user[key]) : base[key]]));
}

/**
 * The installer's settings: the defaults with what the user wrote over them. What the user wrote is read first, key by
 * key (a wrong type is refused, a missing key is fine); the merged settings are read in full (INSTALL_SCHEMA in
 * src/config-schema.js is the one place that knows what a setting may be), so nothing invalid reaches the installer.
 *
 * @param {object} [user] the `install` of config.json
 * @param {object} [overrides] settings of this run (a flag) that go over both
 * @returns {object} the settings
 */
export function installConfig(user = {}, overrides = {}) {
  const base = DEFAULT_CONFIG.install;
  if (user === null) user = {};
  assertInstallSettings(user, { partial: true });
  const value = merge(base, { ...user, ...overrides });
  assertInstallSettings(value);
  return value;
}

export function installPaths(config, { env, platform, home }) {
  const parts = config.dataRoots[platform];
  if (!parts) throw new UsageError(`Unsupported platform: ${platform}`);
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

/**
 * The folder a client uses when nothing of the environment overrides it.
 *
 * The install options of the person name the folder (`clients.<client>.rootParts`, under the home). The variable of
 * the client in the environment is an override and never the folder itself: with it in the environment the client is
 * pointed at another folder, and the folder it uses with no override is still the one of the settings.
 *
 * @param {string} client the client
 * @param {{install?: object, env?: object, platform?: string, home?: string}} deps the install options of the
 *   person, the environment, the platform and the home
 * @returns {string|null} the folder, or null when the client has no settings
 */
export function clientDefaultRoot(client, { install, env = {}, platform = process.platform, home } = {}) {
  let settings;
  try { settings = installConfig(install); } catch { settings = installConfig(); }
  const clientSettings = settings.clients?.[client];
  if (!clientSettings) return null;
  const clean = { ...env };
  if (clientSettings.configEnv) delete clean[clientSettings.configEnv];
  return clientRoot(client, { config: settings, env: clean, home: home ?? homeOf(env, platform) ?? '' });
}
