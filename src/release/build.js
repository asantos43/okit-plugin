// The build of the release: the pairs that were asked for, the payload of
// each one and the archives that come out of it. Nothing is published, no
// tag is cut and no file is written outside the output folder.

import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

import { tarGz, zip } from './archive.js';
import { extensionOf, packageName, planPairs, releaseConfig, renderName } from './config.js';
import { payloadEntries } from './payload.js';

const WRITERS = { 'tar.gz': tarGz, zip };
const run = promisify(execFile);

/**
 * The moment every entry carries, so two builds of the same source produce
 * the same bytes. `SOURCE_DATE_EPOCH` wins; without it the commit date of the
 * revision is used, and without a repository the epoch itself.
 *
 * @param {object} options
 * @param {string} options.root the root of the repository
 * @param {object} options.env the environment
 * @returns {Promise<number>} the seconds since the epoch
 */
export async function sourceDate({ root, env = process.env }) {
  const given = Number.parseInt(env?.SOURCE_DATE_EPOCH ?? '', 10);
  if (Number.isInteger(given) && given >= 0) return given;
  return commitDate(root);
}

/**
 * The date of the commit the build reads, in seconds since the epoch.
 *
 * @param {string} root the root of the repository
 * @returns {Promise<number>} the seconds since the epoch
 */
async function commitDate(root) {
  try {
    const { stdout } = await run('git', ['log', '-1', '--format=%ct'], { cwd: root });
    const seconds = Number.parseInt(stdout.trim(), 10);
    return Number.isInteger(seconds) && seconds >= 0 ? seconds : 0;
  } catch {
    return 0;
  }
}

/**
 * The name of the artifact of one pair.
 *
 * @param {object} options
 * @param {object} options.config the resolved release configuration
 * @param {object} options.packageJson the metadata of the package
 * @param {object} options.pair the pair: `{client, system, arch}`
 * @returns {string} the name of the file
 */
export function artifactName({ config, packageJson, pair }) {
  return renderName({
    template: config.name,
    values: {
      package: packageName(packageJson.name),
      version: packageJson.version,
      client: pair.client,
      system: pair.system,
      arch: pair.arch,
      ext: extensionOf(config.formats[pair.system]),
    },
  });
}

/**
 * Builds the release.
 *
 * Every pair asked for is built on its own: a pair whose client has no
 * adapter, or whose client is unknown, is refused with the reason, and no
 * empty package is written in its place. The exit code is the number of
 * refusals, so a run that refused something is never a success.
 *
 * @param {object} options
 * @param {string} options.root the root of the repository
 * @param {object} [options.config] the `release` section of the user configuration
 * @param {object} [options.userConfig] the whole configuration of the user
 * @param {string} [options.out] the output folder
 * @param {string} [options.client] build only this client
 * @param {string} [options.system] build only this system
 * @param {string} [options.arch] build only this architecture
 * @param {boolean} [options.dryRun] list what would be built, write nothing
 * @param {object} [options.env] the environment
 * @returns {Promise<{built: object[], refused: object[], outputDir: string}>} the result
 */
export async function buildRelease({
  root,
  config: userRelease = {},
  userConfig = {},
  out = null,
  client = null,
  system = null,
  arch = null,
  dryRun = false,
  env = process.env,
}) {
  const config = releaseConfig(userRelease);
  const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  // An explicit folder is relative to where the command ran; the configured
  // one is relative to the repository it belongs to.
  const outputDir = out === null
    ? resolve(root, config.outputDir)
    : resolve(process.cwd(), out);
  const { pairs, refusals } = planPairs({ config, client, system, arch });
  const mtime = await sourceDate({ root, env });

  const built = [];
  for (const pair of pairs) {
    const { entries, refusal } = await payloadEntries({
      root,
      config,
      packageJson,
      pair,
      userConfig,
    });
    if (refusal !== null) {
      refusals.push({ ...pair, reason: refusal });
      continue;
    }
    const file = artifactName({ config, packageJson, pair });
    const write = WRITERS[pair.format];
    const bytes = write(entries, { mtime });
    if (!dryRun) {
      await mkdir(outputDir, { recursive: true });
      await writeFile(join(outputDir, file), bytes);
    }
    built.push({ ...pair, file, bytes: bytes.length, entries: entries.length });
  }

  return { built, refused: refusals, outputDir };
}
