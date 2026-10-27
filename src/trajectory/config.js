import { resolve } from 'node:path';
import { readJson } from '../state.js';
import { paths } from '../store.js';
import { DEFAULT_CONFIG } from '../profiles.js';

export async function settings(root) {
  const config = { ...DEFAULT_CONFIG.trajectory, ...(await readJson(paths(root).config, {})).trajectory };
  const invalid = () => new Error('Invalid recording settings / Ajustes de gravação inválidos');
  if (typeof config.dir !== 'string' || !config.dir.trim()) throw invalid();
  for (const key of ['maxBytes', 'maxFileBytes', 'retentionDays']) {
    if (!Number.isSafeInteger(config[key]) || config[key] <= 0) throw invalid();
  }
  for (const key of ['truncationMarker', 'redactionMarker']) {
    if (typeof config[key] !== 'string' || !config[key]) throw invalid();
  }
  if (!Array.isArray(config.redactionPatterns)) throw invalid();
  config.patterns = config.redactionPatterns.map(pattern => {
    if (typeof pattern !== 'string') throw invalid();
    return new RegExp(pattern, 'gi');
  });
  return { ...config, dir: resolve(root, config.dir) };
}
