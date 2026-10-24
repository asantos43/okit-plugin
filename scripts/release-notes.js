#!/usr/bin/env node
// The release notes of a version: `node scripts/release-notes.js`. It reads
// the change history of the repository root and the metadata of the pairs and
// writes the notes of the version. Nothing is published, no tag is cut and no
// network is used.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { releaseConfig } from '../src/release/config.js';
import { buildNotes } from '../src/release/notes.js';
import { readJson } from '../src/state.js';
import { paths, stateRoot } from '../src/store.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const USAGE = [
  'usage: node scripts/release-notes.js [--out <dir>] [--version <version>] [--dry-run]',
  '',
  '  --out <dir>       where the notes file is written (default: the release folder)',
  '  --version <ver>   the version of the notes; it must be the version of the package',
  '  --dry-run         list what would be written, without writing anything',
].join('\n');

/**
 * The arguments of the command. An unknown flag is a usage error.
 *
 * @param {string[]} argv the arguments, without the script name
 * @returns {{out: string|null, version: string|null, dryRun: boolean, error: string|null}}
 */
export function readArgs(argv) {
  const options = { out: null, version: null, dryRun: false, error: null };
  let index = 0;
  while (index < argv.length) {
    const arg = argv[index];
    index += 1;
    const value = () => {
      const next = argv[index];
      if (!next || next.startsWith('-')) {
        options.error = `${arg} requires a value`;
        return null;
      }
      index += 1;
      return next;
    };
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--out') options.out = value() ?? '';
    else if (arg === '--version') options.version = value() ?? '';
    else if (arg !== '--help' && arg !== '-h') options.error = `unknown argument "${arg}"`;
  }
  return options;
}

/**
 * Writes the notes of the version and prints what it did.
 *
 * @param {string[]} argv the arguments, without the script name
 * @param {object} [io] the streams and the environment
 * @returns {Promise<number>} the exit code: the number of refusals
 */
export async function main(argv = [], io = {}) {
  const out = io.stdout ?? ((line) => process.stdout.write(`${line}\n`));
  const err = io.stderr ?? ((line) => process.stderr.write(`${line}\n`));
  const options = readArgs(argv);
  if (options.error !== null) {
    err(options.error);
    err(USAGE);
    return 2;
  }

  const env = io.env ?? process.env;
  const root = io.root ?? ROOT;
  if (argv.includes('--help') || argv.includes('-h')) {
    out(USAGE);
    return 0;
  }

  const stored = await readJson(paths(stateRoot(env)).config, {});
  const config = releaseConfig(stored.release ?? {});
  const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));

  const result = await buildNotes({
    root,
    config,
    packageJson,
    out: options.out,
    version: options.version,
  });

  if (result.refusal !== null) {
    err(`refused: ${result.refusal}`);
    return 1;
  }

  if (options.dryRun) {
    out(`would write: ${result.file}`);
    for (const pair of result.pairs) out(`would list: ${pair.file}`);
    return 0;
  }

  await mkdir(dirname(result.file), { recursive: true });
  await writeFile(result.file, result.notes, 'utf8');
  out(`wrote: ${result.file}`);
  return 0;
}

const entry = fileURLToPath(import.meta.url);
if (process.argv[1] !== undefined && resolve(process.argv[1]) === entry) {
  process.exitCode = await main(process.argv.slice(2));
}
