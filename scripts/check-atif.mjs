import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { samples } from '../test/helpers/trajectory-samples.js';
import { capture } from '../src/trajectory/capture.js';

if (!process.argv[2]) throw new Error('Usage: node scripts/check-atif.mjs <folder>');
const dir = resolve(process.argv[2]);
await mkdir(dir, { recursive: true });
const root = await mkdtemp(join(tmpdir(), 'check-atif-'));
try {
  await writeFile(join(root, 'config.json'), JSON.stringify({ trajectory: { enabled: true, dir } }));
  for (const [client, , transcript] of samples) {
    const context = { session_id: client, client, model: 'example-model', effort: 'high' };
    if (!await capture(root, context, { transcript, message: 'Read sample.txt', outcome: 'Done',
      usage: { cost_usd: 0.01 } })) throw new Error(`Could not save ${client}`);
    console.log(join(dir, `okit-plugin-${client}.json`));
  }
} finally { await rm(root, { recursive: true, force: true }); }
