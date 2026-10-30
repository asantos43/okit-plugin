import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { manifestFileName, parseManifest, unsafePathReason } from './checksums.js';
import { packageName, renderName } from './config.js';
import { fill, pairLabel, planFiles, proofBasis, proofStatus, readProof } from './notes.js';
import { loadAdapter } from './payload.js';

/** Pure rendering: no clock, smoke, filesystem writes or hash calculation. */
export function renderChecklist({ config, packageJson, pairs, proof = {}, hashes = {}, revision = '' }) {
  const text = config.checklist;
  const values = { package: packageName(packageJson.name), version: packageJson.version,
    bin: Object.keys(packageJson.bin ?? {})[0] ?? '',
    manifest: manifestFileName(packageJson), partial: config.notes.status.partial };
  const lines = [`# ${fill(text.title, values)}`, ''];
  for (const instruction of text.instructions) lines.push(fill(instruction, values), '');
  const row = (label, value = '') => `| ${label} | ${String(value).replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ')} |`;
  for (const pair of pairs) {
    lines.push(`## [ ] ${pairLabel(pair)} (${pair.arch})`, '',
      row(text.headings.field, text.headings.value), '| :- | :- |');
    const filled = { revision, version: packageJson.version, file: pair.file,
      sha256: hashes[pair.file] ?? '', environment: `${pair.system} / / ${pair.arch}` };
    for (const [key, label] of Object.entries(text.labels)) lines.push(row(label, filled[key] ?? ''));
    lines.push(row(config.notes.labels.state, proofStatus({ config, pair, proof }).state));
    lines.push(row(config.notes.labels.basis, proofBasis({ config, pair })));
    lines.push(row(config.notes.labels.signer, text.proofBy[pair.system] ?? config.notes.proofByOther), '');
    for (const layer of Object.values(text.layers)) {
      lines.push(`### ${layer}`, '', row(text.headings.field, text.headings.value), '| :- | :- |');
      for (const label of Object.values(text.layerLabels)) lines.push(row(label));
      lines.push('');
    }
  }
  lines.push(text.producerSignature, '');
  return lines.join('\n');
}

/** Prepare the record, refusing invalid inputs before any output is written. */
export async function buildChecklist({ root, config, packageJson, out = null, version = null, revision = '' }) {
  const refuse = (refusal) => ({ file: null, checklist: null, pairs: [], refusal });
  if (version !== null && version !== packageJson.version) {
    return refuse(`the version "${version}" is not the version of the package ("${packageJson.version}")`);
  }
  const { pairs, refusals } = planFiles({ config, packageJson });
  if (refusals.length) return refuse(refusals.map((item) => item.reason).join('; '));
  if (!pairs.length) return refuse('the release has no configured pairs');
  for (const pair of pairs) {
    const { refusal } = await loadAdapter({ root, config, client: pair.client });
    if (refusal !== null) return refuse(refusal);
  }
  const { proof, refusal } = await readProof({ root, config });
  if (refusal !== null) return refuse(refusal);
  for (const pair of pairs) {
    const { refusal: problem } = proofStatus({ config, pair, proof });
    if (problem !== null) return refuse(problem);
  }
  const folder = out === null ? resolve(root, config.outputDir) : resolve(out);
  let raw = null;
  try { raw = await readFile(join(folder, manifestFileName(packageJson)), 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') return refuse(error.message); }
  const problems = [];
  const entries = raw === null ? [] : parseManifest(raw, problems);
  if (problems.length || entries.some(({ name }) => unsafePathReason(name))) {
    return refuse('invalid checksum manifest');
  }
  const hashes = Object.fromEntries(entries.map(({ name, hash }) => [name, hash]));
  const fileName = renderName({ template: config.checklist.fileName,
    values: { package: packageName(packageJson.name), version: packageJson.version } });
  if (unsafePathReason(fileName)) return refuse('unsafe checklist filename');
  const file = join(folder, fileName);
  const checklist = renderChecklist({ config, packageJson, pairs, proof, hashes, revision });
  try {
    if (await readFile(file, 'utf8') !== checklist) return refuse(`existing checklist differs: ${file}`);
  } catch (error) { if (error.code !== 'ENOENT') return refuse(error.message); }
  return { file, checklist, pairs, refusal: null };
}
