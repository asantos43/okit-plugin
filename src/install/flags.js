import { UsageError } from './exit.js';

export const ALLOWED_FLAGS = {
  // `asset` and `fallback` come from the generated install scripts, which download and verify the package.
  install: ['client', 'from', 'prerelease', 'repo', 'dest', 'no-link', 'no-path', 'autostart', 'dry-run', 'yes', 'statusline', 'no-statusline', 'locale', 'verbose', 'asset', 'fallback', 'set-execution-policy', 'no-execution-policy', 'account', 'panel'],
  // `update` accepts `account` only to refuse it in words (an update moves every registered account).
  update: ['client', 'check', 'rollback', 'dry-run', 'no-path', 'statusline', 'no-statusline', 'locale', 'verbose', 'set-execution-policy', 'no-execution-policy', 'account'],
  uninstall: ['client', 'purge', 'yes', 'dry-run', 'locale', 'verbose', 'account', 'panel'],
};
// Pairs of flags that exclude each other; the refusal is translated by REASONS in present.js.
export const EXCLUSIVE_FLAGS = [['check', 'rollback'], ['statusline', 'no-statusline'], ['set-execution-policy', 'no-execution-policy']];
export const VALUE_FLAGS = ['client', 'repo', 'dest', 'from', 'locale', 'asset', 'account'];

/**
 * The flags of a run, read the one way the installer reads them: a value flag takes the next word and the last one wins.
 * The installer refuses what it does not know; a `lenient` read (the one that tells the run afterwards) keeps any flag
 * and ignores what is not one, so the commands that replay a run mean what the run meant.
 */
export function flagsOf(command, args, { lenient = false } = {}) {
  const flags = {};
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index].replace(/^--/, '');
    if (!args[index].startsWith('--') || !(lenient || ALLOWED_FLAGS[command]?.includes(flag))) {
      if (lenient) continue;
      throw new UsageError(`Unknown flag: ${args[index]}`);
    }
    if (VALUE_FLAGS.includes(flag)) {
      if (!args[index + 1] || args[index + 1].startsWith('--')) {
        if (lenient) continue;
        throw new UsageError(`Missing value for --${flag}`);
      }
      flags[flag] = args[++index];
    } else flags[flag] = true;
  }
  if (!lenient) for (const [first, second] of EXCLUSIVE_FLAGS) {
    if (flags[first] && flags[second]) throw new UsageError(`--${first} and --${second} cannot be combined`);
  }
  return flags;
}
