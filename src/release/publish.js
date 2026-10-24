import { execFile } from 'node:child_process';
import { readFile, writeFile, lstat, mkdir } from 'node:fs/promises';
import { basename, join, relative, resolve, isAbsolute, sep } from 'node:path';
import { promisify } from 'node:util';
import { buildRelease } from './build.js';
import { buildChecklist } from './checklist.js';
import { manifestFileName, unsafePathReason, verifyManifest, writeManifest } from './checksums.js';
import { packageName, releaseConfig, renderName } from './config.js';
import { buildNotes, fill, proofStatus, readProof } from './notes.js';

const run = promisify(execFile);
// Git protocol namespace; not a project setting.
const GIT_TAG_NAMESPACE = 'refs/tags/';
// Conservative single-component Git ref: no options, traversal or .lock suffix.
const SAFE_TAG = /^(?!.*\.\.)(?!.*\.lock$)[A-Za-z0-9_][A-Za-z0-9._+-]*(?<!\.)$/;
const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;

function repositoryWithoutCredentials(repository) {
  const scp = /^(?:[^@/:\s]+@)?([A-Za-z0-9.-]+):([^\s:]+)$/.exec(repository);
  if (!repository.includes('://') && scp) {
    repository = `ssh://${scp[1]}/${scp[2]}`;
  }
  let url;
  try { url = new URL(repository); } catch { throw new Error('unsupported repository remote: use an HTTPS or SSH host/owner/repo URL; local paths are refused'); }
  if (!['https:', 'ssh:'].includes(url.protocol) || !url.hostname
    || !/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/.test(url.pathname)) {
    throw new Error('unsupported repository remote: use HTTPS or SSH host/owner/repo; local paths are refused');
  }
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  return url.protocol === 'https:' ? url.href : `${url.host}${url.pathname.replace(/\.git\/?$/, '').replace(/\/$/, '')}`;
}

export class PublishFailedError extends Error {
  constructor(tag, cause) {
    super(`publish failed (the release may be partly created): tag ${tag}: ${cause.message}`, { cause });
  }
}

function validateSettings(settings) {
  if (!['never', 'auto', 'always'].includes(settings.prerelease)) {
    throw new Error('invalid release.publish.prerelease: expected never, auto or always');
  }
  let safeName;
  if (typeof settings.safeName !== 'string' || !settings.safeName) throw new Error('invalid release.publish.safeName');
  try { safeName = new RegExp(settings.safeName); } catch { throw new Error('invalid release.publish.safeName'); }
  for (const key of ['remote', 'branch', 'executable', 'gitExecutable']) {
    if (typeof settings[key] !== 'string' || !settings[key] || safeName.exec(settings[key])?.[0] !== settings[key]) {
      throw new Error(`unsafe release.publish.${key}: use a name/path matching release.publish.safeName (no leading -, spaces or controls)`);
    }
  }
}

/** Git transport is injected by tests; no GitHub process runs before verification. */
export async function inspectGit({ root, tag, outputDir, settings = releaseConfig().publish, env = process.env, git = async (args) => (
  await run(settings.gitExecutable, args, { cwd: root, env })
).stdout.trim() }) {
  validateSettings(settings);
  if (await git(['status', '--porcelain', '--untracked-files=all'])) throw new Error('working tree is dirty');
  const localOutput = outputDir === undefined ? null : relative(resolve(root), outputDir);
  if (localOutput !== null && !isAbsolute(localOutput) && localOutput !== '..' && !localOutput.startsWith(`..${sep}`)) {
    const ignored = await git(['check-ignore', '--', `${localOutput || '.'}/`]).catch((error) => {
      if (error.code === 1) return '';
      throw error;
    });
    if (!ignored) throw new Error('unsafe --out inside repository: add the output directory to .gitignore or use a directory outside the repository');
  }
  await git(['fetch', '--', settings.remote, settings.branch]);
  // rev-parse uses --end-of-options: bare -- switches to path output.
  const sha = await git(['rev-parse', '--verify', '--end-of-options', 'HEAD']);
  const upstream = `refs/remotes/${settings.remote}/${settings.branch}`;
  if (sha !== await git(['rev-parse', '--verify', '--end-of-options', upstream])) throw new Error(`HEAD differs from ${settings.remote}/${settings.branch}`);
  const ref = `${GIT_TAG_NAMESPACE}${tag}`;
  if (await git(['tag', '--list', '--', tag]) || await git(['ls-remote', '--tags', '--', settings.remote, ref, `${ref}^{}`])) {
    throw new Error(`tag already exists: ${tag}`);
  }
  return { sha, repository: repositoryWithoutCredentials(await git(['remote', 'get-url', '--', settings.remote])) };
}

/** Prepare only generated attachments; default execution never invokes GitHub. */
export async function publishRelease({ root, config: user = {}, userConfig = {}, out = null,
  publish = false, git, verify = verifyManifest, env = process.env }) {
  const config = releaseConfig(user);
  const settings = config.publish;
  validateSettings(settings);
  const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const tag = `${settings.tagPrefix}${packageJson.version}`;
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(packageJson.version)) {
    throw new Error('invalid package version');
  }
  if (!SAFE_TAG.test(tag)) throw new Error('unsafe release tag');
  if (!Number.isSafeInteger(settings.requiredPairs) || settings.requiredPairs < 1) throw new Error('invalid requiredPairs');
  const outputDir = out === null ? resolve(root, settings.outputDir) : resolve(out);
  const { sha, repository } = await inspectGit({ root, tag, outputDir, git, settings, env });
  const notes = await buildNotes({ root, config, packageJson, out: outputDir });
  if (notes.refusal) throw new Error(notes.refusal);
  const checklistName = renderName({ template: config.checklist.fileName,
    values: { package: packageName(packageJson.name), version: packageJson.version } });
  const planned = [...notes.pairs.map(({ file }) => file), relative(outputDir, notes.file),
    checklistName, manifestFileName(packageJson)];
  const bodyName = renderName({ template: settings.bodyFile,
    values: { package: packageName(packageJson.name), version: packageJson.version } });
  for (const name of [settings.bodyDir, bodyName]) {
    if (typeof name !== 'string' || unsafePathReason(name) || name !== basename(name)) throw new Error('unsafe release body path');
  }
  if (planned.includes(settings.bodyDir)) throw new Error('duplicate release filenames');
  const bodyDir = join(outputDir, settings.bodyDir);
  const bodyFile = join(bodyDir, bodyName);
  for (const [file, directory] of [[bodyDir, true], [bodyFile, false]]) {
    const info = await lstat(file).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (info && !(directory ? info.isDirectory() : info.isFile())) throw new Error('unsafe release body path');
  }
  if (new Set(planned).size !== planned.length) throw new Error('duplicate release filenames');
  for (const name of planned) {
    if (unsafePathReason(name) || name !== basename(name)) throw new Error(`unsafe attachment: ${name}`);
    const existing = await lstat(join(outputDir, name)).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (existing && !existing.isFile()) throw new Error(`unsafe attachment: ${name}`);
  }
  const { proof, refusal } = await readProof({ root, config });
  if (refusal) throw new Error(refusal);
  const pairCount = new Set(notes.pairs.map(({ client, system }) => `${client}:${system}`)).size;
  const unproven = pairCount < settings.requiredPairs
    || notes.pairs.some((pair) => proofStatus({ config, pair, proof }).state !== config.notes.status.proven);
  const prerelease = settings.prerelease === 'always' || (settings.prerelease === 'auto' && unproven);
  const built = await buildRelease({ root, config, userConfig, out: outputDir, env });
  if (built.refused.length) throw new Error(built.refused.map((item) => item.reason).join('; '));
  const payloads = built.built.map(({ file }) => file);
  const manifest = join(outputDir, manifestFileName(packageJson));
  await writeManifest({ dir: outputDir, files: payloads, out: manifest });
  const checklist = await buildChecklist({ root, config, packageJson, out: outputDir, revision: sha });
  if (checklist.refusal) throw new Error(checklist.refusal);
  await writeFile(notes.file, notes.notes);
  await writeFile(checklist.file, checklist.checklist);
  const covered = [...payloads, basename(notes.file), basename(checklist.file)];
  await writeManifest({ dir: outputDir, files: covered, out: manifest });
  const verification = await verify(manifest, { dir: outputDir });
  if (!verification.ok) throw new Error(`checksum verification failed: ${JSON.stringify(verification.problems)}`);
  await mkdir(bodyDir, { recursive: true });
  await writeFile(bodyFile, unproven ? `${settings.unprovenNotice}\n\n${notes.notes}` : notes.notes);
  const groups = { payloads, notes: [basename(notes.file)], checklist: [basename(checklist.file)], checksums: [basename(manifest)] };
  if (!Array.isArray(settings.attachments) || settings.attachments.length === 0
    || settings.attachments.some((key) => !Object.hasOwn(groups, key))) throw new Error('invalid publish attachments');
  const names = [...new Set(settings.attachments.flatMap((key) => groups[key]))];
  for (const name of [...covered, basename(manifest)]) {
    if (unsafePathReason(name) || !(await lstat(join(outputDir, name))).isFile()) throw new Error(`unsafe attachment: ${name}`);
  }
  const files = names.map((name) => join(outputDir, name));
  const title = fill(settings.title, { package: packageJson.name, version: packageJson.version });
  const args = ['release', 'create', tag, '--repo', repository, '--target', sha,
    ...(prerelease ? ['--prerelease'] : settings.latest ? ['--latest'] : []),
    '--title', title, '--notes-file', bodyFile, '--', ...files];
  const command = [settings.executable, ...args].map(quote).join(' ');
  if (publish) {
    const current = await inspectGit({ root, tag, outputDir, git, settings, env });
    if (current.sha !== sha) throw new Error('HEAD changed during release preparation');
    if (current.repository !== repository) throw new Error('repository changed during release preparation');
    try {
      await run(settings.executable, args, { cwd: root, env });
    } catch (error) {
      throw new PublishFailedError(tag, error);
    }
  }
  return { title, tag, sha, prerelease, files, args, command, outputDir };
}
