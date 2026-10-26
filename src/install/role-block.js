import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const BEGIN_ROLE = '<!-- okit role:begin -->';
export const END_ROLE = '<!-- okit role:end -->';

/** Only a well-formed, unique plugin block is ever replaced or removed. */
export async function roleBlock(path, content, { remove = false } = {}) {
  const before = await readFile(path, 'utf8').catch((error) => {
    if (error.code !== 'ENOENT') throw error;
    return '';
  });
  const start = before.indexOf(BEGIN_ROLE);
  const end = before.indexOf(END_ROLE);
  if ((start < 0) !== (end < 0) || (start >= 0 && (end < start
    || before.indexOf(BEGIN_ROLE, start + 1) >= 0 || before.indexOf(END_ROLE, end + 1) >= 0))) {
    return { status: 'unsupported', path, reason: 'Malformed managed role block; user file preserved. / Bloco de papel malformado; arquivo do usuário preservado.' };
  }
  const block = remove ? '' : `${BEGIN_ROLE}\n${content}\n${END_ROLE}`;
  const after = start >= 0 ? before.slice(0, start) + block + before.slice(end + END_ROLE.length)
    : remove ? before : before + block;
  if (after !== before) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, after);
  }
  return { status: 'ready', path, written: after !== before };
}
