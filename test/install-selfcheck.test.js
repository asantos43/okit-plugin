import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { main, runCommand } from '../src/cli.js';
import { exitCodeFor } from '../src/install/exit.js';
import { Readable } from 'node:stream';
import { HOME_ENV, SELFCHECK_ENV } from '../src/store.js';
import { statuslineCommand } from '../src/quota/statusline-collector.js';
import { runSessionStart } from '../src/hook-session-start.js';
import { DEFAULT_CONFIG } from '../src/profiles.js';
import { readRecord, saveRecord } from '../src/install/place.js';
import { cliScript, hookCommand } from '../src/install/register.js';
import { fixture } from './helpers/install-fixture.js';

// The check after an install or an update: the installation only counts when it works on this machine.
//
// | case | must pass | must refuse |
// | every check id, every shell of every platform, made to fail (S1) | exit 1, the failed row, a Fix line, one language | a success, no fix, a mixed language |
// | a shell that is not installed (S2) | a visible skipped row, exit 0 | a failure, a silent pass |
// | every shell missing (S2) | a failed command check that says to install a POSIX shell | a pass |
// | the status bar and hook strings (S3) | the ones in the settings file, changed or not | a string worked out again |
// | the state root (S4) | a temporary folder, removed afterwards, even on a failure | a write into the real state |
// | dry-run, --check, --rollback, uninstall (S5) | no process of the check | a check |
// | linux, macOS, Windows (S7) | the shell list and the form of each launch | another list |
// | this machine (S7) | a real shim, the real status bar and hook | skipped by a missing sh only |

const PLATFORMS = ['linux', 'darwin', 'win32'];
const LOCALES = ['en', 'pt-BR'];
const CLIENT = 'claude-code';
const OPERATIONAL = exitCodeFor('operational');
const SHELLS = (platform) => DEFAULT_CONFIG.install.selfcheck.shells[platform].map(({ name }) => name);
const RUNNER = (platform) => DEFAULT_CONFIG.install.selfcheck.runner[platform];

// Words of one language that the other must never show inside the block of the check.
const ENGLISH = /\b(failed|Fix:|does not find|is not installed|installed but not working|checks passed|not registered|Install again|Add .* to the PATH|Write the|Run the installer|Install a POSIX)\b/;
const PORTUGUESE = /(falhou|Correção:|não encontra|não está instalado|instalado, mas não funciona|verificações|Instale de novo|Coloque|Grave|Rode o instalador|Instale um shell)/;

const SELF_ROW = { en: /^ {2}Self-check \(Claude Code\)/, 'pt-BR': /^ {2}Autoverificação \(Claude Code\)/ };
const AFTER_BLOCK = /^ {2}(Models|Modelos|Kit)\b/;

/** The lines of the check, from its summary row to the line before the models. */
function blockOf(lines, locale) {
  const start = lines.findIndex((line) => SELF_ROW[locale].test(line));
  assert.ok(start >= 0, `no self-check block in\n${lines.join('\n')}`);
  const end = lines.findIndex((line, index) => index > start && AFTER_BLOCK.test(line));
  return lines.slice(start, end < 0 ? undefined : end);
}

/** A process of the check, as opposed to the client's own registration command. */
const isCheck = (spec) => spec.timeoutMs !== undefined;
const isResolve = (spec) => isCheck(spec) && (/command -v|Get-Command/.test(spec.args.at(-1) ?? '') || spec.args.at(-2) === 'where');
const barText = (spec) => spec.args.at(-1) ?? '';
const isBar = (spec) => isCheck(spec) && barText(spec).includes('statusline-collector');
const isHook = (spec) => isCheck(spec) && barText(spec).includes('hook session-start');

/**
 * The installer in a temporary world. `fail(spec)` decides the outcome of a process of the check: 'missing' (no such
 * executable), 'timeout', a number (an exit code) or nothing; `meddle(moment)` changes the world at 'register' (the files
 * are in place) or 'check' (the first process of the check); `noReading` stops the fake status bar from leaving a reading;
 * `resolved(spec)` is what a shell prints when asked where the command is.
 */
async function world(t, platform, { argv = ['install', '--client', CLIENT, '--statusline'], locale = 'en', fail, meddle, noReading,
  hook = platform !== 'win32', config, env, update, resolved } = {}) {
  const f = await fixture(t, platform);
  if (platform === 'win32') {
    // The Git Bash of the Windows list is found by its candidate paths: put one in a made-up Program Files.
    f.io.env.ProgramFiles = join(f.home, 'Program Files');
    await fs.mkdir(join(f.io.env.ProgramFiles, 'Git/bin'), { recursive: true });
    await fs.writeFile(join(f.io.env.ProgramFiles, 'Git/bin/bash.exe'), '');
  }
  Object.assign(f.io.env, env);
  if (config) {
    const file = join(f.root, 'config.json');
    const stored = JSON.parse(await fs.readFile(file, 'utf8'));
    config(stored.install);
    await fs.writeFile(file, JSON.stringify(stored));
  }
  if (hook) f.io.loadAdapter = () => import('../adapters/claude-code/index.js');
  const checks = [], inner = f.io.run;
  let registered = false, checked = false;
  f.io.run = async (spec) => {
    if (!isCheck(spec)) {
      if (!registered) { registered = true; await meddle?.('register', f); }
      return inner(spec);
    }
    if (!checked) { checked = true; await meddle?.('check', f); }
    checks.push(spec);
    const outcome = fail?.(spec);
    if (outcome === 'missing') throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
    if (outcome === 'timeout') throw Object.assign(new Error('timed out'), { killed: true, signal: 'SIGKILL' });
    if (typeof outcome === 'number') throw Object.assign(new Error('failed'), { code: outcome, stderr: 'boom' });
    if (noReading && isBar(spec)) return {};
    // `resolved(spec)`: what the shell prints for the command (the path it resolves to), instead of the fake's own answer.
    if (resolved && isResolve(spec)) return { stdout: resolved(spec) };
    return inner(spec);
  };
  if (update) {
    // A first install that works, then an update whose proof step (`smoke`, after every write) leaves the world as `update` says.
    assert.equal(await main([...argv, '--locale', locale], f.io), 0, f.output.join('\n'));
    f.setVersion('2.0.0');
    f.clear();
    checks.length = 0;
    f.io.smoke = async (record) => { await update(record, f); return { code: 0 }; };
    argv = ['update'];
  }
  const code = await main([...argv, '--locale', locale], f.io);
  return { ...f, code, checks, text: f.output.join('\n') };
}

/** Whether a process of the check is the launch of that shell (a Git Bash is found by its candidate paths). */
const launchedBy = (shell, spec) => (shell === 'git-bash' ? spec.command.endsWith('/Git/bin/bash.exe')
  : spec.command === { bash: 'bash', zsh: 'zsh', sh: 'sh', fish: 'fish', 'sh -c': '/bin/sh', powershell: 'powershell.exe', cmd: 'cmd.exe' }[shell]);

const TEXTS = {
  en: {
    recordVersion: 'Version  failed  the install record says 1.0.0, expected 2.0.0',
    packageVersion: 'Version  failed  the installed package.json says 1.0.0, expected 2.0.0',
    fixVersion: 'Fix: Install again: okit-plugin install --client claude-code',
    command: (shell) => `Command (${shell})  failed  ${shell} does not find okit-plugin (exit code 1)`,
    fixCommand: (shell) => `Fix: Add <bin> to the PATH of ${shell}, then run: okit-plugin install --client claude-code`,
    bar: (shell) => `Status bar (${shell})  failed  the status bar command failed (exit code 1)`,
    fixBar: (path) => `Fix: Write the status bar command again: okit-plugin install --client claude-code --statusline (settings file: ${path})`,
    hook: (shell) => `Session hook (${shell})  failed  the session hook failed (exit code 1)`,
    fixHook: (path) => `Fix: Write the hook again: okit-plugin install --client claude-code (settings file: ${path})`,
    collector: 'Quota reading  failed  the status bar ran but wrote no reading',
    path: 'Command on PATH  failed  <bin> is not on your PATH and no profile adds it, so a new terminal will not find okit-plugin',
    fixPath: "Fix: Add this line to your shell profile, then open a new terminal: export PATH='<bin>':\"$PATH\"",
    summary: /^ {2}Self-check \(Claude Code\) {2}failed {2}installed but not working: 1 of \d+ checks failed$/,
    missing: (shell) => `Command (${shell})  skipped  ${shell} is not installed`,
    noShell: (shells) => `Command  failed  no shell could run the check (${shells})`,
    fixNoShell: 'Fix: Install a POSIX shell (sh or bash; on Windows, Git for Windows), then run: okit-plugin install --client claude-code',
  },
  'pt-BR': {
    recordVersion: 'Versão  falhou  o registro da instalação diz 1.0.0, esperado 2.0.0',
    packageVersion: 'Versão  falhou  o package.json instalado diz 1.0.0, esperado 2.0.0',
    fixVersion: 'Correção: Instale de novo: okit-plugin install --client claude-code',
    command: (shell) => `Comando (${shell})  falhou  o ${shell} não encontra okit-plugin (código de saída 1)`,
    fixCommand: (shell) => `Correção: Coloque <bin> no PATH do ${shell} e rode: okit-plugin install --client claude-code`,
    bar: (shell) => `Barra de status (${shell})  falhou  o comando da barra de status falhou (código de saída 1)`,
    fixBar: (path) => `Correção: Grave o comando da barra de status de novo: okit-plugin install --client claude-code --statusline (arquivo de ajustes: ${path})`,
    hook: (shell) => `Hook de sessão (${shell})  falhou  o hook de sessão falhou (código de saída 1)`,
    fixHook: (path) => `Correção: Grave o hook de novo: okit-plugin install --client claude-code (arquivo de ajustes: ${path})`,
    collector: 'Leitura de cota  falhou  a barra de status rodou, mas não gravou leitura',
    path: 'Comando no PATH  falhou  <bin> não está no seu PATH e nenhum perfil o adiciona, então um terminal novo não achará okit-plugin',
    fixPath: "Correção: Adicione esta linha ao perfil do seu shell e abra um terminal novo: export PATH='<bin>':\"$PATH\"",
    summary: /^ {2}Autoverificação \(Claude Code\) {2}falhou {2}instalado, mas não funciona: 1 de \d+ verificações falharam$/,
    missing: (shell) => `Comando (${shell})  pulado  ${shell} não está instalado`,
    noShell: (shells) => `Comando  falhou  nenhum shell pôde fazer a verificação (${shells})`,
    fixNoShell: 'Correção: Instale um shell POSIX (sh ou bash; no Windows, o Git for Windows) e rode: okit-plugin install --client claude-code',
  },
};

/** What each check, made to fail, must say: the failed row and its fix, in the words of the language. */
function cases(platform) {
  const bar = RUNNER(platform);
  const barFile = '<home>/.claude/settings.json', hookFile = '<home>/client/settings.json';
  const list = [
    { name: 'version (the record)', id: 'version',
      update: async (record, w) => {
        await saveRecord(w.destination, { ...record, version: '1.0.0' }, { fs, config: w.io.config });
      },
      say: (t) => [t.recordVersion, t.fixVersion] },
    { name: 'version (the installed package)', id: 'version',
      update: async (record) => {
        const file = join(record.path, 'package.json');
        await fs.writeFile(file, JSON.stringify({ ...JSON.parse(await fs.readFile(file, 'utf8')), version: '1.0.0' }));
      },
      say: (t) => [t.packageVersion, t.fixVersion] },
    ...SHELLS(platform).map((shell) => ({ name: `command in ${shell}`, id: 'command', shell,
      fail: (spec) => (isResolve(spec) && launchedBy(shell, spec) ? 1 : undefined),
      say: (t) => [t.command(shell), t.fixCommand(shell)] })),
    { name: 'statusline', id: 'statusline', fail: (spec) => (isBar(spec) ? 1 : undefined),
      say: (t) => [t.bar(bar), t.fixBar(barFile)] },
    ...(platform === 'win32' ? [] : [{ name: 'hook', id: 'hook', fail: (spec) => (isHook(spec) ? 1 : undefined),
      say: (t) => [t.hook(bar), t.fixHook(hookFile)] }]),
    { name: 'collector', id: 'collector', noReading: true, say: (t) => [t.collector, t.fixBar(barFile)] },
    ...(platform === 'win32' ? [] : [{ name: 'path', id: 'path',
      env: { PATH: '/usr/bin' },
      // The profile block that put the folder on the PATH of new terminals is gone.
      meddle: async (moment, w) => {
        if (moment !== 'check') return;
        for (const name of ['.bashrc', '.zshrc', '.profile', '.bash_profile', '.config/fish/conf.d/okit-plugin.fish', '.config/fish/config.fish']) {
          await fs.rm(join(w.home, name), { force: true });
        }
      },
      say: (t) => [t.path, t.fixPath] }]),
  ];
  return list;
}

// S1: every check id, every shell of the list of every platform, in both languages.
for (const platform of PLATFORMS) {
  for (const locale of LOCALES) {
    test(`S1: each check, made to fail, fails the run with its fix in ${locale} on ${platform}`, async (t) => {
      const names = cases(platform).map(({ name }) => name);
      // two for the version, one per shell, the bar, its reading, and on a POSIX system the hook and the PATH
      assert.equal(names.length, 2 + SHELLS(platform).length + 2 + (platform === 'win32' ? 0 : 2), names.join(', '));
      for (const name of names) {
        const one = cases(platform).find((item) => item.name === name);
        const w = await world(t, platform, { locale, fail: one.fail, meddle: one.meddle, noReading: one.noReading, env: one.env, update: one.update });
        const context = `${name}\n${w.text}`;
        const want = TEXTS[locale];
        assert.equal(w.code, OPERATIONAL, context);
        const lines = w.lines();
        const block = blockOf(lines, locale);
        assert.match(block[0], want.summary, context);
        for (const expected of one.say(want)) assert.ok(block.includes(`  ${expected}`), `missing "${expected}" in\n${block.join('\n')}`);
        // The fix comes right after the row it is for.
        const [row, fix] = one.say(want);
        assert.equal(block.indexOf(`  ${fix}`), block.indexOf(`  ${row}`) + 1, context);
        // One language, and no raw key or placeholder.
        assert.doesNotMatch(block.join('\n'), locale === 'en' ? PORTUGUESE : ENGLISH, context);
        assert.doesNotMatch(block.join('\n'), /\{[a-z]+\}|selfcheck[A-Z]/, context);
        // The installation is left in place, and the run says nothing of success.
        assert.ok((await readRecord(w.destination, CLIENT, fs, w.io.config)).version, context);
        assert.doesNotMatch(w.text, /Done\. Next:|Pronto\. Próximo:/, context);
      }
    });
  }
}

test('S1: a timeout and a result with a non-zero code fail like a thrown exit code', async (t) => {
  const timeout = await world(t, 'linux', { fail: (spec) => (isResolve(spec) && spec.command === 'bash' ? 'timeout' : undefined) });
  assert.equal(timeout.code, OPERATIONAL, timeout.text);
  assert.ok(timeout.lines().includes('  Command (bash)  failed  bash does not find okit-plugin (no answer in 10000 ms)'), timeout.text);
  const f = await fixture(t, 'linux');
  const run = f.io.run;
  f.io.run = async (spec) => (isCheck(spec) && isResolve(spec) && spec.command === 'zsh' ? { code: 3, stderr: '' } : run(spec));
  assert.equal(await main(['install', '--client', CLIENT], f.io), OPERATIONAL, f.output.join('\n'));
  assert.ok(f.lines().includes('  Command (zsh)  failed  zsh does not find okit-plugin (exit code 3)'), f.output.join('\n'));
});

test('S1: a failure is told on the update too, and the fix is the installer again', async (t) => {
  const f = await fixture(t, 'linux');
  assert.equal(await main(['install', '--client', CLIENT], f.io), 0, f.output.join('\n'));
  f.setVersion('2.0.0');
  f.clear();
  const run = f.io.run;
  f.io.run = async (spec) => (isCheck(spec) && isResolve(spec) && spec.command === 'sh' ? Promise.reject(Object.assign(new Error('x'), { code: 1 })) : run(spec));
  assert.equal(await main(['update'], f.io), OPERATIONAL, f.output.join('\n'));
  assert.ok(f.lines().includes('  Command (sh)  failed  sh does not find okit-plugin (exit code 1)'), f.output.join('\n'));
  assert.ok(f.lines().includes('  Fix: Add <bin> to the PATH of sh, then run: okit-plugin install --client claude-code'), f.output.join('\n'));
  assert.equal((await readRecord(f.destination, CLIENT, fs, f.io.config)).version, '2.0.0');
});

test('S1: the same version again is checked as well', async (t) => {
  const f = await fixture(t, 'linux');
  assert.equal(await main(['install', '--client', CLIENT], f.io), 0, f.output.join('\n'));
  f.clear();
  f.commands.length = 0;
  const run = f.io.run;
  f.io.run = async (spec) => (isCheck(spec) && isResolve(spec) && spec.command === 'zsh' ? Promise.reject(Object.assign(new Error('x'), { code: 1 })) : run(spec));
  assert.equal(await main(['update'], f.io), OPERATIONAL, f.output.join('\n'));
  assert.ok(f.commands.some(isCheck), 'the up-to-date update ran no check');
  assert.ok(f.lines().includes('  Command (zsh)  failed  zsh does not find okit-plugin (exit code 1)'), f.output.join('\n'));
});

// S2: a shell that is not installed is skipped, visibly.
for (const platform of PLATFORMS) {
  for (const locale of LOCALES) {
    test(`S2: a missing shell is a visible skip, never a failure (${locale}, ${platform})`, async (t) => {
      for (const shell of SHELLS(platform)) {
        const w = await world(t, platform, { locale, fail: (spec) => (isResolve(spec) && launchedBy(shell, spec) ? 'missing' : undefined),
          hook: false });
        const context = `${shell}\n${w.text}`;
        assert.equal(w.code, 0, context);
        assert.ok(w.lines().includes(`  ${TEXTS[locale].missing(shell)}`), context);
        assert.match(blockOf(w.lines(), locale)[0], locale === 'en' ? /ok {2}\d+ checks passed$/ : /ok {2}\d+ verificações passaram$/, context);
      }
    });

    test(`S2: with every shell missing the command check fails and says to install a POSIX shell (${locale}, ${platform})`, async (t) => {
      const w = await world(t, platform, { locale, hook: false, fail: (spec) => (isResolve(spec) ? 'missing' : undefined) });
      const names = SHELLS(platform).join(', ');
      assert.equal(w.code, OPERATIONAL, w.text);
      const block = blockOf(w.lines(), locale);
      assert.ok(block.includes(`  ${TEXTS[locale].noShell(names)}`), block.join('\n'));
      assert.equal(block.indexOf(`  ${TEXTS[locale].fixNoShell}`), block.indexOf(`  ${TEXTS[locale].noShell(names)}`) + 1, block.join('\n'));
      for (const shell of SHELLS(platform)) assert.ok(block.includes(`  ${TEXTS[locale].missing(shell)}`), block.join('\n'));
    });
  }
}

test('S2: a Git Bash that is nowhere on the machine is a skip too', async (t) => {
  const f = await fixture(t, 'win32');
  assert.equal(await main(['install', '--client', CLIENT], f.io), 0, f.output.join('\n'));
  assert.ok(f.lines().includes('  Command (git-bash)  skipped  git-bash is not installed'), f.output.join('\n'));
});

// S3: the strings come from the settings file the installer wrote.
test('S3: the status bar and hook strings run are the ones in the settings file, as they were written', async (t) => {
  const w = await world(t, 'linux');
  assert.equal(w.code, 0, w.text);
  const bar = JSON.parse(await fs.readFile(join(w.home, '.claude/settings.json'), 'utf8')).statusLine.command;
  const hooks = JSON.parse(await fs.readFile(join(w.io.clientRoot, 'settings.json'), 'utf8')).hooks.SessionStart.flatMap((entry) => entry.hooks.map((item) => item.command));
  assert.equal(hooks.length, 1);
  assert.deepEqual(w.checks.filter(isBar).map(barText), [bar]);
  assert.deepEqual(w.checks.filter(isHook).map(barText), hooks);
  // The hook is the one the registration writes: one source for the writer and the reader.
  const record = await readRecord(w.destination, CLIENT, fs, w.io.config);
  assert.equal(hooks[0], hookCommand(record.path));
});

test('S3: a string changed after it was written is the string that runs', async (t) => {
  const changedBar = "'okit-plugin' 'statusline-collector' '--previous' 'echo' 'changed'";
  const w = await world(t, 'linux', {
    meddle: async (moment, f) => {
      if (moment !== 'check') return;
      const file = join(f.home, '.claude/settings.json');
      const settings = JSON.parse(await fs.readFile(file, 'utf8'));
      settings.statusLine.command = changedBar;
      await fs.writeFile(file, JSON.stringify(settings));
    },
  });
  assert.equal(w.code, 0, w.text);
  // Still exactly what the writer produces (every word quoted, `--previous` and its words): that is what runs.
  assert.deepEqual(w.checks.filter(isBar).map(barText), [changedBar]);
  assert.equal(w.checks.filter(isHook).length, 1);
});

test('S3: a changed string that fails is what fails the run', async (t) => {
  const w = await world(t, 'linux', {
    fail: (spec) => (isBar(spec) && barText(spec).includes('changed') ? 7 : undefined),
    meddle: async (moment, f) => {
      if (moment !== 'check') return;
      const file = join(f.home, '.claude/settings.json');
      const settings = JSON.parse(await fs.readFile(file, 'utf8'));
      settings.statusLine.command = "'okit-plugin' 'statusline-collector' '--previous' 'echo' 'changed'";
      await fs.writeFile(file, JSON.stringify(settings));
    },
  });
  assert.equal(w.code, OPERATIONAL, w.text);
  assert.ok(w.lines().includes('  Status bar (sh)  failed  the status bar command failed (exit code 7)'), w.text);
});

test('S3: a status bar that is not ours is not run', async (t) => {
  const w = await world(t, 'linux', {
    argv: ['install', '--client', CLIENT],
    meddle: async (moment, f) => {
      if (moment !== 'check') return;
      await fs.mkdir(join(f.home, '.claude'), { recursive: true });
      await fs.writeFile(join(f.home, '.claude/settings.json'), JSON.stringify({ statusLine: { type: 'command', command: 'my-own-bar' } }));
    },
  });
  assert.equal(w.code, 0, w.text);
  assert.equal(w.checks.filter(isBar).length, 0);
  assert.ok(!w.checks.some((spec) => barText(spec).includes('my-own-bar')));
});

// S4: the person's own state is never written.
for (const outcome of ['passes', 'fails']) {
  test(`S4: the real state root is untouched and the temporary folder is removed when the check ${outcome}`, async (t) => {
    const seen = [];
    const fail = outcome === 'fails' ? (spec) => (isBar(spec) || isHook(spec) ? 1 : undefined) : undefined;
    const f = await fixture(t, 'linux');
    f.io.loadAdapter = () => import('../adapters/claude-code/index.js');
    const sentinel = join(f.root, 'quota', 'sentinel.txt');
    await fs.mkdir(join(f.root, 'quota'), { recursive: true });
    await fs.writeFile(sentinel, 'mine');
    const before = (await fs.readdir(join(f.root, 'quota'))).sort();
    const run = f.io.run;
    f.io.run = async (spec) => {
      if (isBar(spec) || isHook(spec)) {
        seen.push(spec.env[HOME_ENV]);
        // The temporary folder exists while the string runs.
        assert.ok((await fs.stat(spec.env[HOME_ENV])).isDirectory());
      }
      return fail?.(spec) ? Promise.reject(Object.assign(new Error('x'), { code: 1 })) : run(spec);
    };
    const code = await main(['install', '--client', CLIENT, '--statusline'], f.io);
    assert.equal(code, outcome === 'fails' ? OPERATIONAL : 0, f.output.join('\n'));
    assert.ok(seen.length >= 2, `the strings ran with ${seen.length} state folders`);
    for (const folder of seen) {
      assert.ok(folder && folder !== f.root && !folder.startsWith(`${f.root}/`), `${folder} is inside the real state ${f.root}`);
      assert.ok(folder.startsWith(f.scratch), `${folder} is not in the temporary area`);
      await assert.rejects(fs.stat(folder), { code: 'ENOENT' }, `${folder} was left behind`);
    }
    assert.equal(await fs.readFile(sentinel, 'utf8'), 'mine');
    assert.deepEqual((await fs.readdir(join(f.root, 'quota'))).sort(), before);
    assert.deepEqual(await fs.readdir(f.scratch), [], 'the scratch area is not empty');
  });
}

test('S4: a check that cannot run at all still removes its folder', async (t) => {
  const f = await fixture(t, 'linux');
  const seen = [];
  const run = f.io.run;
  f.io.run = async (spec) => {
    if (isBar(spec)) { seen.push(spec.env[HOME_ENV]); throw Object.assign(new Error('x'), { killed: true }); }
    return run(spec);
  };
  assert.equal(await main(['install', '--client', CLIENT, '--statusline'], f.io), OPERATIONAL, f.output.join('\n'));
  assert.equal(seen.length, 1);
  await assert.rejects(fs.stat(seen[0]), { code: 'ENOENT' });
});

// S5: only the install and the update run the check.
test('S5: dry-run, --check, --rollback and uninstall run no process of the check', async (t) => {
  const dry = await fixture(t, 'linux');
  assert.equal(await main(['install', '--client', CLIENT, '--statusline', '--dry-run'], dry.io), 0, dry.output.join('\n'));
  assert.equal(dry.commands.filter(isCheck).length, 0, 'install --dry-run');
  assert.doesNotMatch(dry.output.join('\n'), /Self-check/);

  const f = await fixture(t, 'linux');
  f.io.loadAdapter = () => import('../adapters/claude-code/index.js');
  assert.equal(await main(['install', '--client', CLIENT, '--statusline'], f.io), 0, f.output.join('\n'));
  assert.ok(f.commands.filter(isCheck).length > 0, 'the install itself runs the check');
  f.setVersion('2.0.0');
  f.commands.length = 0;
  assert.equal(await main(['update'], f.io), 0, f.output.join('\n'));
  assert.ok(f.commands.filter(isCheck).length > 0, 'the update itself runs the check');
  f.setVersion('3.0.0');
  for (const argv of [['update', '--check'], ['update', '--dry-run'], ['update', '--rollback'], ['uninstall']]) {
    f.clear();
    f.commands.length = 0;
    const code = await main(argv, f.io);
    assert.equal(code, 0, `${argv.join(' ')}\n${f.output.join('\n')}`);
    assert.ok(f.output.length > 0, `${argv.join(' ')} printed nothing`);
    assert.equal(f.commands.filter(isCheck).length, 0, `${argv.join(' ')} ran a process of the check`);
    assert.doesNotMatch(f.output.join('\n'), /Self-check|Autoverificação/, argv.join(' '));
  }
});

test('S5: an up-to-date install under --dry-run or --check runs no process of the check', async (t) => {
  const f = await fixture(t, 'linux');
  f.io.loadAdapter = () => import('../adapters/claude-code/index.js');
  assert.equal(await main(['install', '--client', CLIENT, '--statusline'], f.io), 0, f.output.join('\n'));
  for (const argv of [['install', '--client', CLIENT, '--dry-run'], ['update', '--dry-run'], ['update', '--check']]) {
    f.clear();
    f.commands.length = 0;
    assert.equal(await main(argv, f.io), 0, `${argv.join(' ')}\n${f.output.join('\n')}`);
    assert.match(f.output.join('\n'), /up to date|Up to date/i, `${argv.join(' ')} took the same-version path`);
    assert.equal(f.commands.filter(isCheck).length, 0, `${argv.join(' ')} ran a process of the check`);
    assert.doesNotMatch(f.output.join('\n'), /Self-check|Autoverificação/, argv.join(' '));
  }
});

test('S5: the check does not run on an install that is itself refused', async (t) => {
  const f = await fixture(t, 'linux');
  assert.equal(await main(['install', '--client', CLIENT, '--check'], f.io), 2, f.output.join('\n'));
  assert.equal(f.commands.filter(isCheck).length, 0);
});

// S7: the shell list and the form of each launch, by platform.
// (the last row of linux and darwin is the status bar's own executable, resolved in the shell that runs it)
const FORMS = {
  linux: [['bash', ['-c', "command -v 'okit-plugin'"]], ['zsh', ['-c', "command -v 'okit-plugin'"]], ['sh', ['-c', "command -v 'okit-plugin'"]], ['fish', ['-c', "command -v 'okit-plugin'"]],
    ['sh', ['-c', "command -v 'okit-plugin'"]]],
  darwin: [['zsh', ['-c', "command -v 'okit-plugin'"]], ['bash', ['-c', "command -v 'okit-plugin'"]], ['sh', ['-c', "command -v 'okit-plugin'"]], ['/bin/sh', ['-c', "command -v 'okit-plugin'"]], ['/bin/sh', ['-c', "command -v 'okit-plugin'"]]],
  win32: [['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "$c = Get-Command 'okit-plugin' -ErrorAction SilentlyContinue; if (-not $c) { exit 1 }; $c.Source"]],
    ['cmd.exe', ['/d', '/s', '/c', 'where', 'okit-plugin']], ['<program-files>/Git/bin/bash.exe', ['-c', "command -v 'okit-plugin'"]]],
};
for (const platform of PLATFORMS) {
  test(`S7: ${platform} checks its own shells, each launched non-interactively with the configured timeout`, async (t) => {
    const w = await world(t, platform);
    assert.equal(w.code, 0, w.text);
    const resolves = w.checks.filter(isResolve).map((spec) => [spec.command.replace(w.io.env.ProgramFiles ?? '\0', '<program-files>'), spec.args]);
    assert.deepEqual(resolves, FORMS[platform]);
    for (const spec of w.checks) {
      assert.equal(spec.timeoutMs, DEFAULT_CONFIG.install.selfcheck.timeoutMs);
      assert.ok(spec.env.PATH.startsWith(w.bin) || platform === 'win32', `the link folder is not first on ${spec.env.PATH}`);
      // No login shell and no interactive shell: `-l` and `-i` are never an argument.
      assert.ok(!spec.args.some((argument) => ['-l', '-i', '-il', '-li', '--login', '--interactive'].includes(argument)));
    }
    // The strings of the client run in the shell the client uses.
    const runner = { linux: 'sh', darwin: '/bin/sh', win32: `${w.io.env.ProgramFiles}/Git/bin/bash.exe` }[platform];
    for (const spec of w.checks.filter((item) => isBar(item) || isHook(item))) {
      assert.equal(spec.command, runner);
      assert.equal(spec.args[0], '-c');
      assert.equal(spec.args.length, 2);
    }
    // The status bar gets the sample JSON of the rate limits; the hook, the SessionStart event.
    for (const spec of w.checks.filter(isBar)) assert.ok(JSON.parse(spec.input).rate_limits, spec.input);
    for (const spec of w.checks.filter(isHook)) assert.equal(JSON.parse(spec.input).hook_event_name, 'SessionStart');
    // The platform of the run decides, not the machine's: the Windows list has no POSIX-only shell.
    assert.deepEqual(w.checks.filter(isResolve).length, FORMS[platform].length);
  });
}

test('S7: the shell list is the configuration, not the code', async (t) => {
  const w = await world(t, 'linux', { hook: false, config: (install) => {
    install.selfcheck = { shells: { linux: [{ name: 'dash', executable: 'dash', quote: 'posix', resolve: ['-c', 'command -v {command}'] }] } };
  } });
  assert.equal(w.code, 0, w.text);
  assert.deepEqual(w.checks.filter(isResolve).map((spec) => spec.command), ['dash']);
});

// S7: one real run on this machine, with a real shim and the real strings.
const realShell = spawnSync('sh', ['-c', 'exit 0']).status === 0 && process.platform !== 'win32';
test('S7: real run, the shim resolves and the written status bar and hook exit 0', { skip: realShell ? false : 'no sh on this machine' }, async (t) => {
  const f = await fixture(t, process.platform === 'darwin' ? 'darwin' : 'linux');
  f.io.loadAdapter = () => import('../adapters/claude-code/index.js');
  f.io.env.PATH = `${f.bin}:${process.env.PATH}`;
  f.io.env.HOME = f.home;
  const repo = new URL('../', import.meta.url).pathname;
  const readings = [];
  const fake = f.io.run;
  f.io.run = async (spec) => {
    if (!isCheck(spec)) {
      // The client's own commands are not run; the files are in place now, and the shim must reach the real program.
      const installed = join(f.destination, '1.0.0-claude-code');
      await fs.rm(join(installed, 'src'), { recursive: true, force: true });
      await fs.cp(join(repo, 'src'), join(installed, 'src'), { recursive: true });
      await fs.cp(join(repo, 'adapters'), join(installed, 'adapters'), { recursive: true });
      await fs.chmod(join(installed, 'src/cli.js'), 0o755);
      const real = JSON.parse(await fs.readFile(join(repo, 'package.json'), 'utf8'));
      await fs.writeFile(join(installed, 'package.json'), JSON.stringify({ ...real, version: '1.0.0' }));
      return fake(spec);
    }
    const result = await runCommand(spec);
    if (isBar(spec)) readings.push((await fs.readdir(join(spec.env[HOME_ENV], 'quota')).catch(() => [])));
    return result;
  };
  const code = await main(['install', '--client', CLIENT, '--statusline'], f.io);
  assert.equal(code, 0, f.output.join('\n'));
  assert.deepEqual(readings, [['claude-code.json']], 'the real collector left its reading in the temporary root');
  const block = blockOf(f.lines(), 'en');
  assert.match(block[0], /ok {2}\d+ checks passed$/, block.join('\n'));
  assert.ok(f.commands.length > 0);
});

test('S7: a real shim that does not resolve fails the real check', { skip: realShell ? false : 'no sh on this machine' }, async (t) => {
  const f = await fixture(t, process.platform === 'darwin' ? 'darwin' : 'linux');
  f.io.env.PATH = process.env.PATH;
  f.io.bin = f.bin;
  const fake = f.io.run;
  f.io.run = async (spec) => {
    if (!isCheck(spec)) return fake(spec);
    // Take the shim away just before the first launch, as a broken install would leave it.
    await fs.rm(join(f.bin, 'okit-plugin'), { force: true });
    return runCommand({ ...spec, env: { ...spec.env, PATH: '/usr/bin:/bin' } });
  };
  const code = await main(['install', '--client', CLIENT], f.io);
  assert.equal(code, OPERATIONAL, f.output.join('\n'));
  assert.ok(f.lines().some((line) => /^ {2}Command \(sh\) {2}failed {2}sh does not find okit-plugin/.test(line)), f.output.join('\n'));
});

test('S7: the command, a link to cli.js on a POSIX system, runs the program when called through the link', { skip: realShell ? false : 'no sh on this machine' }, async (t) => {
  const folder = await fs.mkdtemp(join(tmpdir(), 'selfcheck-link-'));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  await fs.symlink(cli, join(folder, 'okit-plugin'));
  const result = spawnSync(process.execPath, [join(folder, 'okit-plugin'), '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^usage: okit-plugin/, 'the link printed nothing: the entry check compares the link, not the file');
});

// C1: the check never starts a command that is not ours.
const repoRoot = new URL('../', import.meta.url).pathname;

/**
 * A real install in a temporary world, running the real shim, the real status bar and the real hook. `before(f)` prepares
 * the person's files (a status bar of their own, the collector's configuration); `readings` is what each status bar run
 * left in its temporary state root.
 */
async function realWorld(t, { before, argv = ['install', '--client', CLIENT, '--statusline'] } = {}) {
  const f = await fixture(t, process.platform === 'darwin' ? 'darwin' : 'linux');
  f.io.loadAdapter = () => import('../adapters/claude-code/index.js');
  f.io.env.PATH = `${f.bin}:${process.env.PATH}`;
  f.io.env.HOME = f.home;
  await before?.(f);
  const readings = [], fake = f.io.run;
  f.io.run = async (spec) => {
    if (!isCheck(spec)) {
      const installed = join(f.destination, '1.0.0-claude-code');
      await fs.rm(join(installed, 'src'), { recursive: true, force: true });
      await fs.cp(join(repoRoot, 'src'), join(installed, 'src'), { recursive: true });
      await fs.cp(join(repoRoot, 'adapters'), join(installed, 'adapters'), { recursive: true });
      await fs.chmod(join(installed, 'src/cli.js'), 0o755);
      const real = JSON.parse(await fs.readFile(join(repoRoot, 'package.json'), 'utf8'));
      await fs.writeFile(join(installed, 'package.json'), JSON.stringify({ ...real, version: '1.0.0' }));
      return fake(spec);
    }
    const result = await runCommand(spec);
    if (isBar(spec)) readings.push(await fs.readdir(join(spec.env[HOME_ENV], 'quota')).catch(() => []));
    return result;
  };
  const code = await main(argv, f.io);
  return { f, code, readings, text: f.output.join('\n') };
}

test('C1: a status bar of the person, chained with --previous, is not run by the check; the reading is still written', { skip: realShell ? false : 'no sh on this machine' }, async (t) => {
  let sentinel;
  const w = await realWorld(t, { before: async (f) => {
    sentinel = join(f.home, 'ran-by-the-check');
    await fs.mkdir(join(f.home, '.claude'), { recursive: true });
    await fs.writeFile(join(f.home, '.claude/settings.json'), JSON.stringify({ statusLine: { type: 'command', command: `touch ${sentinel}` } }));
  } });
  assert.equal(w.code, 0, w.text);
  const written = JSON.parse(await fs.readFile(join(w.f.home, '.claude/settings.json'), 'utf8')).statusLine.command;
  assert.match(written, /--previous/, `the written bar does not chain the person's command: ${written}`);
  assert.deepEqual(w.readings, [['claude-code.json']], 'the reading is written in the temporary root');
  await assert.rejects(fs.stat(sentinel), { code: 'ENOENT' }, 'the check ran a command that is not ours');
});

test('C1: every process of the written strings is started with the check variable, and no other process is', async (t) => {
  const w = await world(t, 'linux');
  assert.equal(w.code, 0, w.text);
  const written = w.checks.filter((spec) => isBar(spec) || isHook(spec));
  assert.ok(written.length >= 2);
  for (const spec of written) assert.equal(spec.env[SELFCHECK_ENV], '1');
  for (const spec of w.checks.filter(isResolve)) assert.equal(spec.env[SELFCHECK_ENV], undefined, 'a resolve carries the variable');
  assert.equal(w.io.env[SELFCHECK_ENV], undefined, "the variable leaked into the installer's own environment");
});

test('C1: the collector chains --previous without the variable and never starts it with the variable', async (t) => {
  const folder = await fs.mkdtemp(join(tmpdir(), 'selfcheck-previous-'));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const sentinel = join(folder, 'sentinel');
  const previous = ['--previous', process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'x')`];
  const sample = JSON.stringify({ rate_limits: { five_hour: { used_percentage: 1, resets_at: 1893456000 } } });
  const call = (env) => statuslineCommand(previous, { root: join(folder, env ? 'a' : 'b'), env, stdin: Readable.from([sample]), stdout: () => {} });
  assert.equal(await call({ [SELFCHECK_ENV]: '1' }), 0);
  await assert.rejects(fs.stat(sentinel), { code: 'ENOENT' }, 'the collector chained the command under the check');
  assert.deepEqual(await fs.readdir(join(folder, 'a', 'quota')), ['claude-code.json'], 'the reading is written under the check');
  assert.equal(await call({}), 0);
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'x', 'without the variable the collector chains as before');
});

// C2: the command found is OUR shim.
for (const platform of PLATFORMS) {
  for (const locale of LOCALES) {
    test(`C2: ${platform} (${locale}) a shell that resolves the command to another folder fails with the path found and a fix`, async (t) => {
      const other = platform === 'win32' ? 'C:\\Tools\\okit-plugin.cmd' : '/opt/other/okit-plugin';
      const w = await world(t, platform, { locale, resolved: () => `${other}\n` });
      assert.equal(w.code, OPERATIONAL, w.text);
      const names = SHELLS(platform);
      const found = w.lines().filter((line) => /^ {2}(Command|Comando) \(/.test(line));
      assert.equal(found.length, names.length, w.text);
      const said = locale === 'en' ? /finds okit-plugin at .*, not in <bin>/ : /encontra okit-plugin em .*, não em <bin>/;
      for (const line of found) assert.match(line, said);
      assert.ok(found.every((line) => line.includes(other)), found.join('\n'));
      const fix = w.lines().filter((line) => /^ {4}(Fix|Correção):/.test(line) || /^ {2}(Fix|Correção):/.test(line));
      assert.ok(fix.some((line) => (locale === 'en' ? /Remove or rename .* or put <bin> before it on the PATH of/ : /Remova ou renomeie .* ou ponha <bin> antes dele no PATH do/).test(line)), w.text);
      assert.doesNotMatch(w.text, locale === 'en' ? PORTUGUESE : ENGLISH, w.text);
    });
  }
  test(`C2: ${platform} a shell that resolves the command into the link folder passes, whatever the slashes (and case on Windows)`, async (t) => {
    const windows = platform === 'win32';
    const shown = (bin) => (windows ? `${bin.replaceAll('/', '\\').toUpperCase()}\\OKIT-PLUGIN.CMD` : `${bin}/okit-plugin`);
    const w = await world(t, platform, { resolved: (spec) => `\n${shown(spec.env[Object.keys(spec.env).find((name) => name.toLowerCase() === 'path')].split(windows ? ';' : ':')[0])}\r\n` });
    assert.equal(w.code, 0, w.text);
    assert.ok(w.checks.filter(isResolve).length > 0);
  });
}

test('C2: on Linux the case of the folder counts; a path in another folder with the same tail still fails', async (t) => {
  const w = await world(t, 'linux', { resolved: (spec) => `${spec.env.PATH.split(':')[0].toUpperCase()}/okit-plugin\n` });
  assert.equal(w.code, OPERATIONAL, w.text);
  const w2 = await world(t, 'linux', { resolved: (spec) => `${spec.env.PATH.split(':')[0]}/deeper/okit-plugin\n` });
  assert.equal(w2.code, OPERATIONAL, w2.text);
});

test('C2: a shell that prints nothing for the command fails and says so', async (t) => {
  const w = await world(t, 'linux', { resolved: () => '' });
  assert.equal(w.code, OPERATIONAL, w.text);
  assert.ok(w.lines().some((line) => /finds okit-plugin at \(nothing\), not in <bin>/.test(line)), w.text);
});

// C3: the collector of the check reads the same configuration as the real one.
test('C3: custom field names of the collector pass the check; the real state stays as it was', { skip: realShell ? false : 'no sh on this machine' }, async (t) => {
  let before;
  const w = await realWorld(t, { before: async (f) => {
    const file = join(f.root, 'config.json');
    const stored = JSON.parse(await fs.readFile(file, 'utf8'));
    stored.statuslineCollector = { fields: { rateLimits: 'limits', usedPercentage: 'used', resetsAt: 'reset' } };
    await fs.writeFile(file, JSON.stringify(stored));
    await fs.mkdir(join(f.root, 'quota'), { recursive: true });
    await fs.writeFile(join(f.root, 'quota', 'mine.json'), 'mine');
    before = { config: await fs.readFile(file, 'utf8'), quota: await fs.readdir(join(f.root, 'quota')) };
  } });
  assert.equal(w.code, 0, w.text);
  assert.deepEqual(w.readings, [['claude-code.json']], 'the collector found no reading with the custom fields');
  assert.equal(await fs.readFile(join(w.f.root, 'config.json'), 'utf8'), before.config, 'the real configuration was changed');
  assert.deepEqual(await fs.readdir(join(w.f.root, 'quota')), before.quota, 'the real state root was written');
  assert.deepEqual(await fs.readdir(w.f.scratch), [], 'the temporary copy was left behind');
});

test('C3: no configuration file in the real root means none in the temporary one, and the check still runs', async (t) => {
  const f = await fixture(t, 'linux');
  f.io.loadAdapter = () => import('../adapters/claude-code/index.js');
  await fs.rm(join(f.root, 'config.json'));
  const seen = [], run = f.io.run;
  f.io.run = async (spec) => {
    if (isBar(spec)) seen.push(await fs.readdir(spec.env[HOME_ENV]));
    return run(spec);
  };
  assert.equal(await main(['install', '--client', CLIENT, '--statusline'], f.io), 0, f.output.join('\n'));
  assert.deepEqual(seen, [[]], 'the temporary root should start empty');
});

test('C3: the temporary root starts with the allowed keys of the real configuration, and no other', async (t) => {
  const f = await fixture(t, 'linux');
  f.io.loadAdapter = () => import('../adapters/claude-code/index.js');
  const stored = JSON.parse(await fs.readFile(join(f.root, 'config.json'), 'utf8'));
  stored.statuslineCollector = { fields: { rateLimits: 'limits' } };
  stored.limits = { global: 2, clients: {} };
  stored.language = 'pt-BR';
  await fs.writeFile(join(f.root, 'config.json'), JSON.stringify(stored));
  const real = await fs.readFile(join(f.root, 'config.json'), 'utf8');
  const copies = [], run = f.io.run;
  f.io.run = async (spec) => {
    if (isBar(spec) || isHook(spec)) copies.push(await fs.readFile(join(spec.env[HOME_ENV], 'config.json'), 'utf8'));
    return run(spec);
  };
  assert.equal(await main(['install', '--client', CLIENT, '--statusline', '--locale', 'en'], f.io), 0, f.output.join('\n'));
  assert.ok(copies.length >= 2);
  const allowed = DEFAULT_CONFIG.install.selfcheck.stateKeys;
  for (const copy of copies) {
    assert.deepEqual(JSON.parse(copy), Object.fromEntries(allowed.filter((key) => key in stored).map((key) => [key, stored[key]])));
  }
  assert.equal(await fs.readFile(join(f.root, 'config.json'), 'utf8'), real);
});

// C4: a new terminal, said once, on every way a run can end.
const TERMINAL = { en: /new terminal/gi, 'pt-BR': /terminal novo/gi };
const countOf = (text, locale) => (text.match(TERMINAL[locale]) ?? []).length;
const EXPECTED_ROW = { en: 'Open a new terminal and the command will work there', 'pt-BR': 'Abra um terminal novo e o comando funcionará lá' };

for (const locale of LOCALES) {
  test(`C4: (${locale}) off this PATH with a managed profile, a fresh install, an update and an up-to-date install each say a new terminal once`, async (t) => {
    const f = await fixture(t, 'linux');
    f.io.env.PATH = '/usr/bin';
    f.io.loadAdapter = () => import('../adapters/claude-code/index.js');
    const run = async (argv) => { f.clear(); const code = await main([...argv, '--locale', locale], f.io); return { code, text: f.output.join('\n') }; };
    const fresh = await run(['install', '--client', CLIENT, '--statusline']);
    assert.equal(fresh.code, 0, fresh.text);
    assert.equal(countOf(fresh.text, locale), 1, fresh.text);
    assert.match(fresh.text, locale === 'en' ? /Done\. Next: 1\. open a new terminal/ : /Pronto\. Próximo: 1\. abra um terminal novo/, fresh.text);
    const same = await run(['install', '--client', CLIENT, '--statusline']);
    assert.equal(same.code, 0, same.text);
    assert.equal(countOf(same.text, locale), 1, same.text);
    assert.ok(same.text.includes(EXPECTED_ROW[locale]), same.text);
    assert.doesNotMatch(same.text, /Done\. Next|Pronto\. Próximo/);
    f.setVersion('2.0.0');
    const update = await run(['update']);
    assert.equal(update.code, 0, update.text);
    assert.equal(countOf(update.text, locale), 1, update.text);
    assert.match(update.text, locale === 'en' ? /Done\. Next: 1\. open a new terminal/ : /Pronto\. Próximo: 1\. abra um terminal novo/, update.text);
    const current = await run(['update']);
    assert.equal(current.code, 0, current.text);
    assert.equal(countOf(current.text, locale), 1, current.text);
    assert.ok(current.text.includes(EXPECTED_ROW[locale]), current.text);
  });
}

test('C4: when a check fails, the new terminal is told once, in the row of the path', async (t) => {
  const w = await world(t, 'linux', { env: { PATH: '/usr/bin' }, fail: (spec) => (isBar(spec) ? 1 : undefined) });
  assert.equal(w.code, OPERATIONAL, w.text);
  assert.equal(countOf(w.text, 'en'), 1, w.text);
  assert.ok(w.lines().some((line) => line.includes('Command on PATH') && line.includes(EXPECTED_ROW.en)), w.text);
  assert.doesNotMatch(w.text, /Done\. Next/);
});

test('C4: with the link folder already on the PATH of this process, the check adds no note of its own', async (t) => {
  const f = await fixture(t, 'linux');
  f.io.loadAdapter = () => import('../adapters/claude-code/index.js');
  for (const argv of [['install', '--client', CLIENT, '--statusline'], ['install', '--client', CLIENT, '--statusline'], ['update']]) {
    f.clear();
    assert.equal(await main(argv, f.io), 0, f.output.join('\n'));
    assert.ok(!f.output.join('\n').includes(EXPECTED_ROW.en), f.output.join('\n'));
    assert.ok(!f.lines().some((line) => line.includes('Command on PATH')), f.output.join('\n'));
  }
});

// R1: a hook string is run only when it is exactly ours.
const alterHook = (change) => async (moment, f) => {
  if (moment !== 'check') return;
  const file = join(f.io.clientRoot, 'settings.json');
  const settings = JSON.parse(await fs.readFile(file, 'utf8'));
  const hook = settings.hooks.SessionStart[0].hooks[0];
  hook.command = change(hook.command);
  await fs.writeFile(file, JSON.stringify(settings));
};

for (const [name, change] of [
  ['commands appended after ours', (command) => `${command} && touch /tmp/never`],
  ['a command before ours', (command) => `touch /tmp/never; ${command}`],
  ['our script with another subcommand', (command) => command.replace('hook session-start', 'hook post-compact')],
  ['two words before our script', (command) => `'node' '--inspect' ${command.replace(/^'[^']*' /, '')}`],
]) {
  test(`R1: ${name}: the hook is not run and the check says so`, async (t) => {
    const w = await world(t, 'linux', { meddle: alterHook(change) });
    assert.equal(w.code, 0, w.text);
    assert.equal(w.checks.filter(isHook).length, 0, 'a hook that is not exactly ours was run');
    assert.ok(w.lines().some((line) => /Session hook {2}skipped {2}the session hook is not exactly ours/.test(line)), w.text);
    assert.ok(w.checks.some(isBar), 'the status bar should still run');
  });
}

// R7: a hook that names our script, however quoted, is told and not run.
for (const [name, change] of [
  ['our script in double quotes', (command, script) => `node "${script}" hook session-start`],
  ['our script unquoted', (command, script) => `node ${script} hook session-start`],
  ['our script in double quotes after another command', (command, script) => `touch /tmp/never; node "${script}" hook session-start`],
]) {
  test(`R7: ${name}: the hook is not run and the check says so`, async (t) => {
    const w = await world(t, 'linux', { meddle: async (moment, f) => {
      if (moment !== 'check') return;
      const record = await readRecord(f.destination, CLIENT, fs, f.io.config);
      await alterHook((command) => change(command, cliScript(record.path)))(moment, f);
    } });
    assert.equal(w.code, 0, w.text);
    assert.equal(w.checks.filter(isHook).length, 0, 'a hook that names our script in another quoting was run');
    assert.ok(w.lines().some((line) => /Session hook {2}skipped {2}the session hook is not exactly ours/.test(line)), w.text);
  });
}

test('R7: (pt-BR) the skip of a hook with our script in double quotes is in Portuguese', async (t) => {
  const w = await world(t, 'linux', { locale: 'pt-BR', meddle: async (moment, f) => {
    if (moment !== 'check') return;
    const record = await readRecord(f.destination, CLIENT, fs, f.io.config);
    await alterHook(() => `node "${cliScript(record.path)}" hook session-start`)(moment, f);
  } });
  assert.equal(w.code, 0, w.text);
  assert.ok(w.lines().some((line) => /o hook de sessão não é exatamente o nosso/.test(line)), w.text);
});

// R8: the hook is run only when it is equal to the registrar's string, node path included.
for (const [name, node] of [['the shell of a foreign program', '/bin/rm'], ['another node', '/foreign/node']]) {
  test(`R8: ${name} in the node place: the hook is not run and the check says it was registered with another node`, async (t) => {
    const w = await world(t, 'linux', { meddle: alterHook((command) => command.replace(/^'[^']*'/, `'${node}'`)) });
    assert.equal(w.code, 0, w.text);
    assert.equal(w.checks.filter(isHook).length, 0, 'a hook with another node was run');
    assert.ok(w.lines().some((line) => /Session hook {2}skipped {2}the session hook was registered with another node \(install again to refresh it\)/.test(line)), w.text);
    assert.ok(!w.lines().some((line) => line.includes('not exactly ours')), w.text);
  });
}

test('R8: (pt-BR) the skip of a hook registered with another node is in Portuguese', async (t) => {
  const w = await world(t, 'linux', { locale: 'pt-BR', meddle: alterHook((command) => command.replace(/^'[^']*'/, "'/foreign/node'")) });
  assert.equal(w.code, 0, w.text);
  assert.ok(w.lines().some((line) => /o hook de sessão foi registrado com outro node \(instale de novo para atualizá-lo\)/.test(line)), w.text);
  assert.doesNotMatch(blockOf(w.lines(), 'pt-BR').join('\n'), ENGLISH);
});

test('R8: real run, a hook that runs a foreign program in the node place is not executed', { skip: realShell ? false : 'no sh on this machine' }, async (t) => {
  let marker;
  const w = await realWorld(t, { before: async (f) => {
    marker = join(f.home, 'ran-by-the-check');
    const foreign = join(f.home, 'foreign-node');
    await fs.writeFile(foreign, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
    await fs.mkdir(f.io.clientRoot, { recursive: true });
    await fs.writeFile(join(f.io.clientRoot, 'settings.json'), JSON.stringify({ hooks: { SessionStart: [
      { hooks: [{ type: 'command', command: hookCommand(join(f.destination, '1.0.0-claude-code'), foreign) }] }] } }));
  } });
  assert.equal(w.code, 0, w.text);
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' }, 'the check ran a hook with a foreign node');
  assert.match(w.text, /another node/);
});

test('R1: (pt-BR) the skip of a hook that is not ours is in Portuguese', async (t) => {
  const w = await world(t, 'linux', { locale: 'pt-BR', meddle: alterHook((command) => `${command} && touch /tmp/never`) });
  assert.equal(w.code, 0, w.text);
  assert.ok(w.lines().some((line) => /o hook de sessão não é exatamente o nosso/.test(line)), w.text);
  assert.doesNotMatch(blockOf(w.lines(), 'pt-BR').join('\n'), ENGLISH);
});

test('R8: the recognizer is equality with the registrar\'s own string, for the node it writes', async () => {
  const { isOurHook, hookNode } = await import('../src/install/register.js');
  const path = "/opt/o'k/1.0.0-claude-code";
  assert.equal(isOurHook(hookCommand(path), path), true);
  assert.equal(isOurHook(hookCommand(path, hookNode()), path, hookNode()), true);
  const ours = hookCommand(path);
  for (const bad of [`${ours} x`, `${ours}; x`, `x; ${ours}`, ours.replace(/^'[^']*'/, 'node'), ours.replace(/^'[^']*'/, ''),
    ours.replace(/^'[^']*'/, "'a' 'b'"), ours.replace(/^'[^']*'/, "''"), ours.replace(/^'[^']*'/, "'/foreign/node'"),
    ours.replace(/^'[^']*'/, "'/bin/rm'"), ours.replace('session-start', 'x'), hookCommand('/other', 'node'), 7, null]) {
    assert.equal(isOurHook(bad, path), false, String(bad));
  }
});

test('R1: a hook that is exactly ours still runs and passes', async (t) => {
  const w = await world(t, 'linux');
  assert.equal(w.code, 0, w.text);
  assert.equal(w.checks.filter(isHook).length, 1);
  assert.ok(!w.lines().some((line) => line.includes('not exactly ours')), w.text);
});

test('R1: real run, a preserved hook with a command appended is not executed', { skip: realShell ? false : 'no sh on this machine' }, async (t) => {
  let marker;
  const w = await realWorld(t, { before: async (f) => {
    marker = join(f.home, 'ran-by-the-check');
    const script = join(f.destination, '1.0.0-claude-code', 'src/cli.js');
    await fs.mkdir(f.io.clientRoot, { recursive: true });
    await fs.writeFile(join(f.io.clientRoot, 'settings.json'), JSON.stringify({ hooks: { SessionStart: [
      { hooks: [{ type: 'command', command: `${hookCommand(join(f.destination, '1.0.0-claude-code'))} && touch '${marker}'` }] }] } }));
    assert.ok(script);
  } });
  assert.equal(w.code, 0, w.text);
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' }, 'the check ran a hook that is not exactly ours');
  assert.match(w.text, /not exactly ours/);
});

// R2: the temporary configuration is built from an allowlist.
test('R2: the allowlist is in the configuration and is the only thing that decides the keys', async (t) => {
  assert.deepEqual(DEFAULT_CONFIG.install.selfcheck.stateKeys, ['statuslineCollector', 'limits', 'staleMinutes']);
  const f = await fixture(t, 'linux');
  f.io.loadAdapter = () => import('../adapters/claude-code/index.js');
  const stored = JSON.parse(await fs.readFile(join(f.root, 'config.json'), 'utf8'));
  stored.install.selfcheck = { stateKeys: ['language'] };
  Object.assign(stored, { language: 'en', limits: { global: 2, clients: {} }, telemetry: { enabled: true, dir: '/never' } });
  await fs.writeFile(join(f.root, 'config.json'), JSON.stringify(stored));
  const copies = [], run = f.io.run;
  f.io.run = async (spec) => { if (isBar(spec)) copies.push(JSON.parse(await fs.readFile(join(spec.env[HOME_ENV], 'config.json'), 'utf8'))); return run(spec); };
  assert.equal(await main(['install', '--client', CLIENT, '--statusline'], f.io), 0, f.output.join('\n'));
  assert.deepEqual(copies, [{ language: 'en' }]);
});

test('R2: a measurement folder and a quota command of the real configuration never reach the check', { skip: realShell ? false : 'no sh on this machine' }, async (t) => {
  let outside, marker;
  const w = await realWorld(t, { before: async (f) => {
    outside = join(f.home, 'outside-measurements');
    marker = join(f.home, 'quota-command-ran');
    const file = join(f.root, 'config.json');
    const stored = JSON.parse(await fs.readFile(file, 'utf8'));
    stored.telemetry = { enabled: true, dir: outside };
    stored.opencodeQuota = { sources: { demo: { command: [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x')`] } } };
    stored.statuslineCollector = { fields: { rateLimits: 'limits', usedPercentage: 'used', resetsAt: 'reset' } };
    await fs.writeFile(file, JSON.stringify(stored));
  } });
  assert.equal(w.code, 0, w.text);
  // The installer itself measures into the real configuration's folder (its own models table); the hook of the check
  // would add a role.choice event there, which is what must be absent.
  const written = await Promise.all((await fs.readdir(outside).catch(() => [])).map((name) => fs.readFile(join(outside, name), 'utf8')));
  assert.ok(!written.some((text) => text.includes('role.choice')), 'the hook of the check measured into the real configuration');
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' }, 'the check ran a quota command of the real configuration');
  assert.deepEqual(w.readings, [['claude-code.json']], 'the allowed key (the collector fields) did not arrive');
});

// R3: under the check the hook starts nothing.
async function hookWorld(t, { verifying }) {
  const folder = await fs.mkdtemp(join(tmpdir(), 'selfcheck-hook-'));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const probe = join(folder, 'probe'), quota = join(folder, 'quota');
  const fake = join(folder, 'bin');
  await fs.mkdir(fake);
  for (const client of ['claude', 'codex', 'opencode']) {
    await fs.writeFile(join(fake, client), `#!/bin/sh\necho x >> '${probe}'\n`, { mode: 0o755 });
  }
  await fs.mkdir(join(folder, 'root'));
  await fs.writeFile(join(folder, 'root', 'config.json'), JSON.stringify({
    opencodeQuota: { sources: { demo: { command: [process.execPath, '-e', `require('node:fs').appendFileSync(${JSON.stringify(quota)}, 'x')`] } } } }));
  const out = [];
  const code = await runSessionStart({ root: join(folder, 'root'), stdin: JSON.stringify({ cwd: folder, hook_event_name: 'SessionStart' }),
    stdout: (line) => out.push(line), env: { PATH: `${fake}:/usr/bin:/bin`, ...(verifying ? { [SELFCHECK_ENV]: '1' } : {}) } });
  const started = async (file) => fs.stat(file).then(() => true, () => false);
  return { code, out, probe: await started(probe), quota: await started(quota) };
}

test('R3: with the check variable set the hook starts no probe and no quota command, and still answers', { skip: process.platform === 'win32' ? 'no sh' : false }, async (t) => {
  const w = await hookWorld(t, { verifying: true });
  assert.equal(w.code, 0);
  assert.equal(w.probe, false, 'a client probe was started under the check');
  assert.equal(w.quota, false, 'a quota command was started under the check');
  assert.equal(w.out.length, 1);
  assert.doesNotMatch(w.out[0], /unavailable|indisponível/, w.out[0]);
  assert.equal(JSON.parse(w.out[0]).hookSpecificOutput.hookEventName, 'SessionStart');
});

test('R3: without the check variable the hook is as before: it probes the clients and reads the quota commands', { skip: process.platform === 'win32' ? 'no sh' : false }, async (t) => {
  const w = await hookWorld(t, { verifying: false });
  assert.equal(w.code, 0);
  assert.equal(w.probe, true, 'the real hook no longer probes the clients');
  assert.equal(w.quota, true, 'the real hook no longer reads the quota commands');
});

// R4: the new terminal, said once, with --verbose too.
test('R4: with --verbose the new terminal is said exactly once', async (t) => {
  const w = await world(t, 'linux', { env: { PATH: '/usr/bin' }, argv: ['install', '--client', CLIENT, '--statusline', '--verbose'] });
  assert.equal(w.code, 0, w.text);
  assert.equal(countOf(w.text, 'en'), 1, w.text);
});

// R5, R9: the status bar is run only when it is byte-for-byte what the installer's writer produces (its shim, every word
// quoted by `quote`), not when it is called like it.
const setBar = (command) => async (moment, f) => {
  if (moment !== 'check') return;
  const file = join(f.home, '.claude/settings.json');
  const settings = JSON.parse(await fs.readFile(file, 'utf8'));
  settings.statusLine.command = typeof command === 'function' ? command(f, await readRecord(f.destination, CLIENT, fs, f.io.config)) : command;
  await fs.writeFile(file, JSON.stringify(settings));
};
const FOREIGN_BARS = {
  'a node script that is not ours': () => "'node' '/foreign/src/cli.js' 'statusline-collector'",
  'a script of another installation': (f) => `'node' '${join(f.destination, 'other/src/cli.js')}' 'statusline-collector'`,
  'a shim-named executable by an absolute path elsewhere': () => "'/foreign/bin/okit-plugin' 'statusline-collector'",
  'the short name in another folder': (f) => `'${join(f.bin, '..', 'elsewhere', 'okit')}' 'statusline-collector'`,
  'a bare name that is not the command': () => "'okit' 'statusline-collector'",
  // R9: nothing but the writer's own output is run.
  'our own script by node (the installer never writes this form)': (f, record) => `'node' '${cliScript(record.path)}' 'statusline-collector'`,
  'a foreign interpreter with our script': (f, record) => `'/foreign/node' '${cliScript(record.path)}' 'statusline-collector'`,
  'the shim by the absolute path of the link folder on POSIX (the writer writes the bare name)': (f) => `'${join(f.bin, 'okit-plugin')}' 'statusline-collector'`,
  'the shim with a VT character instead of a space': (f) => `'${join(f.bin, 'okit-plugin')}'\vstatusline-collector`,
  'the bare shim with a VT character instead of a space': () => "'okit-plugin'\vstatusline-collector",
  'the shim with double quotes': () => '"okit-plugin" "statusline-collector"',
  'the shim unquoted': () => 'okit-plugin statusline-collector',
  'the shim with one word unquoted': () => "'okit-plugin' statusline-collector",
  'the shim with two spaces': () => "'okit-plugin'  'statusline-collector'",
  // R6: on POSIX a backslash is a character of a name, so these are other files than our script.
  'a script that differs from ours by a backslash, single-quoted': (f, record) => `node '${record.path}\\src/cli.js' statusline-collector`,
  'a script that differs from ours by a backslash, double-quoted': (f, record) => `node "${record.path}\\src/cli.js" statusline-collector`,
};
for (const [name, bar] of Object.entries(FOREIGN_BARS)) {
  test(`R5: ${name}: the status bar is not run and the check says so`, async (t) => {
    const w = await world(t, 'linux', { meddle: setBar(bar) });
    assert.equal(w.code, 0, w.text);
    assert.equal(w.checks.filter(isBar).length, 0, 'a status bar that is not ours was run');
    assert.ok(w.lines().some((line) => /Status bar {2}skipped {2}the status bar is not ours, so it was not run/.test(line)), w.text);
  });
}

test('R6: an unquoted script with a backslash is what the shell makes of it (the backslash is dropped), another file than ours: not run', async (t) => {
  const w = await world(t, 'linux', { meddle: setBar((f, record) => `node ${record.path}\\src/cli.js statusline-collector`) });
  assert.equal(w.code, 0, w.text);
  assert.equal(w.checks.filter(isBar).length, 0, 'a status bar whose unquoted script has a backslash was run');
});

test('R6, R9: on Windows the bar is the installer\'s own absolute shim path, and it runs; the node form with backslashes does not', async (t) => {
  const w = await world(t, 'win32');
  assert.equal(w.code, 0, w.text);
  assert.equal(w.checks.filter(isBar).length, 1, w.text);
  assert.ok(!w.lines().some((line) => line.includes('is not ours')), w.text);
  const x = await world(t, 'win32', { meddle: setBar((f, record) => `node '${cliScript(record.path).replaceAll('/', '\\')}' statusline-collector`) });
  assert.equal(x.checks.filter(isBar).length, 0, x.text);
  assert.ok(x.lines().some((line) => /Status bar {2}skipped {2}the status bar is not ours/.test(line)), x.text);
});

test('R6: the command check compares a backslash on POSIX as a character: a shim path with one is not in the link folder', async (t) => {
  const w = await world(t, 'linux', { resolved: (spec) => `${spec.env.PATH.split(':')[0]}\\okit-plugin\n` });
  assert.equal(w.code, OPERATIONAL, w.text);
});

test('R5: a bare command that the shell finds outside the link folder is not run', async (t) => {
  let calls = 0;
  // The first four resolutions are the command check of the four shells; the fifth is the status bar's own executable.
  const w = await world(t, 'linux', { resolved: (spec) => (++calls > 4 ? '/foreign/bin/okit-plugin\n' : `${spec.env.PATH.split(':')[0]}/okit-plugin\n`) });
  assert.equal(w.code, 0, w.text);
  assert.equal(w.checks.filter(isBar).length, 0, 'a status bar that resolves outside the link folder was run');
  assert.ok(w.lines().some((line) => /Status bar {2}skipped {2}the status bar is not ours/.test(line)), w.text);
});

test('R6: real run, a bar whose script is in a folder named with a backslash is not executed', { skip: realShell ? false : 'no sh on this machine' }, async (t) => {
  let marker;
  const w = await realWorld(t, { before: async (f) => {
    marker = join(f.home, 'ran-by-the-check');
    const ours = join(f.destination, '1.0.0-claude-code');
    // `<ours>\src/cli.js` is a folder named `1.0.0-claude-code\src` beside ours, not our `src`.
    const other = `${ours}\\src`;
    await fs.mkdir(other, { recursive: true });
    await fs.writeFile(join(other, 'cli.js'), `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x')\n`);
    await fs.mkdir(join(f.home, '.claude'), { recursive: true });
    await fs.writeFile(join(f.home, '.claude/settings.json'), JSON.stringify({ statusLine: { type: 'command', command: `node '${other}/cli.js' statusline-collector` } }));
  }, argv: ['install', '--client', CLIENT] });
  assert.equal(w.code, 0, w.text);
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' }, 'the check ran a script that only differs from ours by a backslash');
  assert.match(w.text, /not ours/);
});

test('R5: (pt-BR) the skip of a status bar that is not ours is in Portuguese', async (t) => {
  const w = await world(t, 'linux', { locale: 'pt-BR', meddle: setBar(FOREIGN_BARS['a node script that is not ours']) });
  assert.equal(w.code, 0, w.text);
  assert.ok(w.lines().some((line) => /a barra de status não é nossa/.test(line)), w.text);
});

for (const [name, bar] of Object.entries({
  'its shim by the bare command, as the writer writes it': () => "'okit-plugin' 'statusline-collector'",
  'its shim chained with --previous, as the writer writes it': () => "'okit-plugin' 'statusline-collector' '--previous' 'echo' 'it'\\''s'",
})) {
  test(`R5, R9: ${name}: the status bar is run and passes`, async (t) => {
    const w = await world(t, 'linux', { meddle: setBar(bar) });
    assert.equal(w.code, 0, w.text);
    assert.equal(w.checks.filter(isBar).length, 1, w.text);
    assert.ok(!w.lines().some((line) => line.includes('is not ours')), w.text);
  });
}

test('R9: the bar the installer itself writes is run', async (t) => {
  const w = await world(t, 'linux');
  assert.equal(w.checks.filter(isBar).length, 1, w.text);
  assert.ok(!w.lines().some((line) => line.includes('is not ours')), w.text);
  const record = await readRecord(w.destination, CLIENT, fs, w.io.config);
  const written = JSON.parse(await fs.readFile(join(w.home, '.claude/settings.json'), 'utf8')).statusLine.command;
  assert.equal(written, "'okit-plugin' 'statusline-collector'", record.path);
});

test('R9: real run, a bar with a VT between the shim and the subcommand is not executed (the shell reads one word)', { skip: realShell ? false : 'no sh on this machine' }, async (t) => {
  let marker;
  const w = await realWorld(t, { before: async (f) => {
    marker = join(f.home, 'ran-by-the-check');
    // `commandWords` reads the VT as a space; the shell reads `okit-plugin<VT>statusline-collector` as one name, found in the PATH.
    await fs.mkdir(f.bin, { recursive: true });
    await fs.writeFile(join(f.bin, 'okit-plugin\vstatusline-collector'), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
    await fs.mkdir(join(f.home, '.claude'), { recursive: true });
    await fs.writeFile(join(f.home, '.claude/settings.json'), JSON.stringify({ statusLine: { type: 'command', command: 'okit-plugin\vstatusline-collector' } }));
  }, argv: ['install', '--client', CLIENT] });
  assert.equal(w.code, 0, w.text);
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' }, 'the check ran the file the VT-joined name resolves to');
  assert.match(w.text, /not ours/);
});

test('R5: real run, a preserved bar that is a foreign script called like ours is not executed', { skip: realShell ? false : 'no sh on this machine' }, async (t) => {
  let marker;
  const w = await realWorld(t, { before: async (f) => {
    marker = join(f.home, 'ran-by-the-check');
    const foreign = join(f.home, 'foreign');
    await fs.mkdir(join(foreign, 'src'), { recursive: true });
    await fs.mkdir(join(foreign, 'bin'), { recursive: true });
    await fs.writeFile(join(foreign, 'src/cli.js'), `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x')\n`);
    await fs.writeFile(join(foreign, 'bin/okit-plugin'), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
    await fs.mkdir(join(f.home, '.claude'), { recursive: true });
    await fs.writeFile(join(f.home, '.claude/settings.json'), JSON.stringify({ statusLine: { type: 'command', command: `'node' '${join(foreign, 'src/cli.js')}' 'statusline-collector'` } }));
  }, argv: ['install', '--client', CLIENT] });
  assert.equal(w.code, 0, w.text);
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' }, 'the check ran a status bar that is not this installation\'s');
  assert.match(w.text, /not ours/);
});

// R10: a bare shim name is attested only by a shim of ours; installed with --no-link there is none, so the bar is not run.
test('R10: installed with --no-link, the bare bar is not run and the skip says why (en and pt-BR)', async (t) => {
  const w = await world(t, 'linux', { argv: ['install', '--client', CLIENT, '--statusline', '--no-link'] });
  assert.equal(w.code, 0, w.text);
  assert.equal(w.checks.filter(isBar).length, 0, 'a bare status bar was run although no shim of ours exists');
  assert.ok(w.lines().some((line) => /Status bar {2}skipped {2}installed without a link, so the check cannot tell which command the status bar names; it was not run/.test(line)), w.text);
  assert.ok(!w.lines().some((line) => line.includes('is not ours')), w.text);
  const x = await world(t, 'linux', { locale: 'pt-BR', argv: ['install', '--client', CLIENT, '--statusline', '--no-link'] });
  assert.ok(x.lines().some((line) => /instalado sem link, então a verificação não sabe qual comando a barra de status nomeia/.test(line)), x.text);
});

// R11: the guard holds for the absolute form too (what Windows writes): a file at <bin>/<command> is not ours without a link.
test('R11: on win32 installed with --no-link, the absolute bar is not run and the skip says why (en and pt-BR)', async (t) => {
  const w = await world(t, 'win32', { argv: ['install', '--client', CLIENT, '--statusline', '--no-link'],
    meddle: async (moment, f) => { if (moment !== 'register') return;
      await fs.mkdir(f.bin, { recursive: true });
      await fs.writeFile(join(f.bin, 'okit-plugin.cmd'), 'foreign');
    } });
  assert.equal(w.code, 0, w.text);
  const written = JSON.parse(await fs.readFile(join(w.home, '.claude/settings.json'), 'utf8')).statusLine.command;
  assert.match(written, /[\\/]/, `the writer no longer writes an absolute bar: ${written}`);
  assert.equal(w.checks.filter(isBar).length, 0, 'an absolute bar in the link folder was run although no shim of ours exists');
  assert.ok(w.lines().some((line) => /Status bar {2}skipped {2}installed without a link, so the check cannot tell which command the status bar names; it was not run/.test(line)), w.text);
  const x = await world(t, 'win32', { locale: 'pt-BR', argv: ['install', '--client', CLIENT, '--statusline', '--no-link'] });
  assert.equal(x.checks.filter(isBar).length, 0, x.text);
  assert.ok(x.lines().some((line) => /instalado sem link, então a verificação não sabe qual comando a barra de status nomeia/.test(line)), x.text);
});

test('R10: real run, installed with --no-link, a file at <bin>/<command> is not executed as the bar', { skip: realShell ? false : 'no sh on this machine' }, async (t) => {
  let marker;
  const w = await realWorld(t, { before: async (f) => {
    marker = join(f.home, 'ran-by-the-check');
    await fs.mkdir(f.bin, { recursive: true });
    await fs.writeFile(join(f.bin, 'okit-plugin'), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
  }, argv: ['install', '--client', CLIENT, '--statusline', '--no-link'] });
  assert.equal(w.code, 0, w.text);
  const written = JSON.parse(await fs.readFile(join(w.f.home, '.claude/settings.json'), 'utf8')).statusLine.command;
  assert.equal(written, "'okit-plugin' 'statusline-collector'", 'the writer no longer writes the bare bar');
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' }, 'the check ran a file of the link folder that is not our shim');
  assert.match(w.text, /installed without a link/);
});
