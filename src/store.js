import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';

export const ROOT_FOLDER = '.okwork';
export const HOME_ENV = 'OKWORK_HOME';
/**
 * Set by the post-install check in the processes it starts, and read by the status bar collector: a verification run reads
 * and writes its reading but never starts the person's own command that the bar chains (`--previous`), which is not ours.
 */
export const SELFCHECK_ENV = 'OKIT_SELFCHECK';

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
    project: join(base, 'project.json'),
    inbox: join(base, 'inbox.json'),
    orders: join(base, 'orders.json'),
    templates: join(base, 'templates.json'),
    quota: join(base, 'quota'),
    runs: join(base, 'runs'),
    locks: join(base, 'locks'),
    logs: join(base, 'logs'),
  };
}
