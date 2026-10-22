import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';

function fail(message) {
  throw new TypeError(message);
}

function checkDir(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    fail(`${label} must be a non-empty string`);
  }
}

/**
 * Every file under one folder, as a path relative to it with forward slashes,
 * which is the form the clients substitute and the one we store, so the list a
 * caller reports and the tree on disk agree on Windows too.
 */
async function walk(dir, base = dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  // Code point order, never locale order: `refs` must not sort before `SKILL.md`
  // on a machine whose collation ignores case, or the report changes per host.
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await walk(full, base));
    else if (entry.isFile()) files.push(relative(base, full).split(sep).join('/'));
  }
  return files;
}

async function readOrNull(file) {
  try {
    return await readFile(file);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Copies the skill folder at `srcDir` into `destDir`, the folder a client
 * reads its skills from. A file that already sits at the destination and holds
 * the same bytes is left alone, and a file that holds different bytes is never
 * overwritten: the user's own copy wins and the caller is told which files were
 * kept. Returns the destination, the files it wrote and the files it skipped
 * with the reason, so an adapter can report the result to a human.
 */
export async function installSkillFiles(srcDir, destDir) {
  checkDir(srcDir, 'srcDir');
  checkDir(destDir, 'destDir');

  const files = await walk(srcDir);
  const written = [];
  const skipped = [];

  for (const file of files) {
    const parts = file.split('/');
    const source = join(srcDir, ...parts);
    const target = join(destDir, ...parts);
    const bytes = await readFile(source);
    const current = await readOrNull(target);

    if (current !== null) {
      const reason = current.equals(bytes) ? 'identical' : 'differs';
      skipped.push({ path: file, reason });
      continue;
    }

    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
    written.push(file);
  }

  return { path: resolve(destDir), written, skipped };
}