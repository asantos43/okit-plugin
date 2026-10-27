import { open } from 'node:fs/promises';
import { readTrajectory as claude } from '../../adapters/claude-code/trajectory.js';
import { readTrajectory as codex } from '../../adapters/codex/trajectory.js';
import { readTrajectory as opencode } from '../../adapters/opencode/trajectory.js';
import { readJson } from '../state.js';
import { settings } from './config.js';
import { save } from './store.js';
import { step, totals } from './schema.js';
const readers = { 'claude-code': claude, codex, opencode };

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
    const data = readers[context.client](transcript, { ...context, version });
    if (message != null) data.steps.unshift(step({ source: 'user', message }));
    if (outcome != null) data.steps.push(step({ source: 'system', message: outcome,
      metrics: usage }));
    if (shortened) data.steps.push(step({ source: 'system', message: config.truncationMarker }));
    data.steps.forEach((item, index) => { item.step_id = index + 1; });
    data.final_metrics = totals(data.steps);
    return await save(root, data);
  } catch { return false; } // Optional local recording never interrupts work.
}
