import * as filesystem from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { DEFAULT_CONFIG } from '../profiles.js';
import { writeJsonAtomic } from '../state.js';
import { installConfig, installPaths, clientRoot } from './config.js';
import { chooseClient } from './menu.js';
import { latestRelease } from './release.js';
import { downloadRelease } from './download.js';
import { place, readRecords } from './place.js';
import { registrationPlan } from './register.js';
import { activate, backup, rollback } from './update.js';
import { uninstall } from './uninstall.js';
import { localSource } from './source.js';

const packageDirectory = fileURLToPath(new URL('../../', import.meta.url));
const allowed = {
  install: ['client', 'from', 'prerelease', 'repo', 'dest', 'no-link', 'autostart', 'dry-run', 'yes'],
  update: ['client', 'check', 'rollback', 'dry-run'], uninstall: ['client', 'purge', 'yes', 'dry-run'],
};
function flagsOf(command, args) {
  const flags = {};
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index].replace(/^--/, '');
    if (!args[index].startsWith('--') || !allowed[command]?.includes(flag)) throw new TypeError(`Unknown flag: ${args[index]}`);
    if (['client', 'repo', 'dest', 'from'].includes(flag)) {
      if (!args[index + 1] || args[index + 1].startsWith('--')) throw new TypeError(`Missing value for --${flag}`);
      flags[flag] = args[++index];
    } else flags[flag] = true;
  }
  if (flags.check && flags.rollback) throw new TypeError('--check and --rollback cannot be combined');
  return flags;
}

async function read(question) {
  const input = createInterface({ input: process.stdin, output: process.stdout });
  try { return await input.question(question); } finally { input.close(); }
}

export async function installerCommand(command, args, ctx, io = {}) {
  try {
    const flags = flagsOf(command, args);
    const fs = io.fs ?? filesystem;
    let user;
    try { user = JSON.parse(await fs.readFile(join(ctx.root, 'config.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; user = {}; }
    const config = installConfig({ ...user.install, ...(flags.dest ? { destination: flags.dest } : {}) });
    const locations = installPaths(config, { env: ctx.env, platform: ctx.platform, home: io.home ?? ctx.env.HOME ?? ctx.env.USERPROFILE ?? homedir() });
    const deps = { ...ctx, ...io, fs, config, ...locations, out: ctx.out,
      home: io.home ?? ctx.env.HOME ?? ctx.env.USERPROFILE ?? homedir(),
      temporary: io.tmpdir ?? tmpdir(), now: ctx.now, platform: ctx.platform, env: ctx.env,
      fetch: io.fetch ?? globalThis.fetch, tty: io.tty ?? Boolean(process.stdin.isTTY),
      read: io.read ?? read, dryRun: Boolean(flags['dry-run']),
      writeJsonAtomic: io.fs ? undefined : writeJsonAtomic };
    let records = await readRecords(deps.destination, fs, config);
    if (!Object.keys(records).length && !flags.dest) {
      const runtime = await readRecords(dirname(packageDirectory.replace(/[\\/]$/, '')), fs, config);
      const installed = Object.values(runtime).find((record) => record.path === packageDirectory.replace(/[\\/]$/, ''));
      if (installed) { deps.destination = installed.destination; records = runtime; }
    }
    const selection = command === 'install' ? await chooseClient(flags.client, deps)
      : flags.client ? [flags.client] : Object.keys(records);
    const clients = Array.isArray(selection) ? selection : [selection];
    if (!clients.length) throw new TypeError('No installation record found');
    if (command !== 'install' && clients.some((client) => !records[client])) throw new TypeError(`Client not registered: ${flags.client}`);
    if (flags.purge && (!flags.yes || clients.length !== Object.keys(records).length)) throw new TypeError('--purge requires --yes and no remaining clients');
    const results = [];
    for (const client of clients) {
      ctx.out(`Client: ${client}`);
      const purge = flags.purge && client === clients.at(-1) && results.every(({ code }) => code === 0);
      const shared = Object.values(await readRecords(deps.destination, fs, config));
      const code = await runClient(command, { ...flags, purge, client }, ctx, io, {
        ...deps, backupPerClient: clients.length > 1,
        sharedLink: shared.some((record) => record.link), sharedAutostart: shared.some((record) => record.autostart),
      }, user, records[client]);
      results.push({ client, code });
    }
    results.forEach(({ client, code }) => ctx.out(`${client}: ${code === 0 ? 'success' : 'failed'}`));
    return results.every(({ code }) => code === 0) ? 0 : results.every(({ code }) => code === 2) ? 2 : 1;
  } catch (error) {
    (ctx.err ?? ctx.out)(`refused: ${error.message}`);
    return error instanceof TypeError ? 2 : 1;
  }
}

async function runClient(command, flags, ctx, io, deps, user, current) {
  let started = false;
  const { fs, config } = deps;
  try {
    if (current) {
      deps.bin = current.linkDirectory ?? deps.bin;
      if (command !== 'install') deps.config = installConfig({ ...current.settings, ...user.install });
      deps.clientRoot = io.clientRoot ?? clientRoot(current.client, deps);
    }
    if (command === 'uninstall') {
      if (!current) throw new TypeError('No installation record found');
      if (flags.purge && !flags.yes) throw new TypeError('--purge requires --yes');
      started = !deps.dryRun;
      return await uninstall(current, flags, deps);
    }
    if (flags.rollback) {
      if (!current?.previous) throw new TypeError('No previous version retained');
      if (current.previous.client !== current.client) throw new TypeError('Previous version belongs to another client');
      started = !deps.dryRun;
      return await rollback(current, deps);
    }
    if (command === 'update' && !current) throw new TypeError('No installation record found');
    const client = flags.client;
    deps.clientRoot = io.clientRoot ?? clientRoot(client, deps);
    const pkg = io.pkg ?? JSON.parse(await fs.readFile(join(packageDirectory, 'package.json'), 'utf8'));
    const release = { ...DEFAULT_CONFIG.release, ...user.release,
      publish: { ...DEFAULT_CONFIG.release.publish, ...user.release?.publish },
      formats: { ...DEFAULT_CONFIG.release.formats, ...user.release?.formats } };
    release.name = deps.config.name ?? release.name;
    const system = deps.config.systems[ctx.platform];
    const arch = deps.config.architectures[io.arch ?? process.arch];
    if (!system || !arch) throw new TypeError('Unsupported system or architecture');
    const repo = flags.repo ?? current?.repo ?? (command === 'install' && !current ? config.repository : pkg.repository?.url);
    const local = flags.from ? await localSource(flags.from, pkg.name, fs, deps.destination) : null;
    const selected = local ? { version: local.version, asset: { name: flags.from } } : await latestRelease({ config: deps.config, release, pkg, repo, client, system, arch,
      prerelease: Boolean(flags.prerelease || current?.prerelease), fetch: deps.fetch });
    ctx.out(`Release: ${selected.version}${selected.prerelease ? ' (pre-release; no stable release selected)' : ''}`);
    ctx.out(`Asset: ${selected.asset.name}`);
    ctx.out(`Destination: ${deps.destination}`);
    ctx.out('SHA-256 detects altered bytes; it does not authenticate the source.');
    if (current?.version === selected.version && current.client === client) {
      ctx.out('up to date'); return 0;
    }
    if (flags.check) { ctx.out(`New version available: ${selected.version}`); return 0; }
    if (current && local) command = 'update';
    const bin = pkg.bin[deps.config.command];
    if (!bin) throw new TypeError(`Package has no configured command: ${deps.config.command}`);
    const planned = { path: join(deps.destination, `${selected.version}-${client}`), client };
    registrationPlan(planned, deps, command === 'update' ? 'update' : 'install').forEach((item) => ctx.out(`command: ${[item.command, ...item.args].join(' ')}`));
    if (deps.dryRun) {
      if (command === 'update') ctx.out('Would stop daemon, back up state/client files, activate and run smoke.');
      ctx.out(`Would ${flags['no-link'] ? 'skip' : 'create'} command link in ${deps.bin}`);
      if (flags.autostart || current?.autostart) ctx.out('Would regenerate autostart using installed paths.');
      return 0;
    }
    started = true;
    // Download/verify before disturbing the running installation.
    const downloaded = local ?? await downloadRelease(selected, deps);
    try {
      let wasRunning = false;
      if (current && command === 'update') {
        wasRunning = await deps.stopDaemon(current);
        await backup(current, deps);
      }
      const { record } = await place(selected, downloaded, { client, system, arch, repo, bin,
        link: deps.sharedLink || (!flags['no-link'] && (current?.link ?? true)), linkDirectory: deps.bin,
        autostart: Boolean(flags.autostart || current?.autostart || deps.sharedAutostart), wasRunning,
        prerelease: Boolean(flags.prerelease), settings: deps.config }, deps);
      await activate(record, current, deps, command === 'update' ? 'update' : 'install');
      if (command === 'update') {
        if (io.smoke) {
          const smoke = await io.smoke(record);
          if (smoke.code !== 0 || smoke.records?.some((check) => check.status !== 'pass')) throw new Error('Smoke proof failed');
        } else {
          const result = await deps.run({ command: deps.config.node, args: [join(record.path, record.bin), 'smoke'] });
          if (result.code && result.code !== 0) throw new Error('Smoke proof failed');
          if (result.stdout) ctx.out(result.stdout);
        }
      }
      ctx.out(`Installed ${record.version}: ${record.path}`);
      return 0;
    } finally { if (!local) await fs.rm(downloaded.folder, { recursive: true, force: true }); }
  } catch (error) {
    (ctx.err ?? ctx.out)(`${started ? 'failed' : 'refused'}: ${error.message}`);
    if (command === 'update' && started) ctx.out(`To return to the retained version: ${DEFAULT_CONFIG.install.command} update --rollback`);
    return started || !(error instanceof TypeError) ? 1 : 2;
  }
}
