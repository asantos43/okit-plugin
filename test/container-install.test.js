import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DISTROS, USER, buildImage, exec, startContainer, startReleaseServer, stop, unavailable } from './helpers/containers.js';

// The install, proved in real Linux containers: the REAL release archive (built by scripts/build-release.js, served by a
// fake release host on the machine) installed by the REAL install.sh as a normal user, and then the command and the status
// bar string run in non-interactive shells. It is OPT-IN, so the default `node --test` stays offline, fast and green:
//
//   OKIT_CONTAINERS=1 node --test test/container-install.test.js
//
// It needs podman and the network (the first run pulls the base images and builds three small ones, `okit-check-debian`,
// `okit-check-fedora`, `okit-check-alpine`: allow up to 15 minutes; the next runs use the cached layers). The images are
// kept; the containers are removed at the end of each case. Without the variable, or without podman, or off x64 Linux,
// every test is skipped with the reason.
//
// | case | must pass | must refuse |
// | install.sh on debian (bash, dash as sh, zsh, fish), fedora (bash, sh=bash, zsh, fish), alpine (busybox sh, no bash) | exit 0, the self-check passed, nothing failed | a failed row, a non-zero exit |
// | a fresh non-interactive LOGIN launch of the shell that installed (`bash -lc`, `sh -lc`, `zsh -lc`, `fish -lc`) | `okit-plugin` found through the managed PATH block and it is the installed version | a command that is not found, another version |
// | the exact `statusLine.command` of ~/.claude/settings.json under `sh -c` with a bare environment and the login PATH | exit 0 and a quota reading written | a string the real shell cannot run |
// | OKIT_MIN_NODE=99 | exit 2, a plain message, nothing written in the home | a half install |
// | a shell of the machine that cannot run the self-check (a broken zsh) | exit non-zero, "installed but not working", a Fix line, the installation left in place | a success |
// | a profile of the person that exits before the PATH block (`~/.profile` starting with `exit 0`) | exit non-zero, "a new sh terminal will not find okit-plugin", a Fix line naming the profile, the installation left in place | a success because the plain launch finds the command |
// | a command of the same name in the link folder that is not ours | exit non-zero, the plain message, the foreign file untouched | an overwrite |
//
// What it cannot prove: macOS, Windows, arm64 (the asset is x64; the six pairs of the asset choice are in
// test/install-entrypoints.test.js), a distro other than these three, an interactive terminal, the real Claude Code.

const reason = unavailable();
const home = `/home/${USER}`;
// The shell is the one the person logs in with: install.sh reads $SHELL to choose the profile that gets the PATH block.
const PATHS = { sh: '/bin/sh', bash: '/bin/bash', zsh: '/usr/bin/zsh', fish: '/usr/bin/fish' };
// The command that prints where the shell finds the command, the real path behind it, and the exit of a run of it.
const LOOKUP = {
  fish: 'command -v okit-plugin; readlink -f (command -v okit-plugin); okit-plugin status >/dev/null; echo "exit=$status"',
  posix: 'command -v okit-plugin; readlink -f "$(command -v okit-plugin)"; okit-plugin status >/dev/null; echo "exit=$?"',
};
// `exec` returns code -1 and a stderr ending in `timed out` when its time ran out: a refusal must be a real exit.
const timedOut = (result) => result.stderr.endsWith('timed out');
// The `version` of the package.json beside the cli.js the login shell resolved (two folders up from src/cli.js).
const RESOLVED_VERSION = {
  fish: 'set d (dirname (dirname (readlink -f (command -v okit-plugin)))); node -p "require(\'$d/package.json\').version"',
  posix: 'd="$(dirname "$(dirname "$(readlink -f "$(command -v okit-plugin)")")")"; node -p "require(\'$d/package.json\').version"',
};
const resolvedVersion = (shell) => RESOLVED_VERSION[shell === 'fish' ? 'fish' : 'posix'];
const lookup = (shell) => LOOKUP[shell === 'fish' ? 'fish' : 'posix'];
const loginPath = (shell) => (shell === 'fish' ? 'string join : $PATH' : 'printf %s "$PATH"');

let server;
describe('install in containers', { skip: reason ?? false, timeout: 3600000 }, () => {
  before(async () => { server = await startReleaseServer(); });
  after(() => server?.close());

  for (const [distro, { shells }] of Object.entries(DISTROS)) {
    describe(distro, { timeout: 1800000 }, () => {
      before(() => buildImage(distro), { timeout: 900000 });

      async function fresh(t) {
        const container = startContainer(distro, server);
        t.after(() => stop(container.name));
        await container.started;
        return container.name;
      }

      if (distro === 'alpine') {
        test('the image has no bash: busybox sh is the only shell', { timeout: 120000 }, async (t) => {
          const id = await fresh(t);
          assert.ok((await exec(id, ['sh', '-c', 'command -v bash'])).code > 0, 'bash exists in the alpine image');
        });
      }

      for (const [shell, label] of shells) {
        test(`${distro}: ${label} installs, finds the command at login and runs the status bar`, { timeout: 120000 }, async (t) => {
          const id = await fresh(t);
          const login = (script) => exec(id, [shell, '-lc', script]);
          const installed = `${home}/.local/share/okit-plugin/${server.version}-claude-code`;

          // Before the install the shell finds nothing: the image does not carry the command by itself.
          assert.ok((await login('command -v okit-plugin')).code > 0, 'the image already has okit-plugin');

          // a. install.sh, as the person would run it, in the shell that is theirs.
          const run = await exec(id, ['sh', '/install.sh', '--client', 'claude-code'], { env: { SHELL: PATHS[shell] } });
          assert.equal(run.code, 0, `install.sh exited ${run.code}\n${run.stdout}${run.stderr}`);
          assert.match(run.stdout, /Self-check \(Claude Code\)\s+ok\s+\d+ checks passed/, run.stdout);
          assert.doesNotMatch(run.stdout + run.stderr, /\bfailed\b|installed but not working/i, run.stdout + run.stderr);
          assert.match(run.stdout, /^Done\./m, run.stdout);

          // b. A fresh non-interactive login launch finds the command through the PATH block, and it is this version.
          const found = await login(lookup(shell));
          assert.equal(found.code, 0, `${shell} -lc exited ${found.code}\n${found.stdout}${found.stderr}`);
          const lines = found.stdout.trim().split('\n');
          assert.deepEqual(lines, [`${home}/.local/bin/okit-plugin`, `${installed}/src/cli.js`, 'exit=0'], `${shell} -lc:\n${found.stdout}${found.stderr}`);

          // The folder name is the installer's own naming: the package.json the shell resolved says what runs.
          const running = await login(resolvedVersion(shell));
          assert.equal(running.code, 0, `${shell} -lc could not read the version\n${running.stdout}${running.stderr}`);
          assert.equal(running.stdout.trim(), server.version, `${shell} -lc runs another version:\n${running.stdout}${running.stderr}`);

          // c. Quota recording is not offered by the downloaded script: the installed command writes the status bar.
          const bar = await login(`okit-plugin install --client claude-code --statusline --from ${installed}`);
          assert.equal(bar.code, 0, `${bar.stdout}${bar.stderr}`);
          assert.match(bar.stdout, /Quota recording\s+ok\s+\S+settings\.json/, bar.stdout);
          const written = await exec(id, ['cat', `${home}/.claude/settings.json`]);
          assert.equal(written.code, 0, `settings.json was not read\n${written.stderr}`);
          const settings = JSON.parse(written.stdout);
          assert.equal(settings.statusLine?.type, 'command');
          const command = settings.statusLine.command;
          assert.equal(typeof command, 'string');
          const loginEnv = await login(loginPath(shell));
          assert.equal(loginEnv.code, 0, `the login PATH was not read\n${loginEnv.stderr}`);
          const path = loginEnv.stdout.trim();
          assert.ok(path.split(':').includes(`${home}/.local/bin`), `the login PATH lacks the link folder: ${path}`);
          const state = '/tmp/okit-state';
          const resets = Math.floor(Date.now() / 1000) + 3600;
          const input = JSON.stringify({ rate_limits: { five_hour: { used_percentage: 10, resets_at: resets }, seven_day: { used_percentage: 20, resets_at: resets } } });
          const ran = await exec(id, ['env', '-i', `HOME=${home}`, `PATH=${path}`, `OKWORK_HOME=${state}`, 'sh', '-c', command], { input });
          assert.equal(ran.code, 0, `sh -c ${command}\n${ran.stdout}${ran.stderr}`);
          const reading = await exec(id, ['sh', '-c', `cat ${state}/quota/claude-code.json`]);
          assert.equal(reading.code, 0, `the collector wrote no reading under ${state}\n${reading.stderr}`);
          assert.equal(JSON.parse(reading.stdout).remainingPct, 80);
        });
      }

      test(`${distro}: OKIT_MIN_NODE=99 refuses with exit 2 and writes nothing`, { timeout: 120000 }, async (t) => {
        const id = await fresh(t);
        const run = await exec(id, ['sh', '/install.sh', '--client', 'claude-code'], { env: { OKIT_MIN_NODE: '99', SHELL: PATHS.sh } });
        assert.equal(run.code, 2, `${run.stdout}${run.stderr}`);
        assert.match(run.stderr, /Node >=99 required/);
        const listing = await exec(id, ['sh', '-c', `ls -A ${home}`]);
        assert.equal(listing.code, 0, `ls failed\n${listing.stderr}`);
        assert.equal(listing.stdout.trim(), '', 'the home folder is not empty');
      });

      test(`${distro}: a shell that cannot run the check fails the run with the fix, and the install stays`, { timeout: 120000 }, async (t) => {
        const id = await fresh(t);
        // The self-check starts every shell of the machine; a zsh that exits 9 is a real failure it must report (a shim
        // ahead of the real one, or in place of it on alpine, which has no zsh).
        const shim = await exec(id, ['sh', '-c', "printf '#!/bin/sh\\nexit 9\\n' > /usr/local/bin/zsh && chmod 755 /usr/local/bin/zsh"], { user: 'root' });
        assert.equal(shim.code, 0, `the zsh shim was not written\n${shim.stderr}`);
        const run = await exec(id, ['sh', '/install.sh', '--client', 'claude-code'], { env: { SHELL: PATHS.sh } });
        const text = run.stdout + run.stderr;
        assert.ok(run.code > 0, `the install did not fail with a real exit code (${run.code})\n${text}`);
        assert.ok(!timedOut(run), `the install hung\n${text}`);
        assert.match(text, /installed but not working: 1 of \d+ checks failed/, text);
        assert.match(text, /zsh does not find okit-plugin \(exit code 9\)/, text);
        assert.match(text, /Fix: /, text);
        assert.equal((await exec(id, ['sh', '-c', `test -L ${home}/.local/bin/okit-plugin`])).code, 0, 'the installation was not left in place');
      });

      test(`${distro}: a profile that exits before the PATH block fails the run with the fix (a login launch finds nothing)`, { timeout: 120000 }, async (t) => {
        const id = await fresh(t);
        // The person's own ~/.profile stops early; install.sh appends its PATH block after it, where no login shell gets to.
        const profile = await exec(id, ['sh', '-c', `printf '# the person: stop early\\nexit 0\\n' > ${home}/.profile`]);
        assert.equal(profile.code, 0, `the profile was not written\n${profile.stderr}`);
        const run = await exec(id, ['sh', '/install.sh', '--client', 'claude-code'], { env: { SHELL: PATHS.sh } });
        const text = run.stdout + run.stderr;
        assert.ok(run.code > 0, `the install did not fail with a real exit code (${run.code})\n${text}`);
        assert.ok(!timedOut(run), `the install hung\n${text}`);
        // The login launch is made for the shell of the person only (here `sh`), and it fails the same way.
        assert.match(text, /installed but not working: \d+ of \d+ checks failed/, text);
        assert.match(text, /a new sh terminal will not find okit-plugin/, text);
        assert.match(text, new RegExp(`Fix: In ${home}/\\.profile, put this line before anything that exits or fails`), text);
        assert.equal((await exec(id, ['sh', '-c', `test -L ${home}/.local/bin/okit-plugin`])).code, 0, 'the installation was not left in place');
      });

      test(`${distro}: a command of the same name that is not ours is left alone and the run fails in plain words`, { timeout: 120000 }, async (t) => {
        const id = await fresh(t);
        const planted = await exec(id, ['sh', '-c', `mkdir -p ${home}/.local/bin && printf '#!/bin/sh\\necho foreign\\n' > ${home}/.local/bin/okit-plugin && chmod 755 ${home}/.local/bin/okit-plugin`]);
        assert.equal(planted.code, 0, `the foreign command was not planted\n${planted.stderr}`);
        const run = await exec(id, ['sh', '/install.sh', '--client', 'claude-code'], { env: { SHELL: PATHS.sh } });
        assert.ok(run.code > 0, `the install did not fail with a real exit code (${run.code})\n${run.stdout}${run.stderr}`);
        assert.ok(!timedOut(run), `the install hung\n${run.stdout}${run.stderr}`);
        assert.match(run.stderr, /is not the plugin command\. Rename or remove it/, run.stderr);
        const still = await exec(id, [`${home}/.local/bin/okit-plugin`]);
        assert.equal(still.code, 0, `the foreign command did not run\n${still.stderr}`);
        assert.equal(still.stdout.trim(), 'foreign', 'the foreign command was overwritten');
      });
    });
  }
});
