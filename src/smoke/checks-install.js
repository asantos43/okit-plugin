// Group A of `docs/SMOKE.md`: the plugin is installed and a client can talk to
// it. Every check here reads the plugin root it is given and writes only under
// `deps.stateRoot` and `deps.configRoot`, so a run of this table never touches
// the machine it runs on.

import { access, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { installHooks, installSkill } from '../../adapters/claude-code/index.js';
import { main } from '../cli.js';
import { handleLine, serverVersion } from '../mcp/server.js';
import { TOOLS, TOOL_NAMES } from '../mcp/tools.js';
import { DEFAULT_CONFIG } from '../profiles.js';

const SKILLS = ['okit-director', 'okit-executor', 'okit-critic', 'okit-smoke', 'okit-setup', 'okit-environment'];

// The hooks the plugin installs; the entry the user writes next to it is the one
// that has to survive a second install.
const OURS = { hooks: [{ event: 'Stop', command: `${DEFAULT_CONFIG.install.command} hooks` }] };
const THEIRS = { event: 'UserPromptSubmit', command: 'what the user wrote' };

function need(ok, message) {
  if (!ok) throw new Error(message);
}

const frame = (id, method, params = undefined) => JSON.stringify(
  params === undefined ? { jsonrpc: '2.0', id, method } : { jsonrpc: '2.0', id, method, params },
);

/**
 * One `okit` invocation with every side effect injected: the state root is the
 * scratch one, `write` only records, and a client reading a quota gets the
 * injected answer, never an adapter that would look at the real home.
 */
async function cli(deps, argv) {
  const out = [];
  const err = [];
  const wrote = [];
  const code = await main(argv, {
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    root: deps.stateRoot,
    env: deps.env,
    now: deps.now,
    platform: deps.platform,
    run: deps.run,
    signal: deps.signal,
    sleep: deps.sleep,
    write: async (path, content) => {
      wrote.push({ path, content });
      return path;
    },
    readQuota: async () => ({ source: 'off' }),
    quotaCache: new Map(),
  });
  return { code, out, err, wrote };
}

// I1: the files a client loads and the skills it reads are readable
// in the checkout the run was given, at the paths the plugin declares.
async function filesPlaced(deps) {
  const wanted = [
    join(deps.root, 'src', 'cli.js'),
    join(deps.root, 'src', 'mcp', 'server.js'),
    join(deps.root, 'adapters', 'claude-code', 'index.js'),
    ...SKILLS.map((name) => join(deps.root, 'skills', name, 'SKILL.md')),
  ];
  for (const file of wanted) await access(file);
}

// I2: the three groups `main` knows answer 0, and anything else answers 2.
async function commandsRegistered(deps) {
  for (const argv of [['daemon', 'status'], ['autostart', 'show'], ['status']]) {
    const run = await cli(deps, argv);
    need(run.code === 0, `${DEFAULT_CONFIG.install.command} ${argv.join(' ')} must exit 0, got ${run.code}: ${run.err.join(' ')}`);
  }
  for (const argv of [[], ['nope'], ['daemon', 'frobnicate']]) {
    const run = await cli(deps, argv);
    need(run.code === 2, `${DEFAULT_CONFIG.install.command} ${argv.join(' ')} must exit 2, got ${run.code}`);
  }
}

// I3: the handshake over `handleLine` names the server and lists every tool.
async function mcpRegistered(deps) {
  const context = { tools: TOOLS, ctx: { root: deps.stateRoot }, version: await serverVersion() };
  const hello = await handleLine(frame(1, 'initialize', { protocolVersion: '2025-06-18' }), context);
  need(hello?.result?.serverInfo?.name === 'okit', 'initialize must answer with the okit server');
  const listed = await handleLine(frame(2, 'tools/list'), context);
  const names = listed?.result?.tools?.map((tool) => tool.name) ?? [];
  need(names.length === TOOL_NAMES.length, `tools/list must name ${TOOL_NAMES.length} tools, got ${names.length}`);
  for (const name of TOOL_NAMES) need(names.includes(name), `tools/list must name ${name}`);
}

// I4: the skill is copied under the scratch config root with the packaged bytes,
// and a second call says `identical` instead of writing again. A root that
// already holds the skill — the second run of `U4` — is the same case.
async function skillsInstalled(deps) {
  for (const name of SKILLS) await skillInstalled(deps, name);
}

async function skillInstalled(deps, name) {
  const source = join(deps.root, 'skills', name);
  const target = join(deps.configRoot, 'skills', name, 'SKILL.md');
  const first = await installSkill(name, source, { root: deps.configRoot });
  need((await readFile(target, 'utf8')) === await readFile(join(source, 'SKILL.md'), 'utf8'),
    'the installed SKILL.md must hold the packaged bytes');
  need(first.written.length === 0 || first.written.includes('SKILL.md'),
    `installSkill wrote ${first.written.join(',')}, which is not this skill`);

  const second = await installSkill(name, source, { root: deps.configRoot });
  need(second.written.length === 0, 'a second install must write nothing');
  need(second.skipped.length > 0 && second.skipped.every((file) => file.reason === 'identical'),
    `every file must be identical, got ${second.skipped.map((file) => file.reason).join(',')}`);
}

// I5: the hooks file is written once, and an install over a file the user edited
// keeps their entry and reports `written: false`.
async function hooksMerged(deps) {
  const first = await installHooks(OURS, { root: deps.configRoot });
  need(first.path === join(deps.configRoot, 'hooks', 'hooks.json'),
    `installHooks must write hooks/hooks.json, wrote ${first.path}`);

  // The user's own entry, added the first time the check runs on a root.
  const stored = JSON.parse(await readFile(first.path, 'utf8'));
  if (!stored.hooks.some((hook) => hook.event === THEIRS.event)) stored.hooks.push(THEIRS);
  await writeFile(first.path, `${JSON.stringify(stored, null, 2)}\n`, 'utf8');

  const second = await installHooks(OURS, { root: deps.configRoot });
  need(second.written === false, 'over a user-edited file installHooks must report written: false');
  const merged = JSON.parse(await readFile(first.path, 'utf8'));
  need(merged.hooks.length === 2, `our entry and the user's must be the two, got ${merged.hooks.length}`);
  need(merged.hooks.some((hook) => hook.event === THEIRS.event), "the user's entry must survive the merge");
  need(merged.hooks.some((hook) => hook.event === OURS.hooks[0].event), 'our own entry must be there');
}

// I6: the bin the package declares and every SKILL.md are readable. Windows has
// no permission bits, so the mode is only read off it.
async function permissionsReadable(deps) {
  const pkg = JSON.parse(await readFile(join(deps.root, 'package.json'), 'utf8'));
  const folders = await readdir(join(deps.root, 'skills'), { withFileTypes: true });
  const files = [
    ...Object.values(pkg.bin).map((bin) => join(deps.root, bin)),
    ...folders.filter((entry) => entry.isDirectory())
      .map((entry) => join(deps.root, 'skills', entry.name, 'SKILL.md')),
  ];
  for (const file of files) {
    await access(file);
    if (deps.platform === 'win32') continue;
    const info = await stat(file);
    need((info.mode & 0o444) === 0o444, `${file} is not readable`);
  }
  need(files.length === SKILLS.length + 1, `the package must ship ${SKILLS.length} skills, found ${files.length - 1}`);
}

// I7: the version the MCP server reports is the one in package.json, and
// `okit-plugin status` prints the table under the capacity line.
async function versionMatches(deps) {
  const pkg = JSON.parse(await readFile(join(deps.root, 'package.json'), 'utf8'));
  const version = await serverVersion();
  need(version === pkg.version, `serverVersion() is ${version}, package.json says ${pkg.version}`);

  const run = await cli(deps, ['status']);
  need(run.code === 0, `${DEFAULT_CONFIG.install.command} status must exit 0, got ${run.code}: ${run.err.join(' ')}`);
  need(run.out.some((line) => line.startsWith('| Subscription |')),
    `${DEFAULT_CONFIG.install.command} status must print the table header, got ${run.out.join(' / ')}`);
  need(run.out.some((line) => line.includes('executors that can launch now')),
    `${DEFAULT_CONFIG.install.command} status must print the capacity line`);
}

/**
 * The install group, in the order of the table in `docs/SMOKE.md`. `run` resolves
 * when the check passes and throws a plain-words `Error` when it fails; the
 * runner of step 3 is what turns that into a record.
 */
export const INSTALL_CHECKS = [
  { id: 'I1', name: 'files.placed', group: 'I', timeoutMs: 5000, run: filesPlaced },
  { id: 'I2', name: 'commands.registered', group: 'I', timeoutMs: 15000, run: commandsRegistered },
  { id: 'I3', name: 'mcp.registered', group: 'I', timeoutMs: 15000, run: mcpRegistered },
  { id: 'I4', name: 'skills.installed', group: 'I', timeoutMs: 10000, run: skillsInstalled },
  { id: 'I5', name: 'hooks.merged', group: 'I', timeoutMs: 10000, run: hooksMerged },
  { id: 'I6', name: 'permissions.readable', group: 'I', timeoutMs: 5000, run: permissionsReadable },
  { id: 'I7', name: 'version.matches', group: 'I', timeoutMs: 10000, run: versionMatches },
];

export default INSTALL_CHECKS;
