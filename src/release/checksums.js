import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_JSON = fileURLToPath(new URL('../../package.json', import.meta.url));
const MANIFEST_SUFFIX = '-checksums.sha256';
const HASH_LINE = /^([0-9a-f]{64})  (.+)$/;
const UNSAFE_PART = /[^a-z0-9._-]+/g;

// Code-unit order, not locale order: the manifest has to be the same bytes on
// every machine that writes it.
export const compareNames = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * A filesystem-safe piece of a name: lowercase, only letters, digits, dot,
 * dash and underscore. Anything else becomes a single dash.
 */
export function safeNamePart(value, fallback) {
  const text = typeof value === 'string' ? value.trim() : '';
  const cleaned = text.toLowerCase().replace(UNSAFE_PART, '-').replace(/^[.-]+/, '').replace(/[.-]+$/, '');
  return cleaned || fallback;
}

/**
 * The manifest filename of a package: `<P>-<V>-checksums.sha256`, with `P` and
 * `V` taken from the package metadata, never from a constant.
 */
export function manifestFileName(pkg) {
  const name = safeNamePart(pkg?.name, 'package');
  const version = safeNamePart(pkg?.version, '0.0.0');
  return `${name}-${version}${MANIFEST_SUFFIX}`;
}

/**
 * Reads the package metadata that names the manifest.
 */
export async function readPackageMeta(file = PACKAGE_JSON) {
  return JSON.parse(await readFile(file, 'utf8'));
}

/**
 * The manifest name derived from the package metadata of this checkout.
 */
export async function defaultManifestName(file = PACKAGE_JSON) {
  return manifestFileName(await readPackageMeta(file));
}

/**
 * The reason a manifest entry is refused, or null when the name is safe. A
 * name is safe when it stays inside the release folder: no absolute path and
 * no `..` segment.
 */
export function unsafePathReason(name) {
  if (typeof name !== 'string' || name.trim() === '') return 'empty';
  if (isAbsolute(name) || name.startsWith('/') || name.startsWith('\\') || /^[A-Za-z]:/.test(name)) return 'absolute';
  if (name.split(/[\\/]/).includes('..')) return 'traversal';
  return null;
}

const toPosix = (name) => name.replace(/\\/g, '/');

/**
 * The SHA-256 of a file's final bytes, read in a stream so a large payload is
 * never held in memory.
 */
export async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

/**
 * The regular files of a folder, ordered by name.
 */
export async function listRegularFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort(compareNames);
}

/**
 * The files the manifest covers: the given list, or every regular file of the
 * folder. The manifest itself is never among them.
 */
async function selectNames(folder, files, manifestName) {
  const names = [];
  if (files === undefined || files === null) {
    names.push(...await listRegularFiles(folder));
  } else {
    for (const raw of files) {
      const name = toPosix(String(raw).trim());
      const reason = unsafePathReason(name);
      if (reason) throw new Error(`Unsafe file name refused (${reason}): ${raw}`);
      names.push(name);
    }
  }

  const unique = [...new Set(names)].filter((name) => name !== manifestName).sort(compareNames);
  for (const name of unique) {
    const info = await stat(join(folder, name)).catch(() => null);
    if (!info) throw new Error(`Cannot hash missing file: ${name}`);
    if (!info.isFile()) throw new Error(`Not a regular file: ${name}`);
  }
  return unique;
}

/**
 * Writes the SHA-256 manifest of a release folder.
 *
 * `dir` is the folder that holds the artifacts, `files` the names to cover
 * (every regular file of the folder when it is omitted) and `out` the manifest
 * path (the derived name inside `dir` when it is omitted). The manifest never
 * lists itself, and one line per file carries the lowercase digest, two spaces
 * and the exact name, ordered by name, LF and UTF-8.
 */
export async function writeManifest({ dir = '.', files, out } = {}) {
  const folder = resolve(dir);
  const target = out ? resolve(out) : join(folder, await defaultManifestName());
  const manifestName = toPosix(relative(folder, target));
  const names = await selectNames(folder, files, manifestName);

  const lines = [];
  for (const name of names) {
    const digest = await hashFile(join(folder, name));
    lines.push(`${digest}  ${name}\n`);
  }
  await writeFile(target, lines.join(''), 'utf8');
  return { out: target, files: names };
}

/**
 * Reads the manifest lines. A line that is not `<digest>  <name>` is reported
 * as `malformed-line` instead of being ignored.
 */
function parseManifest(raw, problems) {
  const entries = [];
  const lines = raw.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  lines.forEach((line, index) => {
    const text = line.endsWith('\r') ? line.slice(0, -1) : line;
    const match = HASH_LINE.exec(text);
    if (!match) {
      problems.push({ file: text.trim() || `line ${index + 1}`, reason: 'malformed-line' });
      return;
    }
    entries.push({ name: match[2], hash: match[1] });
  });
  return entries;
}

/**
 * Reports the files of the folder that the manifest does not list. The
 * manifest never lists itself, so it is not one of them.
 */
async function reportUnlisted(folder, manifest, listed, problems) {
  const manifestName = toPosix(relative(folder, manifest));
  for (const name of await listRegularFiles(folder)) {
    if (name === manifestName) continue;
    if (listed.has(name)) continue;
    problems.push({ file: name, reason: 'unlisted' });
  }
}

/**
 * Verifies a release folder against its SHA-256 manifest.
 *
 * `checked` counts the listed files whose bytes were compared; `problems`
 * carries one entry per refusal, with the reason `missing`, `modified`,
 * `unlisted`, `malformed-line` or `unsafe-path`.
 */
export async function verifyManifest(manifestPath, { dir } = {}) {
  const manifest = resolve(manifestPath);
  const folder = resolve(dir ?? dirname(manifest));
  const problems = [];
  const entries = parseManifest(await readFile(manifest, 'utf8'), problems);

  const listed = new Set();
  let checked = 0;
  for (const entry of entries) {
    const name = toPosix(entry.name).replace(/^\.\//, '');
    if (unsafePathReason(name)) {
      problems.push({ file: entry.name, reason: 'unsafe-path' });
      continue;
    }
    listed.add(name);
    const digest = await hashFile(join(folder, name)).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (digest === null) {
      problems.push({ file: entry.name, reason: 'missing' });
      continue;
    }
    checked += 1;
    if (digest !== entry.hash) problems.push({ file: entry.name, reason: 'modified' });
  }

  await reportUnlisted(folder, manifest, listed, problems);
  return { ok: problems.length === 0, checked, problems };
}
