import * as filesystem from 'node:fs/promises';
import { spawn as spawnProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { configOf } from '../profiles.js';
import { accountsOf } from '../accounts.js';
import { pollStateFile } from './active-poller.js';

// The CLI waits only for local file operations; the bounded worker owns the read.
export async function requestQuotaRead({ root, env = process.env, fs = filesystem, spawn = spawnProcess,
  now = Date.now }, client, id = 'default', { force = false } = {}) {
  try {
    const saved = JSON.parse(await fs.readFile(join(root, 'config.json'), 'utf8'));
    // Isolated CLI tests must explicitly opt in before launching detached work.
    if (process.env.NODE_TEST_CONTEXT && saved?.quotaPoll?.enabled !== true) return;
    const config = configOf(saved);
    if (!config.quotaPoll.enabled || !accountsOf(config, client).some((a) => a.id === id)) return;
    const directory = join(root, 'quota');
    const file = join(directory, pollStateFile(client, id));
    let state;
    try { state = JSON.parse(await fs.readFile(file, 'utf8')); } catch { /* no observation */ }
    if (!force && (now() - (state?.at ?? 0) < 60_000 || now() < (state?.nextTryAt ?? 0))) return;
    await fs.mkdir(directory, { recursive: true });
    const lease = `${file}.request`;
    let handle;
    try { handle = await fs.open(lease, 'wx', 0o600); }
    catch {
      const text = await fs.readFile(lease, 'utf8');
      if (!text.trim() || now() - Number(text) < 60_000) return;
      await fs.rm(lease, { force: true });
      try { handle = await fs.open(lease, 'wx', 0o600); } catch { return; }
    }
    await handle.writeFile(String(now())); await handle.close();
    const worker = spawn(process.execPath, [fileURLToPath(new URL('./active-worker.js', import.meta.url)), root,
      client, id, force ? 'force' : 'due'], { env, detached: true, stdio: 'ignore' });
    worker.on('error', () => {});
    worker.unref();
  } catch { /* Best effort: a quota read never fails the foreground operation. */ }
}

export async function serviceRunning(root, fs = filesystem) {
  try {
    const owner = JSON.parse(await fs.readFile(join(root, 'daemon.pid.json'), 'utf8'));
    if (!Number.isInteger(owner.pid) || owner.pid < 1) return false;
    process.kill(owner.pid, 0); return true;
  } catch { return false; }
}
