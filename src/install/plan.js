import * as filesystem from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { createStructuredPresenter, redact, resolveLocale } from './present.js';
import { hookCommand, registrationPlan } from './register.js';
import { mcpPlan } from './mcp-register.js';
import { linkPlan, pathProposal, pluginExecutable } from './link.js';
import { appliesStatusline, planStatusline, statuslineOf } from './statusline.js';
import { PANEL_CLIENT, panelOf, panelProposal } from './panel.js';
import { clientRoot, installConfig, renderName } from './config.js';
import { autostartPlan, detectAutostart } from '../autostart.js';
import { rolePrompt } from '../roles.js';
import { roleBlockProposal } from './role-block.js';
import { ACCOUNT_CLIENTS, accountFiles, accountsOf } from '../accounts.js';
import { configOf } from '../profiles.js';
import { latestRelease } from './release.js';
import { detect } from './menu.js';
import { STATUSLINE_FILE } from '../quota/statusline-collector.js';

/**
 * @typedef {object} InstallPlan
 * @property {1} schemaVersion
 * @property {'install'|'update'} operation
 * @property {object[]} clients Selected client/account roots.
 * @property {object[]} releases Pinned assets and integrity evidence.
 * @property {object[]} mutations Typed paths, argv and redacted diffs, never executable shell strings.
 * @property {object[]} fingerprints Re-observable input hashes and metadata.
 * @property {object[]} deferred Own-consent followups (`followup: true`), declared
 * apply-time observations (`resolvedAtApply`, exact argv and decision rule), or
 * unresolved core effects (`requiresObservation`) which still block consent.
 * @property {boolean} reviewable Core effects are declared, exit is zero and no ownership conflict exists.
 */

const hash = (value) => createHash('sha256').update(value).digest('hex');
const environmentIdentity = (env) => hash(JSON.stringify(Object.entries(env).sort(([a], [b]) => a.localeCompare(b))));
const safe = (value) => JSON.parse(JSON.stringify(value, (_key, item) =>
  typeof item === 'string' ? redact(item) : item));
const refusal = () => {
  throw Object.assign(new Error('Install preview cannot write or start processes.'),
    { name: 'PreviewCapabilityError', kind: 'operational' });
};
const READS = new Set(['readFile', 'readdir', 'readlink', 'realpath', 'stat', 'lstat', 'access']);

/** A preview has no writable filesystem capability, even with an injected adapter. */
function observingFilesystem(fs, inputs) {
  return new Proxy({}, { get(_target, key) {
    if (!READS.has(key)) return refusal;
    return async (...args) => {
      const path = String(args[0]);
      try {
        const result = await fs[key](...args);
        const value = key === 'readFile' ? hash(result)
          : key === 'readdir' ? result.map((item) => typeof item === 'string' ? item : item.name).sort()
            : key === 'readlink' || key === 'realpath' ? result : undefined;
        inputs.set(`${key}:${path}`, value === undefined ? await fingerprint(path, key, fs)
          : { kind: 'file', path, method: key, value });
        return result;
      } catch (error) {
        inputs.set(`${key}:${path}`, { kind: 'file', path, method: key, error: error.code ?? 'UNKNOWN' });
        throw error;
      }
    };
  } });
}

async function fingerprint(path, method, fs) {
  try {
    let value;
    if (method === 'readFile') value = hash(await fs.readFile(path));
    else if (method === 'readdir') value = (await fs.readdir(path)).sort();
    else if (method === 'readlink' || method === 'realpath') value = await fs[method](path);
    else {
      const stat = await fs[method === 'lstat' ? 'lstat' : 'stat'](path);
      value = { size: stat.size, mtimeMs: stat.mtimeMs, mode: stat.mode, directory: stat.isDirectory() };
    }
    return { kind: 'file', path, method, value };
  } catch (error) {
    if (!['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code)) throw error;
    return { kind: 'file', path, method, error: error.code };
  }
}

/** Re-observe all local dependencies; hashes never contain the input's plaintext. */
export async function compareInstallFingerprints(plan, { fs = filesystem, env = process.env, fetch = globalThis.fetch } = {}) {
  const changed = [];
  for (const input of plan.fingerprints) {
    try {
      const actual = input.kind === 'file' ? await fingerprint(input.path, input.method, fs)
        : input.kind === 'environment' ? { ...input, value: environmentIdentity(env) }
          : { ...input, value: releaseIdentity(await observeRelease(input, fs, fetch)) };
      if (JSON.stringify(actual) !== JSON.stringify(input)) changed.push(input.path ?? input.kind);
    } catch { changed.push(input.path ?? input.kind); }
  }
  return { matches: changed.length === 0, changed };
}

async function observeRelease(input, fs, fetch) {
  const user = JSON.parse(await fs.readFile(input.configPath, 'utf8').catch((error) => {
    if (error.code !== 'ENOENT') throw error;
    return '{}';
  }));
  const config = installConfig(user?.install);
  const release = configOf(user).release;
  return latestRelease({ ...input.request, config, release: { ...release, name: config.name ?? release.name }, fetch });
}

/** No apply capability is passed through this boundary. */
export async function buildInstallPlan(command, args, ctx, io = {}) {
  const inputs = new Map();
  const fs = observingFilesystem(io.fs ?? filesystem, inputs);
  const raw = await fs.readFile(join(ctx.root, 'config.json'), 'utf8').catch((error) => {
    if (error.code !== 'ENOENT') throw error;
    return '{}';
  });
  let saved;
  try { saved = JSON.parse(raw); } catch { saved = {}; }
  const locale = resolveLocale({ args, env: ctx.env, saved: saved?.language }).locale;
  const ui = createStructuredPresenter({ locale, verbose: args.includes('--verbose') });
  const config = installConfig(saved?.install);
  const run = async (request) => {
    const probe = { fs, env: ctx.env, platform: ctx.platform, config };
    const allowed = config.kit.path ?? await firstKitExecutable(probe);
    if (!allowed || request.command !== allowed || !isDeepStrictEqual(request.args, config.kit.versionArgs)) refusal();
    return (io.run ?? ctx.run)(request);
  };
  const plan = { schemaVersion: 1, operation: command, locale, clients: [], releases: [], mutations: [],
    conflicts: [], deferred: [], events: ui.events, fingerprints: [] };
  const { installerCommand } = await import('./index.js');
  const preview = { ...io, fs, ui, previewPlan: plan, run,
    pathExecute: refusal, policyExecute: refusal, write: refusal, writeConfig: refusal,
    startDaemon: refusal, stopDaemon: refusal, autostart: refusal };
  plan.exitCode = await installerCommand(command, args.includes('--dry-run') ? args : [...args, '--dry-run'],
    { ...ctx, run, write: refusal, writeConfig: refusal, out: () => {}, err: () => {} }, preview);
  for (const mutation of [...plan.mutations]) {
    if (!mutation.path || mutation.path.includes('*')) continue;
    const info = await fs.lstat(mutation.path).catch((error) => {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
      return null;
    });
    if (info?.isFile()) await fs.readFile(mutation.path);
    if (info?.isSymbolicLink()) await fs.readlink(mutation.path);
    let parent = dirname(mutation.path);
    plan.mutations.push({ kind: 'directory', path: parent });
    while (parent !== dirname(parent) && !await fs.stat(parent).catch(() => null)) {
      plan.mutations.push({ kind: 'directory', path: parent });
      parent = dirname(parent);
    }
  }
  plan.mutations = [...new Map(plan.mutations.map((item) => [JSON.stringify(item), item])).values()];
  plan.reviewable = plan.exitCode === 0 && !plan.conflicts.length
    && !plan.deferred.some((item) => item.requiresObservation && !item.followup && !item.resolvedAtApply);
  plan.fingerprints = [...plan.fingerprints, ...inputs.values(),
    { kind: 'environment', value: environmentIdentity(ctx.env ?? {}) },
  ];
  return safe(plan);
}

/** Paths and content hashes only; payload bytes never enter the public object. */
async function payloadInventory(selected, local, record, deps, mutations) {
  const put = (path, kind, bytes) => mutations.push({ kind, path,
    ...(bytes ? { sha256: hash(bytes) } : {}) });
  if (local) {
    const walk = async (source, target) => {
      put(target, 'directory');
      for (const entry of await deps.fs.readdir(source, { withFileTypes: true })) {
        const from = join(source, entry.name), to = join(target, entry.name);
        if (entry.isDirectory()) await walk(from, to);
        else if (entry.isSymbolicLink()) {
          mutations.push({ kind: 'symlink', path: to, target: await deps.fs.readlink(from) });
        }
        else put(to, 'payload', await deps.fs.readFile(from));
      }
    };
    await walk(local.source, record.path);
    return null;
  }
  mutations.push({ kind: 'payload-tree', path: record.path,
    source: { version: selected.version, name: selected.asset.name, url: selected.asset.browser_download_url },
    sha256: null, resolvedAtApply: true, recursive: true });
  return null;
}

const releaseIdentity = (selected) => hash(JSON.stringify({ version: selected.version,
  asset: selected.asset.name, url: selected.asset.browser_download_url }));

async function firstKitExecutable(deps) {
  for (const name of deps.config.kit.executables) {
    const found = await detect(name, deps);
    if (found && !await pluginExecutable(found, deps)) return found;
  }
  return null;
}

/** Inventory for a client selected by the existing installer rules. */
export async function collectClientPlan(plan, { command, flags, selected, local, current, whole,
  named, pkg, deps, accounts, releaseRequest }) {
  const upToDate = current?.version === selected.version && whole;
  const replacing = !upToDate && !flags.check;
  const action = command === 'update' || (current && local) ? 'update' : 'install';
  const record = upToDate ? current : { path: join(deps.destination, `${selected.version}-${flags.client}`),
    client: flags.client, version: selected.version, bin: pkg.bin[deps.config.command], previous: current };
  plan.destination = deps.destination;
  plan.clients.push({ client: flags.client, accounts: accounts.map((account) => ({
    id: account.accountScope?.id ?? 'default', root: account.clientRoot })), upToDate: Boolean(upToDate) });
  const changes = [];
  await payloadInventory(selected, local, record, deps, replacing ? changes : []);
  plan.releases.push({ client: flags.client, version: selected.version, asset: selected.asset.name,
    source: local ? local.source : selected.asset.browser_download_url,
    checksum: null, resolvedAtApply: !local, trustedLocal: Boolean(local),
    ...(selected.asset.id === undefined ? {} : { id: selected.asset.id }),
    ...(selected.asset.size === undefined ? {} : { size: selected.asset.size }) });
  if (!local) {
    const { repo, client, system, arch, prerelease, pkg: { name } } = releaseRequest;
    plan.fingerprints.push({ kind: 'release', configPath: join(deps.root, 'config.json'),
      request: { repo, client, system, arch, prerelease, pkg: { name } }, value: releaseIdentity(selected) });
  }
  const add = (item) => plan.mutations.push(safe({ client: flags.client, ...item }));
  for (const change of changes) add(change);
  if (replacing) {
    add({ kind: 'directory', path: deps.destination });
    add({ kind: 'staging', path: join(deps.destination, '.staging-*'), temporary: true });
    if (!local) add({ kind: 'download-staging', path: join(deps.temporary, 'installer-*'), temporary: true, recursive: true });
    const recordName = renderName({ template: deps.config.recordName, values: { client: flags.client } });
    add({ kind: 'record', path: join(deps.destination, recordName) });
    add({ kind: 'record-temporary', path: join(deps.destination, `${recordName}.tmp`) });
    add({ kind: 'remove-legacy-record', path: join(deps.destination, 'install.json') });
    for (const client of Object.keys(deps.config.clients)) {
      const path = join(deps.destination, renderName({ template: deps.config.recordName, values: { client } }));
      if (client !== flags.client && await deps.fs.stat(path).catch(() => null)) {
        add({ kind: 'shared-record', path, keys: ['link', 'linkDirectory', 'autostart'] });
        add({ kind: 'record-temporary', path: `${path}.tmp` });
      }
    }
  }
  plan.deferred.push({ kind: 'setup', optional: true, followup: true,
    path: join(deps.root, 'config.json'), keys: ['profiles', 'limits.clients', 'setup.detected', 'setup.done.profiles'] });
  if (deps.platform === deps.config.windowsPlatform && !flags['no-execution-policy']) {
    plan.deferred.push({ kind: 'policy', optional: !flags['set-execution-policy'],
      scope: 'CurrentUser', before: null, after: 'RemoteSigned', followup: true });
  }
  await registrationInventory({ plan, flags, record, current, accounts, action, replacing, named, add, deps });
  if (!flags.check) auxiliaryInventory({ plan, flags, record, accounts, action, replacing, add, deps });
}

function auxiliaryInventory({ plan, flags, record, accounts, action, replacing, add, deps }) {
  const config = configOf(deps.accountsConfig);
  const scratch = join(deps.temporary, 'selfcheck-*');
  add({ kind: 'selfcheck-scratch', path: scratch, temporary: true, recursive: true });
  add({ kind: 'selfcheck-config', path: join(scratch, 'config.json'), temporary: true });
  add({ kind: 'selfcheck-reading', path: join(scratch, 'quota', STATUSLINE_FILE), temporary: true });
  if (action === 'install' && replacing && config.quotaPoll.enabled && ACCOUNT_CLIENTS.includes(record.client)) for (const account of accounts) {
    const id = account.accountScope?.id ?? 'default';
    const reading = accountFiles(record.client, id).reading;
    const state = join(deps.root, 'quota', reading.replace(/\.json$/, '.state.json'));
    for (const path of [state, `${state}.request`, `${state}.lock`, `${state}.*.tmp`,
      join(deps.root, 'quota', reading), join(deps.root, 'quota', `${reading}.*.tmp`)]) {
      add({ kind: 'quota-read', path, conditional: true });
    }
    for (let index = 0; index < 4; index++) add({ kind: 'quota-slot', path: join(deps.root, 'quota', `read-slot-${index}.lock`), conditional: true });
    if (record.client === PANEL_CLIENT) {
      add({ kind: 'quota-fallback-lease', path: join(deps.root, 'quota', `${deps.config.clients[PANEL_CLIENT].executable}-fallback.lock`), conditional: true });
      add({ kind: 'quota-fallback-scratch', path: join(deps.root, 'quota', 'empty-*'), conditional: true, temporary: true });
    }
  }
  if (!flags['no-statusline'] && record.client === config.statuslineRegistration.client) {
    for (const account of accountsOf(deps.accountsConfig, record.client).filter((item) => !item.isDefault)) {
      const path = join(account.configDir, config.statuslineRegistration.settingsFile);
      add({ kind: 'account-collector', account: account.id, path, conditional: true });
      add({ kind: 'account-collector-metadata', path: join(deps.root, 'quota', `collector-${record.client}.${account.id}.json`), conditional: true });
      add({ kind: 'account-collector-temporary', path: `${path}.*.tmp`, temporary: true, conditional: true });
      plan.deferred.push({ kind: 'account-collector', account: account.id, path, followup: true,
        writes: ['statusline', 'collector-metadata'] });
    }
  }
}

const sensitive = /token|secret|password|credential|api[_-]?key|authorization/i;

/** Panel-only and rollback use retained payloads, without release acquisition. */
export async function collectRetainedPlan(plan, current, flags, deps, accounts) {
  plan.destination = deps.destination;
  plan.clients.push({ client: current.client, accounts: accounts.map((account) => ({
    id: account.accountScope?.id ?? 'default', root: account.clientRoot })) });
  const add = (item) => plan.mutations.push(safe({ client: current.client, ...item }));
  if (flags.panel) {
    const panel = panelProposal(current, flags, deps);
    if (!panel) return;
    add({ kind: 'panel-command', ...panel, optional: false, conditional: true });
    plan.deferred.push({ kind: 'panel-list', command: panel.command,
      args: ['plugin', 'list', '--json'], resolvedAtApply: true,
      decision: { whenPresent: 'skip', whenAbsent: 'install-panel', invalid: 'refuse' } });
  } else {
    const record = { ...current.previous, link: current.link, autostart: current.autostart,
      previous: current, ...(current.panel ? { panel: current.panel } : {}) };
    plan.releases.push({ client: record.client, version: record.version, source: record.path,
      checksum: record.sha256 ?? null, retained: true });
    await registrationInventory({ plan, flags: { ...flags, 'no-statusline': true, 'no-link': !record.link },
      record, current, accounts, action: 'update', replacing: true, named: false, add, deps });
  }
  for (const client of Object.keys(deps.config.clients)) {
    const path = join(deps.destination, renderName({ template: deps.config.recordName, values: { client } }));
    if (await deps.fs.stat(path).catch(() => null)) {
      add({ kind: 'record', path });
      add({ kind: 'record-temporary', path: `${path}.tmp` });
    }
  }
  add({ kind: 'remove-legacy-record', path: join(deps.destination, 'install.json') });
}

function diffText(value) {
  const text = Buffer.isBuffer(value) ? value.toString('utf8') : String(value ?? '');
  try {
    return redact(JSON.stringify(JSON.parse(text), (key, item) => sensitive.test(key) ? '[redacted]' : item, 2));
  } catch { /* Shell profiles and managed Markdown are text, not JSON. */ }
  return redact(text).split('\n').map((line) => sensitive.test(line) ? '[redacted]' : line).join('\n');
}

async function registrationInventory({ plan, flags, record, current, accounts, action, replacing, named, add, deps }) {
  for (const account of accounts) {
    const id = account.accountScope?.id ?? 'default';
    if (replacing || named) for (const entry of registrationPlan(record, account, action)) {
      add({ kind: 'client-command', account: id, ...entry });
    }
    const mcp = mcpPlan(record, account, action);
    if (mcp && !flags.check) {
      add({ kind: 'mcp', account: id, ...mcp,
        ownership: 'observe-before-apply', conflictPolicy: 'preserve-foreign' });
      plan.deferred.push({ kind: 'mcp-ownership', client: record.client, account: id,
        command: mcp.get[0], args: mcp.get.slice(1), resolvedAtApply: true,
        decision: { ownedAtConfiguredScope: 'replace', absent: 'register', foreign: 'preserve',
          unscopedExisting: 'preserve', ambiguous: 'preserve', invalid: 'refuse' } });
    }
    if (!flags.check && appliesStatusline(record, flags, account)) {
      const bar = await planStatusline(current ?? record, account).catch(() => {
        plan.conflicts.push({ kind: 'unreadable-statusline', client: record.client, account: id });
        return null;
      });
      if (bar) {
        add({ kind: 'statusline', account: id, path: bar.path,
          before: diffText(bar.original), after: diffText(bar.bytes) });
        add({ kind: 'statusline-temporary', path: `${bar.path}.*.tmp`, temporary: true });
        const backup = statuslineOf(current ?? record, account)?.backup ?? join(deps.root,
          `${deps.statuslineConfig.backupFile}${account.accountScope && !account.accountScope.isDefault ? `.${id}` : ''}`);
        add({ kind: 'statusline-backup', path: backup });
        add({ kind: 'statusline-backup-temporary', path: `${backup}.*.tmp`, temporary: true });
        add({ kind: 'record', path: join(deps.destination,
          renderName({ template: deps.config.recordName, values: { client: record.client } })) });
      }
    }
    if (replacing || named) {
      const root = account.clientRoot ?? clientRoot(record.client, account);
      const settings = deps.config.clients[record.client];
      await nativeRoleInventory(plan, record, account, add);
      if (settings.strategy === 'module' && settings.module) {
        add({ kind: 'directory', path: join(root, deps.config.pluginsDirectory) });
        add({ kind: 'module-staging', path: join(deps.temporary, 'plugin-*'), temporary: true, recursive: true });
        add({ kind: 'client-skills-tree', path: join(root, 'skills'), recursive: true,
          source: join(record.path, 'skills'), resolvedAtApply: true });
        add({ kind: 'client-module', account: id, path: join(root, deps.config.pluginsDirectory, `${deps.config.entry}.js`),
          source: join(record.path, settings.module), conflictPolicy: 'preserve-foreign' });
        for (const file of plan.mutations.filter((item) => item.kind === 'payload' && item.path.startsWith(join(record.path, 'skills') + '/'))) {
          add({ kind: 'client-skill', account: id, path: join(root, 'skills', file.path.slice(join(record.path, 'skills').length)),
            source: file.path, conflictPolicy: 'preserve-foreign' });
        }
      }
    }
    const panel = panelProposal(record, flags, account);
    if (panel && action === 'install') plan.deferred.push({ kind: 'panel', ...panel, followup: true });
    const held = panelOf(current, account);
    if (held && action === 'update' && replacing) add({ kind: 'panel-command', account: id,
      command: deps.config.clients[record.client].executable, args: ['plugin', 'update', held.identity, '--scope', 'user'] });
  }
  await sharedInventory({ plan, flags, record, current, action, replacing, add, deps });
}

async function sharedInventory({ plan, flags, record, current, action, replacing, add, deps }) {
  const linked = !flags.check && (current?.version === record.version && !replacing
    ? Boolean(current.link) : !flags['no-link'] && (current?.link ?? true));
  if (linked) {
    add({ kind: 'directory', path: deps.bin });
    for (const entry of linkPlan(record, deps)) {
      const exists = await deps.fs.lstat(entry.path).catch(() => null);
      const conflict = exists && !await pluginExecutable(entry.path, deps);
      add({ kind: 'command-link', ...entry, conflict: Boolean(conflict) });
      if (conflict) plan.conflicts.push({ kind: 'foreign-command', path: entry.path });
    }
    for (const command of deps.config.legacyCommands ?? []) {
      for (const entry of linkPlan(record, { ...deps, config: { ...deps.config, command } })) {
        if (await deps.fs.lstat(entry.path).catch(() => null) && await pluginExecutable(entry.path, deps)) {
          add({ kind: 'remove-legacy-link', path: entry.path });
        }
      }
    }
    for (const item of await pathProposal(deps)) {
      const change = { ...item, before: item.before === null ? null : diffText(item.before),
        after: item.after === null ? null : diffText(item.after) };
      add(change);
      if (item.conflict) plan.conflicts.push({ kind: 'foreign-profile-block', path: item.path });
      if (item.requiresObservation || item.resolvedAtApply) plan.deferred.push({ ...item });
    }
    add({ kind: 'path-state', path: join(deps.destination, deps.config.path.stateFile) });
  }
  if (replacing && action === 'update' && current && !flags.rollback) {
    const base = join(deps.destination, 'backups', String(deps.now()));
    const path = deps.backupPerClient ? join(base, record.client) : base;
    add({ kind: 'backup', path, sources: [deps.root, ...(deps.config.backupPaths ?? []),
      ...new Set([deps.clientRoot, ...(deps.accountRoots ?? [])].filter(Boolean))], recursive: true });
    const sources = [deps.root, ...(deps.config.backupPaths ?? []),
      ...new Set([deps.clientRoot, ...(deps.accountRoots ?? [])].filter(Boolean))];
    for (const [index, source] of [...new Set(sources)].entries()) {
      await backupInventory(source, join(path, String(index)), deps, add);
    }
    add({ kind: 'backup-record', path: join(path, 'sources.json') });
  }
  if (replacing && (flags.autostart || current?.autostart || deps.sharedAutostart)) {
    const service = autostartPlan(detectAutostart(deps.platform), {
      root: deps.root, home: deps.home, node: deps.config.node,
      script: join(record.path, record.bin), command: deps.config.command });
    add({ kind: 'autostart', ...service });
  }
}

async function backupInventory(source, target, deps, add) {
  if (source === deps.destination || source.startsWith(deps.destination + '/')) return;
  const info = await deps.fs.lstat(source).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (!info) return;
  add({ kind: info.isDirectory() ? 'directory' : 'backup-file', path: target, source });
  if (info.isDirectory()) for (const name of await deps.fs.readdir(source)) {
    if (deps.accountScope && /token|credential|secret|auth\.json|keychain|\.key$|\.pem$/i.test(name)) continue;
    await backupInventory(join(source, name), join(target, name), deps, add);
  }
}

async function nativeRoleInventory(plan, record, deps, add) {
  if (deps.platform === 'win32') return;
  const root = deps.clientRoot;
  const path = join(root, record.client === PANEL_CLIENT ? 'settings.json'
    : record.client === 'codex' ? 'AGENTS.md' : 'commands/okit.md');
  const before = await deps.fs.readFile(path, 'utf8').catch((error) => {
    if (error.code !== 'ENOENT') throw error;
    return '';
  });
  if (record.client === 'codex') {
    const override = await deps.fs.readFile(join(root, 'AGENTS.override.md'), 'utf8').catch(() => '');
    if (override.trim()) { plan.conflicts.push({ kind: 'role-override', path }); return; }
  }
  if (record.client !== PANEL_CLIENT) {
    const content = rolePrompt({ client: record.client }) + (record.client === 'opencode' ? '\nUse the okit-director agent.' : '');
    const proposal = roleBlockProposal(path, before, content);
    if (proposal.status !== 'ready') plan.conflicts.push({ kind: 'foreign-role-block', path });
    else add({ kind: 'native-role', path, before: diffText(before), after: diffText(proposal.after) });
    return;
  }
  let value;
  try { value = JSON.parse(before || '{}'); } catch { plan.conflicts.push({ kind: 'unreadable-role', path }); return; }
  const entry = { matcher: 'startup|resume|clear|compact', hooks: [{ type: 'command', command: hookCommand(record.path), timeout: 10 }] };
  if (!value || typeof value !== 'object' || Array.isArray(value) || (value.hooks?.SessionStart && !Array.isArray(value.hooks.SessionStart))) {
    plan.conflicts.push({ kind: 'unreadable-role', path }); return;
  }
  const previous = record.previous ? { ...entry, hooks: [{ ...entry.hooks[0], command: hookCommand(record.previous.path) }] } : null;
  const entries = (value.hooks?.SessionStart ?? []).filter((item) => !isDeepStrictEqual(item, entry)
    && (!previous || !isDeepStrictEqual(item, previous)));
  add({ kind: 'native-role', path, before: diffText(before),
    after: diffText(JSON.stringify({ ...value, hooks: { ...value.hooks, SessionStart: [...entries, entry] } }, null, 2) + '\n') });
}
