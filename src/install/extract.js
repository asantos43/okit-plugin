import { gunzipSync, inflateRawSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { unsafePathReason } from './manifest.js';

const text = (bytes) => bytes.toString('utf8').split('\0')[0];
const octal = (bytes) => Number.parseInt(text(bytes).trim() || '0', 8);

function tarEntries(bytes, limit) {
  const data = gunzipSync(bytes, { maxOutputLength: limit });
  const entries = [];
  for (let offset = 0; offset + 512 <= data.length;) {
    const header = data.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) return entries;
    const sum = [...header].reduce((total, byte, index) => total + (index >= 148 && index < 156 ? 32 : byte), 0);
    if (sum !== octal(header.subarray(148, 156))) throw new Error('Invalid tar header checksum');
    const size = octal(header.subarray(124, 136));
    const type = text(header.subarray(156, 157));
    if (!['', '0', '5'].includes(type)) throw new Error('Archive links and special entries refused');
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > data.length) throw new Error('Truncated tar entry');
    const prefix = text(header.subarray(345, 500));
    entries.push({ name: `${prefix ? `${prefix}/` : ''}${text(header.subarray(0, 100))}`,
      mode: octal(header.subarray(100, 108)), directory: type === '5', data: data.subarray(offset + 512, offset + 512 + size) });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error('Truncated tar archive');
}

function zipEntries(bytes, limit) {
  let end = bytes.length - 22;
  while (end >= Math.max(0, bytes.length - 65557) && bytes.readUInt32LE(end) !== 0x06054b50) end -= 1;
  if (end < 0 || bytes.readUInt32LE(end) !== 0x06054b50) throw new Error('Invalid zip directory');
  let offset = bytes.readUInt32LE(end + 16);
  const count = bytes.readUInt16LE(end + 10);
  const entries = [];
  let total = 0;
  for (let index = 0; index < count; index += 1) {
    if (bytes.readUInt32LE(offset) !== 0x02014b50) throw new Error('Invalid zip entry');
    const flags = bytes.readUInt16LE(offset + 8);
    const method = bytes.readUInt16LE(offset + 10);
    const compressed = bytes.readUInt32LE(offset + 20);
    const size = bytes.readUInt32LE(offset + 24);
    const nameSize = bytes.readUInt16LE(offset + 28);
    const mode = bytes.readUInt32LE(offset + 38) >>> 16;
    const local = bytes.readUInt32LE(offset + 42);
    total += size;
    if (total > limit) throw new Error('Extraction size limit exceeded');
    if ((flags & 1) || ![0, 8].includes(method) || ((mode & 0o170000) && ![0o100000, 0o040000].includes(mode & 0o170000))) throw new Error('Archive links or unsupported zip entry refused');
    if (bytes.readUInt32LE(local) !== 0x04034b50) throw new Error('Invalid zip local header');
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    const packed = bytes.subarray(start, start + compressed);
    if (packed.length !== compressed) throw new Error('Truncated zip entry');
    const data = method === 8 ? inflateRawSync(packed, { maxOutputLength: Math.max(1, size) }) : packed;
    if (data.length !== size) throw new Error('Invalid zip entry size');
    const name = bytes.subarray(offset + 46, offset + 46 + nameSize).toString('utf8');
    entries.push({ name, mode: mode || 0o644, data, directory: name.endsWith('/') });
    offset += 46 + nameSize + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
  }
  return entries;
}

/** Validate the entire archive before writing; links are deliberately refused. */
export async function extract(bytes, destination, { format, fs, maxExtractBytes }) {
  if (!['tar.gz', 'zip'].includes(format)) throw new Error(`Unsupported archive: ${format}`);
  const entries = format === 'tar.gz' ? tarEntries(bytes, maxExtractBytes) : zipEntries(bytes, maxExtractBytes);
  let total = 0;
  const seen = new Set();
  for (const entry of entries) {
    if (unsafePathReason(entry.name) || entry.name.includes('\\') || entry.name.includes(':')) throw new Error(`Unsafe archive path: ${entry.name}`);
    if (seen.has(entry.name)) throw new Error(`Duplicate archive path: ${entry.name}`);
    seen.add(entry.name);
    total += entry.data.length;
    if (total > maxExtractBytes) throw new Error('Extraction size limit exceeded');
  }
  for (const entry of entries) {
    const path = join(destination, entry.name);
    await fs.mkdir(entry.directory ? path : dirname(path), { recursive: true });
    if (!entry.directory) {
      await fs.writeFile(path, entry.data, { flag: 'wx', mode: entry.mode & 0o777 });
      await fs.chmod(path, entry.mode & 0o777);
    }
  }
  return entries.length;
}
