#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publishRelease, PublishFailedError } from '../src/release/publish.js';
import { readJson } from '../src/state.js';
import { paths, stateRoot } from '../src/store.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const USAGE = 'usage: node scripts/release-publish.js [--publish | --dry-run] [--out <dir>]';

export function readArgs(argv) {
  const options = { publish: false, out: null };
  if (argv.includes('--publish') && argv.includes('--dry-run')) throw new Error('choose --publish or --dry-run');
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--publish') options.publish = true;
    else if (arg === '--dry-run') options.publish = false;
    else if (arg === '--out') {
      const value = argv[++index];
      if (!value || value.startsWith('-')) throw new Error('--out requires a value');
      options.out = resolve(value);
    } else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

export async function main(argv = [], io = {}) {
  const stdout = io.stdout ?? ((line) => console.log(line));
  const stderr = io.stderr ?? ((line) => console.error(line));
  if (argv.includes('--help')) { stdout(USAGE); return 0; }
  try {
    const options = readArgs(argv);
    const env = io.env ?? process.env;
    const stored = await readJson(paths(stateRoot(env)).config, {});
    const result = await publishRelease({ root: io.root ?? ROOT, config: stored.release ?? {},
      userConfig: stored, env, git: io.git, verify: io.verify, ...options });
    stdout(`${options.publish ? 'published' : 'dry-run'}: ${result.title}\ntag: ${result.tag}\ntarget: ${result.sha}\nprerelease: ${result.prerelease}`);
    for (const file of result.files) stdout(`file: ${file}`);
    stdout(result.command);
    return 0;
  } catch (error) {
    stderr(error instanceof PublishFailedError ? error.message : `refused: ${error.message}`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
