import { resolve, join } from 'node:path';

/** Validate a preverified, extracted package. Ownership stays with the caller. */
export async function localSource(folder, name, fs, destination) {
  const source = resolve(folder);
  if (destination && (resolve(destination) === source || resolve(destination).startsWith(source + (process.platform === 'win32' ? '\\' : '/')))) {
    throw new TypeError('--from source must not contain the installation destination');
  }
  let pkg;
  try {
    pkg = JSON.parse(await fs.readFile(join(source, 'package.json'), 'utf8'));
    if (!(await fs.stat(join(source, 'src/cli.js'))).isFile()) throw new Error('Missing CLI');
  } catch (error) { throw new TypeError(`Invalid --from package: ${error.message}`); }
  if (pkg.name !== name) throw new TypeError('Invalid --from package name');
  if (!/^[A-Za-z0-9][A-Za-z0-9.+_-]*$/.test(pkg.version) || pkg.version.includes('..')) {
    throw new TypeError('Invalid --from package version');
  }
  return { source, version: pkg.version, sha256: null };
}
