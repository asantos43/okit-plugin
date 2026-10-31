// The command line of the configuration: it reads the argv, asks the registry
// for the values and prints the lines. The logic of the settings (the schema,
// the value of each entry and the change of one of them) lives in
// `src/core/config.js`, where the operations of the registry call it.

import { CONFIG_SCHEMA } from './config-schema.js';
import { exitCodeFor } from './install/exit.js';
import { fill } from './core/config.js';
import { Refusal } from './core/refusal.js';

export { CONFIG_SCHEMA };
export { fillMissingConfig, resolveEntry } from './core/config.js';

function formatValue(value) {
  return value === undefined ? '-' : JSON.stringify(value);
}

function effectText(description) {
  return `${description.en} / ${description['pt-BR']}`;
}

function valueLine(entry) {
  return fill(CONFIG_SCHEMA.labels.value, {
    path: entry.path,
    value: formatValue(entry.value),
    origin: entry.origin,
    effect: effectText(entry.description),
  });
}

function changeLine(entry) {
  return fill(CONFIG_SCHEMA.labels.change, {
    path: entry.path,
    before: formatValue(entry.previous.value),
    beforeOrigin: entry.previous.origin,
    after: formatValue(entry.after.value),
    afterOrigin: entry.after.origin,
    effect: effectText(entry.description),
  });
}

async function showConfig(ctx, run) {
  const result = await run('config_get', ctx.root, {});
  for (const entry of result.entries) ctx.out(valueLine(entry));
  return 0;
}

async function getConfig(ctx, args, run) {
  if (args.length !== 1) return ctx.unknown();
  const key = args[0];
  try {
    const result = await run('config_get', ctx.root, { key });
    for (const entry of result.entries) ctx.out(valueLine(entry));
    return 0;
  } catch (error) {
    if (error instanceof Refusal) {
      ctx.err(error.message);
      return exitCodeFor('usage');
    }
    throw error;
  }
}

async function setConfig(ctx, args, write, run) {
  if (args.length !== 2) return ctx.unknown();
  const [key, text] = args;
  try {
    const result = await run('config_set', ctx.root, { key, value: text }, { write });
    ctx.out(changeLine(result));
    for (const alias of result.removedAliases) {
      ctx.out(fill(CONFIG_SCHEMA.messages.legacyAliasRemoved, { alias, key }));
    }
    return 0;
  } catch (error) {
    if (error instanceof Refusal) {
      ctx.err(error.message);
      return exitCodeFor('usage');
    }
    throw error;
  }
}

async function unsetConfig(ctx, args, write, run) {
  if (args.length !== 1) return ctx.unknown();
  const key = args[0];
  try {
    const result = await run('config_set', ctx.root, { key }, { write });
    ctx.out(changeLine(result));
    for (const alias of result.removedAliases) {
      ctx.out(fill(CONFIG_SCHEMA.messages.legacyAliasRemoved, { alias, key }));
    }
    return 0;
  } catch (error) {
    if (error instanceof Refusal) {
      ctx.err(error.message);
      return exitCodeFor('usage');
    }
    throw error;
  }
}

/**
 * The `config` command of the command line: it reads the argv and prints the
 * lines. The registry of the operations is a parameter, because the modules of
 * the installer import this one and must not pull the whole core in.
 *
 * @param {object} ctx the context of the command line
 * @param {string} action show, get, set or unset
 * @param {string[]} args the arguments of the action
 * @param {{write?: Function, run?: Function}} [options] the writer of the file and the registry
 * @returns {Promise<number>} the exit code
 */
export async function configCommand(ctx, action, args, { write, run } = {}) {
  // The registry is asked for here, so this module never holds the core.
  const registry = run ?? (await import('./core/operations.js')).run;
  if (action === 'show' && args.length === 0) return showConfig(ctx, registry);
  if (action === 'get') return getConfig(ctx, args, registry);
  if (action === 'set') return setConfig(ctx, args, write, registry);
  if (action === 'unset') return unsetConfig(ctx, args, write, registry);
  return ctx.unknown();
}
