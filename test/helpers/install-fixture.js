import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { tarGz, zip } from '../../src/release/archive.js';
import { installConfig } from '../../src/install/config.js';
import { HOME_ENV, paths } from '../../src/store.js';
import { READING_FILE } from '../../src/quota/statusline-collector.js';

// The installer's world in a temporary folder: a fake release, the clients' executables found or not, and the
// output collected line by line. Shared by the installer's tests; each one keeps its own expectations.

export const SYSTEM = { linux: 'linux', darwin: 'macos', win32: 'windows' };
export const FORMAT = { linux: 'tar.gz', darwin: 'tar.gz', win32: 'zip' };
/**
 * The fake world of the post-install check: a status bar string run with a temporary state root (OKWORK_HOME) leaves its
 * reading there, as the real collector does. A fake `run` calls this with the command object it was given.
 */
export async function collectReading({ env, args = [] }) {
  const folder = env?.[HOME_ENV];
  if (!folder || !args.some((item) => String(item).includes('statusline-collector'))) return;
  await fs.mkdir(paths(folder).quota, { recursive: true });
  await fs.writeFile(join(paths(folder).quota, READING_FILE), '{}');
}

export async function fixture(t, platform = 'linux', { tty = false, ask, read } = {}) {
  const home = await fs.mkdtemp(join(tmpdir(), 'installer-output-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const root = join(home, 'state'), destination = join(home, 'data'), bin = join(home, 'bin'), scratch = join(home, 'scratch');
  await fs.mkdir(root);
  await fs.mkdir(scratch);
  const config = installConfig({ repository: 'example/project', api: 'https://fake.invalid', destination, linkDirectory: bin });
  await fs.writeFile(join(root, 'config.json'), JSON.stringify({ install: config }));
  const output = [], commands = [];
  let version = '1.0.0';
  const pkg = { name: 'sample', version, bin: { 'okit-plugin': 'src/cli.js' }, repository: { url: 'https://example.invalid/example/project' } };
  const pack = platform === 'win32' ? zip : tarGz;
  const payload = () => pack([
    { path: 'package.json', mode: 0o644, data: JSON.stringify({ ...pkg, version }) },
    { path: 'src/cli.js', mode: 0o755, data: '#!/usr/bin/env node\n' },
    { path: 'skills/example/SKILL.md', mode: 0o644, data: 'fake skill' },
  ]);
  const clients = Object.keys(config.clients);
  const name = (client) => `sample-${version}-${client}-${SYSTEM[platform]}-x64.${FORMAT[platform]}`;
  const selected = () => ({ tag_name: `v${version}`, prerelease: false, published_at: '2026-10-24', assets: [
    ...clients.map((client) => ({ name: name(client), browser_download_url: `https://fake.invalid/package/${client}` })),
    { name: `sample-${version}-checksums.sha256`, browser_download_url: 'https://fake.invalid/manifest' },
  ] });
  const fetch = async (url) => {
    if (url.endsWith('/latest')) return Response.json(selected());
    if (url.endsWith('/releases')) return Response.json([selected()]);
    if (url.includes('/package/')) return new Response(payload());
    if (url.endsWith('/manifest')) return new Response(clients.map((client) => `${createHash('sha256').update(payload()).digest('hex')}  ${name(client)}\n`).join(''));
    throw new Error(`Unexpected request ${url}`);
  };
  const out = (line) => output.push(line);
  const io = { home, root, destination, bin, config, fs, fetch, platform, now: () => 1700000000000,
    env: { HOME: home, PATH: platform === 'win32' ? '' : bin },
    pkg, arch: 'x64', tmpdir: scratch, tty, ask, read, outTty: false, clientRoot: join(home, 'client'),
    stdout: out, stderr: out, out, adapters: [], readQuota: async () => ({ source: 'off' }),
    detect: async () => true, run: async (command) => { commands.push(command); await collectReading(command); return {}; },
    pathExecute: async () => ({ stdout: 'true\n' }),
    policyExecute: async () => ({ stdout: 'LocalMachine=RemoteSigned\n' }),
    stopDaemon: async () => true, startDaemon: async () => {}, autostart: async () => {}, smoke: async () => ({ code: 0 }) };
  // Goldens normalize folders and padding; assertStatusColumns checks raw padding.
  const lines = () => output.map((line) => line.replaceAll(destination, '<data>').replaceAll(bin, '<bin>').replaceAll(scratch, '<scratch>')
    .replaceAll(home, '<home>').replace(/ {2,}/g, '  ').trimEnd());
  return { home, root, destination, bin, scratch, io, output, commands, lines, name,
    setVersion: (value) => { version = value; }, clear: () => { output.length = 0; } };
}
