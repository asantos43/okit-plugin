import { readdir } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { configOf } from '../profiles.js';
import { readJson } from '../state.js';
import { paths } from '../store.js';
import { readSnapshot, safePath, writeSnapshot } from './safe.js';

export const TODO_WARNING = 'The work was saved, but its task list could not be updated. Review the task list and try again. / O trabalho foi salvo, mas sua lista de tarefas não pôde ser atualizada. Confira a lista e tente novamente.';
const plain = text => text.replace(/[\r\n]/g, ' ');
export function validateTodoLink(link) {
  if (link === undefined) return undefined;
  if (!link || typeof link !== 'object' || Array.isArray(link)
    || typeof link.project !== 'string' || !isAbsolute(link.project)
    || typeof link.item !== 'string' || !link.item.trim()
    || link.file !== undefined && (typeof link.file !== 'string' || !link.file.trim())
    || Object.keys(link).some(key => !['project', 'item', 'file'].includes(key))) {
    throw new TypeError('Choose a project folder and task text or anchor. / Escolha a pasta do projeto e o texto ou âncora da tarefa.');
  }
  return { ...link, project: resolve(link.project) };
}
export function projectsOf(item) {
  const values = item.ext?.todo?.project ? [item.ext.todo.project] : [item.appliesTo].flat();
  return [...new Set(values.filter(value => typeof value === 'string' && isAbsolute(value)).map(value => resolve(value)))];
}
export function settingsOf(raw, project) {
  const config = configOf(raw).todo;
  const local = config.projects[project] ?? Object.entries(config.projects).find(([key]) => resolve(key) === project)?.[1] ?? {};
  return { ...config, ...local, checkbox: { ...config.checkbox, ...local.checkbox } };
}
const metadata = / <!-- okit-todo:([A-Za-z0-9_-]+):([A-Za-z0-9+/=]+)(:new)? -->\r?$/;
function original(line) {
  const match = line.match(metadata);
  return match ? Buffer.from(match[2], 'base64').toString('utf8') : line;
}

export function parseItems(snapshot) {
  return snapshot.text.split('\n').flatMap((line, index) => {
    const base = original(line);
    const match = base.match(/^(\s*[-*+] \[)([^\]])(\] )(.*?)(\r?)$/);
    if (!match) return [];
    return [{ snapshot, index, line, base, prefix: match[1], suffix: match[3],
      text: match[4], ending: match[5], owner: line.match(metadata)?.[1], generated: Boolean(line.match(metadata)?.[3]) }];
  });
}

async function filesOf(project, settings) {
  const files = [await readSnapshot(project, settings.file)];
  if (settings.areaDir) {
    const directory = await safePath(project, settings.areaDir);
    for (const entry of (await readdir(directory.file, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isFile() || entry.isSymbolicLink()) {
        if (entry.name.endsWith('.md')) files.push(await readSnapshot(project, join(settings.areaDir, entry.name)));
      }
    }
  }
  return files.filter((file, index) => files.findIndex(other => other.file === file.file) === index);
}
const words = text => new Set(text.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').match(/[\p{L}\p{N}]+/gu) ?? []);
function similarity(a, b) {
  const left = words(a), right = words(b);
  return [...left].filter(word => right.has(word)).length / (new Set([...left, ...right]).size || 1);
}

function matchItem(items, demand, project) {
  const owned = items.filter(item => item.owner === demand.id);
  if (owned.length) return owned;
  const link = demand.ext?.todo;
  if (!link || resolve(link.project) !== project || !link.item) return [];
  return items.filter(item => (!link.file || item.snapshot.requested === resolve(project, link.file))
    && (item.text === link.item || item.text.includes(`{#${link.item.replace(/^#/, '')}}`)
      || item.text.includes(`<a id="${link.item.replace(/^#/, '')}">`)));
}
function closest(items, demand) {
  return items.filter(item => !item.owner).map(item => ({ item, score: similarity(item.text, demand.title) }))
    .filter(candidate => candidate.score > 0).sort((a, b) => b.score - a.score)[0]?.item;
}
function stateOf(demand, event) {
  const released = demand.heldBefore?.at(-1);
  if (!demand.hold && released?.reason === 'released' && released.statusAtRelease === demand.status
    && event !== 'take' && event !== 'status') return 'open';
  if (event === 'release' || ['failed', 'pending'].includes(demand.status) && !demand.hold && event !== 'take') return 'open';
  if (demand.status === 'consolidated') return 'done';
  return 'progress';
}
const confirmationMessage = 'Use this task for the saved work? Confirm the link before updating it. / Usar esta tarefa para o trabalho salvo? Confirme o vínculo antes de atualizar.';

function changedLine(item, demand, settings, state, date) {
  const mark = ` <!-- okit-todo:${demand.id}:${Buffer.from(item.base).toString('base64')}${item.generated ? ':new' : ''} -->`;
  if (state === 'open') return item.generated ? `${item.base.replace(/\r$/, '')}${mark}${item.ending}` : item.base;
  const box = state === 'done' ? settings.checkbox.done : settings.checkbox.progress;
  const stamp = state === 'done' ? ` (${demand.id}, ${date})` : ` (${demand.id})`;
  return `${item.prefix}${box}${item.suffix}${item.text}${stamp}${mark}${item.ending}`;
}

function addItem(snapshot, demand, settings) {
  const lines = snapshot.text.split('\n');
  const ending = snapshot.text.includes('\r\n') ? '\r' : '';
  let at = lines.findIndex(line => line.replace(/\r$/, '') === settings.section);
  if (at < 0) throw new Error('The section for new tasks is missing. / Falta a seção para tarefas novas.');
  at += 1;
  while (at < lines.length && !/^#{1,6} /.test(lines[at])) at += 1;
  if (at === lines.length && lines.at(-1) === '') at -= 1;
  const base = `- [${settings.checkbox.open}] ${plain(demand.title)}${ending}`;
  return { index: at, line: '', base, prefix: '- [', suffix: '] ', text: plain(demand.title), ending, generated: true };
}

export async function syncProject(project, demands, raw, { dryRun = false, check = false, event, date } = {}) {
  if (!isAbsolute(project)) throw new TypeError('Use the full project folder. / Use a pasta completa do projeto.');
  project = resolve(project);
  const settings = settingsOf(raw, project);
  const report = { project, enabled: settings.enabled, changes: [], suggestions: [], demandsWithoutItem: [], itemsWithoutDemand: [] };
  if (!settings.enabled) return report;
  const snapshots = await filesOf(project, settings);
  const items = snapshots.flatMap(parseItems);
  const matched = new Set();
  const relevant = demands.filter(demand => projectsOf(demand).includes(project));
  const updates = new Map();
  for (const demand of relevant) {
    const matches = matchItem(items, demand, project);
    if (matches.length > 1) throw new Error('Several tasks match; choose one by file and text. / Várias tarefas correspondem; escolha uma por arquivo e texto.');
    let item = matches[0];
    if (item?.owner && item.owner !== demand.id || item && matched.has(item)) throw new Error('This task already belongs to other work. / Esta tarefa já pertence a outro trabalho.');
    if (item) matched.add(item);
    else report.demandsWithoutItem.push({ title: demand.title, id: demand.id });
    const candidate = !item && !demand.ext?.todo?.item && closest(items, demand);
    if (candidate) report.suggestions.push({ demand: demand.id, project, file: candidate.snapshot.requested,
      item: candidate.text, message: confirmationMessage });
    if (check || candidate) continue;
    const state = stateOf(demand, event);
    if (!item && state === 'open') continue;
    if (!item && demand.ext?.todo?.item) throw new Error('The linked task was not found. Review the link. / A tarefa vinculada não foi encontrada. Confira o vínculo.');
    const destinations = snapshots.filter(file => file.text.split(/\r?\n/).includes(settings.section));
    const destination = destinations.find(file => file === snapshots[0]) ?? (destinations.length === 1 ? destinations[0] : undefined);
    const snapshot = item?.snapshot ?? destination;
    if (!snapshot) throw new Error('Choose one section for new tasks. / Escolha uma seção para tarefas novas.');
    const added = !item;
    item ??= addItem(snapshot, demand, settings);
    const next = changedLine(item, demand, settings, state, date ?? (demand.updatedAt ?? new Date().toISOString()).slice(0, 10));
    if (next === item.line) continue;
    const edits = updates.get(snapshot) ?? [];
    edits.push({ ...item, next, added });
    updates.set(snapshot, edits);
    report.changes.push({ file: snapshot.requested, line: item.index + 1, title: demand.title,
      added, before: item.line, after: next, diff: `--- ${snapshot.requested}\n+++ ${snapshot.requested}\n@@ -${item.index + 1} +${item.index + 1} @@\n${added ? '' : `-${item.line}\n`}+${next}\n` });
  }
  report.itemsWithoutDemand = items.filter(item => !matched.has(item)).map(item => ({
    file: item.snapshot.requested, line: item.index + 1, text: item.text,
  }));
  for (const [snapshot, edits] of updates) {
    const lines = snapshot.text.split('\n');
    for (const edit of edits.sort((a, b) => b.index - a.index)) lines.splice(edit.index, edit.added ? 0 : 1, edit.next);
    if (!dryRun) await writeSnapshot(snapshot, lines.join('\n'));
  }
  return report;
}

export async function todoRun(root, { project, link, id, confirm, ...options } = {}) {
  if (project !== undefined && (typeof project !== 'string' || !isAbsolute(project))) throw new TypeError('Use the full project folder. / Use a pasta completa do projeto.');
  const [raw, store] = await Promise.all([readJson(paths(root).config, {}), readJson(paths(root).inbox, { items: [] })]);
  if (link !== undefined || id !== undefined) {
    if (confirm !== true || !id || !link) throw new TypeError(confirmationMessage);
    const clean = validateTodoLink(link);
    const demand = store.items.find(item => item.id === id);
    if (!demand) throw new TypeError('Saved work was not found. / O trabalho salvo não foi encontrado.');
    if (!projectsOf(demand).includes(clean.project)) throw new TypeError('Choose a declared project. / Escolha um projeto declarado.');
    demand.ext = { ...demand.ext, todo: clean };
    project = clean.project;
  }
  const projects = project ? [resolve(project)] : [...new Set([
    ...store.items.flatMap(projectsOf), ...Object.keys(configOf(raw).todo.projects).map(name => resolve(name)),
  ])];
  const reports = [];
  for (const name of projects) reports.push(await syncProject(name, store.items, raw, options));
  if (link && !options.dryRun && !options.check && reports.some(report => report.enabled)) {
    const { inboxSetExt } = await import('../inbox.js');
    await inboxSetExt(root, id, { todo: validateTodoLink(link) });
  }
  return { reports, dryRun: Boolean(options.dryRun), check: Boolean(options.check) };
}

export async function todoHook(root, item, event) {
  try {
    const raw = await readJson(paths(root).config, {});
    const reports = [];
    for (const project of projectsOf(item)) reports.push(await syncProject(project, [item], raw,
      { event, check: event === 'register' }));
    return reports.some(report => report.enabled) ? { ...item, todo: { reports } } : item;
  } catch {
    return { ...item, todoWarning: TODO_WARNING };
  }
}
