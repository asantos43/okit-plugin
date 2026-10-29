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

test('the remaining install question recommends review in both languages', () => {
  assert.match(formatOffer('question', 'en'), /Recommended: yes, review the detected choices together/);
  assert.match(formatOffer('question', 'pt-BR'), /Recomendação: sim, revisar juntos as escolhas encontradas/);
});

const PENDING = /Setup is not done yet/;
const PENDING_PT = /O setup ainda não foi feito/;
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

async function statusOf(root, home, extra = {}, argv = ['status']) {
  const out = [];
  const code = await main(argv, {
    root,
    home,
    env: { HOME: home, OKWORK_HOME: root },
    readQuota: async () => ({ source: 'off' }),
    run: async () => ({}),
    stdout: (line) => out.push(line),
    stderr: (line) => out.push(line),
    ...extra,
  });
  return { code, out };
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
    run: async () => ({}),
    stopDaemon: async () => true,
    startDaemon: async () => {},
    autostart: async () => {},
    smoke: async () => ({ code: 0 }),
    stdout: (line) => out.push(line),
    stderr: (line) => out.push(line),
  };
  return { home, root, bin, config, io, out, setVersion: (value) => { version = value; } };
}

// Must pass / must refuse:
// | case | must pass | must refuse |
// | setup pending | one pending line naming the command | a second line, another command |
// | setup done | no pending line | the pending line |
// | install without a terminal | the offer, the installation succeeds | a question |
// | install with a terminal | the question, the setup runs | a failed installation |
// | a setup that cannot run | the installation still succeeds | a failed installation |

test('status shows one pending setup line before the setup and none after it', async (t) => {
  const { home, root } = await temporaryHome(t);
  const before = await statusOf(root, home);
  assert.equal(before.code, 0);
  const pending = before.out.filter((line) => PENDING.test(line));
  assert.equal(pending.length, 1, before.out.join(' / '));
  assert.match(pending[0], /Run okit-plugin setup to choose the models\./);

  const portuguese = await statusOf(root, home, {}, ['status', '--locale', 'pt-BR']);
  assert.equal(portuguese.code, 0);
  assert.equal(portuguese.out.filter((line) => PENDING_PT.test(line)).length, 1, portuguese.out.join(' / '));

  assert.equal(await main(['setup', '--defaults'], {
    root,
    env: { HOME: home, OKWORK_HOME: root },
    adapters: [fakeClient('claude-code', ['haiku', 'sonnet', 'opus'])],
    run: async () => ({}),
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
  assert.match(pending[0], /Run my-okit setup/);
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
    ask: async (question) => { questions.push(question); return 'yes'; },
  });
  f.io.adapters = [fakeClient('claude-code', ['haiku', 'sonnet', 'opus'])];
  assert.equal(await main(['install', '--client', 'codex'], f.io), 0, f.out.join(' / '));
  assert.ok(questions.some((question) => question.includes('Choose the models now? [Y/n]')), questions.join(' / '));
  // One question per prompt, the explanation before it and the question last.
  assert.equal(questions.filter((question) => /\n/.test(question.trimEnd())).length, 0);
  assert.ok(f.out.some((line) => /^\s*Models\s+ok\s+.*haiku.* saved$/.test(line)), f.out.join(' / '));
  const raw = JSON.parse(await readFile(join(f.root, 'config.json'), 'utf8'));
  assert.match(raw.setup.done.at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(raw.profiles['claude-code'].simple.model, 'haiku');
});

test('the install setup reader treats EOF as cancellation without changing the configuration', { timeout: 2000 }, async (t) => {
  const f = await installation(t, { tty: true });
  f.io.adapters = [fakeClient('claude-code', ['other/model'])];
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
    f.out.some((line) => /Could not check the configuration/.test(line)),
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
    f.out.some((line) => /Could not check the configuration/.test(line)),
    f.out.join(' / '),
  );
  // One language per run: the Portuguese sentence belongs to --locale pt-BR.
  assert.ok(!f.out.some((line) => /não está legível/.test(line)), f.out.join(' / '));
});

test('the unreadable configuration is reported in Portuguese with --locale pt-BR only', async (t) => {
  const f = await installation(t);
  const original = f.io.stdout;
  f.io.stdout = (line) => {
    original(line);
    if (LINK_ROW_PT.test(line)) writeFileSync(join(f.root, 'config.json'), 'null');
  };
  assert.equal(await main(['install', '--client', 'codex', '--locale', 'pt-BR'], f.io), 0, f.out.join(' / '));
  assert.ok(f.out.some((line) => /não está legível/.test(line)), f.out.join(' / '));
  assert.ok(!f.out.some((line) => /Could not check/.test(line)), f.out.join(' / '));
});

test('the install setup reader with an input that already ended does not hang', { timeout: 5000 }, async (t) => {
  const f = await installation(t, { tty: true });
  f.io.adapters = [fakeClient('claude-code', ['other/model'])];
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
    run: async () => ({}),
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
  assert.match(pending[0], /Run okit-plugin setup to choose the models\./);
});
