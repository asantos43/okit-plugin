// The release notes of a version: the changes of the root change history, the
// prerequisites, the names of the artifacts, the instructions of installation
// and update, the state of the proof of each pair and the gaps that are still
// open. The texts come from the configuration, the name, the version and the
// engines from `package.json`; nothing here is a project constant.

import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import process from 'node:process';

import { artifactName } from './build.js';
import { manifestFileName } from './checksums.js';
import { packageName, planPairs, renderName } from './config.js';

/** A regular expression that matches the text as it is. */
const escapeRegExp = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Fills the placeholders of a text with the values of the release.
 *
 * @param {string} text the text with the placeholders
 * @param {object} values the values of the placeholders
 * @returns {string} the text with the placeholders filled
 */
export function fill(text, values) {
  return String(text).replace(/\{(\w+)\}/g, (whole, key) => (
    key in values ? String(values[key]) : whole
  ));
}

/**
 * The lines of the `[Unreleased]` section of the change history.
 *
 * The text of every line is preserved as it is written, so the notes never
 * say more than the history says, including whitespace and blank lines.
 *
 * @param {string} raw the text of the change history
 * @param {object} [options]
 * @param {string} [options.section] the name of the section
 * @returns {{found: boolean, lines: string[]}} the lines of the section
 */
export function parseUnreleased(raw, { section = 'Unreleased' } = {}) {
  const wanted = new RegExp(`^##\\s+\\[?${escapeRegExp(section)}\\]?\\s*$`);
  const lines = [];
  let inside = false;

  for (const line of String(raw ?? '').split(/\r?\n/)) {
    if (!inside) {
      if (wanted.test(line)) inside = true;
      continue;
    }
    // The next section of the same level ends this one.
    if (/^##\s/.test(line)) break;
    lines.push(line);
  }

  return { found: inside, lines };
}

/**
 * The name of the notes file, from the name model of the configuration.
 *
 * @param {object} options
 * @param {object} options.config the resolved release configuration
 * @param {object} options.packageJson the metadata of the package
 * @returns {string} the name of the file
 */
export function notesFileName({ config, packageJson }) {
  return renderName({
    template: config.notes.fileName,
    values: { package: packageName(packageJson.name), version: packageJson.version },
  });
}

/**
 * The key of a pair in the proof record: the client and the system, the two
 * dimensions the proof of the design speaks about.
 *
 * @param {object} pair the pair
 * @returns {string} the key of the pair
 */
export function pairKey(pair) {
  return `${pair.client}:${pair.system}`;
}

/**
 * The label of a pair, as the notes name it.
 *
 * @param {object} pair the pair
 * @returns {string} the label
 */
export function pairLabel(pair) {
  return `${pair.client} × ${pair.system}`;
}

/**
 * The files of the pairs, named as the build names them, and the pairs the
 * configuration refuses.
 *
 * @param {object} options
 * @param {object} options.config the resolved release configuration
 * @param {object} options.packageJson the metadata of the package
 * @returns {{pairs: object[], refusals: object[]}} the pairs and the refusals
 */
export function planFiles({ config, packageJson }) {
  const { pairs, refusals } = planPairs({ config });
  return {
    pairs: pairs.map((pair) => ({ ...pair, file: artifactName({ config, packageJson, pair }) })),
    refusals,
  };
}

/**
 * The proof record of the pairs, read from the file the configuration names.
 * A file that is not there is a refusal: the record that was promised does
 * not exist.
 *
 * @param {object} options
 * @param {string} options.root the root of the repository
 * @param {object} options.config the resolved release configuration
 * @returns {Promise<{proof: object, refusal: string|null}>} the record
 */
export async function readProof({ root, config }) {
  const file = config.notes.proofFile;
  if (file === null || file === undefined) return { proof: {}, refusal: null };
  const path = join(root, file);
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return { proof: {}, refusal: `the proof record cannot be read: ${file}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { proof: {}, refusal: `the proof record is not valid JSON: ${file}` };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { proof: {}, refusal: `the proof record is not an object: ${file}` };
  }
  return { proof: parsed, refusal: null };
}

/**
 * The state of the proof of one pair: the one the record carries, or the
 * unproven state while the Producer has not registered it.
 *
 * @param {object} options
 * @param {object} options.config the resolved release configuration
 * @param {object} options.pair the pair
 * @param {object} [options.proof] the proof record, by pair key
 * @returns {{state: string, refusal: string|null}} the state and the refusal
 */
export function proofStatus({ config, pair, proof = {} }) {
  const key = pairKey(pair);
  const status = config.notes.status;
  const given = proof[key];
  if (given === undefined || given === null) return { state: status.unproven, refusal: null };
  const state = String(given).trim();
  const known = [status.unproven, status.proven, status.partial];
  if (!known.includes(state)) {
    return { state: status.unproven, refusal: `unknown proof status "${state}" for ${key}` };
  }
  return { state, refusal: null };
}

/**
 * The notes of one version, as the text of the file.
 *
 * The text is deterministic: it carries no moment of the machine and no
 * value of the project, so two runs over the same source write the same
 * bytes.
 *
 * @param {object} options
 * @param {object} options.config the resolved release configuration
 * @param {object} options.packageJson the metadata of the package
 * @param {object[]} options.pairs the pairs of the release
 * @param {string[]} options.lines the lines of the change history
 * @param {object} [options.proof] the proof record, by pair key
 * @returns {string} the text of the notes
 */
export function renderNotes({ config, packageJson, pairs, lines, proof = {} }) {
  const notes = config.notes;
  const values = {
    package: packageName(packageJson.name),
    version: packageJson.version,
    engines: packageJson.engines?.node ?? '',
    manifest: manifestFileName(packageJson),
    section: notes.section,
    history: notes.history,
  };
  const out = [];

  out.push(`# ${fill(notes.title, values)}`);
  out.push('');
  out.push(`## ${notes.headings.version}`);
  out.push('');
  out.push(`- ${notes.labels.package}: \`${values.package}\``);
  out.push(`- ${notes.labels.version}: \`${values.version}\``);
  out.push('');
  out.push(`## ${notes.headings.prerequisites}`);
  out.push('');
  const engines = packageJson.engines?.node;
  if (typeof engines === 'string' && engines.trim() !== '') {
    out.push(`- ${fill(notes.prerequisites, values)}`);
  } else {
    out.push(`- ${notes.prerequisitesNone}`);
  }
  out.push('');
  out.push(`## ${notes.headings.artifacts}`);
  out.push('');
  for (const pair of pairs) out.push(`- \`${pair.file}\``);
  out.push('');
  out.push(`- ${fill(notes.manifest, values)}`);
  out.push('');
  out.push(`## ${notes.headings.install}`);
  out.push('');
  notes.install.forEach((step, index) => out.push(`${index + 1}. ${fill(step, values)}`));
  out.push('');
  out.push(`### ${notes.headings.update}`);
  out.push('');
  notes.update.forEach((step, index) => out.push(`${index + 1}. ${fill(step, values)}`));
  out.push('');
  out.push(`## ${notes.headings.proof}`);
  out.push('');
  out.push(`| ${notes.labels.pair} | ${notes.labels.state} | ${notes.labels.signer} |`);
  out.push('| :- | :- | :- |');
  for (const pair of pairs) {
    const { state } = proofStatus({ config, pair, proof });
    const signer = notes.proofBy[pair.system] ?? notes.proofByOther;
    out.push(`| ${pairLabel(pair)} | ${state} | ${signer} |`);
  }
  out.push('');
  out.push(`## ${notes.headings.gaps}`);
  out.push('');
  out.push(notes.gapsIntro);
  for (const pair of pairs) {
    const { state } = proofStatus({ config, pair, proof });
    if (state === notes.status.proven) continue;
    out.push(fill(notes.gapLine, { ...values, pair: pairLabel(pair), state }));
  }
  out.push('');
  out.push(`## ${notes.headings.changes}`);
  out.push('');
  out.push(fill(notes.source, values));
  out.push('');
  for (const line of lines) out.push(line);
  out.push('');

  return out.join('\n');
}

/**
 * Prepares the notes of a version without writing an output file.
 *
 * The history of the repository root is the only source of the changes, and
 * it is read, never written: the notes never become a second history. A
 * history that is not there, a section that is empty or a version that does
 * not match the package are refusals with a reason, and no file is written.
 *
 * @param {object} options
 * @param {string} options.root the root of the repository
 * @param {object} options.config the resolved release configuration
 * @param {object} options.packageJson the metadata of the package
 * @param {string} [options.out] the output folder
 * @param {string} [options.version] the version the notes are for
 * @returns {Promise<{file: string, notes: string, pairs: object[], refusal: string|null}>} the result
 */
export async function buildNotes({ root, config, packageJson, out = null, version = null }) {
  const refuse = (reason) => ({ file: null, notes: null, pairs: [], refusal: reason });

  if (version !== null && version !== packageJson.version) {
    return refuse(`the version "${version}" is not the version of the package ("${packageJson.version}")`);
  }

  const historyPath = join(root, config.notes.history);
  let raw;
  try {
    raw = await readFile(historyPath, 'utf8');
  } catch {
    return refuse(`the change history is missing: ${config.notes.history}`);
  }

  const { found, lines } = parseUnreleased(raw, { section: config.notes.section });
  if (!found) {
    return refuse(`the change history has no [${config.notes.section}] section: ${config.notes.history}`);
  }
  const content = lines.join('\n').replace(/<!--[\s\S]*?-->/g, '');
  if (!content.split('\n').some((line) => line.trim() && !/^\s*#{1,6}\s/.test(line))) {
    return refuse(`the [${config.notes.section}] section of the change history is empty: ${config.notes.history}`);
  }

  const { pairs, refusals } = planFiles({ config, packageJson });
  if (pairs.length === 0 && refusals.length === 0) return refuse('the release has no configured pairs');
  if (refusals.length > 0) {
    const reason = refusals.map((item) => item.reason).join('; ');
    return refuse(`the release refuses a pair: ${reason}`);
  }

  const { proof, refusal: proofRefusal } = await readProof({ root, config });
  if (proofRefusal !== null) return refuse(proofRefusal);
  for (const pair of pairs) {
    const { refusal } = proofStatus({ config, pair, proof });
    if (refusal !== null) return refuse(refusal);
  }

  const file = notesFileName({ config, packageJson });
  const notes = renderNotes({ config, packageJson, pairs, lines, proof });
  const folder = out === null ? resolve(root, config.outputDir) : resolve(process.cwd(), out);

  return { file: join(folder, file), notes, pairs, refusal: null };
}
