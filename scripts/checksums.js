#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';

import { defaultManifestName, verifyManifest, writeManifest } from '../src/release/checksums.js';

const USAGE = [
  'Usage:',
  '  node scripts/checksums.js write [--dir DIR] [--files a,b,c] [--out PATH]',
  '  node scripts/checksums.js verify [--manifest PATH] [--dir DIR]',
  '',
  'Without --files, write covers every regular file of the folder except the',
  'manifest itself. Without --manifest, verify looks for the manifest name',
  'derived from package.json inside --dir.',
  '',
  'Exit codes: 0 ok, 1 problems or refusal, 2 usage error.',
].join('\n');

function usageError(message) {
  return Object.assign(new Error(message), { usage: true });
}

async function writeCommand(values) {
  const files = values.files
    ? values.files.flatMap((item) => item.split(',')).map((item) => item.trim()).filter(Boolean)
    : undefined;
  const result = await writeManifest({
    dir: values.dir ?? '.',
    files,
    out: values.out ? resolve(values.out) : undefined,
  });
  process.stdout.write(`checksums: wrote ${result.out} (${result.files.length} files)\n`);
  return 0;
}

async function verifyCommand(values) {
  const dir = values.dir ? resolve(values.dir) : undefined;
  const manifest = values.manifest
    ? resolve(values.manifest)
    : (dir ? join(dir, await defaultManifestName()) : undefined);
  if (!manifest) throw usageError('verify needs --manifest or --dir');
  if (!existsSync(manifest)) throw usageError(`manifest not found: ${manifest}`);

  const result = await verifyManifest(manifest, dir ? { dir } : {});
  for (const problem of result.problems) {
    process.stdout.write(`checksums: ${problem.reason} ${problem.file}\n`);
  }
  if (!result.ok) {
    process.stdout.write(`checksums: ${result.problems.length} problems\n`);
    return 1;
  }
  process.stdout.write(`checksums: ok (${result.checked} files checked)\n`);
  return 0;
}

async function main(argv) {
  let values;
  let positionals;
  try {
    ({ values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        dir: { type: 'string' },
        files: { type: 'string', multiple: true },
        out: { type: 'string' },
        manifest: { type: 'string' },
      },
    }));
  } catch (error) {
    throw usageError(error.message);
  }

  const command = positionals[0];
  if (command === 'write') return await writeCommand(values);
  if (command === 'verify') return await verifyCommand(values);
  throw usageError(command ? `unknown command: ${command}` : 'a command is required');
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`checksums: ${error.message}\n`);
  if (error.usage) process.stderr.write(`\n${USAGE}\n`);
  process.exitCode = error.usage ? 2 : 1;
}
