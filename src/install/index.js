import * as filesystem from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { DEFAULT_CONFIG, configOf } from '../profiles.js';
import { createPresenter, planSteps, fill, localizeReason, pick, TEXTS, redactingStream, redactingWriter, resolveLocale, supportsUnicode, headerValues, clientLabel, finish, finishLink } from './present.js';
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
import { detectKit } from './kit.js';
import { applyLink, chooseLinkDirectory } from './link.js';
import { offerSetup } from '../setup/offer.js';
import { initializeDetectedConfig, setupReader, formatUnreadable, formatNotSaved } from '../setup/setup.js';
import { adapterQuotaReader } from '../env/quota.js';
import { registerStatusline, appliesStatusline } from './statusline.js';
import { executionPolicyStep } from './policy.js';
import { exitCodeFor, kindOf, LanguageError, UsageError } from './exit.js';

const packageDirectory = fileURLToPath(new URL('../../', import.meta.url));
const allowed = {
  // `asset` and `fallback` come from the generated install scripts, which download and verify the package.
  install: ['client', 'from', 'prerelease', 'repo', 'dest', 'no-link', 'no-path', 'autostart', 'dry-run', 'yes', 'statusline', 'no-statusline', 'locale', 'verbose', 'asset', 'fallback', 'set-execution-policy', 'no-execution-policy'],
  update: ['client', 'check', 'rollback', 'dry-run', 'no-path', 'statusline', 'no-statusline', 'locale', 'verbose', 'set-execution-policy', 'no-execution-policy'],
  uninstall: ['client', 'purge', 'yes', 'dry-run', 'locale', 'verbose'],
};
export const ALLOWED_FLAGS = allowed;
// Pairs of flags that exclude each other; the refusal is translated by REASONS in present.js.
export const EXCLUSIVE_FLAGS = [['check', 'rollback'], ['statusline', 'no-statusline'], ['set-execution-policy', 'no-execution-policy']];
function flagsOf(command, args) {
  const flags = {};
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index].replace(/^--/, '');
    if (!args[index].startsWith('--') || !allowed[command]?.includes(flag)) throw new UsageError(`Unknown flag: ${args[index]}`);
    if (['client', 'repo', 'dest', 'from', 'locale', 'asset'].includes(flag)) {
      if (!args[index + 1] || args[index + 1].startsWith('--')) throw new UsageError(`Missing value for --${flag}`);
      flags[flag] = args[++index];
    } else flags[flag] = true;
  }
  for (const [first, second] of EXCLUSIVE_FLAGS) {
    if (flags[first] && flags[second]) throw new UsageError(`--${first} and --${second} cannot be combined`);
  }
  return flags;
}

// The terminal question: readline writes straight to its output, so the output is the redacting one.
const readerOf = (hide) => async (question) => {
  const input = createInterface({ input: process.stdin, output: redactingStream(process.stdout, hide) });
  try { return await input.question(question); } finally { input.close(); }
};

/**
 * The reader of the setup the end of an installation offers: the injected
 * `ask` when the caller has one, and a terminal reader otherwise. The reader is
 * opened only when a question is really asked, and it is closed when the offer
 * ends, so the process is never held by it.
 */
function setupReaderOf(io, hide) {
  if (typeof io.ask === 'function') return { ask: io.ask, close: () => {} };
  return setupReader({ stdin: io.stdin, output: redactingStream(io.output ?? process.stdout, hide) });
}

export async function installerCommand(command, args, ctx, io = {}) {
  // Folders an error must not print: the temporary one shows as <temp>.
  const hide = [io.tmpdir ?? tmpdir()];
  // The one door of the output: whatever any module prints (steps, details, errors, what a started
  // process said, the setup) passes through `redact` here, so no module has to remember to.
  ctx = { ...ctx, out: redactingWriter(ctx.out, hide), err: ctx.err ? redactingWriter(ctx.err, hide) : ctx.err };
  let ui = createPresenter({ locale: resolveLocale({ args, env: ctx.env }).locale, write: ctx.out, hide });
  try {
    // The one entry: read the configuration, decide the language, and only then read the flags, so that every
    // refusal (an unknown flag included) is said in the language of the run.
    const fs = io.fs ?? filesystem;
    let user;
    try { user = JSON.parse(await fs.readFile(join(ctx.root, 'config.json'), 'utf8')); }
    catch (error) {
      // A file that is not JSON is not a configuration: the refusal is the
      // simple sentence the setup says, without the technical detail.
      if (error.code === 'ENOENT') user = {};
      else if (error instanceof SyntaxError) throw new Error(formatUnreadable(ui.locale, ctx.command));
      else throw error;
    }
    // The one function decides: a valid --locale, then OKIT_LANGUAGE, then the saved language, then English. A
    // --locale or a saved language that is not one is refused in the language that function gives, never in both.
    // A file whose root is not an object (null, a list, a number) holds no settings: the defaults apply (the setup, which
    // writes the file, is the one that calls it unreadable).
    if (user === null || typeof user !== 'object' || Array.isArray(user)) user = {};
    const chosen = resolveLocale({ args, env: ctx.env, saved: user?.language });
    ui = createPresenter({ locale: chosen.locale, write: ctx.out, hide });
    if (chosen.invalid) throw new LanguageError('Choose a language: en, pt-BR.');
    const flags = flagsOf(command, args);
    ui = io.ui ?? createPresenter({ locale: chosen.locale, verbose: Boolean(flags.verbose), write: ctx.out,
      unicode: supportsUnicode({ tty: io.outTty ?? Boolean(process.stdout.isTTY), env: ctx.env, platform: ctx.platform }), hide });
    const config = installConfig(user?.install, flags.dest ? { destination: flags.dest } : {});
    const locations = installPaths(config, { env: ctx.env, platform: ctx.platform, home: io.home ?? ctx.env.HOME ?? ctx.env.USERPROFILE ?? homedir() });
    const deps = { ...ctx, ...io, fs, config, ...locations, out: ctx.out, err: ctx.err, ui, hints: [],
      statuslineConfig: configOf(user).statuslineRegistration,
      home: io.home ?? ctx.env.HOME ?? ctx.env.USERPROFILE ?? homedir(),
      temporary: io.tmpdir ?? tmpdir(), now: ctx.now, platform: ctx.platform, env: ctx.env,
      fetch: io.fetch ?? globalThis.fetch, tty: io.tty ?? Boolean(process.stdin.isTTY),
      read: io.read ?? readerOf(hide), dryRun: Boolean(flags['dry-run']),
      writeJsonAtomic: io.fs ? undefined : writeJsonAtomic };
    deps.pathSetup = true;
    deps.noPath = Boolean(flags['no-path']);
    deps.bin = await chooseLinkDirectory(deps);
    let records = await readRecords(deps.destination, fs, config);
    if (!Object.keys(records).length && !flags.dest) {
      const runtime = await readRecords(dirname(packageDirectory.replace(/[\\/]$/, '')), fs, config);
      const installed = Object.values(runtime).find((record) => record.path === packageDirectory.replace(/[\\/]$/, ''));
      if (installed) { deps.destination = installed.destination; records = runtime; }
    }
    const selection = command === 'install' ? await chooseClient(flags.client, deps)
      : flags.client ? [flags.client] : Object.keys(records);
    const clients = Array.isArray(selection) ? selection : [selection];
    if (!clients.length) throw new UsageError('No installation record found');
    if (command !== 'install' && clients.some((client) => !records[client])) throw new UsageError(`Client not registered: ${flags.client}`);
    if (flags.purge && (!flags.yes || clients.length !== Object.keys(records).length)) throw new UsageError('--purge requires --yes and no remaining clients');
    const results = [];
    for (const client of clients) {
      const purge = flags.purge && client === clients.at(-1) && results.every(({ code }) => code === 0);
      const shared = Object.values(await readRecords(deps.destination, fs, config));
      const code = await runClient(command, { ...flags, purge, client }, ctx, io, {
        ...deps, backupPerClient: clients.length > 1,
        sharedLink: shared.some((record) => record.link), sharedAutostart: shared.some((record) => record.autostart),
      }, user, records[client]);
      results.push({ client, code });
    }
    if (results.length > 1) results.forEach(({ client, code }) => ui.row(clientLabel(client), code === 0 ? 'ok' : 'failed'));
    const succeeded = results.every(({ code }) => code === 0);
    if ((command === 'install' || command === 'update') && !flags.check && !flags.rollback && succeeded) {
      await executionPolicyStep(ui, flags, deps);
    }
    // The setup was not done yet: offer it. A setup that cannot run is
    // reported and never fails the installation.
    if ((command === 'install' || command === 'update') && !deps.dryRun && !flags.check && succeeded) {
      const reader = setupReaderOf(io, hide);
      try {
        let observation;
        try {
          ({ observation } = await initializeDetectedConfig({ root: ctx.root, env: ctx.env,
            run: ctx.run, adapters: io.setupAdapters ?? io.adapters,
            readQuota: io.readQuota ?? adapterQuotaReader({ stateRoot: ctx.root, env: ctx.env,
              config: configOf(user), now: ctx.now }),
            write: ctx.writeConfig ?? ctx.write, command: deps.config.command }));
        } catch {
          ui.warn(formatNotSaved(ui.locale, ctx.root, deps.config.command));
        }
        await offerSetup({
          root: ctx.root,
          command: deps.config.command,
          locale: ui.locale,
          ui,
          tty: deps.tty,
          ask: reader.ask,
          out: ctx.out,
          run: ctx.run,
          env: ctx.env,
          adapters: io.setupAdapters ?? io.adapters,
          snapshot: observation,
          write: ctx.writeConfig ?? ctx.write,
        });
      } finally { reader.close(); }
    }
    if (command === 'install' || command === 'update') kitRow(ui, deps, await detectKit(deps));
    if (command !== 'uninstall' && deps.dryRun) ui.explain([ui.text('dryRunDone')]);
    else if (command !== 'uninstall' && succeeded && deps.hints.length) {
      ui.summary({ client: clientLabel(clients.at(-1)), command: deps.config.command, hint: deps.hints.find(Boolean) });
    }
    return exitCodeFor(succeeded ? 'ok' : results.every(({ code }) => code === exitCodeFor('usage')) ? 'usage' : 'operational');
  } catch (error) {
    ui.failure({ reason: error.message, next: ui.text('nextCheck') }).forEach((item) => (ctx.err ?? ctx.out)(item));
    return exitCodeFor(kindOf(error));
  }
}

/** What the `kit` command says, in the one language of the run: the probe's facts told by the presenter's own texts. */
export function kitLine(result, kitConfig, locale) {
  const lang = locale === 'pt-BR' ? 'pt-BR' : 'en';
  const text = (key, values) => fill(pick(TEXTS[key], lang), values);
  const defaults = DEFAULT_CONFIG.install.kit;
  const hint = kitConfig.hint === defaults.hint ? text('kitHint') : pick(kitConfig.hint, lang);
  if (result.state === 'installed') {
    const overlap = result.overlap === defaults.overlap ? text('kitOverlap') : pick(result.overlap, lang);
    return text('kitInstalled', { path: result.path, version: result.version, overlap });
  }
  if (result.state === 'broken') return text('kitLineBroken', { path: result.path, reason: localizeReason(result.reason, lang) });
  return text(result.ignored ? 'kitLineIgnored' : 'kitLineAbsent', { hint });
}

/** The kit row: found or not, and for a kit that is absent, where to read about it. */
function kitRow(ui, deps, kit) {
  const { hint } = deps.config.kit;
  if (kit.state === 'installed') {
    const overlap = kit.overlap === DEFAULT_CONFIG.install.kit.overlap ? ui.text('kitOverlap') : pick(kit.overlap, ui.locale);
    ui.detail(ui.text('kitInstalled', { path: kit.path, version: kit.version, overlap }));
    return ui.row(ui.text('kit'), 'ok', `${kit.path} (${kit.version})`);
  }
  if (kit.state === 'broken') {
    return ui.row(ui.text('kit'), 'skipped', ui.text('kitBroken', { path: kit.path, reason: localizeReason(kit.reason, ui.locale) }));
  }
  const custom = hint !== DEFAULT_CONFIG.install.kit.hint;
  return ui.row(ui.text('kit'), 'info', ui.text('kitAbsent', { hint: custom ? pick(hint, ui.locale) : ui.text('kitHint') }));
}

async function runClient(command, flags, ctx, io, deps, user, current) {
  let started = false;
  let stage = null;
  const { fs, config, ui } = deps;
  const label = clientLabel(flags.client);
  // The step being worked on, so a failure can name it.
  deps.stage = (key) => { stage = key; };
  try {
    if (current) {
      deps.bin = current.linkDirectory ?? deps.bin;
      if (command !== 'install') deps.config = installConfig({ ...current.settings, command: config.command, ...user?.install });
      deps.clientRoot = io.clientRoot ?? clientRoot(current.client, deps);
    }
    if (command === 'uninstall') {
      if (!current) throw new UsageError('No installation record found');
      if (flags.purge && !flags.yes) throw new UsageError('--purge requires --yes');
      started = !deps.dryRun;
      return await uninstall(current, flags, deps);
    }
    if (flags.rollback) {
      if (!current?.previous) throw new UsageError('No previous version retained');
      if (current.previous.client !== current.client) throw new UsageError('Previous version belongs to another client');
      started = !deps.dryRun;
      return await rollback(current, deps);
    }
    if (command === 'update' && !current) throw new UsageError('No installation record found');
    const client = flags.client;
    deps.clientRoot = io.clientRoot ?? clientRoot(client, deps);
    const pkg = io.pkg ?? JSON.parse(await fs.readFile(join(packageDirectory, 'package.json'), 'utf8'));
    const release = { ...DEFAULT_CONFIG.release, ...user.release,
      publish: { ...DEFAULT_CONFIG.release.publish, ...user.release?.publish },
      formats: { ...DEFAULT_CONFIG.release.formats, ...user.release?.formats } };
    release.name = deps.config.name ?? release.name;
    const system = deps.config.systems[ctx.platform];
    const arch = deps.config.architectures[io.arch ?? process.arch];
    if (!system || !arch) throw new UsageError('Unsupported system or architecture');
    const repo = flags.repo ?? current?.repo ?? (command === 'install' && !current ? config.repository : pkg.repository?.url);
    const local = flags.from ? await localSource(flags.from, pkg.name, fs, deps.destination) : null;
    deps.stage('get');
    const selected = local ? { version: local.version, asset: { name: flags.asset ?? flags.from }, prerelease: Boolean(flags.fallback) }
      : await latestRelease({ config: deps.config, release, pkg, repo, client, system, arch,
        prerelease: Boolean(flags.prerelease || current?.prerelease), fetch: deps.fetch });
    deps.stage(null);
    const quota = appliesStatusline({ client }, flags, deps);
    ui.header(headerValues(deps, selected.version, client));
    if (current?.version === selected.version && current.client === client) {
      // The same steps in a dry run as in the run itself: the command link is planned, not skipped.
      const link = !flags.check && Boolean(current.link);
      const next = ui.sequence(planSteps({ upToDate: true, quota, link }), { client: label });
      ui.row(ui.text('upToDate'), 'ok', selected.version);
      deps.stage('quota');
      const recorded = await registerStatusline(current, flags, deps);
      if (recorded) finish(next('quota'), recorded);
      deps.stage('link');
      if (link && deps.dryRun) finishLink(ui, next('link'), null, { dryRun: true, command: deps.config.command, bin: deps.bin });
      else if (link) finishLink(ui, next('link'), await applyLink(current, deps));
      return exitCodeFor('ok');
    }
    if (flags.check) {
      const next = ui.sequence(quota ? ['quota'] : [], { client: label });
      const recorded = await registerStatusline(current, flags, deps);
      ui.row(ui.text('newVersion'), 'info', selected.version);
      if (recorded) finish(next('quota'), recorded);
      return exitCodeFor('ok');
    }
    if (current && local) command = 'update';
    const bin = pkg.bin[deps.config.command];
    if (!bin) throw new UsageError(`Package has no configured command: ${deps.config.command}`);
    const planned = { path: join(deps.destination, `${selected.version}-${client}`), client };
    const refreshing = command === 'update';
    const getKey = local && !flags.asset ? 'local' : 'get';
    const next = ui.sequence(planSteps({ get: getKey, backup: refreshing && Boolean(current), quota, smoke: refreshing }), { client: label });
    const getDetail = getKey === 'local' ? ui.text('localSource', { version: selected.version })
      : ui.text(deps.dryRun ? 'plain' : 'checked', { asset: selected.asset.name });
    // Said once in the run, however many clients it installs: neither belongs to one client.
    const getNotes = getKey === 'local' ? [] : [ui.global(ui.text('shaNote')), ...(selected.prerelease ? [ui.global(ui.text('fallback', { version: selected.version }))] : [])];
    // A real run prints each command as it runs it (register); only a dry run shows the plan.
    if (deps.dryRun) registrationPlan(planned, deps, refreshing ? 'update' : 'install').forEach((item) => ui.detail([item.command, ...item.args].join(' ')));
    if (deps.dryRun) {
      next(getKey).plan(getDetail, getNotes);
      if (refreshing && current) next('backup').plan();
      next('files').plan(planned.path);
      next('register').plan();
      finishLink(ui, next('link'), null, { dryRun: !flags['no-link'], command: deps.config.command, bin: deps.bin });
      const recorded = await registerStatusline(current ?? planned, flags, deps);
      if (recorded) finish(next('quota'), recorded);
      if (refreshing) next('smoke').plan();
      return exitCodeFor('ok');
    }
    started = true;
    // Download/verify before disturbing the running installation.
    deps.stage('get');
    const downloaded = local ?? await downloadRelease(selected, deps);
    next(getKey).ok(getDetail, getNotes);
    try {
      let wasRunning = false;
      if (current && command === 'update') {
        deps.stage('backup');
        wasRunning = await deps.stopDaemon(current);
        next('backup').ok(await backup(current, deps));
      }
      deps.stage('files');
      const { record } = await place(selected, downloaded, { client, system, arch, repo, bin,
        link: deps.sharedLink || (!flags['no-link'] && (current?.link ?? true)), linkDirectory: deps.bin,
        autostart: Boolean(flags.autostart || current?.autostart || deps.sharedAutostart), wasRunning,
        prerelease: Boolean(flags.prerelease), settings: deps.config }, deps);
      next('files').ok(record.path);
      const done = await activate(record, current, deps, refreshing ? 'update' : 'install', deps.stage);
      finish(next('register'), done.registered);
      finishLink(ui, next('link'), done.linked);
      deps.hints.push(done.linked?.hint ?? null);
      if (current?.statusline) record.statusline = current.statusline;
      deps.stage('quota');
      const recorded = await registerStatusline(record, flags, deps);
      if (recorded) finish(next('quota'), recorded);
      if (refreshing) {
        deps.stage('smoke');
        if (io.smoke) {
          const smoke = await io.smoke(record);
          if (smoke.code !== 0 || smoke.records?.some((check) => check.status !== 'pass')) throw new Error('Smoke proof failed');
        } else {
          const result = await deps.run({ command: deps.config.node, args: [join(record.path, record.bin), 'smoke'] });
          if (result.code && result.code !== 0) throw new Error('Smoke proof failed');
          if (result.stdout) ui.detail(result.stdout);
        }
        next('smoke').ok();
      }
      return exitCodeFor('ok');
    } finally { if (!local) await fs.rm(downloaded.folder, { recursive: true, force: true }); }
  } catch (error) {
    const step = stage ? ui.text(stage, { client: label }) : '';
    const rollbackNext = command === 'update' && started && !flags.rollback ? ui.text('nextRollback', { command: deps.config.command }) : null;
    ui.failure({ step, reason: error.message, next: rollbackNext ?? ui.text(started ? 'nextRetry' : 'nextCheck') })
      .forEach((item) => (ctx.err ?? ctx.out)(item));
    return exitCodeFor(started ? 'operational' : kindOf(error));
  }
}
