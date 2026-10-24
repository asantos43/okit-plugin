// The two archive writers: a tarball compressed with gzip and a zip, both
// written by hand so the bytes depend on the entries alone. The order of the
// entries is sorted, the modification time is the one the caller gives, the
// modes are explicit and the paths use forward slashes, so two builds of the
// same source produce the same bytes.

import { deflateRawSync } from 'node:zlib';

const BLOCK = 512;

/** The ustar header, in the order the format writes it. */
const HEADER = {
  name: [0, 100],
  mode: [100, 8],
  uid: [108, 8],
  gid: [116, 8],
  size: [124, 12],
  mtime: [136, 12],
  chksum: [148, 8],
  type: [156, 1],
  linkname: [157, 100],
  magic: [257, 6],
  version: [263, 2],
  uname: [265, 32],
  gname: [297, 32],
  devmajor: [329, 8],
  devminor: [337, 8],
  prefix: [345, 155],
  pad: [500, 12],
};

const ZIP_LOCAL = 0x04034b50;
const ZIP_CENTRAL = 0x02014b50;
const ZIP_END = 0x06054b50;
const ZIP_DEFLATE = 8;
const ZIP_UTF8 = 0x0800;

/** The CRC-32 of the zip format, computed without a table. */
function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** The octal field of a tar header: digits, then a NUL. */
function octal(value, length) {
  const digits = Math.max(0, Math.floor(value)).toString(8);
  if (digits.length > length - 1) throw new RangeError(`value does not fit in ${length} octal bytes`);
  return `${digits.padStart(length - 1, '0')}\0`;
}

/** The checksum field of a tar header: six digits, a NUL and a space. */
function checksum(value) {
  return `${value.toString(8).padStart(6, '0')}\0 `;
}

/**
 * The name of a tar entry, split into the prefix and the name when the name
 * is longer than the format allows.
 *
 * @param {string} path the path of the entry
 * @returns {{name: string, prefix: string}} the two fields
 */
function splitName(path) {
  if (Buffer.byteLength(path) <= HEADER.name[1]) return { name: path, prefix: '' };
  for (let index = path.lastIndexOf('/'); index > 0; index = path.lastIndexOf('/', index - 1)) {
    const prefix = path.slice(0, index);
    const name = path.slice(index + 1);
    if (Buffer.byteLength(name) <= HEADER.name[1] && Buffer.byteLength(prefix) <= HEADER.prefix[1]) {
      return { name, prefix };
    }
  }
  throw new RangeError(`path is too long for a tar entry: ${path}`);
}

/** The mode of an entry, as the number the header writes. */
function modeNumber(mode) {
  const parsed = typeof mode === 'number' ? mode : Number.parseInt(String(mode ?? ''), 8);
  if (!Number.isInteger(parsed) || parsed < 0) throw new TypeError(`mode is not an octal number: ${mode}`);
  return parsed;
}

/**
 * The header of one tar entry.
 *
 * @param {object} entry the entry: `{path, data, mode}`
 * @param {number} mtime the modification time, in seconds
 * @returns {Buffer} the 512 bytes of the header
 */
function tarHeader(entry, mtime) {
  const header = Buffer.alloc(BLOCK, 0);
  const { name, prefix } = splitName(entry.path);
  header.write(name, HEADER.name[0], HEADER.name[1], 'utf8');
  header.write(octal(modeNumber(entry.mode), HEADER.mode[1]), HEADER.mode[0], HEADER.mode[1], 'ascii');
  header.write(octal(0, HEADER.uid[1]), HEADER.uid[0], HEADER.uid[1], 'ascii');
  header.write(octal(0, HEADER.gid[1]), HEADER.gid[0], HEADER.gid[1], 'ascii');
  header.write(octal(entry.data.length, HEADER.size[1]), HEADER.size[0], HEADER.size[1], 'ascii');
  header.write(octal(mtime, HEADER.mtime[1]), HEADER.mtime[0], HEADER.mtime[1], 'ascii');
  header.write('0', HEADER.type[0], HEADER.type[1], 'ascii');
  header.write('ustar\0', HEADER.magic[0], HEADER.magic[1], 'ascii');
  header.write('00', HEADER.version[0], HEADER.version[1], 'ascii');
  if (prefix !== '') header.write(prefix, HEADER.prefix[0], HEADER.prefix[1], 'utf8');
  // The checksum covers the header with its own field filled with spaces.
  header.write('        ', HEADER.chksum[0], HEADER.chksum[1], 'ascii');
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(checksum(sum), HEADER.chksum[0], HEADER.chksum[1], 'ascii');
  return header;
}

/**
 * The entries in the order they are written: sorted by path, so the bytes do
 * not depend on the order the caller collected them.
 *
 * @param {object[]} entries the entries of the archive
 * @returns {object[]} the sorted entries
 */
function sorted(entries) {
  return [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * A gzip container around a deflate stream. The header is written here, not
 * by `zlib`, so the time and the operating system byte are the same on every
 * machine.
 *
 * @param {Buffer} data the bytes to compress
 * @param {number} mtime the modification time, in seconds
 * @returns {Buffer} the bytes of the container
 */
function gzip(data, mtime) {
  const header = Buffer.alloc(10, 0);
  header[0] = 0x1f;
  header[1] = 0x8b;
  header[2] = 0x08;
  header[3] = 0x00;
  header.writeUInt32LE(mtime >>> 0, 4);
  header[8] = 0x00;
  header[9] = 0xff;
  const tail = Buffer.alloc(8, 0);
  tail.writeUInt32LE(crc32(data), 0);
  tail.writeUInt32LE(data.length >>> 0, 4);
  return Buffer.concat([header, deflateRawSync(data, { level: 9 }), tail]);
}

/**
 * A tarball, compressed with gzip.
 *
 * @param {object[]} entries the entries: `{path, data, mode}`
 * @param {object} [options]
 * @param {number} [options.mtime] the modification time of every entry
 * @returns {Buffer} the bytes of the archive
 */
export function tarGz(entries, { mtime = 0 } = {}) {
  const blocks = [];
  for (const entry of sorted(entries)) {
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data ?? '', 'utf8');
    blocks.push(tarHeader({ ...entry, data }, mtime));
    blocks.push(data);
    const padding = (BLOCK - (data.length % BLOCK)) % BLOCK;
    if (padding > 0) blocks.push(Buffer.alloc(padding, 0));
  }
  blocks.push(Buffer.alloc(BLOCK * 2, 0));
  return gzip(Buffer.concat(blocks), mtime);
}

/** The DOS time and date of a moment, in UTC so the bytes do not depend on the machine. */
function dosTime(mtime) {
  const when = new Date(mtime * 1000);
  const year = Math.max(when.getUTCFullYear(), 1980);
  const time = (when.getUTCHours() << 11) | (when.getUTCMinutes() << 5) | (when.getUTCSeconds() >> 1);
  const date = ((year - 1980) << 9) | ((when.getUTCMonth() + 1) << 5) | when.getUTCDate();
  return { time, date };
}

/**
 * A zip file.
 *
 * @param {object[]} entries the entries: `{path, data, mode}`
 * @param {object} [options]
 * @param {number} [options.mtime] the modification time of every entry
 * @returns {Buffer} the bytes of the archive
 */
export function zip(entries, { mtime = 0 } = {}) {
  const ordered = sorted(entries);
  const local = [];
  const central = [];
  let offset = 0;

  for (const entry of ordered) {
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data ?? '', 'utf8');
    const name = Buffer.from(entry.path, 'utf8');
    const { time, date } = dosTime(mtime);
    const sum = crc32(data);
    const compressed = deflateRawSync(data, { level: 9 });

    const header = Buffer.alloc(30, 0);
    header.writeUInt32LE(ZIP_LOCAL, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(ZIP_UTF8, 6);
    header.writeUInt16LE(ZIP_DEFLATE, 8);
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(date, 12);
    header.writeUInt32LE(sum, 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(0, 28);
    local.push(header, name, compressed);

    const record = Buffer.alloc(46, 0);
    record.writeUInt32LE(ZIP_CENTRAL, 0);
    // The high byte says the attributes are POSIX ones, so the mode is read.
    record.writeUInt16LE(0x031e, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(ZIP_UTF8, 8);
    record.writeUInt16LE(ZIP_DEFLATE, 10);
    record.writeUInt16LE(time, 12);
    record.writeUInt16LE(date, 14);
    record.writeUInt32LE(sum, 16);
    record.writeUInt32LE(compressed.length, 20);
    record.writeUInt32LE(data.length, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt16LE(0, 30);
    record.writeUInt16LE(0, 32);
    record.writeUInt16LE(0, 34);
    record.writeUInt32LE(((modeNumber(entry.mode) | 0o100000) * 0x10000) >>> 0, 38);
    record.writeUInt32LE(offset, 42);
    central.push(record, name);

    offset += header.length + name.length + compressed.length;
  }

  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22, 0);
  end.writeUInt32LE(ZIP_END, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(ordered.length, 8);
  end.writeUInt16LE(ordered.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...local, directory, end]);
}
