import { isAbsolute } from 'node:path';

/**
 * A filesystem-safe piece of a name: lowercase, only letters, digits, dot,
 * dash and underscore. Anything else becomes a single dash.
 */
export function safeNamePart(value, fallback) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[.-]+/, '').replace(/[.-]+$/, '') || fallback;
}

/**
 * The manifest filename of a package: `<P>-<V>-checksums.sha256`, with `P` and
 * `V` taken from the package metadata, never from a constant.
 */
export function manifestFileName(pkg) {
  return `${safeNamePart(pkg?.name, 'package')}-${safeNamePart(pkg?.version, '0.0.0')}-checksums.sha256`;
}

/**
 * The reason a manifest entry is refused, or null when the name is safe. A
 * name is safe when it stays inside the release folder: no absolute path and
 * no `..` segment.
 */
export function unsafePathReason(name) {
  if (typeof name !== 'string' || !name.trim() || name.includes('\0')) return 'empty';
  if (isAbsolute(name) || /^[\\/]|^[A-Za-z]:/.test(name)) return 'absolute';
  if (name.split(/[\\/]/).includes('..')) return 'traversal';
  return null;
}

/**
 * Reads the manifest lines. A line that is not `<digest>  <name>` is reported
 * as `malformed-line` instead of being ignored.
 */
export function parseManifest(raw, problems = []) {
  const lines = raw.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines.flatMap((line, index) => {
    const match = /^([0-9a-f]{64})  (.+)$/.exec(line.replace(/\r$/, ''));
    if (match) return [{ hash: match[1], name: match[2] }];
    problems.push({ file: line.trim() || `line ${index + 1}`, reason: 'malformed-line' });
    return [];
  });
}
