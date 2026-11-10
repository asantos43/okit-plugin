#!/usr/bin/env node
// Browser acceptance for the install wizard (D151). Not a unit test: it lives outside test/ so
// `node --test` never collects it. It needs a Playwright already installed (no repository dependency):
//   node scripts/acceptance/install-wizard.playwright.mjs
// Without a runner it prints `not run: no runner` and exits 0. Set PLAYWRIGHT_MODULE to a path or
// package name to force one. It runs `okit-plugin install --headless` in a scratch HOME.
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const require = createRequire(import.meta.url);

async function findRunner() {
  const candidates = [process.env.PLAYWRIGHT_MODULE, 'playwright', 'playwright-core',
    '/usr/lib/node_modules/playwright', '/usr/local/lib/node_modules/playwright'].filter(Boolean);
  for (const name of candidates) {
    try { const mod = require(name); if (mod.chromium) return mod; } catch { /* try the next */ }
  }
  return null;
}

const playwright = await findRunner();
if (!playwright) { console.log('not run: no runner'); process.exit(0); }

const home = await mkdtemp(join(tmpdir(), 'okit-wizard-accept-'));
// A PATH with only what the install needs: node, a shell and a fake `claude` that answers the plugin commands.
// With the real PATH the run would drive the clients installed on this machine (and could wait on them), which is
// what made an earlier version of this script report "install did not finish within 120 s".
const bin = join(home, 'bin'); await mkdir(bin, { recursive: true });
await symlink(process.execPath, join(bin, 'node'));
for (const shell of ['sh', 'bash']) await symlink(`/bin/${shell}`, join(bin, shell)).catch(() => {});
await writeFile(join(bin, 'claude'), '#!/bin/sh\ncase "$1" in --version) echo 2.0.0;; esac\nexit 0\n'); await chmod(join(bin, 'claude'), 0o755);
const env = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: join(home, '.codex'),
  CLAUDE_CONFIG_DIR: join(home, '.claude'), OKIT_NO_UPDATE_CHECK: '1', PATH: bin };
// One headless run of the installer: its child process and the private URL it prints.
const children = [];
function launch() {
  const child = spawn(process.execPath, [join(repo, 'src', 'cli.js'), 'install', '--headless', '--from', repo],
    { env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  const url = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no private URL printed within 15 s')), 15000);
    let text = '';
    child.stdout.on('data', (chunk) => {
      text += chunk; const hit = text.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[a-f0-9]+/);
      if (hit) { clearTimeout(timer); resolve(hit[0]); }
    });
    child.on('exit', (code) => reject(new Error(`install exited early with ${code}`)));
  });
  return { child, url };
}
const stop = async () => { for (const child of children) child.kill('SIGTERM'); await rm(home, { recursive: true, force: true }); };
const run = launch();
const url = await run.url;

let browser, failure = null;
try {
  try { browser = await playwright.chromium.launch(); }
  catch (error) { console.log(`not run: no browser (${String(error.message).split('\n')[0]})`); await stop(); process.exit(0); }
  const page = await browser.newPage();
  const foreign = [];
  await page.route('**/*', (route) => {
    const target = new URL(route.request().url());
    if (!['127.0.0.1', 'localhost'].includes(target.hostname) && target.protocol.startsWith('http')) {
      foreign.push(target.href); return route.abort();
    }
    return route.continue();
  });
  const check = (ok, message) => { if (!ok) throw new Error(message); };
  const heading = () => page.locator('#wizard-heading').innerText();

  await page.goto(url);
  await page.waitForSelector('#wizard-heading:not(:empty)');
  check(!page.url().includes('token='), 'the token must leave the address bar');
  const first = await heading();

  // Language switch, by keyboard: the heading changes and the key sets stay aligned.
  await page.focus('#wizard-locale');
  await page.keyboard.press('ArrowDown');
  await page.waitForFunction((was) => document.querySelector('#wizard-heading').textContent !== was, first);
  const other = await heading();
  check(other !== first, 'changing the language must change the heading');
  // The wizard moves focus to the new heading after a language change, so focus the select again.
  await page.focus('#wizard-locale');
  await page.keyboard.press('ArrowUp');
  await page.waitForFunction((was) => document.querySelector('#wizard-heading').textContent === was, first);

  // Keyboard only: Tab to the next primary button until the review is shown, consent, apply.
  const press = async (action) => {
    const selector = `[data-wizard="${action}"]:not([disabled])`;
    await page.waitForSelector(selector);
    await page.focus(selector); await page.keyboard.press('Enter');
  };
  await page.evaluate(() => { document.querySelector('#wizard-body details.wizard-options').open = true; });
  for (const key of ['noLink', 'noPath']) await page.check(`input[data-choice="${key}"]`);
  await press('review');
  // The plan takes a while with --from: the screen must say so, never restart, and end in a readable summary.
  await page.waitForSelector('#wizard-consent-label:not([hidden])', { timeout: 120000 });
  const summary = await page.locator('#wizard-preview').innerText();
  check(summary.trim().length > 20, 'the plan summary must have text, not just a non-empty node');
  check(!/[{}\[\]]|undefined|null/.test(summary), `the summary must be words, not JSON: ${summary.slice(0, 80)}`);
  check((await page.locator('[data-wizard="apply"]').isDisabled()), 'Apply must wait for consent');
  await page.waitForSelector('#wizard-consent-label:not([hidden])');
  await page.focus('#wizard-consent'); await page.keyboard.press('Space');
  await page.waitForSelector('[data-wizard="apply"]:not([disabled])');
  await press('apply');
  await page.waitForFunction(() => ['applying', 'result'].includes(document.documentElement.dataset.screen), null, { timeout: 30000 });

  // Reload reconnects to the same job (the token is gone from the URL; reopen with it).
  await page.goto(url);
  await page.waitForSelector('#wizard-heading:not(:empty)');
  check(foreign.length === 0, `foreign requests: ${foreign.join(', ')}`);
  // Rerun (D154): once the install has finished, a second run on the same HOME finds the records and offers
  // Update, Repair and Change models, each only as a review (nothing is written before the consent).
  // After the reload this page is a second view of the same job: it is offered the take-over and shows nothing of the job
  // until it takes it. This is why an earlier version never saw the end ("install did not finish within 120 s"): it waited
  // on a view that was not the owner. Take it, then wait for the real end.
  await page.waitForFunction(() => document.querySelector('[data-wizard="take"]') || document.documentElement.dataset.screen === 'result', null, { timeout: 30000 });
  if (await page.locator('[data-wizard="take"]').count()) await page.click('[data-wizard="take"]');
  const startedAt = Date.now();
  // The install must really end: a failed or finished job both show the done screen. No limit but 300 s, and no "skipped".
  await page.waitForFunction(() => document.documentElement.dataset.screen === 'result', null, { timeout: 300000 });
  const finished = true; console.log(`install ended after ${Date.now() - startedAt} ms`);
  if (finished) {
    run.child.kill('SIGTERM');
    const again = launch(); const secondUrl = await again.url;
    await page.goto(secondUrl);
    await page.waitForSelector('#wizard-heading:not(:empty)');
    for (const action of ['rerun:update', 'rerun:repair', 'rerun:models']) {
      check(await page.locator(`[data-wizard="${action}"]`).count() === 1, `a second run must offer ${action}`);
    }
    await page.click('[data-wizard="rerun:update"]');
    await page.waitForSelector('#wizard-consent-label:not([hidden])', { timeout: 120000 });
    check((await page.locator('#wizard-preview').innerText()).trim().length > 10, 'the rerun review must show a summary');
    check(await page.locator('[data-wizard="apply"]').isDisabled(), 'a rerun review must wait for consent');
    again.child.kill('SIGTERM');
  }

  console.log('ok: keyboard review and apply, reload, language switch, no foreign request');
} catch (error) { failure = error; }
finally { await browser?.close(); await stop(); }
if (failure) { console.error(`failed: ${failure.message}`); process.exit(1); }
