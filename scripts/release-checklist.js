#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { releaseConfig } from '../src/release/config.js';
import { buildChecklist } from '../src/release/checklist.js';
import { readJson } from '../src/state.js';
import { paths, stateRoot } from '../src/store.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const USAGE = 'usage: node scripts/release-checklist.js [--out <dir>] [--version <version>] [--revision <revision>] [--dry-run]';

export function readArgs(argv) {
  const options = { out: null, version: null, revision: '', dryRun: false, error: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') options.dryRun = true;
    else if (['--out', '--version', '--revision'].includes(arg)) {
      const value = argv[index + 1];
      if (!value || value.startsWith('-')) { options.error = `${arg} requires a value`; break; }
      options[arg.slice(2)] = value;
      index += 1;
    } else if (!['--help', '-h'].includes(arg)) { options.error = `unknown argument "${arg}"`; break; }
  }
  return options;
}

export async function main(argv = [], io = {}) {
  const out = io.stdout ?? ((line) => process.stdout.write(`${line}\n`));
  const err = io.stderr ?? ((line) => process.stderr.write(`${line}\n`));
  const options = readArgs(argv);
  if (options.error) { err(options.error); err(USAGE); return 2; }
  if (argv.includes('--help') || argv.includes('-h')) { out(USAGE); return 0; }
  try {
    const root = io.root ?? ROOT;
    const stored = await readJson(paths(stateRoot(io.env ?? process.env)).config, {});
    const config = releaseConfig(stored.release ?? {});
    const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
    const result = await buildChecklist({ root, config, packageJson, ...options });
    if (result.refusal !== null) { err(`refused: ${result.refusal}`); return 1; }
    if (options.dryRun) {
      out(`would write: ${result.file}`);
      for (const pair of result.pairs) out(`would list: ${pair.file}`);
      return 0;
    }
    await mkdir(dirname(result.file), { recursive: true });
    try { await writeFile(result.file, result.checklist, { encoding: 'utf8', flag: 'wx' }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (await readFile(result.file, 'utf8') !== result.checklist) throw new Error(`existing checklist differs: ${result.file}`);
    }
    out(`wrote: ${result.file}`);
    return 0;
  } catch (error) { err(`refused: ${error.message}`); return 1; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
