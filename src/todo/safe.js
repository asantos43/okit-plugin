import { createHash, randomBytes } from 'node:crypto';
import { open, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { withLock } from '../state.js';

const hash = text => createHash('sha256').update(text).digest('hex');
const refuse = message => { throw new Error(message); };
function inside(root, file) {
  const rel = relative(root, file);
  if (rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel)) {
    refuse('The file is outside the project. / O arquivo está fora do projeto.');
  }
}

export async function safePath(project, name) {
  if (!isAbsolute(project)) refuse('Use the full project folder. / Use a pasta completa do projeto.');
  const root = await realpath(resolve(project));
  const file = resolve(root, name);
  inside(root, file);
  const actual = await realpath(file);
  inside(root, actual);
  return { root, file: actual, requested: file };
}

export async function readSnapshot(project, name) {
  const path = await safePath(project, name);
  const before = await stat(path.file);
  if (!before.isFile()) refuse('Choose a regular file. / Escolha um arquivo comum.');
  const text = await readFile(path.file, 'utf8');
  const after = await stat(path.file);
  if (before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) refuse('The file changed; try again. / O arquivo mudou; tente novamente.');
  return { ...path, text, hash: hash(text), mtime: after.mtimeMs, ino: after.ino, mode: after.mode };
}

async function unchanged(snapshot) {
  const path = await safePath(snapshot.root, snapshot.requested);
  const current = await readSnapshot(snapshot.root, snapshot.requested);
  if (path.file !== snapshot.file || current.hash !== snapshot.hash
    || current.mtime !== snapshot.mtime || current.ino !== snapshot.ino) {
    refuse('The file changed; review it and try again. / O arquivo mudou; confira e tente novamente.');
  }
}

// Reuse the state lock and the sibling-temp + rename pattern used by state.js.
// The destination must already exist: synchronization never creates directories.
export async function writeSnapshot(snapshot, text, { beforeRename = async () => {} } = {}) {
  await unchanged(snapshot);
  return withLock(snapshot.file, async () => {
    await unchanged(snapshot);
    const temp = resolve(dirname(snapshot.file), `.${randomBytes(12).toString('hex')}.tmp`);
    try {
      const handle = await open(temp, 'wx', snapshot.mode);
      try { await handle.chmod(snapshot.mode); await handle.writeFile(text); await handle.sync(); }
      finally { await handle.close(); }
      await beforeRename();
      await unchanged(snapshot);
      await rename(temp, snapshot.file);
    } finally {
      await rm(temp, { force: true });
    }
  });
}
