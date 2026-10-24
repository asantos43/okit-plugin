import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { parseManifest, unsafePathReason } from './manifest.js';
import { request } from './release.js';

export async function boundedDownload(url, deps) {
  const { config, fetch } = deps;
  const response = await request(url, config, fetch);
  if (!response.ok) throw new Error(`Download returned ${response.status}: ${url}`);
  if (Number(response.headers.get('content-length')) > config.maxDownloadBytes) throw new Error('Download size limit exceeded');
  const chunks = [];
  let size = 0;
  const reader = response.body.getReader();
  let timer;
  try {
    await Promise.race([
      (async () => {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          size += value.length;
          if (size > config.maxDownloadBytes) throw new Error('Download size limit exceeded');
          chunks.push(Buffer.from(value));
        }
      })(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Download timeout exceeded')), config.timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); void reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks);
}

export async function downloadRelease(selected, deps) {
  const { fs, temporary } = deps;
  const folder = await fs.mkdtemp(join(temporary, 'installer-'));
  try {
    if (unsafePathReason(selected.asset.name)) throw new Error('Unsafe asset filename');
    const raw = await boundedDownload(selected.manifest.browser_download_url, deps);
    const problems = [];
    const entries = parseManifest(raw.toString('utf8'), problems);
    const matches = entries.filter((entry) => entry.name === selected.asset.name);
    if (problems.length || matches.length !== 1) throw new Error('Checksum manifest malformed or missing unique package entry');
    const bytes = await boundedDownload(selected.asset.browser_download_url, deps);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (sha256 !== matches[0].hash) throw new Error('SHA-256 mismatch: package refused');
    await fs.writeFile(join(folder, selected.asset.name), bytes, { flag: 'wx' });
    return { folder, bytes, sha256 };
  } catch (error) {
    await fs.rm(folder, { recursive: true, force: true });
    throw error;
  }
}
