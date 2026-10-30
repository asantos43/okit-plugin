import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { releaseConfig } from '../src/release/config.js';
import { planFiles } from '../src/release/notes.js';
import { manifestFileName } from '../src/release/checksums.js';
import { buildChecklist } from '../src/release/checklist.js';
import { main, readArgs } from '../scripts/release-checklist.js';

const roots = [];
const packageJson = { name: '@example/release', version: '2.3.4', type: 'module', bin: { demo: 'src/cli.js' } };
async function fixture(user = {}) {
  const root = await mkdtemp(join(tmpdir(), 'release-checklist-'));
  roots.push(root);
  const config = releaseConfig(user);
  await writeFile(join(root, 'package.json'), JSON.stringify(packageJson));
  for (const client of releaseConfig().clients) {
    const folder = join(root, 'adapters', client);
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, 'index.js'), 'export const adapter = {};\n');
  }
  const io = { root, env: { OKWORK_HOME: join(root, 'state') }, stdout() {}, stderr() {} };
  return { root, config, packageJson, io };
}
after(async () => { for (const root of roots) await rm(root, { recursive: true, force: true }); });

// Corpus: must pass — eighteen build pairs (nine client and system pairs, two architectures), matching version, absent/present manifest,
// repeated identical generation and configured labels/signers/proof states.
// Must refuse — mismatched version, invalid pairs/proof/manifest, filled record,
// unknown flags (including --force), and missing argument values.
test('eighteen unchecked build pairs carry every field, both layers and system signers', async () => {
  const options = await fixture();
  const result = await buildChecklist(options);
  assert.equal(result.refusal, null);
  assert.equal(result.pairs.length, 18);
  assert.ok(result.file.endsWith('example-release-2.3.4-release-checklist.md'));
  assert.equal((result.checklist.match(/^## \[ \]/gm) ?? []).length, 18);
  for (const pair of planFiles(options).pairs) {
    assert.ok(result.checklist.includes(`## [ ] ${pair.client} × ${pair.system} (${pair.arch})`));
    assert.ok(result.checklist.includes(`| Payload filename | ${pair.file} |`));
  }
  for (const label of Object.values(options.config.checklist.labels)) {
    assert.equal(result.checklist.split(`| ${label} |`).length - 1, 18);
  }
  assert.equal(result.checklist.split('### In-process smoke').length - 1, 18);
  assert.equal(result.checklist.split('### D25 real-client scenario').length - 1, 18);
  assert.equal(result.checklist.split('| Skip / absent driver |  |').length - 1, 36);
  assert.equal(result.checklist.split('| Proof owner | Producer |').length - 1, 12);
  assert.equal(result.checklist.split('| Proof owner | Director |').length - 1, 6);
  assert.equal(result.checklist.split('| Source revision |  |').length - 1, 18);
  assert.ok(result.checklist.includes('`demo smoke`'));
  assert.ok(result.checklist.includes('`demo client-smoke`'));
  assert.ok(result.checklist.includes('Producer signature for Windows/macOS'));
});

test('manifest digests are read by exact payload name; absent manifest leaves blanks', async () => {
  const options = await fixture();
  const empty = await buildChecklist(options);
  assert.equal(empty.checklist.split('| Payload SHA-256 |  |').length - 1, 18);
  const folder = join(options.root, options.config.outputDir);
  await mkdir(folder, { recursive: true });
  const pairs = planFiles(options).pairs;
  const hashes = pairs.map((pair, index) => ({ name: pair.file, hash: index.toString(16).padStart(2, '0').repeat(32) }));
  await writeFile(join(folder, manifestFileName(packageJson)), hashes.map(({ name, hash }) => `${hash}  ${name}\n`).join(''));
  const result = await buildChecklist({ ...options, revision: 'reviewed-commit' });
  for (const { hash } of hashes) assert.ok(result.checklist.includes(`| Payload SHA-256 | ${hash} |`));
  assert.equal(result.checklist.split('| Source revision | reviewed-commit |').length - 1, 18);
  assert.equal((await readdir(folder)).length, 1); // No checklist/notes hashes or output writes.
});

test('CLI dry-run, identical rerun and filled-record protection', async () => {
  const { root, io } = await fixture();
  const out = join(root, 'output');
  const messages = [];
  const args = ['--out', out, '--version', packageJson.version, '--revision', 'abc123'];
  assert.equal(await main([...args, '--dry-run'], { ...io, stdout: (s) => messages.push(s) }), 0);
  assert.equal(messages.filter((s) => s.startsWith('would list:')).length, 18);
  assert.ok(messages[0].includes(out));
  assert.ok(!(await readdir(root)).includes('output'));
  assert.equal(await main(args, io), 0);
  const file = join(out, 'example-release-2.3.4-release-checklist.md');
  const original = await readFile(file, 'utf8');
  assert.equal(await main(args, io), 0);
  assert.equal(await readFile(file, 'utf8'), original);
  await writeFile(file, `${original}\nTester: recorded evidence\n`);
  const errors = [];
  assert.equal(await main(args, { ...io, stderr: (s) => errors.push(s) }), 1);
  assert.match(errors.join('\n'), /existing checklist differs/);
  assert.equal(await readFile(file, 'utf8'), `${original}\nTester: recorded evidence\n`);
});

test('configuration merges names, fields and notes proof ownership/status without duplicating defaults', async () => {
  const options = await fixture({ outputDir: 'candidate', notes: {
    proofFile: 'proof.json', proofBy: { linux: 'Reviewer' }, status: { partial: 'Partial proof' },
  }, checklist: { fileName: '{version}-{package}.md', title: 'Proof {package} {version}',
    labels: { tester: 'Responsible / date' }, layers: { process: 'Process layer' },
    proofBy: { windows: 'Native tester' } } });
  await writeFile(join(options.root, 'proof.json'), JSON.stringify({ 'codex:windows': 'Partial proof' }));
  const result = await buildChecklist(options);
  assert.equal(result.refusal, null);
  assert.equal(result.file, join(options.root, 'candidate', '2.3.4-example-release.md'));
  for (const value of ['# Proof example-release 2.3.4', 'Responsible / date', '### Process layer',
    '| Proof owner | Reviewer |', '| Proof owner | Native tester |', '| Proof | Partial proof |']) {
    assert.ok(result.checklist.includes(value), value);
  }
});

test('mismatched version and invalid CLI arguments refuse without writing', async () => {
  const options = await fixture();
  const before = await readdir(options.root);
  assert.match((await buildChecklist({ ...options, version: '9.0.0' })).refusal, /not the version/);
  assert.equal(await main(['--version', '9.0.0'], options.io), 1);
  for (const args of [['--out'], ['--version'], ['--revision'], ['--force'], ['--unknown']]) {
    assert.ok(readArgs(args).error);
    assert.equal(await main(args, options.io), 2);
  }
  assert.equal(await main(['--help'], options.io), 0);
  assert.deepEqual(await readdir(options.root), before);
});

test('invalid pair configurations refuse as the build does', async () => {
  for (const [user, reason] of [
    [{ formats: { windows: 'rar' } }, /unknown archive format/],
    [{ formats: { linux: null } }, /no archive format/],
    [{ clients: [] }, /no configured pairs/],
    [{ clients: ['unknown'] }, /no adapter/],
    [{ adapters: { codex: 'missing' } }, /not implemented/],
  ]) {
    const options = await fixture(user);
    const before = await readdir(options.root);
    assert.match((await buildChecklist(options)).refusal, reason);
    assert.deepEqual(await readdir(options.root), before);
  }
});

test('invalid configured proof and malformed or unsafe manifests refuse', async () => {
  const options = await fixture({ notes: { proofFile: 'proof.json' } });
  assert.match((await buildChecklist(options)).refusal, /cannot be read/);
  await writeFile(join(options.root, 'proof.json'), JSON.stringify({ 'codex:linux': 'invented' }));
  assert.match((await buildChecklist(options)).refusal, /unknown proof status/);
  await writeFile(join(options.root, 'proof.json'), '{}');
  const folder = join(options.root, options.config.outputDir);
  await mkdir(folder, { recursive: true });
  for (const raw of ['bad line\n', `${'a'.repeat(64)}  ../unsafe\n`]) {
    await writeFile(join(folder, manifestFileName(packageJson)), raw);
    assert.match((await buildChecklist(options)).refusal, /invalid checksum manifest/);
    assert.deepEqual(await readdir(folder), [manifestFileName(packageJson)]);
  }
});

// D98: every asset has its own record, and the record says what its proof stands on.
test('each architecture has its own record with the basis of its proof', async () => {
  const options = await fixture();
  const result = await buildChecklist(options);
  assert.equal(result.refusal, null);
  assert.equal(result.checklist.split('| Proof basis | payload identical to x64; not run on real arm64 hardware |').length - 1, 9);
  assert.equal(result.checklist.split('| Proof basis | proof recorded for this payload |').length - 1, 9);
  for (const pair of planFiles(options).pairs) {
    const record = result.checklist.split('## [ ] ').find((part) => part.startsWith(`${pair.client} × ${pair.system} (${pair.arch})\n`));
    assert.ok(record.includes(`| OS / version / architecture | ${pair.system} / / ${pair.arch} |`), pair.file);
    assert.ok(record.includes(`| Payload filename | ${pair.file} |`), pair.file);
  }
});

// D98 step 4: the Extra layer is for the systems whose installer only real hardware can prove.
const recordOf = (checklist, pair) => checklist.split('## [ ] ').find((part) => part.startsWith(`${pair.client} × ${pair.system} (${pair.arch})\n`));

test('macOS and Windows pairs carry the Extra layer with every configured label; Linux pairs do not', async () => {
  const options = await fixture();
  const { extra } = options.config.checklist;
  const result = await buildChecklist(options);
  assert.equal(result.refusal, null);
  assert.equal(result.checklist.split(`### ${extra.title}`).length - 1, 12);
  for (const pair of planFiles(options).pairs) {
    const record = recordOf(result.checklist, pair);
    const has = record.includes(`### ${extra.title}`);
    assert.equal(has, pair.system !== 'linux', `${pair.system} ${pair.arch}`);
    if (!has) continue;
    const section = record.slice(record.indexOf(`### ${extra.title}`));
    for (const label of Object.values(extra.labels)) assert.ok(section.includes(`| ${label} |  |`), label);
    assert.equal(section.split('\n').filter((line) => line.startsWith('| ')).length, Object.keys(extra.labels).length + 2);
  }
  assert.ok(result.checklist.includes('The Extra layer applies to macOS and Windows pairs only.'));
  assert.ok(result.checklist.includes('a container, a mock or a simulated platform'));
});

// The claude-code x64 Linux record exactly as `main` rendered it before the Extra layer (no Extra section, no other byte).
const LINUX_GOLDEN = `claude-code × linux (x64)

| Field | Evidence / value |
| :- | :- |
| Tester / date |  |
| Source revision |  |
| Package version | 2.3.4 |
| Payload filename | example-release-2.3.4-claude-code-linux-x64.tar.gz |
| Payload SHA-256 |  |
| OS / version / architecture | linux / / x64 |
| Node version |  |
| Client version |  |
| Install scope |  |
| Resolved plugin / config / state / bin paths |  |
| Fresh installation steps / result |  |
| Update from prior candidate / restart / preserved state |  |
| PATH / permissions |  |
| Autostart show / install / restart |  |
| JSONL / log locations |  |
| D25 scenario revision |  |
| Written acceptance of skips / partial proof |  |
| Proof | not proven |
| Proof basis | proof recorded for this payload |
| Proof owner | Director |

### In-process smoke

| Field | Evidence / value |
| :- | :- |
| Command / driver |  |
| Exit code |  |
| Totals (pass / fail / skip) |  |
| Reasons |  |
| Skip / absent driver |  |
| JSONL / logs |  |

### D25 real-client scenario

| Field | Evidence / value |
| :- | :- |
| Command / driver |  |
| Exit code |  |
| Totals (pass / fail / skip) |  |
| Reasons |  |
| Skip / absent driver |  |
| JSONL / logs |  |

`;

test('the Extra layer follows the section of the layers and changes no other byte of the checklist', async () => {
  const options = await fixture();
  const result = await buildChecklist(options);
  const none = await buildChecklist(await fixture({ checklist: { extra: { systems: [] } } }));
  const pairs = planFiles(options).pairs;
  // (a) every Linux record (both architectures, all clients) is byte-identical.
  const linuxPairs = pairs.filter((pair) => pair.system === 'linux');
  assert.equal(linuxPairs.length, 6);
  const x64Basis = '| Proof basis | proof recorded for this payload |';
  const armBasis = '| Proof basis | payload identical to x64; not run on real arm64 hardware |';
  for (const pair of linuxPairs) {
    const linux = recordOf(result.checklist, pair);
    assert.equal(linux, recordOf(none.checklist, pair), `${pair.client} ${pair.arch}`);
    assert.ok(!linux.includes('Extra layer'));
    // Compared with the record as main renders it, before the Extra layer existed.
    const golden = LINUX_GOLDEN.replaceAll('claude-code', pair.client).replaceAll('linux-x64', `linux-${pair.arch}`)
      .replace('linux / / x64', `linux / / ${pair.arch}`).replace('(x64)', `(${pair.arch})`)
      .replace(x64Basis, pair.arch === 'x64' ? x64Basis : armBasis);
    assert.equal(linux, golden, `${pair.client} ${pair.arch}`);
  }
  const mac = recordOf(result.checklist, pairs.find((pair) => pair.system === 'macos'));
  assert.ok(mac.indexOf('### D25 real-client scenario') < mac.indexOf('### Extra layer'));
  // (b) without the Extra sections (heading through the blank line after the last row) the default equals the empty-systems rendering.
  const { title } = options.config.checklist.extra;
  const kept = [];
  let skipping = false;
  let rows = false;
  for (const line of result.checklist.split('\n')) {
    if (line === `### ${title}`) { skipping = true; rows = false; continue; }
    if (skipping) {
      if (line.startsWith('| ')) rows = true;
      else if (line === '' && rows) skipping = false;
      continue;
    }
    kept.push(line);
  }
  const stripped = kept.join('\n');
  assert.notEqual(stripped, result.checklist);
  assert.equal(stripped, none.checklist);
  // The one instruction line added by this step is present in both renderings.
  for (const text of [result.checklist, none.checklist]) assert.equal(text.split('\n').filter((line) => line.startsWith('The Extra layer applies')).length, 1);
});

test('a user configuration overrides the Extra layer labels, title and systems', async () => {
  const options = await fixture({ checklist: { extra: { systems: ['linux'], title: 'Own layer', labels: { installer: 'Own installer row' } } } });
  const result = await buildChecklist(options);
  assert.equal(result.refusal, null);
  assert.equal(result.checklist.split('### Own layer').length - 1, 6);
  assert.equal(result.checklist.split('| Own installer row |  |').length - 1, 6);
  for (const pair of planFiles(options).pairs) {
    assert.equal(recordOf(result.checklist, pair).includes('### Own layer'), pair.system === 'linux');
  }
  assert.ok(result.checklist.includes('| Self-check output (paste) |  |'));
});

test('an invalid systems list falls back to the default', async () => {
  for (const systems of ['linux', [1], [null], {}]) {
    const options = await fixture({ checklist: { extra: { systems } } });
    assert.deepEqual(options.config.checklist.extra.systems, ['macos', 'windows']);
  }
  assert.deepEqual((await fixture({ checklist: { extra: { systems: [] } } })).config.checklist.extra.systems, []);
});

test('the Extra layer renders identically on every run', async () => {
  const options = await fixture();
  assert.equal((await buildChecklist(options)).checklist, (await buildChecklist(options)).checklist);
});
