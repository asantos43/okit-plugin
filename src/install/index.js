import * as filesystem from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { DEFAULT_CONFIG, configOf } from '../profiles.js';
import { createPresenter, planSteps, fill, localizeReason, pick, TEXTS, redactingStream, redactingWriter, resolveLocale, supportsUnicode, headerValues, clientLabel, finish, finishLink } from './present.js';
import { writeJsonAtomic } from '../state.js';
import { installConfig, installPaths, clientRoot, homeOf } from './config.js';
import { flagsOf } from './flags.js';
import { chooseClient } from './menu.js';
import { latestRelease } from './release.js';
import { downloadRelease } from './download.js';
import { discoverRecords, payloadComplete, place, readRecords, readRecordsLenient, saveRecord } from './place.js';
import { registrationPlan, mcpNotes, register } from './register.js';
import { mcpPlan, ensureMcp, shown } from './mcp-register.js';
import { activate, backup, rollback } from './update.js';
import { uninstall } from './uninstall.js';
import { PANEL_CLIENT, panelCommand, offerPanel } from './panel.js';
import { resolvedRecord } from './where.js';
import { localSource } from './source.js';
import { detectKit } from './kit.js';
import { applyLink, chooseLinkDirectory } from './link.js';
import { offerSetup } from '../setup/offer.js';
import { initializeDetectedConfig, setupReader, formatUnreadable, formatNotSaved } from '../setup/setup.js';
import { adapterQuotaReader } from '../env/quota.js';
import { registerStatusline, appliesStatusline } from './statusline.js';
import { accountIds, depsFor, hasExtras, header, involvesAccounts, markRegistered, registeredIds, registeredTargets, requestedAccount, targetOf } from './account-scope.js';
import { accountsOf } from '../accounts.js';
import { verifyInstall } from './selfcheck.js';
import { executionPolicyStep } from './policy.js';
import { commandText } from './command-token.js';
import { exitCodeFor, kindOf, LanguageError, UsageError } from './exit.js';

const packageDirectory = fileURLToPath(new URL('../../', import.meta.url));
// The flags are read in ./flags.js, the one place the installer and the commands that replay a run share.
export { ALLOWED_FLAGS, EXCLUSIVE_FLAGS } from './flags.js';

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

/**
 * The proof of an update: the offline smoke checks of the payload that was just placed. The checks are
 * internal test code, not a command of the program, so there is no installed command to call: the runner
 * of the payload is imported and asked for the same run, in this process. It is the payload's own runner,
 * so the proof is about the installation and not about this checkout.
 *
 * @param {object} record the record of the installation that was just placed
 * @param {object} deps the dependencies of the installer
 * @returns {Promise<{code: number, records: object[], report: string}>}
 */
async function smokeProof(record, deps) {
  const { runSmoke } = await import(pathToFileURL(join(record.path, 'src', 'smoke.js')).href);
  const lines = [];
  // The run builds a scratch home of its own: a state root the user chose is never the one it reads.
  const env = { ...deps.env };
  delete env.OKWORK_HOME;
  const smoke = await runSmoke([], { command: deps.config.command, env, out: (line) => lines.push(line) });
  return { code: smoke.code, records: smoke.records, report: lines.join('\n') };
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
    if (args.includes('--panel')) {
      const allowed = ['client', 'account', 'dry-run', 'locale', 'verbose', 'panel'];
      const refused = Object.keys(flagsOf(command, args, { lenient: true })).find((flag) => !allowed.includes(flag));
      if (refused) throw new UsageError(ui.text('panelFlag', { flag: `--${refused}` }));
    }
    const flags = flagsOf(command, args);
    if (flags.panel && flags.client && flags.client !== PANEL_CLIENT) throw new UsageError(ui.text('panelOnlyClaude', { client: PANEL_CLIENT }));
    if (flags.panel) flags.client = PANEL_CLIENT;
    // An account is named with its client; an update moves every registered account, so it names none.
    if (flags.account !== undefined) {
      if (command === 'update') throw new UsageError('An update moves every registered account; run it without --account.');
      if (!flags.client || flags.client === 'all') throw new UsageError('Name the client of the account with --client.');
    }
    ui = io.ui ?? createPresenter({ locale: chosen.locale, verbose: Boolean(flags.verbose), write: ctx.out,
      unicode: supportsUnicode({ tty: io.outTty ?? Boolean(process.stdout.isTTY), env: ctx.env, platform: ctx.platform }), hide });
    const config = installConfig(user?.install, flags.dest ? { destination: flags.dest } : {});
    const locations = installPaths(config, { env: ctx.env, platform: ctx.platform, home: io.home ?? homeOf(ctx.env, ctx.platform) ?? homedir() });
    const deps = { ...ctx, ...io, fs, config, ...locations, out: ctx.out, err: ctx.err, ui, hints: [], pathNotes: [],
      statuslineConfig: configOf(user).statuslineRegistration, collectorConfig: configOf(user).statuslineCollector,
      home: io.home ?? homeOf(ctx.env, ctx.platform) ?? homedir(),
      temporary: io.tmpdir ?? tmpdir(), now: ctx.now, platform: ctx.platform, env: ctx.env,
      fetch: io.fetch ?? globalThis.fetch, tty: io.tty ?? Boolean(process.stdin.isTTY),
      read: io.read ?? readerOf(hide), dryRun: Boolean(flags['dry-run']),
      writeJsonAtomic: io.fs ? undefined : writeJsonAtomic };
    deps.accountsConfig = user;
    deps.pathSetup = true;
    deps.noPath = Boolean(flags['no-path']);
    deps.bin = await chooseLinkDirectory(deps);
    // The install reads the records leniently: a record that cannot be read is no usable record for that
    // client (a clean install of it) and the other clients keep working. The other commands keep the
    // strict reading, and its message.
    const lenient = command === 'install';
    const found = await discoverRecords(deps.destination, { fs, config, explicitDestination: Boolean(flags.dest), lenient });
    deps.destination = found.destination;
    // A legacy record names no folder: every command works with the folders the installer places an installation in.
    const records = Object.fromEntries(Object.entries(found.records).map(([client, record]) => [client, record !== null && typeof record === 'object' ? resolvedRecord(record, found.destination) : record]));
    /** The records of the destination, read the way this command reads them. */
    const recordsOf = async () => (lenient
      ? (await readRecordsLenient(deps.destination, fs, config)).records
      : await readRecords(deps.destination, fs, config));
    const selection = command === 'install' ? await chooseClient(flags.client, deps)
      : flags.client ? [flags.client] : Object.keys(records);
    const clients = Array.isArray(selection) ? selection : [selection];
    if (!clients.length) throw new UsageError('No installation record found');
    if (!flags.panel && command !== 'install' && clients.some((client) => !records[client])) throw new UsageError(`Client not registered: ${flags.client}`);
    if (flags.purge && (!flags.yes || clients.length !== Object.keys(records).length)) throw new UsageError('--purge requires --yes and no remaining clients');
    const results = [];
    ui.beginClients?.(clients);
    for (const client of clients) {
      const purge = flags.purge && client === clients.at(-1) && results.every(({ code }) => code === 0);
      const shared = Object.values(await recordsOf());
      const code = await runClient(command, { ...flags, purge, client }, ctx, io, {
        ...deps, backupPerClient: clients.length > 1,
        sharedLink: shared.some((record) => record.link), sharedAutostart: shared.some((record) => record.autostart),
      }, user, records[client]);
      results.push({ client, code });
    }
    ui.endClients?.();
    if (results.length > 1) results.forEach(({ client, code }) => ui.row(clientLabel(client), code === 0 ? 'ok' : 'failed'));
    const succeeded = results.every(({ code }) => code === 0);
    if (!flags.panel && (command === 'install' || command === 'update') && !flags.check && !flags.rollback && succeeded) {
      await executionPolicyStep(ui, flags, deps);
    }
    // The setup was not done yet: offer it. A setup that cannot run is
    // reported and never fails the installation.
    if (!flags.panel && (command === 'install' || command === 'update') && !deps.dryRun && !flags.check && succeeded) {
      const reader = setupReaderOf(io, hide);
      try {
        let observation;
        try {
          ({ observation } = await initializeDetectedConfig({ clients, root: ctx.root, env: ctx.env,
            run: ctx.run, adapters: io.setupAdapters ?? io.adapters,
            readQuota: io.readQuota ?? adapterQuotaReader({ stateRoot: ctx.root, env: ctx.env,
              config: configOf(user), now: ctx.now }),
            write: ctx.writeConfig ?? ctx.write, command: deps.config.command }));
        } catch {
          ui.warn(formatNotSaved(ui.locale, ctx.root, commandText(ui, deps.config.command, [], { later: true })));
        }
        await offerSetup({
          clients,
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
    if (!flags.panel && (command === 'install' || command === 'update')) kitRow(ui, deps, await detectKit(deps));
    if (command !== 'uninstall' && deps.dryRun) ui.explain([ui.text('dryRunDone')]);
    else if (command !== 'uninstall' && succeeded && deps.hints.length) {
      ui.summary({ client: clientLabel(clients.at(-1)), command: deps.config.command, hint: deps.hints.find(Boolean) });
    } else if (command !== 'uninstall' && deps.pathNotes.length) {
      // No closing "Next" steps (the version was already installed, or a check failed): the new terminal is told here, once.
      ui.row(ui.text('selfcheckPath'), 'info', deps.pathNotes[0]);
    }
    return exitCodeFor(succeeded ? 'ok' : results.every(({ code }) => code === exitCodeFor('usage')) ? 'usage' : 'operational');
  } catch (error) {
    ui.failure({ reason: error.message, next: ui.text('nextCheck') }).forEach((item) => (ctx.err ?? ctx.out)(item));
    return exitCodeFor(kindOf(error));
  }
}

/** The line of `status` for each installation record that is not a JSON object and was left out, with its file path. */
export function recordIgnoredLines(paths, locale) {
  const lang = locale === 'pt-BR' ? 'pt-BR' : 'en';
  return paths.map((path) => fill(pick(TEXTS.recordIgnored, lang), { path }));
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
    // Accounts (D116): the payload is shared, the registration is made in the folder of each account. Without an account
    // in play none of this runs and the single-account path is exactly what it always was.
    const requested = requestedAccount(flags, user, flags.client, current, command);
    let target = null;
    if (involvesAccounts(current, user, flags.client, requested)) {
      deps.injectedRoot = io.clientRoot;
      target = targetOf(deps, user, requested ?? accountsOf(user, flags.client)[0]);
      deps.registered = registeredTargets(current, user, deps);
      deps.registeredIds = registeredIds(current);
      deps.accountRoots = deps.registered.map(({ root }) => root);
      // What is registered is known by the record: the folder of a registration is the one it was made in. A command that
      // takes the registration out acts there; one that makes it again refuses when the saved folder is another one.
      const held = deps.registered.find(({ id }) => id === target.id);
      if (held && held.root !== target.root && !target.isDefault) {
        if (command === 'uninstall') target = held;
        else throw new UsageError(ui.text('accountMoved', { account: target.id }));
      }
      Object.assign(deps, depsFor(deps, target));
    }
    if (!requested && hasExtras(user, flags.client)) {
      deps.accountNote = ui.text('accountsListed', { client: label, accounts: accountIds(user, flags.client) });
    }
    /** The dependencies of one registered account (the run's own when no account is in play). */
    const scoped = (account) => (account ? depsFor(deps, account) : deps);
    if (flags.panel) return await panelCommand(command, current, deps);
    if (command === 'uninstall') {
      if (!current) throw new UsageError('No installation record found');
      if (flags.purge && !flags.yes) throw new UsageError('--purge requires --yes');
      // The other registrations come first: --purge cannot take the payload while an account still uses it, whichever account is named.
      // Every registration the record holds counts, also that of an account that is no longer saved.
      const standing = target ? deps.registeredIds.filter((id) => id !== target.id) : [];
      if (flags.purge && standing.length && !deps.dryRun) throw new UsageError(ui.text('purgeAccounts', { accounts: standing.join(', ') }));
      if (target && !deps.registeredIds.includes(target.id)) throw new UsageError('That account is not registered.');
      started = !deps.dryRun;
      return await uninstall(current, flags, deps);
    }
    if (flags.rollback) {
      if (!current?.previous) throw new UsageError('No previous version retained');
      if (current.previous.client !== current.client) throw new UsageError('Previous version belongs to another client');
      started = !deps.dryRun;
      return await rollback(current, deps, target ? deps.registered.map((account) => ({ deps: scoped(account), action: 'update' })) : null);
    }
    if (command === 'update' && !current) throw new UsageError('No installation record found');
    const client = flags.client;
    deps.clientRoot = target?.root ?? io.clientRoot ?? clientRoot(client, deps);
    // The accounts this run registers: an install acts on the one it names (and follows the payload in the others); an
    // update moves every registered account.
    const registered = deps.registered ?? [];
    const named = command !== 'update' && target && !registered.some(({ id }) => id === target.id);
    // An install touches the account it names and no other; the others follow the payload only on an update.
    const moving = !target ? [] : command === 'update' ? registered : [target];
    // Where the MCP entry and the status bar are looked after: the named account, or every registered one on an update.
    const acting = !target ? [null] : command === 'update' ? registered : [target];
    const offeringPanel = command === 'install';
    const panelAfterSuccess = async (record, succeeded) => {
      if (offeringPanel && succeeded) {
        for (const account of acting) await offerPanel(record, flags, scoped(account));
      }
      return exitCodeFor(succeeded ? 'ok' : 'operational');
    };
    /** Registers the payload where the named account has not been yet, and notes it in the record. */
    const registerNamed = async (record) => {
      const done = await register(record, scoped(target), 'install');
      markRegistered(record, target);
      await saveRecord(deps.destination, record, deps);
      return done;
    };
    /** The status bar in the settings of each acting account; the row of the step tells the first result. */
    const statusbar = async (record) => {
      let first = null;
      for (const account of acting) {
        const result = await registerStatusline(record, flags, scoped(account));
        if (!first) first = result;
      }
      return first;
    };
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
    header(ui, deps, headerValues(deps, selected.version, client));
    // An installation whose payload is not whole (the server of the MCP server was deleted) is not the installation
    // of that version: it is written again, so the fix the doctor advertises really repairs.
    const whole = current && await payloadComplete(current, deps.config, deps.fs);
    // An install touches one account. A payload of another version would move the accounts that use this one: an update does that.
    if (command === 'install' && target && current && current.version !== selected.version
      && (deps.registeredIds ?? []).some((id) => id !== target.id)) {
      throw new UsageError(ui.text('accountsOtherVersion', { version: current.version, command: deps.config.command }));
    }
    if (current?.version === selected.version && current.client === client && whole) {
      // The same steps in a dry run as in the run itself: the command link is planned, not skipped.
      const link = !flags.check && Boolean(current.link);
      const next = ui.sequence(planSteps({ upToDate: true, quota, link, register: Boolean(named) && !flags.check }), { client: label });
      ui.row(ui.text('upToDate'), 'ok', selected.version);
      // An account that is not registered yet gets the payload that is already here registered in its folder.
      if (named && deps.dryRun) {
        registrationPlan(current, deps, 'install').forEach((item) => ui.detail([item.command, ...item.args].join(' ')));
        next('register').plan();
      } else if (named && !flags.check) {
        deps.stage('register');
        finish(next('register'), await registerNamed(current));
      }
      // The MCP entry of this installation is read again: an installation whose first add failed is fixed by this one.
      if (deps.dryRun) mcpPlan(current, deps, 'install')?.steps.forEach((words) => ui.detail(shown(words, deps.platform)));
      else if (!flags.check && !named) {
        for (const account of acting) {
          const mcp = await ensureMcp(current, scoped(account));
          for (const note of mcpNotes(mcp, deps, 'install')) ui.note(note);
        }
      }
      deps.stage('quota');
      const recorded = await statusbar(current);
      if (recorded) finish(next('quota'), recorded);
      deps.stage('link');
      if (link && deps.dryRun) finishLink(ui, next('link'), null, { dryRun: true, command: deps.config.command, bin: deps.bin });
      else if (link) finishLink(ui, next('link'), await applyLink(current, deps));
      // Up to date is not enough: the install must also work (a dry run and --check change nothing, so they check nothing).
      const succeeded = flags.check || deps.dryRun || await verifyInstall(current, selected.version, deps);
      return await panelAfterSuccess(current, succeeded);
    }
    if (flags.check) {
      const next = ui.sequence(quota ? ['quota'] : [], { client: label });
      const recorded = await statusbar(current);
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
    if (deps.dryRun) {
      registrationPlan(planned, deps, refreshing ? 'update' : 'install').forEach((item) => ui.detail([item.command, ...item.args].join(' ')));
      mcpPlan(planned, deps, refreshing ? 'update' : 'install')?.steps.forEach((words) => ui.detail(shown(words, deps.platform)));
    }
    if (deps.dryRun) {
      next(getKey).plan(getDetail, getNotes);
      if (refreshing && current) next('backup').plan();
      next('files').plan(planned.path);
      next('register').plan();
      finishLink(ui, next('link'), null, { dryRun: !flags['no-link'], command: deps.config.command, bin: deps.bin });
      const recorded = await statusbar(current ?? planned);
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
        prerelease: Boolean(flags.prerelease), settings: deps.config,
        // A first install for an extra account leaves the default account unregistered.
        ...(target && !target.isDefault && !current ? { defaultRegistered: false } : {}) }, deps);
      next('files').ok(record.path);
      const action = refreshing ? 'update' : 'install';
      const done = await activate(record, current, deps, action, deps.stage,
        target ? moving.map((account) => ({ deps: scoped(account), action })) : null);
      finish(next('register'), done.registered);
      finishLink(ui, next('link'), done.linked);
      deps.hints.push(done.linked?.hint ?? null);
      if (current?.statusline) record.statusline = current.statusline;
      if (target) {
        // The payload is shared: the record notes which accounts hold a registration of it.
        if (moving.some(({ id }) => id === target.id)) markRegistered(record, target);
      }
      await saveRecord(deps.destination, record, deps);
      deps.stage('quota');
      const recorded = await statusbar(record);
      if (recorded) finish(next('quota'), recorded);
      if (refreshing) {
        deps.stage('smoke');
        if (io.smoke) {
          const smoke = await io.smoke(record);
          if (smoke.code !== 0 || smoke.records?.some((check) => check.status !== 'pass')) throw new Error('Smoke proof failed');
          if (smoke.report) ui.detail(smoke.report);
        } else {
          const smoke = await smokeProof(record, deps);
          if (smoke.code !== 0 || smoke.records?.some((check) => check.status !== 'pass')) throw new Error('Smoke proof failed');
          ui.detail(smoke.report);
        }
        next('smoke').ok();
      }
      // The install is left in place when it does not work: the rows say what to fix.
      return await panelAfterSuccess(record, await verifyInstall(record, selected.version, deps));
    } finally { if (!local) await fs.rm(downloaded.folder, { recursive: true, force: true }); }
  } catch (error) {
    const step = stage ? ui.text(stage, { client: label }) : '';
    const rollbackNext = command === 'update' && started && !flags.rollback ? ui.text('nextRollback', { command: deps.config.command }) : null;
    ui.failure({ step, client: flags.client, reason: error.message, next: rollbackNext ?? ui.text(started ? 'nextRetry' : 'nextCheck') })
      .forEach((item) => (ctx.err ?? ctx.out)(item));
    return exitCodeFor(started ? 'operational' : kindOf(error));
  }
}
