// The release configuration: the pairs to build, the format of each system,
// the output folder, the name of each artifact and the files that enter a
// payload. The defaults live in `DEFAULT_CONFIG.release`; the user
// configuration and the build flags replace them, and nothing here is a
// project constant: the name, the version, the licence, the repository, the
// bin and the engines come from `package.json`.

import { DEFAULT_CONFIG } from '../profiles.js';

const DEFAULTS = DEFAULT_CONFIG.release;

/** The archive formats this build knows how to write. */
export const FORMATS = ['tar.gz', 'zip'];

/** The placeholder names the name model understands. */
const NAME_PARTS = ['package', 'version', 'client', 'system', 'arch', 'ext'];

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

const isText = (value) => typeof value === 'string' && value.trim() !== '';

const isList = (value) => Array.isArray(value) && value.length > 0 && value.every(isText);

/**
 * Merges the user configuration over the defaults. The sections that hold a
 * map (the formats, the adapters, the client files) merge key by key, so a
 * user who changes one format keeps the other two.
 *
 * @param {object} [user] the user's `release` configuration
 * @returns {object} the resolved configuration
 */
export function releaseConfig(user = {}) {
  const given = isPlainObject(user) ? user : {};
  const merged = { ...DEFAULTS, ...given };
  const map = (base, extra) => ({ ...base, ...(isPlainObject(extra) ? extra : {}) });
  return {
    ...merged,
    publish: map(DEFAULTS.publish, given.publish),
    formats: map(DEFAULTS.formats, given.formats),
    adapters: map(DEFAULTS.adapters, given.adapters),
    clientFiles: map(DEFAULTS.clientFiles, given.clientFiles),
    instructions: map(DEFAULTS.instructions, given.instructions),
    marketplace: { ...DEFAULTS.marketplace, ...(given.marketplace ?? {}) },
    modes: { ...DEFAULTS.modes, ...(given.modes ?? {}) },
    checklist: {
      ...DEFAULTS.checklist,
      ...(isPlainObject(given.checklist) ? given.checklist : {}),
      ...Object.fromEntries(['headings', 'labels', 'layers', 'layerLabels'].map((key) => [
        key, map(DEFAULTS.checklist[key], given.checklist?.[key]),
      ])),
      proofBy: map(map(map(DEFAULTS.notes.proofBy, given.notes?.proofBy), DEFAULTS.checklist.proofBy), given.checklist?.proofBy),
    },
    notes: {
      ...DEFAULTS.notes,
      ...(isPlainObject(given.notes) ? given.notes : {}),
      proofBy: map(DEFAULTS.notes.proofBy, isPlainObject(given.notes) ? given.notes.proofBy : {}),
      status: map(DEFAULTS.notes.status, isPlainObject(given.notes) ? given.notes.status : {}),
      headings: map(DEFAULTS.notes.headings, isPlainObject(given.notes) ? given.notes.headings : {}),
      labels: map(DEFAULTS.notes.labels, isPlainObject(given.notes) ? given.notes.labels : {}),
    },
  };
}

/**
 * The name of the package, safe for a file name: the npm name can hold
 * characters a file name should not, and a scope is a folder.
 *
 * @param {string} name the name of the package
 * @returns {string} the name as a file name
 */
export function packageName(name) {
  return String(name ?? '')
    .replace(/^@/, '')
    .replace(/[/\\]+/g, '-')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || 'package';
}

/**
 * The extension of an archive, without the dot: `tar.gz` stays `tar.gz`.
 *
 * @param {string} format the archive format
 * @returns {string} the extension
 */
export function extensionOf(format) {
  return String(format ?? '').replace(/^\./, '');
}

/**
 * Fills the name model with the values of one pair.
 *
 * @param {object} options
 * @param {string} options.template the name model
 * @param {object} options.values the values of the pair
 * @returns {string} the name of the artifact
 */
export function renderName({ template, values }) {
  return String(template).replace(/\{(\w+)\}/g, (whole, key) => (
    NAME_PARTS.includes(key) ? String(values[key] ?? '') : whole
  ));
}

/**
 * The pairs to build, and the ones to refuse.
 *
 * A pair is a client, a system and an architecture. A client the
 * configuration does not name, a system it does not name, a system without an
 * archive format and an architecture that is not configured are refusals, each
 * with the reason it was refused.
 *
 * @param {object} options
 * @param {object} options.config the resolved release configuration
 * @param {string} [options.client] build only this client
 * @param {string} [options.system] build only this system
 * @param {string} [options.arch] build only this architecture
 * @returns {{pairs: object[], refusals: object[]}} the pairs and the refusals
 */
export function planPairs({ config, client = null, system = null, arch = null }) {
  const pairs = [];
  const refusals = [];
  const clients = isList(config.clients) ? config.clients : [];
  const systems = isList(config.systems) ? config.systems : [];
  const architectures = isList(config.architectures) ? config.architectures : [];

  if (client !== null && !clients.includes(client)) {
    refusals.push({ client, system, arch, reason: `unknown client "${client}"` });
    return { pairs, refusals };
  }
  if (system !== null && !systems.includes(system)) {
    refusals.push({ client, system, arch, reason: `unknown system "${system}"` });
    return { pairs, refusals };
  }
  if (arch !== null && !architectures.includes(arch)) {
    refusals.push({ client, system, arch, reason: `unknown architecture "${arch}"` });
    return { pairs, refusals };
  }

  const wanted = (value, list) => (value === null ? list : list.filter((item) => item === value));
  for (const one of wanted(client, clients)) {
    for (const two of wanted(system, systems)) {
      for (const three of wanted(arch, architectures)) {
        const format = config.formats?.[two];
        if (!isText(format)) {
          refusals.push({ client: one, system: two, arch: three, reason: `no archive format for system "${two}"` });
          continue;
        }
        if (!FORMATS.includes(format)) {
          refusals.push({ client: one, system: two, arch: three, reason: `unknown archive format "${format}"` });
          continue;
        }
        pairs.push({ client: one, system: two, arch: three, format });
      }
    }
  }
  return { pairs, refusals };
}
