import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { releaseConfig } from '../src/release/config.js';
import { publishRelease, inspectGit } from '../src/release/publish.js';
import { manifestFileName, verifyManifest } from '../src/release/checksums.js';
import { main, readArgs } from '../scripts/release-publish.js';

const roots = [];
const pkg = { name: 'example-release', version: '2.3.4', type: 'module' };
const sha = 'a'.repeat(40);
const repository = 'https://github.com/example/release';
after(async () => { for (const root of roots) await rm(root, { recursive: true, force: true }); });
async function fixture(user = {}) {
  const root = await mkdtemp(join(tmpdir(), 'release-publish-'));
  roots.push(root);
  await writeFile(join(root, 'package.json'), JSON.stringify(pkg));
  await writeFile(join(root, 'CHANGELOG.md'), '## [Unreleased]\n### Added\n- Example.\n');
  for (const client of releaseConfig().clients) {
    await mkdir(join(root, 'adapters', client), { recursive: true });
    await writeFile(join(root, 'adapters', client, 'index.js'), 'export const adapter = {};\n');
  }
  const executable = join(root, 'fake-gh');
  const log = join(root, 'gh-args.json');
  await writeFile(executable, `#!${process.execPath}\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)));\n`);
  await chmod(executable, 0o755);
  const calls = [];
  const git = async (args) => {
    calls.push(args);
    if (args[0] === 'check-ignore') return args.at(-1);
    if (args[0] === 'rev-parse') return sha;
    if (args[0] === 'remote') return repository;
    return '';
  };
  const config = releaseConfig({ ...user, publish: { ...user.publish, executable } });
  return { root, config, git, calls, log, env: { SOURCE_DATE_EPOCH: '0' } };
}

// Corpus                         | Must pass / must refuse
// dry-run, exact args, proofs    | pass (stable default, auto follows proofs)
// unsafe names/local remote/out | refuse before build and gh
// dirty tree, tag, changed SHA  | refuse, including the final inspection
// bad attachments/version/ref  | refuse without calling gh
// credential URL, failing gh    | redact userinfo / report partial failure
test('dry-run never calls GitHub, verifies final files and repeats deterministically', async () => {
  const options = await fixture();
  const first = await publishRelease(options);
  assert.equal(first.prerelease, false);
  assert.equal(first.tag, `v${pkg.version}`);
  assert.equal(first.files.length, 21);
  assert.ok(!(await readdir(options.root)).includes('gh-args.json'));
  assert.equal((await verifyManifest(join(first.outputDir, manifestFileName(pkg)))).checked, 20);
  const bytes = await Promise.all(first.files.map((file) => readFile(file)));
  const second = await publishRelease(options);
  assert.deepEqual(second, first);
  assert.deepEqual(await Promise.all(second.files.map((file) => readFile(file))), bytes);
  assert.deepEqual(options.calls[0], ['status', '--porcelain', '--untracked-files=all']);
  assert.deepEqual(options.calls[1], ['check-ignore', '--', 'dist/publish/']);
  assert.deepEqual(options.calls[2], ['fetch', '--', 'origin', 'main']);
});

test('bootstrap scripts and bilingual guides are attached and checksummed outside pair archives', async () => {
  const options = await fixture();
  await writeFile(join(options.root, 'package.json'), JSON.stringify({ ...pkg, engines: { node: '>=20' } }));
  await mkdir(join(options.root, 'src/install'), { recursive: true });
  await writeFile(join(options.root, 'src/install/bootstrap.js'), await readFile('src/install/bootstrap.js'));
  await writeFile(join(options.root, 'src/install/present.js'), await readFile('src/install/present.js'));
  await writeFile(join(options.root, 'src/install/rules.js'), await readFile('src/install/rules.js'));
  await writeFile(join(options.root, 'src/install/exit.js'), await readFile('src/install/exit.js'));
  for (const file of ['install.sh', 'install.ps1', 'INSTALL.md', 'INSTALL.pt-BR.md']) {
    await writeFile(join(options.root, file), await readFile(file));
  }
  const result = await publishRelease(options);
  assert.equal(result.files.length, 25);
  const manifest = join(result.outputDir, manifestFileName(pkg));
  assert.equal((await verifyManifest(manifest)).checked, 24);
  for (const file of options.config.publish.bootstrapAttachments) {
    assert.ok(result.files.includes(join(result.outputDir, file)));
  }
  await writeFile(join(result.outputDir, 'install.sh'), 'altered');
  assert.equal((await verifyManifest(manifest)).ok, false);
});

test('explicit publication calls only fake gh with the exact generated argument list', async () => {
  const options = await fixture();
  const result = await publishRelease({ ...options, publish: true });
  assert.deepEqual(JSON.parse(await readFile(options.log)), ['release', 'create', `v${pkg.version}`,
    '--repo', repository, '--target', sha, '--latest', '--title', `${pkg.name} ${pkg.version}`,
    '--notes-file', join(result.outputDir, options.config.publish.bodyDir, `${pkg.name}-${pkg.version}-release-body.md`), '--', ...result.files]);
  assert.doesNotMatch(await readFile(result.files[18], 'utf8'), /Some client\/system pairs/);
  assert.equal(result.files.filter((file) => /\.(tar\.gz|zip)$/.test(file)).length, 18);
});

for (const [name, respond, reason] of [
  ['dirty tree', (args) => args[0] === 'status' ? ' M package.json' : null, /dirty/],
  ['local tag', (args) => args[0] === 'tag' ? 'v2.3.4' : null, /tag already exists/],
  ['remote tag', (args) => args[0] === 'ls-remote' ? 'remote-ref' : null, /tag already exists/],
  ['wrong revision', (args) => args.at(-1) === 'refs/remotes/origin/main' ? 'different' : null, /differs/],
]) {
  test(`${name} refuses before creating output or invoking gh`, async () => {
    const options = await fixture();
    const git = async (args) => respond(args) ?? options.git(args);
    await assert.rejects(publishRelease({ ...options, git, publish: true }), reason);
    assert.ok(!(await readdir(options.root)).includes('dist'));
    assert.ok(!(await readdir(options.root)).includes('gh-args.json'));
    if (name === 'dirty tree') assert.equal(options.calls.length, 0);
  });
}

test('actual checksum tampering refuses publication', async () => {
  const options = await fixture();
  const verify = async (manifest, { dir }) => {
    const file = (await readFile(manifest, 'utf8')).split('\n')[0].slice(66);
    await writeFile(join(dir, file), 'tampered');
    return verifyManifest(manifest, { dir });
  };
  await assert.rejects(publishRelease({ ...options, publish: true, verify }), /checksum verification failed.*modified/);
  assert.ok(!(await readdir(options.root)).includes('gh-args.json'));
});

test('auto requires all nine proven pairs, using configured proof labels', async () => {
  for (const missing of [true, false]) {
    const options = await fixture({ publish: { prerelease: 'auto' }, notes: { proofFile: 'proof.json', status: { proven: 'Verified' } } });
    const proof = Object.fromEntries(options.config.clients.flatMap((client) =>
      options.config.systems.map((system) => [`${client}:${system}`, 'Verified'])));
    if (missing) proof['codex:windows'] = 'PARCIAL';
    await writeFile(join(options.root, 'proof.json'), JSON.stringify(proof));
    const result = await publishRelease({ ...options, publish: true });
    assert.equal(result.prerelease, missing);
    assert.equal(JSON.parse(await readFile(options.log)).includes('--prerelease'), missing);
  }
});

test('reduced proven client/system matrix remains prerelease unless requiredPairs is configured', async () => {
  for (const requiredPairs of [undefined, 1]) {
    const options = await fixture({ clients: ['codex'], systems: ['linux'],
      notes: { proofFile: 'proof.json' }, publish: { prerelease: 'auto', ...(requiredPairs ? { requiredPairs } : {}) } });
    await writeFile(join(options.root, 'proof.json'), JSON.stringify({ 'codex:linux': 'proven' }));
    const result = await publishRelease({ ...options, publish: true });
    assert.equal(result.prerelease, requiredPairs !== 1);
    assert.equal(JSON.parse(await readFile(options.log)).includes('--prerelease'), requiredPairs !== 1);
    const body = result.args[result.args.indexOf('--notes-file') + 1];
    assert.equal((await readFile(body, 'utf8')).startsWith(options.config.publish.unprovenNotice), requiredPairs !== 1);
  }
});

for (const mode of ['never', 'auto', 'always']) {
  for (const proven of [false, true]) {
    test(`${mode}: fake gh flags and separate body with proven=${proven}`, async () => {
      const options = await fixture({ clients: ['codex'], systems: ['linux'],
        notes: { proofFile: 'proof.json' }, publish: { prerelease: mode, requiredPairs: 1,
          bodyDir: 'message', bodyFile: '{package}-{version}-body.md', unprovenNotice: 'CUSTOM unproven warning' } });
      await writeFile(join(options.root, 'proof.json'), JSON.stringify({ 'codex:linux': proven ? 'proven' : options.config.notes.status.partial }));
      const result = await publishRelease({ ...options, publish: true });
      const args = JSON.parse(await readFile(options.log));
      assert.equal(args.includes('--prerelease'), mode === 'always' || (mode === 'auto' && !proven));
      assert.equal(args.includes('--latest'), !result.prerelease);
      const body = args[args.indexOf('--notes-file') + 1];
      const notes = result.files.find((file) => file.endsWith('-release-notes.md'));
      const attached = await readFile(notes, 'utf8');
      assert.equal(await readFile(body, 'utf8'), proven ? attached : `${options.config.publish.unprovenNotice}\n\n${attached}`);
      assert.doesNotMatch(attached, /CUSTOM unproven warning/);
      assert.ok(!result.files.includes(body));
      assert.doesNotMatch(await readFile(join(result.outputDir, manifestFileName(pkg)), 'utf8'), /-body\.md|CUSTOM unproven warning/);
      assert.equal((await verifyManifest(join(result.outputDir, manifestFileName(pkg)))).ok, true);
    });
  }
}

test('Latest selection can be left to GitHub by configuration', async () => {
  const options = await fixture({ publish: { latest: false } });
  await publishRelease({ ...options, publish: true });
  const args = JSON.parse(await readFile(options.log));
  assert.equal(args.includes('--latest'), false);
  assert.equal(args.includes('--prerelease'), false);
});

for (const change of ['SHA', 'dirty output', 'local tag', 'remote tag']) {
  test(`final git inspection refuses ${change} before gh`, async () => {
    const options = await fixture();
    let inspections = 0;
    const git = async (args) => {
      if (args[0] === 'status') inspections += 1;
      if (inspections === 2) {
        if (change === 'SHA' && args[0] === 'rev-parse') return 'b'.repeat(40);
        if (change === 'dirty output' && args[0] === 'status') return ' M tracked-output';
        if (change === 'local tag' && args[0] === 'tag') return 'v2.3.4';
        if (change === 'remote tag' && args[0] === 'ls-remote') return 'remote-ref';
      }
      return options.git(args);
    };
    const reason = change === 'SHA' ? /HEAD changed/ : change === 'dirty output' ? /dirty/ : /tag already exists/;
    await assert.rejects(publishRelease({ ...options, git, publish: true,
      out: join(options.root, 'tracked-output') }), reason);
    assert.equal(inspections, 2);
    await assert.rejects(readFile(options.log), { code: 'ENOENT' });
  });
}

test('origin credentials never reach printed output or fake gh arguments', async () => {
  const options = await fixture();
  const git = async (args) => args[0] === 'remote'
    ? 'https://secret-user:secret-token@github.com/example/release' : options.git(args);
  const lines = [];
  assert.equal(await main(['--dry-run'], { ...options, git,
    stdout: (line) => lines.push(line), stderr: assert.fail }), 0);
  const result = await publishRelease({ ...options, git, publish: true });
  assert.equal(result.args[result.args.indexOf('--repo') + 1], repository);
  assert.doesNotMatch([...lines, result.command, await readFile(options.log, 'utf8')].join('\n'), /secret-user|secret-token/);
});

test('scp remote is normalized without credentials for fake gh', async () => {
  const options = await fixture();
  const git = async (args) => args[0] === 'remote' ? 'git@github.com:example/release.git' : options.git(args);
  const result = await publishRelease({ ...options, git, publish: true });
  const args = JSON.parse(await readFile(options.log));
  assert.equal(args[args.indexOf('--repo') + 1], 'github.com/example/release');
  assert.doesNotMatch(result.command, /git@/);
});

for (const remote of ['/tmp/local/repo.git', '../repo', 'file:///tmp/repo', 'https://github.com/owner']) {
  test(`unsupported remote ${remote} refuses before build`, async () => {
    const options = await fixture();
    const git = async (args) => args[0] === 'remote' ? remote : options.git(args);
    await assert.rejects(publishRelease({ ...options, git, publish: true }), /unsupported repository remote/);
    assert.ok(!(await readdir(options.root)).includes('dist'));
    await assert.rejects(readFile(options.log), { code: 'ENOENT' });
  });
}

test('unsafe tag prefixes refuse before git or gh', async () => {
  for (const tagPrefix of ['-', '--', '../', 'bad..', 'bad/', 'bad ']) {
    const options = await fixture({ publish: { tagPrefix } });
    await assert.rejects(publishRelease({ ...options, publish: true }), /unsafe release tag/);
    assert.equal(options.calls.length, 0);
    await assert.rejects(readFile(options.log), { code: 'ENOENT' });
  }
});

for (const key of ['remote', 'branch', 'executable', 'gitExecutable']) {
  for (const value of ['-x', 'bad name', 'bad\nname', 'bad\n', 'bad\x7fname', '', null, 7]) {
    test(`unsafe ${key} ${JSON.stringify(value)} refuses before git/build`, async () => {
      const options = await fixture();
      options.config.publish[key] = value;
      await assert.rejects(publishRelease({ ...options, publish: true }), new RegExp(`unsafe release.publish.${key}`));
      assert.equal(options.calls.length, 0);
      assert.ok(!(await readdir(options.root)).includes('dist'));
      await assert.rejects(readFile(options.log), { code: 'ENOENT' });
    });
  }
}

test('invalid prerelease modes refuse before git/build', async () => {
  for (const prerelease of ['invalid', '', null, true]) {
    const options = await fixture({ publish: { prerelease } });
    await assert.rejects(publishRelease({ ...options, publish: true }), /invalid release.publish.prerelease/);
    assert.equal(options.calls.length, 0);
    assert.ok(!(await readdir(options.root)).includes('dist'));
    await assert.rejects(readFile(options.log), { code: 'ENOENT' });
  }
});

test('safeName is configurable and malformed patterns refuse', async () => {
  for (const safeName of ['[', '^only-this-name$', '', null]) {
    const options = await fixture({ publish: { safeName } });
    const reason = safeName === '^only-this-name$' ? /unsafe release.publish.remote/ : /invalid release.publish.safeName/;
    await assert.rejects(publishRelease(options), reason);
    assert.equal(options.calls.length, 0);
  }
});

for (const publish of [false, true]) {
  test(`unignored in-repository --out refuses early, publish=${publish}`, async () => {
    const options = await fixture();
    for (const throwing of [false, true]) {
      const git = async (args) => {
        if (args[0] !== 'check-ignore') return options.git(args);
        if (throwing) throw Object.assign(new Error('not ignored'), { code: 1 });
        return '';
      };
      await assert.rejects(publishRelease({ ...options, git, publish, out: join(options.root, 'output') }), /--out.*\.gitignore.*outside/);
      assert.ok(!(await readdir(options.root)).includes('output'));
      await assert.rejects(readFile(options.log), { code: 'ENOENT' });
    }
    const out = await mkdtemp(join(tmpdir(), 'release-out-'));
    roots.push(out);
    const result = await publishRelease({ ...options, out, publish });
    assert.equal(result.outputDir, out);
  });
}

test('symlink and directory attachments refuse publication', async () => {
  for (const kind of ['symlink', 'directory']) {
    const options = await fixture();
    const result = await publishRelease(options);
    const file = result.files[0];
    await rm(file);
    if (kind === 'symlink') await symlink(join(options.root, 'package.json'), file);
    else await mkdir(file);
    await assert.rejects(publishRelease({ ...options, publish: true }), /unsafe attachment/);
    await assert.rejects(readFile(options.log), { code: 'ENOENT' });
  }
});

test('duplicate filenames and invalid attachments refuse publication', async () => {
  for (const user of [{ name: 'duplicate.zip' }, ...[null, {}, [], ['unknown']]
    .map((attachments) => ({ publish: { attachments } }))]) {
    const options = await fixture(user);
    await assert.rejects(publishRelease({ ...options, publish: true }), /duplicate release filenames|invalid publish attachments/);
    await assert.rejects(readFile(options.log), { code: 'ENOENT' });
  }
});

test('unsafe or colliding release body paths refuse before build', async () => {
  for (const publish of [{ bodyDir: '../body' }, { bodyFile: '../body.md' },
    { bodyDir: `${pkg.name}-${pkg.version}-release-notes.md` }]) {
    const options = await fixture({ publish });
    await assert.rejects(publishRelease(options), /unsafe release body path|duplicate release filenames/);
    assert.ok(!(await readdir(options.root)).includes('dist'));
  }
});

test('release body directory and file refuse symlinks and wrong types', async () => {
  for (const target of ['directory', 'file']) {
    for (const symlinked of [false, true]) {
      const options = await fixture();
      const result = await publishRelease(options);
      const body = result.args[result.args.indexOf('--notes-file') + 1];
      const path = target === 'file' ? body : join(result.outputDir, options.config.publish.bodyDir);
      await rm(path, { recursive: true });
      if (symlinked) await symlink(join(options.root, 'package.json'), path);
      else if (target === 'file') await mkdir(path);
      else await writeFile(path, 'wrong type');
      await assert.rejects(publishRelease({ ...options, publish: true }), /unsafe release body path/);
      await assert.rejects(readFile(options.log), { code: 'ENOENT' });
    }
  }
});

test('configured git executable, remote and branch are used without real git', async () => {
  const options = await fixture({ publish: { remote: 'upstream', branch: 'stable' } });
  const executable = join(options.root, 'fake-git');
  const log = join(options.root, 'git-args.jsonl');
  await writeFile(executable, `#!${process.execPath}\nimport { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
console.log(args[0] === 'rev-parse' ? ${JSON.stringify(sha)} : args[0] === 'remote' ? ${JSON.stringify(repository)} : args[0] === 'check-ignore' ? args.at(-1) : '');
`);
  await chmod(executable, 0o755);
  await publishRelease({ ...options, git: undefined, publish: true,
    config: { ...options.config, publish: { ...options.config.publish, gitExecutable: executable } } });
  const calls = (await readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(calls.filter((args) => args[0] === 'status').length, 2);
  assert.ok(calls.some((args) => JSON.stringify(args) === JSON.stringify(['fetch', '--', 'upstream', 'stable'])));
  assert.ok(calls.some((args) => args.at(-1) === 'refs/remotes/upstream/stable'));
  assert.ok(calls.some((args) => args[0] === 'ls-remote' && args[3] === 'upstream'));
  assert.ok(calls.some((args) => args[0] === 'remote' && args[3] === 'upstream'));
  for (const args of calls.filter((args) => ['fetch', 'tag', 'ls-remote', 'rev-parse'].includes(args[0]))) {
    assert.ok(args.includes(args[0] === 'rev-parse' ? '--end-of-options' : '--'));
  }
});

test('CLI distinguishes a fake gh failure from a refusal', async () => {
  const options = await fixture();
  const executable = join(options.root, 'gh');
  await writeFile(executable, `#!${process.execPath}\nimport { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(options.log)}, 'started');
process.stderr.write('simulated upload failure\\n');
process.exit(7);\n`);
  await chmod(executable, 0o755);
  const errors = [];
  const io = { ...options, env: { ...options.env, PATH: options.root },
    stdout: assert.fail, stderr: (line) => errors.push(line) };
  assert.equal(await main(['--publish'], io), 1);
  assert.match(errors[0], /^publish failed \(the release may be partly created\): tag v2\.3\.4: /);
  assert.equal(await readFile(options.log, 'utf8'), 'started');
  errors.length = 0;
  assert.equal(await main(['--unknown'], io), 1);
  assert.match(errors[0], /^refused: unknown argument/);
});

test('invalid generation and version refuse; CLI flags and dry-run output', async () => {
  const bad = await fixture({ formats: { windows: 'rar' } });
  await assert.rejects(publishRelease(bad), /unknown archive format/);
  const options = await fixture();
  const lines = [];
  assert.equal(await main(['--dry-run', '--out', join(options.root, 'output')], {
    ...options, stdout: (line) => lines.push(line), stderr: assert.fail,
  }), 0);
  assert.match(lines[0], /dry-run:.*\ntag:.*\ntarget:.*\nprerelease: false/);
  assert.equal(lines.filter((line) => line.startsWith('file:')).length, 21);
  assert.match(lines.at(-1), /'gh' 'release' 'create'/);
  for (const args of [['--unknown'], ['--out'], ['--publish', '--dry-run']]) assert.throws(() => readArgs(args));
  await writeFile(join(options.root, 'package.json'), JSON.stringify({ ...pkg, version: 'invalid' }));
  await assert.rejects(publishRelease({ ...options, publish: true }), /invalid package version/);
  await assert.rejects(readFile(options.log), { code: 'ENOENT' });
  await assert.rejects(inspectGit({ root: options.root, tag: 'v1', git: async () => { throw new Error('fetch failed'); } }), /fetch failed/);
});
