import { basename } from 'node:path';
import { readJson } from './state.js';
import { paths } from './store.js';

const text = (value) => typeof value === 'string' ? value.trim() : '';

export function demandRef(id, projectName) {
  const name = text(projectName);
  return name ? `${id} (${name})` : id;
}

/** Resolve the state root's project record, falling back to its repository path. */
export async function projectName(root) {
  const project = await readJson(paths(root).project, {});
  return text(project?.name) || basename(text(project?.path)) || undefined;
}

export function demandProject(item, fallback) {
  const targets = item.appliesTo;
  if (Array.isArray(targets) && targets.length !== 1) return undefined;
  const target = text(Array.isArray(targets) ? targets[0] : targets);
  return target && target !== 'global' ? basename(target) : fallback;
}

export function withDemandRef(item, name) {
  return { ...item, ref: demandRef(item.id, demandProject(item, name)) };
}
