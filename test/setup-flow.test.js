import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import test from 'node:test';

import { main } from '../src/cli.js';
import { installConfig } from '../src/install/config.js';
import { tarGz } from '../src/release/archive.js';
import { formatOffer } from '../src/setup/offer.js';
import { createPresenter } from '../src/install/present.js';
import { runSetup } from '../src/setup/setup.js';
import { answerCheck } from './helpers/install-fixture.js';
import { callTool } from './helpers/tools.js';

test('the remaining install question recommends review in both languages', () => {
  assert.match(formatOffer('question', 'en'), /Recommended: yes, review the detected choices together/);
  assert.match(formatOffer('question', 'pt-BR'), /Recomendação: sim, revisar juntos as escolhas encontradas/); // locale:pt-BR
});

const PENDING = /model choices have not been saved/;
const PENDING_PT = /a escolha de modelos ainda não foi salva/; // locale:pt-BR
// The installer shows the pending setup as one `Models` row, and the command-and-PATH row ends the files part.
const MODELS_PENDING = (line) => /^\s*Models\s+-\s+not set yet\. Run: /.test(line);
const LINK_ROW = /\bCommand and PATH\b/;
const LINK_ROW_PT = /\bComando e PATH\b/;

async function temporaryHome(t) {
  const home = await mkdtemp(join(tmpdir(), 'okit-setup-flow-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  return { home, root: join(home, '.okwork') };
}

/** A client that lists its models, so the setup has something to detect. */
function fakeClient(client, models) {
  return {
    CLIENT: client,
    async listModels() {
      return { client, installed: true, models, hidden: [], source: 'listing' };
    },
  };
}

function terminal(text) {
  return {
    stdin: Readable.from([text]),
    output: new Writable({
      write(_chunk, _encoding, done) { done(); },
    }),
  };
}

async function statusOf(root, home, extra = {}, locale = 'en') {
  const report = await callTool('env_report', { locale }, {
    root,
    home,
    env: { HOME: home, OKWORK_HOME: root },
    readQuota: async () => ({ source: 'off' }),
    run: answerCheck,
    ...extra,
  });
  return { code: 0, out: report.text.split('\n') };
}

/**
 * An installation that really runs: a fake release, a fake download and a
 * temporary home. The state root holds no `setup.done`, so the setup is
 * pending until a test writes it.
 */
async function installation(t, { tty = false, ask } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'okit-setup-install-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const root = join(home, 'state');
  const destination = join(home, 'data');
  const bin = join(home, 'bin');
  await mkdir(root, { recursive: true });
  const config = installConfig({
    repository: 'example/project', api: 'https://fake.invalid', destination, linkDirectory: bin,
  });
  await writeFile(join(root, 'config.json'), JSON.stringify({ install: config }));
  const out = [];
  let version = '1.0.0';
  const pkg = {
    name: 'sample', version, bin: { 'okit-plugin': 'src/cli.js' },
    repository: { url: 'https://example.invalid/example/project' },
  };
  const clients = Object.keys(config.clients);
  const payload = () => tarGz([
    { path: 'package.json', mode: 0o644, data: JSON.stringify({ ...pkg, version }) },
    { path: 'src/cli.js', mode: 0o755, data: '#!/usr/bin/env node\n' },
    // The payload of an installation is whole: the MCP server and the probe of the check are files of it.
    { path: 'src/mcp/server.js', mode: 0o644, data: '// fake MCP server\n' },
    { path: 'src/mcp/selfcheck-probe.js', mode: 0o644, data: '// fake probe of the check\n' },
    { path: 'src/install/client-plugin.js', mode: 0o644, data: '// native client plugin\n' },
    { path: 'skills/.keep', mode: 0o644, data: '' },
  ]);
  const name = (client) => `sample-${version}-${client}-linux-x64.tar.gz`;
  const selected = () => ({
    tag_name: `v${version}`, prerelease: false, published_at: '2026-10-24',
    assets: [
      ...clients.map((client) => ({ name: name(client), browser_download_url: `https://fake.invalid/package/${client}` })),
      { name: `sample-${version}-checksums.sha256`, browser_download_url: 'https://fake.invalid/manifest' },
    ],
  });
  const fetch = async (url) => {
    if (url.endsWith('/latest')) return Response.json(selected());
    if (url.endsWith('/releases')) return Response.json([selected()]);
    if (url.includes('/package/')) return new Response(payload());
    if (url.endsWith('/manifest')) {
      const digest = createHash('sha256').update(payload()).digest('hex');
      return new Response(clients.map((client) => `${digest}  ${name(client)}\n`).join(''));
    }
    throw new Error(`Unexpected request ${url}`);
  };
  const io = {
    root,
    home,
    adapters: [],
    readQuota: async () => ({ source: 'off' }),
    env: { HOME: home, PATH: '' },
    platform: 'linux',
    now: () => 1700000000000,
    tmpdir: home,
    tty,
    ask,
    arch: 'x64',
    pkg,
    fetch,
    detect: async () => false,
    run: answerCheck,
    stopDaemon: async () => true,
    startDaemon: async () => {},
    autostart: async () => {},
    smoke: async () => ({ code: 0 }),
    stdout: (line) => out.push(line),
    stderr: (line) => out.push(line),
  };
  // These lifecycle tests inject failures at presenter events; CLI layout has its own goldens.
  io.ui = createPresenter({ locale: 'en', write: (line) => io.stdout(line) });
  return { home, root, bin, config, io, out, setVersion: (value) => { version = value; } };
}

// Must pass / must refuse:
// | case | must pass | must refuse |
// | setup pending | one pending line naming the command | a second line, another command |
// | setup done | no pending line | the pending line |
// | install without a terminal | the offer, the installation succeeds | a question |
// | install with a terminal | the question, the setup runs | a failed installation |
// | a setup that cannot run | the installation still succeeds | a failed installation |

test('the report of the environment shows one pending setup line before the setup and none after it', async (t) => {
  const { home, root } = await temporaryHome(t);
  const before = await statusOf(root, home);
  assert.equal(before.code, 0);
  const pending = before.out.filter((line) => PENDING.test(line));
  assert.equal(pending.length, 1, before.out.join(' / '));
  assert.match(pending[0], /run `okit-plugin setup`/);

  const portuguese = await statusOf(root, home, {}, 'pt-BR');
  assert.equal(portuguese.code, 0);
  assert.equal(portuguese.out.filter((line) => PENDING_PT.test(line)).length, 1, portuguese.out.join(' / '));

  assert.equal(await main(['setup', '--defaults'], {
    root,
    env: { HOME: home, OKWORK_HOME: root },
    adapters: [fakeClient('claude-code', ['haiku', 'sonnet', 'opus'])],
    run: answerCheck,
    stdout: () => {},
    stderr: () => {},
  }), 0);

  const after = await statusOf(root, home);
  assert.equal(after.code, 0);
  assert.ok(!after.out.some((line) => PENDING.test(line)), after.out.join(' / '));
});

test('the pending setup line names the configured command', async (t) => {
  const { home, root } = await temporaryHome(t);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'config.json'), JSON.stringify({ install: { command: 'my-okit' } }), 'utf8');
  const status = await statusOf(root, home);
  assert.equal(status.code, 0);
  const pending = status.out.filter((line) => PENDING.test(line));
  assert.equal(pending.length, 1, status.out.join(' / '));
  assert.match(pending[0], /run `my-okit setup`/);
});

test('the end of an install offers the setup and never fails the installation', async (t) => {
  const f = await installation(t);
  assert.equal(await main(['install', '--client', 'codex'], f.io), 0, f.out.join(' / '));
  const offer = f.out.filter(MODELS_PENDING);
  assert.equal(offer.length, 1, f.out.join(' / '));
  assert.match(offer[0], /^\s*Models\s+-\s+not set yet\. Run: okit-plugin setup$/);
  assert.ok(!f.out.some((line) => /Choose the models now\?/.test(line)), 'no terminal, no question');
  const raw = JSON.parse(await readFile(join(f.root, 'config.json'), 'utf8'));
  assert.equal(raw.setup, undefined);
});

test('an interactive install asks, runs the setup and keeps the installation successful', async (t) => {
  const questions = [];
  const f = await installation(t, {
    tty: true,
    ask: async (question, recommended) => { questions.push(question); return recommended ? '' : 'yes'; },
  });
  f.io.adapters = [fakeClient('codex', ['gpt-5', 'gpt-5-mini'])];
  assert.equal(await main(['install', '--client', 'codex'], f.io), 0, f.out.join(' / '));
  assert.ok(questions.some((question) => question.includes('Choose the models now? [Y/n]')), questions.join(' / '));
  // One question per prompt, the explanation before it and the question last.
  assert.equal(questions.filter((question) => /\n/.test(question.trimEnd())).length, 0);
  assert.ok(f.out.some((line) => /^\s*Models\s+ok\s+.*gpt-5.* saved$/.test(line)), f.out.join(' / '));
  const raw = JSON.parse(await readFile(join(f.root, 'config.json'), 'utf8'));
  assert.match(raw.setup.done.at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(raw.profiles.codex.simple.model, 'gpt-5');
});

for (const selected of ['claude-code', 'all']) test(`D132 install ${selected} reviews only its clients with one list each`, async (t) => {
  const questions = [];
  const f = await installation(t, { tty: true, ask: async (question) => {
    questions.push(question);
    return /tasks \[/.test(question) ? '' : /Record quota|optional panel/.test(question) ? 'n' : 'yes';
  } });
  delete f.io.ui;
  f.io.read = f.io.ask;
  f.io.detect = async () => true;
  f.io.loadAdapter = async () => ({ installHooks: async () => ({}), installSkill: async () => ({}) });
  f.io.adapters = ['claude-code', 'codex', 'opencode'].map((client) => fakeClient(client,
    client === 'claude-code' ? ['haiku', 'sonnet', 'opus'] : ['other/model', 'second/model']));
  assert.equal(await main(['install', '--client', selected, '--no-panel'], f.io), 0, f.out.join('\n'));
  const count = selected === 'all' ? 3 : 1;
  assert.equal(questions.filter((question) => /tasks \[/.test(question)).length, count * 3);
  assert.deepEqual(questions.filter((question) => /tasks \[/.test(question)).slice(0, 3),
    ['Small tasks [1]:', 'Everyday tasks [2]:', 'Complex tasks [3]:']);
  assert.equal(f.out.filter((line) => /^1\. haiku/.test(line)).length, 1);
  assert.equal(f.out.filter((line) => /^1\. other\/model/.test(line)).length, count - 1);
  if (selected !== 'all') assert.doesNotMatch(f.out.join('\n'), /Codex|OpenCode|"codex"|"opencode"/);
  const raw = JSON.parse(await readFile(join(f.root, 'config.json'), 'utf8'));
  assert.equal(raw.profiles['claude-code'].hard.model, 'opus');
  if (selected !== 'all') assert.deepEqual(Object.keys(raw.profiles), ['claude-code']);
});

test('D132 a multi-client filter keeps current defaults and prints the fallback notice once', async (t) => {
  const { home, root } = await temporaryHome(t), lines = [], questions = [];
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'config.json'), JSON.stringify({ profiles: { 'claude-code': { simple: { model: 'opus' } } } }));
  const adapters = ['claude-code', 'codex', 'opencode'].map((client) => ({ CLIENT: client,
    listModels: async () => ({ client, installed: true, models: ['haiku', 'sonnet', 'opus'], source: 'catalog' }) }));
  const result = await runSetup({ root, env: { HOME: home }, clients: ['claude-code', 'codex'], locale: 'en',
    adapters, run: answerCheck, out: (line) => lines.push(line),
    ask: async (question) => { questions.push(question); return /tasks \[/.test(question) ? '' : 'yes'; } });
  assert.equal(result.changes.length, 6);
  assert.equal(questions[0], 'Small tasks [3]:');
  assert.equal(lines.filter((line) => /built-in list/.test(line)).length, 1);
  assert.doesNotMatch(lines.join('\n'), /OpenCode|opencode/);
  assert.equal(lines.filter((line) => /^1\. haiku/.test(line)).length, 2);
  assert.match(lines.find((line) => /^3\. opus/.test(line)), /Small tasks.*default/);
});

test('D132 a single option is explained per class in the table without model questions', async (t) => {
  const { home, root } = await temporaryHome(t), lines = [], questions = [];
  const result = await runSetup({ root, env: { HOME: home }, clients: ['claude-code'], locale: 'en',
    adapters: [fakeClient('claude-code', ['one/model'])], run: answerCheck, out: (line) => lines.push(line),
    ask: async (question) => { questions.push(question); return 'yes'; } });
  assert.equal(result.changes.length, 3);
  assert.equal(questions.length, 1);
  assert.match(questions[0], /Save these choices/);
  assert.equal(lines.filter((line) => /one\/model \(only option\)/.test(line)).length, 3);
});

test('the install setup reader treats EOF as cancellation without changing the configuration', { timeout: 2000 }, async (t) => {
  const f = await installation(t, { tty: true });
  f.io.adapters = [fakeClient('codex', ['other/model', 'second/model'])];
  Object.assign(f.io, terminal('yes\n'));
  assert.equal(await main(['install', '--client', 'codex'], f.io), 0, f.out.join(' / '));
  assert.ok(f.out.some((line) => /Setup was cancelled and nothing was saved/.test(line)), f.out.join(' / '));
  assert.ok(!f.out.some((line) => /Setup could not run/.test(line)), f.out.join(' / '));
  const raw = JSON.parse(await readFile(join(f.root, 'config.json'), 'utf8'));
  assert.equal(raw.setup, undefined);
});

test('a refused setup leaves the installation successful and the configuration untouched', async (t) => {
  const questions = [];
  const f = await installation(t, {
    tty: true,
    ask: async (question) => { questions.push(question); return 'n'; },
  });
  assert.equal(await main(['install', '--client', 'codex'], f.io), 0, f.out.join(' / '));
  assert.ok(questions.some((question) => question.includes('Choose the models now? [Y/n]')));
  assert.ok(f.out.some((line) => /^\s*Models\s+skipped\s+not set\. Run when you want: okit-plugin setup$/.test(line)), f.out.join(' / '));
  const raw = JSON.parse(await readFile(join(f.root, 'config.json'), 'utf8'));
  assert.equal(raw.setup, undefined);
});

test('a setup that cannot run never fails the installation', async (t) => {
  const f = await installation(t, {
    tty: true,
    ask: async () => { throw new Error('no terminal here'); },
  });
  assert.equal(await main(['install', '--client', 'codex'], f.io), 0, f.out.join(' / '));
  assert.ok(f.out.some((line) => /Setup could not run/.test(line)), f.out.join(' / '));
});

test('a corrupted configuration at the end of the install keeps the installation successful', async (t) => {
  const f = await installation(t);
  const original = f.io.stdout;
  f.io.stdout = (line) => {
    original(line);
    if (LINK_ROW.test(line)) writeFileSync(join(f.root, 'config.json'), '{ broken');
  };
  assert.equal(await main(['install', '--client', 'codex'], f.io), 0, f.out.join(' / '));
  assert.ok(
    f.out.some((line) => /Settings could not be read/.test(line)),
    f.out.join(' / '),
  );
});

test('a configuration without an object root at the end of the install keeps the installation successful', async (t) => {
  const f = await installation(t);
  const original = f.io.stdout;
  f.io.stdout = (line) => {
    original(line);
    if (LINK_ROW.test(line)) writeFileSync(join(f.root, 'config.json'), 'null');
  };
  assert.equal(await main(['install', '--client', 'codex'], f.io), 0, f.out.join(' / '));
  assert.ok(
    f.out.some((line) => /Settings could not be read/.test(line)),
    f.out.join(' / '),
  );
  // One language per run: the Portuguese sentence belongs to --locale pt-BR.
  assert.ok(!f.out.some((line) => /não está legível/.test(line)), f.out.join(' / ')); // locale:pt-BR
});

test('the unreadable configuration is reported in Portuguese with --locale pt-BR only', async (t) => {
  const f = await installation(t);
  f.io.ui = createPresenter({ locale: 'pt-BR', write: (line) => f.io.stdout(line) });
  const original = f.io.stdout;
  f.io.stdout = (line) => {
    original(line);
    if (LINK_ROW_PT.test(line)) writeFileSync(join(f.root, 'config.json'), 'null');
  };
  assert.equal(await main(['install', '--client', 'codex', '--locale', 'pt-BR'], f.io), 0, f.out.join(' / '));
  assert.ok(f.out.some((line) => /Não foi possível ler os ajustes/.test(line)), f.out.join(' / ')); // locale:pt-BR
  assert.ok(!f.out.some((line) => /Could not check/.test(line)), f.out.join(' / '));
});

test('the install setup reader with an input that already ended does not hang', { timeout: 5000 }, async (t) => {
  const f = await installation(t, { tty: true });
  f.io.adapters = [fakeClient('codex', ['other/model', 'second/model'])];
  const stdin = Readable.from([]);
  stdin.resume();
  await new Promise((resolve) => stdin.once('end', resolve));
  f.io.stdin = stdin;
  f.io.output = new Writable({
    write(_chunk, _encoding, done) { done(); },
  });
  assert.equal(await main(['install', '--client', 'codex'], f.io), 0, f.out.join(' / '));
  assert.ok(
    f.out.some((line) => /Setup was cancelled and nothing was saved/.test(line)),
    f.out.join(' / '),
  );
  assert.ok(!f.out.some((line) => /Setup could not run/.test(line)), f.out.join(' / '));
});

test('the end of an update offers the setup as well', async (t) => {
  const f = await installation(t);
  assert.equal(await main(['install', '--client', 'codex'], f.io), 0, f.out.join(' / '));
  f.out.length = 0;
  f.setVersion('2.0.0');
  assert.equal(await main(['update', '--client', 'codex'], f.io), 0, f.out.join(' / '));
  assert.equal(f.out.filter(MODELS_PENDING).length, 1, f.out.join(' / '));
});

test('the status keeps asking for the setup after a setup that found no client', async (t) => {
  const { home, root } = await temporaryHome(t);
  const output = [];
  const errors = [];
  const code = await main(['setup', '--defaults'], {
    root,
    env: { HOME: home, OKWORK_HOME: root },
    adapters: [],
    run: answerCheck,
    stdout: (line) => output.push(line),
    stderr: (line) => errors.push(line),
  });
  assert.equal(code, 0);
  assert.deepEqual(errors, []);
  assert.match(output.join('\n'), /No client with an active model was found/);
  // No `setup.done`: the configuration is still pending.
  await assert.rejects(readFile(join(root, 'config.json'), 'utf8'), { code: 'ENOENT' });

  const status = await statusOf(root, home);
  assert.equal(status.code, 0);
  const pending = status.out.filter((line) => PENDING.test(line));
  assert.equal(pending.length, 1, status.out.join(' / '));
  assert.match(pending[0], /run `okit-plugin setup`/);
});
