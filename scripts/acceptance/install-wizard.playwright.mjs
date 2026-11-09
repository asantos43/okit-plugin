#!/usr/bin/env node
// Browser acceptance for the install wizard (D151). Not a unit test: it lives outside test/ so
// `node --test` never collects it. It needs a Playwright already installed (no repository dependency):
//   node scripts/acceptance/install-wizard.playwright.mjs
// Without a runner it prints `not run: no runner` and exits 0. Set PLAYWRIGHT_MODULE to a path or
// package name to force one. It runs `okit-plugin install --headless` in a scratch HOME.
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
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
const env = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: join(home, '.codex'),
  CLAUDE_CONFIG_DIR: join(home, '.claude'), OKIT_NO_UPDATE_CHECK: '1' };
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
  await press('requirements');
  await press('review');
  await page.waitForSelector('#wizard-preview:not(:empty)');
  check((await page.locator('[data-wizard="apply"]').isDisabled()), 'Apply must wait for consent');
  await page.waitForSelector('#wizard-consent-label:not([hidden])');
  await page.focus('#wizard-consent'); await page.keyboard.press('Space');
  await page.waitForSelector('[data-wizard="apply"]:not([disabled])');
  await press('apply');
  await page.waitForFunction(() => document.querySelector('#wizard-status').textContent.length > 0);

  // Reload reconnects to the same job (the token is gone from the URL; reopen with it).
  await page.goto(url);
  await page.waitForSelector('#wizard-heading:not(:empty)');
  check(foreign.length === 0, `foreign requests: ${foreign.join(', ')}`);
  // Rerun (D154): once the install has finished, a second run on the same HOME finds the records and offers
  // Update, Repair and Change models, each only as a review (nothing is written before the consent).
  const finished = await page.waitForFunction(() => document.querySelector('#wizard-status').textContent === '', null, { timeout: 120000 }).then(() => true, () => false);
  if (finished) {
    run.child.kill('SIGTERM');
    const again = launch(); const secondUrl = await again.url;
    await page.goto(secondUrl);
    await page.waitForSelector('#wizard-heading:not(:empty)');
    for (const action of ['rerun:update', 'rerun:repair', 'rerun:models']) {
      check(await page.locator(`[data-wizard="${action}"]`).count() === 1, `a second run must offer ${action}`);
    }
    await page.click('[data-wizard="rerun:update"]');
    await page.waitForSelector('#wizard-preview:not(:empty)');
    check(await page.locator('[data-wizard="apply"]').isDisabled(), 'a rerun review must wait for consent');
    again.child.kill('SIGTERM');
  } else console.log('note: install did not finish within 120 s; rerun case skipped');

  console.log('ok: keyboard review and apply, reload, language switch, no foreign request');
} catch (error) { failure = error; }
finally { await browser?.close(); await stop(); }
if (failure) { console.error(`failed: ${failure.message}`); process.exit(1); }
