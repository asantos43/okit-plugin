import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createQuotaPoller } from '../src/quota/active-poller.js';

const execute = promisify(execFile);
test('sandbox cycle and real panel-state CLI show distinct default and extra quotas', { timeout: 15_000 }, async (t) => {
  const probe = await execute(process.execPath, ['-e', 'console.log("d145-pipe-probe")'], { timeout: 3000 });
  if (probe.stdout.trim() !== 'd145-pipe-probe') {
    t.skip('Sandbox drops child stdout pipes (exit 0, empty stdout); Director must run this subprocess proof.');
    return;
  }
  const home = await fs.mkdtemp(join(tmpdir(), 'd145-e2e-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const root = join(home, 'state'), bin = join(home, 'bin'), extra = join(home, 'extra');
  for (const dir of [root, bin, extra, join(home, '.claude'), join(home, '.codex')]) await fs.mkdir(dir, { recursive: true });
  const env = { HOME: home, USERPROFILE: home, TMPDIR: home, PATH: bin,
    CLAUDE_CONFIG_DIR: join(home, '.claude'), CODEX_HOME: join(home, '.codex'), OKWORK_HOME: root };
  await fs.writeFile(join(root, 'config.json'), JSON.stringify({ accounts: {
    'claude-code': [{ id: 'extra', label: 'Extra', configDir: extra }] } }));
  for (const dir of [extra, join(home, '.claude')]) await fs.writeFile(join(dir, '.credentials.json'), JSON.stringify({
    claudeAiOauth: { accessToken: 'SANDBOX_ONLY_SECRET', expiresAt: 1 } }));
  await fs.writeFile(join(home, '.codex', 'auth.json'), '{}');
  await fs.writeFile(join(bin, 'claude'), `#!${process.execPath}
const used = process.env.CLAUDE_CONFIG_DIR === ${JSON.stringify(extra)} ? .1 : .6;
const resetsAt = Math.floor(Date.now() / 1000) + 3600;
console.log(JSON.stringify({type:'rate_limit_event',rate_limit_info:{unifiedWindows:{
five_hour:{utilization:used,resetsAt},seven_day:{utilization:used,resetsAt}}}}));
setInterval(() => {}, 1000);
`, { mode: 0o700 });
  await fs.writeFile(join(bin, 'codex'), `#!${process.execPath}
const rl = require('node:readline').createInterface({input:process.stdin});
rl.on('line', line => { const m=JSON.parse(line);
if(m.id===1) console.log(JSON.stringify({id:1,result:{}}));
if(m.id===2) console.log(JSON.stringify({id:2,result:{rateLimits:{
primary:{usedPercent:25,windowDurationMins:300,resetsAt:Math.floor(Date.now()/1000)+3600},
secondary:{usedPercent:30,windowDurationMins:10080,resetsAt:Math.floor(Date.now()/1000)+86400}}}})); });
`, { mode: 0o700 });
  const poller = createQuotaPoller({ root, env, spawn, cliTimeoutMs: 1000, appTimeoutMs: 1000,
    fetch: () => assert.fail('network is forbidden') });
  await poller.cycle(); await poller.stop();
  const { stdout } = await execute(process.execPath, ['src/cli.js', 'panel-state', '--json', '--client', 'claude'], { env, timeout: 3000 });
  const state = JSON.parse(stdout);
  assert.deepEqual(state.accounts.map((a) => [a.id, a.quota.session.remaining_pct, a.quota.weekly.remaining_pct]),
    [['default', 40, 40], ['extra', 90, 90]]);
  assert.equal(state.accounts[1].rotation.eligible, true);
  assert.equal(JSON.parse(await fs.readFile(join(root, 'quota', 'codex.json'), 'utf8')).windows[0].remainingPct, 75);
});
