// The kit of a root: the read-only probe that says whether the orchestration
// kit is installed, which version it is and why it is broken when it is. The
// line the command line prints comes from the result of this probe. Nothing
// here prints.

import * as filesystem from 'node:fs/promises';
import process from 'node:process';

import { installConfig } from '../install/config.js';
import { detectKit } from '../install/kit.js';
import { paths } from '../store.js';
import { runCommand } from '../spawn-process.js';
import { readJson } from '../state.js';
import { argsOf } from './arguments.js';

/**
 * The probe of the kit of a root.
 *
 * @param {string} root state root
 * @param {object} [args] no argument is taken
 * @param {object} [deps] the file system, the platform, the environment and the runner of a command
 * @returns {Promise<{state: string, path: string|null, version: string|null}>}
 */
export async function kitDetect(root, args = {}, deps = {}) {
  argsOf('kit_detect', args, []);
  const stored = await readJson(paths(root).config, {});
  // The probe reads the installer's settings, the ones that name the kit.
  const install = installConfig(stored?.install);
  // The runner of a command is the one of the command line, so a kit that is
  // found is probed the same way in both.
  return detectKit({ fs: filesystem, platform: process.platform, env: process.env, ...deps,
    run: deps.run ?? runCommand, config: install });
}
