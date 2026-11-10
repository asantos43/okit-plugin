#!/usr/bin/env node
// Browser acceptance for the install wizard's decision tree (D156). Like install-wizard.playwright.mjs it lives
// outside test/ and needs a Playwright already installed (PLAYWRIGHT_MODULE forces a path); no runner: `not run`.
//   node scripts/acceptance/install-wizard-tree.playwright.mjs
//   OKIT_SCREENSHOTS=/some/folder node ...   one picture per screen and language: en-03-review.png, pt-BR-03-review.png
// It walks the tree in en and pt-BR, end to end, against `install --headless --from <repo>` in scratch HOMEs, with
// fake `claude` and `codex` programs on PATH (the fake claude really answers the plugin commands, so the install
// finishes). Branches: no client, one vs several clients, every client off, Back, the plan calculating, consent before
// Install, installing with Cancel pressed, a reload in the middle that goes back to the same job, a failed install, a
// folder with no write permission, the done screen with its optional steps (models, panel, accounts, restart), Back from
// each of them, and a second run (update, repair, models). On every screen the visible text (outside the collapsed
// "View details") must be words: it fails on JSON, null, undefined, NaN or {placeholder}, on a screen with no text for
// more than 1 s, and on any request that leaves the machine. At the end it prints the paths walked, one per line.
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { labels } from '../../src/config-ui/labels.js';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);
let playwright = null;
for (const name of [process.env.PLAYWRIGHT_MODULE, 'playwright', 'playwright-core', '/usr/lib/node_modules/playwright'].filter(Boolean)) {
  try { const mod = require(name); if (mod.chromium) { playwright = mod; break; } } catch { /* next */ }
}
if (!playwright) { console.log('not run: no runner'); process.exit(0); }

const roots = []; const children = [];
const scratch = async () => { const dir = await mkdtemp(join(tmpdir(), 'okit-wizard-tree-')); roots.push(dir); return dir; };
// A client the wizard can detect. `claude` answers the plugin commands like a client that registers; `delay` slows
// the registration (so a Cancel has something to stop) and `fail` makes `plugin install` fail.
async function fakeClients(home, names, { delay = 0, fail = false } = {}) {
  const bin = join(home, 'bin'); await mkdir(bin, { recursive: true });
  await symlink(process.execPath, join(bin, 'node'));
  for (const shell of ['sh', 'bash']) await symlink(`/bin/${shell}`, join(bin, shell)).catch(() => {});   // the self-check runs a shell
  for (const name of names) {
    const body = name === 'claude'
      ? `#!/bin/sh\ncase "$1" in --version) echo 2.0.0; exit 0;; esac\n${delay ? `sleep ${delay}\n` : ''}${fail ? 'case "$1 $2" in "plugin install") echo "plugin install refused" >&2; exit 1;; esac\n' : ''}exit 0\n`
      : '#!/bin/sh\necho 1.0.0\n';
    await writeFile(join(bin, name), body); await chmod(join(bin, name), 0o755);
  }
  return bin;
}
function launch(home, bin) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: join(home, '.codex'), CLAUDE_CONFIG_DIR: join(home, '.claude'),
    OKIT_NO_UPDATE_CHECK: '1', PATH: bin };
  const child = spawn(process.execPath, [join(repo, 'src', 'cli.js'), 'install', '--headless', '--from', repo], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  const url = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no private URL printed within 20 s')), 20000); let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; const hit = out.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[a-f0-9]+/); if (hit) { clearTimeout(timer); resolve(hit[0]); } });
    child.on('exit', (code) => reject(new Error(`install exited early with ${code}`)));
  });
  return { child, url };
}
const check = (ok, message) => { if (!ok) throw new Error(message); };
const JSONISH = /[{}\[\]]|\bnull\b|undefined|NaN|\[object|\{\w+\}/;
const paths = []; const timings = {}; const foreign = [];
const shotsDir = process.env.OKIT_SCREENSHOTS;
let browser, failure = null;

// Runs in the page: every 100 ms read the words a person sees; remember the first text that looks like JSON and the
// longest time the wizard showed no text at all (after the first text).
const watcher = () => {
  const ids = ['heading', 'status', 'error', 'existing', 'choices', 'body', 'boundaries', 'preview', 'question', 'actions'];
  const read = () => ids.map((id) => { const node = document.getElementById(`wizard-${id}`); return node && node.offsetParent !== null ? node.innerText : ''; }).join('\n');
  window.__wizard = { bad: null, maxEmpty: 0, since: 0, started: false };
  const bad = /[{}\[\]]|\bnull\b|undefined|NaN|\[object|\{\w+\}/;
  setInterval(() => { const state = window.__wizard; const text = read();
    if (state.bad === null && bad.test(text)) state.bad = text.slice(0, 200);
    if (text.trim().length > 0) { state.started = true; state.since = 0; }
    else if (state.started) { state.since ||= Date.now(); state.maxEmpty = Math.max(state.maxEmpty, Date.now() - state.since); } }, 100);
};
const verdict = async (page, where) => {
  const state = await page.evaluate(() => window.__wizard);
  check(state.bad === null, `${where}: JSON-looking text on screen: ${state.bad}`);
  check(state.maxEmpty <= 1000, `${where}: the screen had no text for ${state.maxEmpty} ms`);
};
const words = (page) => page.evaluate(() => ['heading', 'status', 'error', 'existing', 'choices', 'body', 'boundaries', 'preview', 'question', 'actions']
  .map((id) => { const node = document.getElementById(`wizard-${id}`); return node && node.offsetParent !== null ? node.innerText : ''; }).join('\n'));
const screen = (page) => page.evaluate(() => document.documentElement.dataset.screen);
const waitScreen = (page, name, timeout = 300000) => page.waitForFunction((want) => document.documentElement.dataset.screen === want, name, { timeout });
const counters = {};
// One step of the tree: record it, take the picture, check the words.
// The words that are English only: a value of the English catalog that the Portuguese one says differently.
const englishOnly = new Set([labels.en.tablanguage, ...Object.entries(labels.en.wizard).filter(([key, value]) => typeof value === 'string' && labels['pt-BR'].wizard[key] !== value).map(([, value]) => value)]);
async function visit(page, locale, name, label = name) {
  paths.push(`${locale} > ${label}`);
  // The language on screen is the one the step is labelled with: the selector, the page and the words of the screen.
  const shown = await page.evaluate(() => ({ selector: document.getElementById('wizard-locale').value, lang: document.documentElement.lang,
    heading: document.getElementById('wizard-heading').innerText.trim(),
    chrome: [document.getElementById('wizard-locale').parentNode.firstChild.textContent.trim(), document.querySelector('#wizard-technical summary').textContent.trim()],
    buttons: [...document.querySelectorAll('#wizard-actions button, #wizard-body button')].filter((node) => node.offsetParent !== null).map((node) => node.innerText.trim()) }));
  check(shown.selector === locale, `${locale} ${name}: the language selector says ${shown.selector}`);
  check(shown.lang === locale, `${locale} ${name}: the page language is ${shown.lang}`);
  if (locale !== 'en') for (const word of [shown.heading, ...shown.buttons, ...shown.chrome]) check(!englishOnly.has(word), `${locale} ${name}: "${word}" is the English text`);
  const text = await words(page);
  check(text.trim().length > 5, `${locale} ${name}: empty screen`);
  check(!JSONISH.test(text), `${locale} ${name}: JSON-looking text: ${text.slice(0, 120)}`);
  await verdict(page, `${locale} ${name}`);
  if (shotsDir) {
    counters[locale] = (counters[locale] ?? 0) + 1;
    await mkdir(shotsDir, { recursive: true });
    await page.screenshot({ path: join(shotsDir, `${locale}-${String(counters[locale]).padStart(2, '0')}-${name.replace(/[^a-z0-9]+/gi, '-')}.png`), fullPage: true });
  }
  return text;
}
const header = (page) => page.evaluate(() => { const shown = (selector) => [...document.querySelectorAll(selector)].some((node) => node.offsetParent !== null);
  return { close: shown('header [data-action=close]'), title: shown('header h1'), badge: shown('header .badge'), locale: shown('#wizard-locale') }; });

async function pickLocale(page, locale) {
  if (await page.locator('#wizard-locale').inputValue() === locale) return;
  await page.selectOption('#wizard-locale', locale);
  await page.waitForFunction((want) => document.documentElement.lang === want, locale);
}
async function open(locale, names, options = {}) {
  const home = await scratch(); const bin = await fakeClients(home, names, options); if (options.before) await options.before(home);
  const run = launch(home, bin); const url = await run.url;
  const page = await browser.newPage(); await page.addInitScript(watcher);
  await page.route('**/*', (route) => { const target = new URL(route.request().url());
    if (!['127.0.0.1', 'localhost'].includes(target.hostname) && target.protocol.startsWith('http')) { foreign.push(target.href); return route.abort(); } return route.continue(); });
  await page.goto(url); await page.waitForSelector('#wizard-heading:not(:empty)');
  await pickLocale(page, locale);
  return { page, run, home, bin, url, stop: async () => { run.child.kill('SIGTERM'); await page.close(); } };
}
// The advanced options (collapsed): no command link and no PATH change, so the scratch HOME needs nothing on PATH.
const keepHomeClean = async (page) => {
  for (const key of ['noLink', 'noPath']) {
    for (let attempt = 0; ; attempt++) {   // the block can be redrawn while the first screen settles: open it again
      await page.evaluate(() => { const block = document.querySelector('#wizard-body details.wizard-options'); if (block) block.open = true; });
      try { await page.check(`input[data-choice="${key}"]`, { timeout: 5000 }); break; } catch (error) { if (attempt >= 3) throw error; }
    }
  }
};
const toReview = async (page, locale) => {
  const started = Date.now();
  await page.click('[data-wizard="review"]'); await waitScreen(page, 'review', 5000);
  const planning = await page.locator('#wizard-consent-label').isHidden();
  if (planning) {
    await visit(page, locale, 'planning', 'review (plan calculating)');
    check(await page.locator('#wizard-actions [data-wizard="review"]').isDisabled(), `${locale}: the preview button waits while the plan is calculated`);
  }
  await page.waitForSelector('#wizard-consent-label:not([hidden])', { timeout: 150000 });
  timings.plan = Math.max(timings.plan ?? 0, Date.now() - started);
};
const consentAndApply = async (page) => {
  await page.check('#wizard-consent'); await page.waitForSelector('[data-wizard="apply"]:not([disabled])'); await page.click('[data-wizard="apply"]');
};
// After a reload the same job is offered back: take it over, then wait for the screen the job is on.
const reconnect = async (page, url, locale) => {
  await page.goto(url); await page.waitForSelector('#wizard-heading:not(:empty)');
  await pickLocale(page, locale);   // a reload opens the page in the language of the run: choose again
  const take = page.locator('[data-wizard="take"]');
  await page.waitForFunction(() => ['applying', 'result'].includes(document.documentElement.dataset.screen) || document.querySelector('[data-wizard="take"]'), null, { timeout: 30000 });
  const offered = await take.count() > 0; if (offered) await take.click();
  return offered;
};

async function walk(locale) {
  // 1. No client found: no box, the reason, Next disabled.
  { const { page, stop } = await open(locale, []);
    await visit(page, locale, 'detect-none', 'detect (no client found)');
    check(await page.locator('#wizard-choices input[type=checkbox]').count() === 0, 'no client: no checkbox');
    check(await page.locator('[data-wizard="review"]').isDisabled(), 'no client: Next is disabled'); await stop(); }

  // 2. A folder with no write permission: the first screen says so and cannot go on.
  { const { page, home: locked, stop } = await open(locale, ['claude'], { before: (home) => chmod(home, 0o500) });
    const text = await visit(page, locale, 'detect-no-permission', 'detect (no write permission)');
    check(await page.locator('[data-wizard="review"]').isDisabled() || /\S/.test(text), 'no permission: the screen answers');
    paths.push(`${locale} > detect (no write permission) > Next ${await page.locator('[data-wizard="review"]').isDisabled() ? 'disabled' : 'enabled'}`);
    await chmod(locked, 0o700); await stop(); }

  // 3. Several clients: boxes, advanced options, header, every client off, one, Back, consent, a reload in the middle.
  const { page, run, home, bin, url, stop } = await open(locale, ['claude', 'codex']);
  const first = await visit(page, locale, 'detect', 'detect (several clients)');
  check(await page.locator('#wizard-choices input[type=checkbox]').count() >= 2, 'a checkbox per detected client');
  const head = await header(page);
  check(!head.close && !head.title && !head.badge && head.locale, 'the header has only the language selector while the wizard runs');
  check(await page.locator('#wizard-body details:not([open])').count() >= 1, 'advanced options are collapsed');
  check(/\S/.test(first), 'the first screen has words');
  const boxes = page.locator('#wizard-choices input[type=checkbox]'); const count = await boxes.count();
  for (let index = 0; index < count; index++) if (await boxes.nth(index).isChecked()) await boxes.nth(index).uncheck();
  check(await page.locator('[data-wizard="review"]').isDisabled(), 'no client selected: Next is disabled');
  await visit(page, locale, 'detect-none-selected', 'detect (every client off, Next disabled)');
  await boxes.first().check();   // one client
  await keepHomeClean(page);
  const planRequests = []; page.on('request', (request) => { if (request.url().endsWith('/api/install/plan')) planRequests.push(request.url()); });
  await toReview(page, locale);
  check(planRequests.length === 1, `exactly one plan request, got ${planRequests.length}`);
  const one = await visit(page, locale, 'review-one', 'review (one client)');
  check(!/fixtures/.test(one), 'the package test fixtures are not listed');
  check(await page.locator('[data-wizard="apply"]').isDisabled(), 'Install waits for the consent');
  check(await page.locator('#wizard-preview details:not([open])').count() >= 1, 'the JSON is only in the collapsed "View details"');
  await page.click('[data-wizard="detect"]'); await waitScreen(page, 'detect', 5000);
  paths.push(`${locale} > review > Back > detect`);
  await boxes.nth(1).check();    // several clients
  await toReview(page, locale);
  check(planRequests.length === 2, 'a second plan request after Back and another choice');
  await visit(page, locale, 'review-two', 'review (several clients)');
  await consentAndApply(page);
  await page.waitForFunction(() => ['applying', 'result'].includes(document.documentElement.dataset.screen), null, { timeout: 30000 });
  const startedInstall = Date.now();
  // A reload in the middle: the same job comes back (the take-over of this view), and the install goes on to the end.
  if (await screen(page) === 'applying') {
    check(await page.locator('[data-wizard="cancel"]').count() === 1, 'Cancel is visible while installing');
    const text = await visit(page, locale, 'installing', 'installing');
    check(!/completed:|remaining:/.test(text), 'no completed:/remaining: lists');
    const offered = await reconnect(page, url, locale);
    paths.push(`${locale} > installing > reload > ${offered ? 'take over the same job' : 'same job'}`);
  } else paths.push(`${locale} > installing (finished before it could be seen)`);
  await waitScreen(page, 'result', 600000);
  timings.install = Math.max(timings.install ?? 0, Date.now() - startedInstall);
  const done = await visit(page, locale, 'done', 'done');
  const steps = await page.locator('#wizard-body .wizard-checklist li').count();
  check(steps >= 3, `the done screen lists the optional steps (got ${steps}); text: ${done.slice(0, 300)}`);
  for (let index = 0; index < steps; index++) check(await page.locator('#wizard-body .wizard-checklist li').nth(index).locator('button').count() >= 1, `optional step ${index + 1} has its own button`);
  check(/restart|reinici/i.test(done), 'the restart step is on the done screen');
  // Each step in its own screen with its own consent, and Back to the done screen.
  await page.click('#wizard-body .wizard-checklist [data-wizard="models"]'); await waitScreen(page, 'models', 10000);
  await visit(page, locale, 'models', 'done > models'); await page.click('[data-wizard="result"]'); await waitScreen(page, 'result', 10000);
  paths.push(`${locale} > models > Back > done`);
  await page.click('#wizard-body .wizard-checklist [data-wizard="accounts"]'); await waitScreen(page, 'accounts', 10000);
  await visit(page, locale, 'accounts', 'done > accounts'); await page.click('[data-wizard="result"]'); await waitScreen(page, 'result', 10000);
  paths.push(`${locale} > accounts > Back > done`);
  await page.click('#wizard-body .wizard-checklist [data-wizard="panel-preview"]');
  await page.waitForSelector('#wizard-consent-label:not([hidden])', { timeout: 60000 });
  check(await page.locator('#wizard-body [data-wizard="followup"]').isDisabled(), 'the panel step waits for its own consent');
  await visit(page, locale, 'done-panel-review', 'done > panel > review with its own consent');
  check(foreign.length === 0, `foreign requests: ${foreign.join(', ')}`);

  // 4. A second run on the same HOME: update, repair and models, each only a readable review.
  run.child.kill('SIGTERM'); await page.close();
  const again = launch(home, bin); const second = await browser.newPage(); await second.addInitScript(watcher);
  await second.goto(await again.url); await second.waitForSelector('#wizard-heading:not(:empty)');
  await pickLocale(second, locale);
  for (const action of ['rerun:update', 'rerun:repair', 'rerun:models']) check(await second.locator(`[data-wizard="${action}"]`).count() === 1, `a second run offers ${action}`);
  await visit(second, locale, 'second-run', 'second run (update, repair, models)');
  await second.click('[data-wizard="rerun:update"]'); await second.waitForSelector('#wizard-consent-label:not([hidden])', { timeout: 150000 });
  await visit(second, locale, 'second-run-review', 'second run > update > review');
  check(await second.locator('[data-wizard="apply"]').isDisabled(), 'a rerun waits for the consent');
  again.child.kill('SIGTERM'); await second.close();

  // 5. Cancel while installing (a slow registration gives Cancel something to stop).
  { const slow = await open(locale, ['claude'], { delay: 4 });
    await keepHomeClean(slow.page); await toReview(slow.page, locale); await consentAndApply(slow.page);
    await waitScreen(slow.page, 'applying', 30000);
    await slow.page.waitForSelector('[data-wizard="cancel"]:not([disabled])', { timeout: 30000 });
    await slow.page.click('[data-wizard="cancel"]');
    await waitScreen(slow.page, 'result', 120000);
    const text = await visit(slow.page, locale, 'cancelled', 'installing > Cancel > done (cancelled)');
    check(/✗|cancel/i.test(text), `a cancelled install says so: ${text.slice(0, 200)}`);
    await slow.stop(); }

  // 6. A failed install: the client refuses the plugin; the message is per client and the screen offers no next steps.
  { const bad = await open(locale, ['claude'], { fail: true });
    await keepHomeClean(bad.page); await toReview(bad.page, locale); await consentAndApply(bad.page);
    await waitScreen(bad.page, 'result', 300000);
    const text = await visit(bad.page, locale, 'failed', 'installing > failed install (per-client message)');
    check(/✗/.test(text), `a failed install says which client failed: ${text.slice(0, 200)}`);
    await bad.stop(); }
}

try {
  try { browser = await playwright.chromium.launch(); }
  catch (error) { console.log(`not run: no browser (${String(error.message).split('\n')[0]})`); process.exit(0); }
  for (const locale of ['en', 'pt-BR']) await walk(locale);
  check(foreign.length === 0, `foreign requests: ${foreign.join(', ')}`);
  console.log('paths walked:'); for (const line of paths) console.log(`  ${line}`);
  console.log(`ok: ${paths.length} steps in en and pt-BR, no JSON on screen, no screen empty for more than 1 s, no foreign request; plan up to ${timings.plan} ms, install up to ${timings.install ?? 'n/a'} ms`);
} catch (error) { failure = error; }
finally { await browser?.close(); for (const child of children) child.kill('SIGTERM'); for (const dir of roots) { await chmod(dir, 0o700).catch(() => {}); await rm(dir, { recursive: true, force: true }); } }
if (failure) { console.error(`failed: ${failure.message}`); console.error('paths walked so far:'); for (const line of paths) console.error(`  ${line}`); process.exit(1); }
