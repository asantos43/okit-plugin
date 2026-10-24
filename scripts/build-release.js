#!/usr/bin/env node
// The local build of the release: `node scripts/build-release.js`. It reads
// the configuration, asks for the pairs, builds what it can and refuses what
// it cannot, with the reason. Nothing is published and no file is written
// outside the output folder.

import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { buildRelease } from '../src/release/build.js';
import { writeManifest, verifyManifest, manifestFileName } from '../src/release/checksums.js';
import { readJson } from '../src/state.js';
import { paths, stateRoot } from '../src/store.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const USAGE = [
  'usage: node scripts/build-release.js [--out <dir>] [--pair <client>:<system>]',
  '         [--arch <arch>] [--dry-run]',
  '',
  '  --out <dir>   where the archives are written (default: the configured folder)',
  '  --pair <c:s>  build only this client and system, e.g. claude-code:linux',
  '  --arch <arch> build only this architecture, e.g. x64',
  '  --dry-run     list what would be built, without writing anything',
].join('\n');

/**
 * The arguments of the command. An unknown flag is a usage error, and a
 * `--pair` without a colon is one too.
 *
 * @param {string[]} argv the arguments, without the script name
 * @returns {{out: string|null, pair: string|null, arch: string|null, dryRun: boolean, error: string|null}}
 */
export function readArgs(argv) {
  const options = { out: null, pair: null, arch: null, dryRun: false, error: null };
  let index = 0;
  while (index < argv.length) {
    const arg = argv[index];
    index += 1;
    const value = () => {
      const next = argv[index];
      index += 1;
      return next;
    };
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--out') options.out = value() ?? '';
    else if (arg === '--pair') options.pair = value() ?? '';
    else if (arg === '--arch') options.arch = value() ?? '';
    else options.error = `unknown argument "${arg}"`;
  }
  if (options.pair !== null && !/^[^:]+:[^:]+$/.test(options.pair)) {
    options.error = `--pair must be "<client>:<system>", not "${options.pair}"`;
  }
  return options;
}

/**
 * Runs the build and prints what it did.
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
  const [client, system] = options.pair === null ? [null, null] : options.pair.split(':');

  const result = await buildRelease({
    root,
    config: stored.release ?? {},
    userConfig: stored,
    out: options.out,
    client,
    system,
    arch: options.arch,
    dryRun: options.dryRun,
    env,
  });

  if (!options.dryRun && result.built.length && !result.refused.length) {
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    const manifest = await writeManifest({ dir: result.outputDir, files: result.built.map(({ file }) => file), out: join(result.outputDir, manifestFileName(pkg)) });
    const proof = await verifyManifest(manifest.out, { dir: result.outputDir });
    if (!proof.ok) { err(`checksum verification failed: ${JSON.stringify(proof.problems)}`); return 1; }
  }

  for (const item of result.built) {
    out(`${options.dryRun ? 'would build' : 'built'}: ${item.file} (${item.entries} files)`);
  }
  for (const item of result.refused) {
    err(`refused: ${item.client ?? '?'}:${item.system ?? '?'}:${item.arch ?? '?'} — ${item.reason}`);
  }
  out(`output: ${result.outputDir}`);
  // A run that refused a pair is never a success, and the reason is above.
  return result.refused.length > 0 ? 1 : 0;
}

const entry = fileURLToPath(import.meta.url);
if (process.argv[1] !== undefined && resolve(process.argv[1]) === entry) {
  process.exitCode = await main(process.argv.slice(2));
}
