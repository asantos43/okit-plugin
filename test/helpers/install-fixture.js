import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { tarGz, zip } from '../../src/release/archive.js';
import { installConfig } from '../../src/install/config.js';
import { HOME_ENV, paths } from '../../src/store.js';
import { STATUSLINE_FILE } from '../../src/quota/statusline-collector.js';

// The installer's world in a temporary folder: a fake release, the clients' executables found or not, and the
// output collected line by line. Shared by the installer's tests; each one keeps its own expectations.

export const SYSTEM = { linux: 'linux', darwin: 'macos', win32: 'windows' };
export const FORMAT = { linux: 'tar.gz', darwin: 'tar.gz', win32: 'zip' };
/**
 * The fake world of the post-install check: a status bar string run with a temporary state root (OKWORK_HOME) leaves its
 * reading there, as the real collector does, and a shell asked for the command prints the first folder of its PATH. A fake
 * `run` returns this with the command object it was given.
 */
export async function answerCheck({ command = '', env, args = [] }, { bin } = {}) {
  const folder = env?.[HOME_ENV];
  const text = args.map(String);
  if (folder && text.some((item) => item.includes('statusline-collector'))) {
    await fs.mkdir(paths(folder).quota, { recursive: true });
    await fs.writeFile(join(paths(folder).quota, STATUSLINE_FILE), '{}');
    return {};
  }
  // A shell asked where the command is says the first folder of the PATH it was given (the way a real shell finds it).
  if (/command -v|Get-Command/.test(text.at(-1) ?? '') || text.at(-2) === 'where') {
    const windows = command.toLowerCase().endsWith('.exe');
    // A login launch gets a PATH without the link folder: the fake profile puts it back (by default `<HOME>/bin`, the fixtures' own).
    const login = ['-lc', '-l'].includes(text[0]);
    const first = login ? (bin ?? join(env?.HOME ?? '', 'bin'))
      : String(env?.[Object.keys(env ?? {}).find((name) => name.toLowerCase() === 'path')] ?? '').split(windows ? ';' : ':')[0];
    // The name the shell was asked about is the name it resolves (the command may be renamed in the configuration).
    const asked = text.at(-1) ?? '';
    const name = asked.match(/'([^']+)'/)?.[1] ?? asked.split(/\s+/).at(-1) ?? '';
    return { stdout: `${first}${windows ? '\\' : '/'}${name}${text.at(-2) === 'where' || text.at(-1).includes('Get-Command') ? '.cmd' : ''}\n` };
  }
  return {};
}

/**
 * The name of the entry in the words of the client's own command: the first word that is not a flag and not the
 * value of one (`mcp add --scope user okit -- node server.js` and `mcp remove okit --scope user` both name `okit`).
 */
function mcpNameOf(args) {
  const words = args.slice(2);
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    if (word === '--') break;
    if (word.startsWith('-')) { index += 1; continue; }
    return word;
  }
  return undefined;
}

/**
 * The entry a client holds, as the client prints it: the fields of the server are indented two spaces, and each client
 * prints its own names (`Scope`, `Type` and `Args` for Claude Code, `transport` and `args` for Codex).
 */
const printedEntry = (executable, name, entry) => (/codex/i.test(executable)
  ? `${name}\n  enabled: true\n  transport: stdio\n  command: ${entry.command}\n  args: ${entry.args.join(' ')}\n`
  : `${name}:\n  Scope: User config (available in all your projects)\n  Type: stdio\n  Command: ${entry.command}\n  Args: ${entry.args.join(' ')}\n`);

/**
 * The MCP registry of a client, as the fake world of the tests: the entry of each client and the file it points at.
 * The client's own `mcp get`, `mcp add` and `mcp remove` commands are answered as the real clients answer them: the
 * read of an entry that is not there fails, the read of one that is there prints the command and its arguments.
 */
export function mcpWorld() {
  const registries = new Map();
  const registryOf = (executable) => {
    if (!registries.has(executable)) registries.set(executable, new Map());
    return registries.get(executable);
  };
  return {
    /** Whether the command is one of the MCP commands of a client. */
    handles: ({ args = [] }) => args[0] === 'mcp',
    /** The entry a client holds, as the client prints it. */
    async run({ command: executable, args = [] }) {
      const verb = args[1];
      const name = mcpNameOf(args);
      const registry = registryOf(executable);
      if (verb === 'get') {
        const entry = registry.get(name);
        // The real clients answer that they hold no entry with this name, print it and exit with 1.
        if (!entry) throw Object.assign(new Error(`Command failed: ${executable} mcp get ${name}`), { code: 1,
          stdout: `No MCP server named "${name}" found.\n`, stderr: '' });
        return { stdout: printedEntry(executable, name, entry) };
      }
      if (verb === 'add') {
        const at = args.indexOf('--');
        const [command, ...rest] = args.slice(at + 1);
        registry.set(name, { command, args: rest });
        return {};
      }
      if (verb === 'remove') { registry.delete(name); return {}; }
      return {};
    },
    /** The entry a client holds now, as the tests read it back. */
    entry: (executable, name) => registryOf(executable).get(name),
  };
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
  const mcp = mcpWorld();
  const io = { home, root, destination, bin, config, fs, fetch, platform, now: () => 1700000000000,
    env: { HOME: home, PATH: platform === 'win32' ? '' : bin },
    pkg, arch: 'x64', tmpdir: scratch, tty, ask, read, outTty: false, clientRoot: join(home, 'client'),
    stdout: out, stderr: out, out, adapters: [], readQuota: async () => ({ source: 'off' }),
    detect: async () => true,
    run: async (command) => { commands.push(command); return mcp.handles(command) ? mcp.run(command) : answerCheck(command, { bin }); },
    pathExecute: async () => ({ stdout: 'true\n' }),
    policyExecute: async () => ({ stdout: 'LocalMachine=RemoteSigned\n' }),
    stopDaemon: async () => true, startDaemon: async () => {}, autostart: async () => {}, smoke: async () => ({ code: 0 }) };
  // Goldens normalize folders and padding; assertStatusColumns checks raw padding.
  const lines = () => output.map((line) => line.replaceAll(destination, '<data>').replaceAll(bin, '<bin>').replaceAll(scratch, '<scratch>')
    .replaceAll(home, '<home>').replace(/ {2,}/g, '  ').trimEnd());
  return { home, root, destination, bin, scratch, io, output, commands, lines, name, mcp,
    setVersion: (value) => { version = value; }, clear: () => { output.length = 0; } };
}
