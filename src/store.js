import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';

const ROOT_FOLDER = '.okwork';
const HOME_ENV = 'OKWORK_HOME';
const PROJECT_FOLDER = '.okwork';

/**
 * Resolves the state root: the override in the environment when it is set,
 * the home folder otherwise. The environment is a parameter so tests and
 * callers never touch the real one.
 */
export function stateRoot(env = process.env) {
  const override = env?.[HOME_ENV];
  if (typeof override === 'string' && override.trim() !== '') return resolve(override);
  return join(homedir(), ROOT_FOLDER);
}

/**
 * Every path the state root holds, built with `node:path` so Windows and
 * POSIX agree.
 */
export function paths(root) {
  const base = resolve(root);
  return {
    root: base,
    config: join(base, 'config.json'),
    inbox: join(base, 'inbox.json'),
    orders: join(base, 'orders.json'),
    quota: join(base, 'quota'),
    runs: join(base, 'runs'),
    locks: join(base, 'locks'),
    logs: join(base, 'logs'),
  };
}

/**
 * Path of the standing orders of one project, which live beside the project
 * rather than in the shared root.
 */
export function projectOrdersPath(projectRoot) {
  return join(resolve(projectRoot), PROJECT_FOLDER, 'orders.json');
}