// The settings of a root: the file `config.json` over the defaults, read on
// every call so a change to the file is picked up without restarting the
// server.
//
// The context of the caller brings its own settings when it has them (a test
// fixes them, a server reads them once); without them the file is read, the
// way the operations of the core always read it.

import { configOf as normalizeConfig } from '../profiles.js';
import { readJson } from '../state.js';
import { paths } from '../store.js';

/**
 * The settings the daemon would use for this root: `config.json` over
 * `DEFAULT_CONFIG`, read on every call so a change to the file is picked up
 * without restarting the server.
 *
 * @param {string} root the state root
 * @returns {Promise<object>} the settings of the root
 */
export async function loadConfig(root) {
  const stored = await readJson(paths(root).config, {});
  return normalizeConfig(stored);
}

/**
 * The settings of the caller, or the ones of the root when the caller brings
 * none.
 *
 * @param {object} [deps] the dependencies of the caller
 * @param {string} [root] the state root
 * @returns {Promise<object>} the settings
 */
export async function configOf(deps = {}, root) {
  return deps?.config === undefined ? loadConfig(root) : deps.config;
}
