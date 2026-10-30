// Helpers of the container install check (test/container-install.test.js): the images, the fake release server that
// serves the REAL archive built by the release code, and the calls to podman. Nothing here runs unless the test asks.

import { execFile, spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
export const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
export const USER = 'tester';
export const SKIP_REASON = 'set OKIT_CONTAINERS=1; needs podman and network to pull images';

/** Why the check cannot run here, or null when it can (the variable, podman, and an x64 Linux host: the asset is x64). */
export function unavailable() {
  if (process.env.OKIT_CONTAINERS !== '1') return SKIP_REASON;
  const podman = spawnSync('podman', ['--version'], { encoding: 'utf8', timeout: 20000 });
  if (podman.status !== 0) return `podman does not work (${podman.error?.message ?? podman.stderr.trim()}); ${SKIP_REASON}`;
  if (process.platform !== 'linux' || process.arch !== 'x64') return `the release asset under test is linux x64; this host is ${process.platform} ${process.arch}`;
  return null;
}

// The user has an EMPTY skeleton (`-k /dev/null`): the distros' default profiles add ~/.local/bin to the PATH by
// themselves, which would hide a missing PATH block of the installer. `claude` is a fake executable so the client is detected.
const USER_LINES = {
  debian: `useradd -m -k /dev/null -s /bin/bash ${USER}`,
  fedora: `useradd -m -k /dev/null -s /bin/bash ${USER}`,
  alpine: `adduser -D -s /bin/sh ${USER}`,
};
const FAKE = "printf '#!/bin/sh\\nexit 0\\n' > /usr/local/bin/claude && chmod 755 /usr/local/bin/claude";

export const DISTROS = {
  debian: {
    shells: [['bash', 'bash'], ['sh', 'sh'], ['zsh', 'zsh'], ['fish', 'fish']],
    file: ['FROM docker.io/library/node:22-bookworm-slim',
      'RUN apt-get update && apt-get install -y --no-install-recommends bash zsh fish curl ca-certificates && rm -rf /var/lib/apt/lists/*'],
  },
  fedora: {
    shells: [['bash', 'bash'], ['sh', 'sh'], ['zsh', 'zsh'], ['fish', 'fish']],
    file: ['FROM docker.io/library/fedora:latest', 'RUN dnf install -y nodejs zsh fish && dnf clean all'],
  },
  alpine: {
    shells: [['sh', 'sh']],
    file: ['FROM docker.io/library/node:22-alpine'],
  },
};

const containerfile = (name) => [...DISTROS[name].file, `RUN ${USER_LINES[name]} && ${FAKE}`, ''].join('\n');
export const imageTag = (name) => `okit-check-${name}`;

/** Builds the image from the Containerfile text above (cached layers make a second call quick); a failure carries podman's words. */
export function buildImage(name) {
  const context = mkdtempSync(join(tmpdir(), 'okit-context-'));   // holds only the Containerfile: nothing else is sent to the build
  writeFileSync(join(context, 'Containerfile'), containerfile(name));
  const result = spawnSync('podman', ['build', '--quiet', '-t', imageTag(name), context],
    { encoding: 'utf8', timeout: 900000, maxBuffer: 1 << 24 });
  rmSync(context, { recursive: true, force: true });
  if (result.status !== 0) throw new Error(`podman build ${name} failed (${result.status}): ${result.stderr}${result.error?.message ?? ''}`);
}

/**
 * Builds the real release for claude-code on linux x64 with the release code (scripts/build-release.js), and serves it
 * the way GitHub does: `/latest` with the real asset names, the archive, the checksum manifest.
 *
 * @returns {Promise<{base: string, version: string, name: string, close: () => Promise<void>}>}
 */
export async function startReleaseServer() {
  const folder = await mkdtemp(join(tmpdir(), 'okit-container-'));
  const { main } = await import(new URL('../../scripts/build-release.js', import.meta.url));
  const errors = [];
  const code = await main(['--out', join(folder, 'out'), '--pair', 'claude-code:linux', '--arch', 'x64'],
    { env: { ...process.env, OKWORK_HOME: join(folder, 'state') }, stdout() {}, stderr: (line) => errors.push(line) });
  if (code !== 0) throw new Error(`the release build failed: ${errors.join('; ')}`);
  const files = await readdir(join(folder, 'out'));
  const name = files.find((file) => file.endsWith('-claude-code-linux-x64.tar.gz'));
  const manifestName = files.find((file) => file.endsWith('-checksums.sha256'));
  const version = name.match(/-(\d+\.\d+\.\d+[^-]*)-claude-code/)[1];
  const [archive, manifest] = await Promise.all([readFile(join(folder, 'out', name)), readFile(join(folder, 'out', manifestName))]);
  let base = '';
  const release = () => JSON.stringify({ tag_name: `v${version}`, prerelease: false, published_at: '2026-01-01', assets: [
    { name, browser_download_url: `${base}/package` }, { name: manifestName, browser_download_url: `${base}/manifest` }] });
  const server = createServer((req, res) => {
    if (req.url.endsWith('/latest')) res.end(release());
    else if (req.url.endsWith('/releases')) res.end(`[${release()}]`);
    else if (req.url === '/package') res.end(archive);
    else if (req.url === '/manifest') res.end(manifest);
    else { res.statusCode = 404; res.end(); }
  });
  await new Promise((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', done); });
  base = `http://127.0.0.1:${server.address().port}`;
  return { base, version, name, close: async () => {
    await new Promise((done) => { server.close(done); server.closeAllConnections(); });
    await rm(folder, { recursive: true, force: true });
  } };
}

/**
 * Starts a container of the image (host network, the install script mounted read-only, the release server's address) that
 * sleeps for a while; the test runs commands in it with `exec` and removes it with `stop`. `--rm` and the sleep bound it.
 */
export async function startContainer(name, server) {
  const { stdout } = await run('podman', ['run', '-d', '--rm', '--network=host', '--security-opt', 'label=disable',
    '-v', `${join(ROOT, 'install.sh')}:/install.sh:ro`, '--user', USER,
    '-e', `OKIT_API=${server.base}`, '-e', 'OKIT_REPO=fake/repo', imageTag(name), 'sleep', '900'], { timeout: 60000 });
  return stdout.trim();
}

/**
 * Runs a command in the container (as the test user), with `input` on its standard input when given. Never throws on a
 * non-zero exit or a timeout: returns `{code, stdout, stderr}` (code -1 for a timeout).
 */
export function exec(id, argv, { env = {}, input, user = USER, timeout = 90000 } = {}) {
  const flags = Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`]);
  return new Promise((done) => {
    const child = spawn('podman', ['exec', ...(input === undefined ? [] : ['-i']), '--user', user, ...flags, id, ...argv], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', late = false;
    const timer = setTimeout(() => { late = true; child.kill('SIGKILL'); }, timeout);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => { clearTimeout(timer); done({ code: -1, stdout, stderr: `${stderr}${error.message}` }); });
    child.on('close', (code) => { clearTimeout(timer); done({ code: late ? -1 : code ?? -1, stdout, stderr: late ? `${stderr}timed out` : stderr }); });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

export async function stop(id) {
  await run('podman', ['rm', '-f', '-t', '0', id], { timeout: 60000 }).catch(() => {});
}
