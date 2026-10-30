import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { artifactName } from '../src/release/build.js';
import { manifestFileName } from '../src/release/checksums.js';
import { planPairs, releaseConfig } from '../src/release/config.js';
import { buildNotes, parseUnreleased } from '../src/release/notes.js';
import { main, readArgs } from '../scripts/release-notes.js';

const roots = [];
const packageJson = { name: '@example/release', version: '2.3.4', engines: { node: '>=22' } };
const history = '## [Unreleased]\n\n### Added\n\n- Original `text`  \n  continuation\n\n## [1.0.0]\n- Old\n';
async function fixture(raw = history) {
  const root = await mkdtemp(join(tmpdir(), 'release-notes-'));
  roots.push(root);
  await writeFile(join(root, 'package.json'), JSON.stringify(packageJson));
  if (raw !== null) await writeFile(join(root, 'CHANGELOG.md'), raw);
  const io = { root, env: { OKWORK_HOME: join(root, 'state') }, stdout() {}, stderr() {} };
  return { root, io, config: releaseConfig(), packageJson };
}
after(async () => { for (const root of roots) await rm(root, { recursive: true, force: true }); });

test('repository package, MCP fallback and release notes versions agree', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const server = await readFile(new URL('../src/mcp/server.js', import.meta.url), 'utf8');
  assert.equal(server.match(/const FALLBACK_VERSION = '([^']+)'/)?.[1], pkg.version);
  const result = await buildNotes({ root, packageJson: pkg, config: releaseConfig(), version: pkg.version });
  assert.equal(result.refusal, null);
  assert.ok(result.notes.includes(`- Version: \`${pkg.version}\``));
  const raw = await readFile(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
  const changes = parseUnreleased(raw).lines.filter((line) => line.startsWith('- '));
  assert.ok(changes.length > 0);
  for (const change of changes) assert.ok(result.notes.includes(change));
  const previous = raw.split(/^## /m).find((section) => /^\[(?!Unreleased\])/.test(section));
  assert.ok(previous, 'the latest released section must exist');
  const previousChanges = previous.split('\n').filter((line) => line.startsWith('- '));
  assert.ok(previousChanges.length > 0);
  for (const change of previousChanges) {
    assert.ok(!result.notes.includes(change));
  }
});

test('CLI dry-run writes nothing and two actual runs write identical bytes', async () => {
  const { root, io } = await fixture();
  const out = join(root, 'output');
  const messages = [];
  const args = ['--out', out, '--version', packageJson.version];
  assert.equal(await main([...args, '--dry-run'], { ...io, stdout: (s) => messages.push(s) }), 0);
  assert.equal(messages.filter((s) => s.startsWith('would list:')).length, 18);
  assert.ok(!(await readdir(root)).includes('output'));
  assert.equal(await main(args, io), 0);
  const file = join(out, 'example-release-2.3.4-release-notes.md');
  const first = await readFile(file);
  assert.equal(await main(args, io), 0);
  assert.deepEqual(await readFile(file), first);
  assert.deepEqual(await readdir(out), ['example-release-2.3.4-release-notes.md']);
});

test('CLI refuses a version mismatch and missing flag values, and supports help', async () => {
  const { root, io } = await fixture();
  assert.equal(await main(['--version', '9.9.9'], io), 1);
  assert.ok(!(await readdir(root)).includes('dist'));
  for (const args of [['--out'], ['--out', '--dry-run'], ['--version'], ['--unknown']]) {
    assert.ok(readArgs(args).error);
    assert.equal(await main(args, io), 2);
  }
  assert.equal(await main(['--help'], io), 0);
});

test('release notes configuration merges texts and naming over the defaults', async () => {
  const options = await fixture();
  options.config = releaseConfig({ outputDir: 'candidate', notes: {
    fileName: '{version}-{package}.md', headings: { gaps: 'Remaining proof' },
    status: { unproven: 'não provado' },
  } });
  const result = await buildNotes(options);
  assert.equal(result.file, join(options.root, 'candidate', '2.3.4-example-release.md'));
  assert.ok(result.notes.includes('## Remaining proof'));
  assert.ok(result.notes.includes('## Prerequisites'));
  assert.equal((result.notes.match(/: não provado\./g) ?? []).length, 18);
});

test('notes use the build names, package version, engines and checksum manifest', async () => {
  const options = await fixture();
  const result = await buildNotes(options);
  assert.equal(result.refusal, null);
  assert.equal(result.pairs.length, 18);
  assert.ok(result.file.endsWith('example-release-2.3.4-release-notes.md'));
  for (const pair of planPairs(options).pairs) {
    assert.ok(result.notes.includes(artifactName({ ...options, pair })));
  }
  assert.ok(result.notes.includes(manifestFileName(packageJson)));
  assert.ok(result.notes.includes('Node >=22'));
  assert.ok(result.notes.includes('`2.3.4`'));
  assert.ok(result.notes.includes('GitHub releases page'));
  assert.ok(result.notes.includes('SHA-256 of every file against the manifest before extracting'));
  assert.ok(result.notes.includes('Stop the old daemon'));
  assert.equal((result.notes.match(/\| not proven \|/g) ?? []).length, 18);
  assert.equal((result.notes.match(/: not proven\./g) ?? []).length, 18);
  assert.equal((result.notes.match(/\| Producer \|/g) ?? []).length, 12);
});

// Must pass: real changes, original whitespace, defaults and explicit matching version.
test('the extracted source preserves every line and excludes older releases', async () => {
  const options = await fixture();
  const expected = '\n### Added\n\n- Original `text`  \n  continuation\n';
  assert.equal(parseUnreleased(history).lines.join('\n'), expected);
  const result = await buildNotes(options);
  assert.ok(result.notes.includes(expected));
  assert.ok(!result.notes.includes('- Old'));
});

test('a recorded partial proof stays visible in the table and known gaps', async () => {
  const options = await fixture();
  options.config = releaseConfig({ notes: { proofFile: 'proof.json' } });
  await writeFile(join(options.root, 'proof.json'), JSON.stringify({
    'codex:windows': 'PARCIAL', 'codex:linux': 'proven',
  }));
  const result = await buildNotes(options);
  assert.equal(result.refusal, null);
  assert.ok(result.notes.includes('| codex × windows (x64) | PARCIAL | Producer | proof recorded for this payload |'));
  assert.ok(result.notes.includes('| codex × windows (arm64) | PARCIAL | Producer | payload identical to x64; not run on real arm64 hardware |'));
  assert.ok(result.notes.includes('- codex × windows (x64): PARCIAL.'));
  assert.ok(result.notes.includes('- codex × windows (arm64): PARCIAL.'));
  assert.ok(!result.notes.includes('- codex × linux'));
});

test('invalid or missing configured proof refuses instead of implying success', async () => {
  const options = await fixture();
  options.config = releaseConfig({ notes: { proofFile: 'proof.json' } });
  assert.match((await buildNotes(options)).refusal, /cannot be read/);
  for (const [raw, reason] of [
    ['{', /not valid JSON/], ['[]', /not an object/],
    [JSON.stringify({ 'codex:windows': 'passed' }), /unknown proof status/],
  ]) {
    await writeFile(join(options.root, 'proof.json'), raw);
    assert.match((await buildNotes(options)).refusal, reason);
  }
});

// Must refuse: missing history/section, empty headings/comments and mismatched version.
for (const [name, raw, reason] of [
  ['missing history', null, /history is missing/],
  ['missing section', '## [1.0.0]\n- Previous\n', /has no \[Unreleased\]/],
  ['empty section', '## [Unreleased]\n\n## [1.0.0]\n- Old\n', /is empty/],
  ['headings only', '## [Unreleased]\n### Added\n\n', /is empty/],
  ['comments only', '## [Unreleased]\n<!-- pending\ntext -->\n', /is empty/],
]) {
  test(`${name} refuses without writing an output`, async () => {
    const options = await fixture(raw);
    const before = await readdir(options.root);
    assert.match((await buildNotes(options)).refusal, reason);
    const errors = [];
    assert.equal(await main([], { ...options.io, stderr: (line) => errors.push(line) }), 1);
    assert.match(errors.join('\n'), reason);
    assert.deepEqual(await readdir(options.root), before);
  });
}

// D98: the proof table has a row per asset, and says what each architecture's proof stands on.
test('the proof table says the arm64 assets stand on the x64 payload and were not run on arm64 hardware', async () => {
  const options = await fixture();
  const result = await buildNotes(options);
  assert.equal(result.refusal, null);
  const arm = 'payload identical to x64; not run on real arm64 hardware';
  const rows = result.notes.split('\n').filter((line) => /^\| \S+ × \S+ \((x64|arm64)\) \|/.test(line));
  assert.equal(rows.length, 18);
  assert.equal(rows.filter((line) => line.includes('(arm64)') && line.endsWith(`| ${arm} |`)).length, 9);
  assert.equal(rows.filter((line) => line.includes('(x64)') && line.endsWith('| proof recorded for this payload |')).length, 9);
  assert.ok(result.notes.includes('| Pair | Proof | Proof owner | Proof basis |'));
  // The known gaps name the architecture too, so two lines are never the same.
  const gaps = result.notes.split('\n').filter((line) => /^- \S+ × \S+ \((x64|arm64)\): not proven\.$/.test(line));
  assert.equal(new Set(gaps).size, 18);
  // An architecture the configuration does not describe still says it was not run there.
  const other = await fixture();
  other.config = releaseConfig({ architectures: ['riscv64'] });
  assert.ok((await buildNotes(other)).notes.includes('| payload identical to x64; not run on this architecture |'));
});
