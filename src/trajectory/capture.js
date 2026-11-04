import { open } from 'node:fs/promises';
import { readTrajectory as claude } from '../../adapters/claude-code/trajectory.js';
import { readTrajectory as codex } from '../../adapters/codex/trajectory.js';
import { readTrajectory as opencode } from '../../adapters/opencode/trajectory.js';
import { readJson } from '../state.js';
import { settings } from './config.js';
import { save } from './store.js';
import { step, normalize } from './schema.js';
const readers = new Map([['claude-code', claude], ['codex', codex], ['opencode', opencode]]);

export async function capture(root, context, { transcript, file, message, outcome, usage } = {}) {
  try {
    const config = await settings(root);
    if (config.enabled !== true) return false;
    let shortened = false;
    if (file) {
      const handle = await open(file, 'r');
      try {
        const buffer = Buffer.alloc(config.maxFileBytes);
        const read = await handle.read(buffer, 0, buffer.length, 0);
        transcript = buffer.subarray(0, read.bytesRead).toString('utf8');
        shortened = (await handle.stat()).size > read.bytesRead;
      } finally { await handle.close(); }
    }
    const version = (await readJson(new URL('../../package.json', import.meta.url), {})).version ?? null;
    const data = readers.get(context.client)(transcript, { ...context, version });
    if (message != null) data.steps.unshift(step({ source: 'user', message }));
    if (outcome != null) data.steps.push(step({ source: 'system', message: outcome,
      metrics: usage }));
    if (shortened) data.steps.push(step({ source: 'system', message: config.truncationMarker }));
    data.final_metrics.total_steps = data.steps.length;
    return await save(root, normalize(data));
  } catch { return false; } // Optional local recording never interrupts work.
}
