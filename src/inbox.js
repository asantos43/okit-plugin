import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import { inScope, validateAppliesTo, validateAppliesToFilter } from './applies.js';
import { readJson, withLock, writeJsonAtomic } from './state.js';
import { paths } from './store.js';
import { configOf } from './profiles.js';
import { record } from './telemetry/index.js';
import { todoHook, validateTodoLink } from './todo/index.js';

export const STATUSES = ['pending', 'delegated', 'criticised', 'consolidated', 'failed'];
export const EFFORTS = ['simple', 'normal', 'hard'];

const ID_PREFIX = 'I';

// Padded so ids sort as text in the same order as they were created.
const ID_WIDTH = 6;
const DEFAULT_KIND = 'task';
const DEFAULT_STATUS = 'pending';

// A move is allowed when it is listed here; every other move is refused.
const MOVES = new Map([
  ['pending', new Set(['delegated', 'failed'])],
  ['delegated', new Set(['criticised', 'failed'])],
  ['criticised', new Set(['consolidated', 'failed'])],
  ['consolidated', new Set(['failed'])],
  ['failed', new Set(['pending'])],
]);

const emptyStore = () => ({ version: 1, seq: 0, items: [] });

export function holdIsStale(hold, config, now = Date.now()) {
  return Boolean(hold) && now - Date.parse(hold.takenAt) > configOf(config).inbox.holdStaleMinutes * 60_000;
}

const sameHolder = (a, b) => a?.client === b?.client && a?.session === b?.session;
const heldMessage = (item) => `${item.id} held by ${item.hold.client} (${item.hold.worktree ?? '-'}) since ${item.hold.takenAt}`;

function clearHold(item, reason) {
  if (!item.hold) return;
  const { client, session, worktree, takenAt } = item.hold;
  (item.heldBefore ??= []).push({ client, session, worktree, takenAt, releasedAt: new Date().toISOString(), reason,
    ...(reason === 'released' ? { statusAtRelease: item.status } : {}) });
  delete item.hold;
}

export function holdText(item, config, locale = 'en', now = Date.now()) {
  if (!item.hold) return '-';
  const h = item.hold;
  const stale = holdIsStale(h, config, now);
  return locale === 'pt-BR'
    ? `em posse de ${h.client} (${h.worktree ?? '-'}) desde ${h.takenAt}${stale ? ' — obsoleta' : ''}`
    : `taken by ${h.client} (${h.worktree ?? '-'}) since ${h.takenAt}${stale ? ' — stale' : ''}`;
}

function fail(message) {
  throw new TypeError(message);
}

function isText(value) {
  return typeof value === 'string' && value.trim() !== '';
}


function validateTitle(title) {
  if (!isText(title)) fail('title must be a non-empty string');
  return title.trim();
}

function validateBody(body) {
  if (body === undefined) return '';
  if (typeof body !== 'string') fail('body must be a string when given');
  return body;
}

function validateKind(kind) {
  const value = kind === undefined ? DEFAULT_KIND : kind;
  if (!isText(value)) fail(`kind must be a non-empty string (default ${DEFAULT_KIND})`);
  return value.trim();
}

function validateAccept(accept) {
  const value = accept === undefined ? [] : accept;
  if (!Array.isArray(value)) fail('accept must be an array of strings');
  if (!value.every((check) => typeof check === 'string' && check.trim() !== '')) {
    fail('accept must hold only non-empty strings');
  }
  return value.map((check) => check.trim());
}

function validateEffort(effort) {
  if (effort === undefined || effort === null) return undefined;
  if (!EFFORTS.includes(effort)) fail(`effort must be one of ${EFFORTS.join('|')} when given`);
  return effort;
}

async function loadStore(file) {
  const store = await readJson(file, emptyStore());
  if (!Array.isArray(store.items)) fail(`${file} has no items array`);
  return { version: 1, seq: Number.isInteger(store.seq) ? store.seq : 0, items: store.items };
}

async function mutate(root, fn) {
  const file = paths(root).inbox;
  // The lock sits beside the file and mkdir is not recursive, so the root
  // exists before the first add.
  await mkdir(dirname(file), { recursive: true });
  return withLock(file, async () => {
    const store = await loadStore(file);
    const value = await fn(store);
    await writeJsonAtomic(file, store);
    return value;
  });
}

const nextId = (seq) => `${ID_PREFIX}${String(seq).padStart(ID_WIDTH, '0')}`;

async function changeHold(root, id, owner, { release = false, producer = false, expectedHold, allowStale = true } = {}) {
  if (!isText(id)) fail('id must be a non-empty string');
  if (!isText(owner?.client)) fail('client must be a non-empty string');
  for (const key of ['session', 'worktree']) {
    if (owner[key] !== undefined && !isText(owner[key])) fail(`${key} must be a non-empty string`);
  }
  return mutate(root, async (store) => {
    const item = store.items.find((entry) => entry.id === id.trim());
    if (!item) fail(`unknown inbox item ${id}`);
    const config = await readJson(paths(root).config, {});
    const stale = holdIsStale(item.hold, config);
    if (producer && JSON.stringify(item.hold) !== JSON.stringify(expectedHold)) fail('hold changed; inspect situation again');
    if (item.hold && !sameHolder(item.hold, owner) && (!stale || !allowStale) && !producer) fail(heldMessage(item));
    if (!release && item.hold && sameHolder(item.hold, owner) && !producer && !stale) return { ...item, stale: false };
    clearHold(item, producer ? 'producer takeover' : stale ? 'stale' : 'released');
    if (!release) item.hold = { ...owner, takenAt: new Date().toISOString(), via: producer ? 'producer' : 'claim' };
    item.updatedAt = new Date().toISOString();
    return { ...item, stale };
  }).then(item => todoHook(root, item, release ? 'release' : 'take'));
}

export const inboxClaim = (root, id, owner, options) => changeHold(root, id, owner, { allowStale: options?.allowStale ?? true });
export const inboxRelease = (root, id, owner) => changeHold(root, id, owner, { release: true });
// Only the human CLI exposes this operation; expectedHold guards the confirmation interval.
export const inboxProducerTakeover = (root, id, owner, expectedHold) =>
  changeHold(root, id, owner, { producer: true, expectedHold });


/**
 * Adds a demand and returns the stored item. The id comes from the file
 * itself, so ids stay unique even when two callers add at once. `appliesTo`
 * names the projects the demand is about; absent or `global`, it is shared and
 * the field is left out of the stored item.
 */
export async function inboxAdd(root, { title, body, kind, accept, effort, client, appliesTo, ext, todoLink } = {}) {
  const link = validateTodoLink(todoLink ?? ext?.todo);
  const clean = {
    title: validateTitle(title),
    body: validateBody(body),
    kind: validateKind(kind),
    accept: validateAccept(accept),
  };
  const effortValue = validateEffort(effort);
  const appliesToValue = validateAppliesTo(appliesTo);

  return mutate(root, async (store) => {
    store.seq += 1;
    const item = {
      id: nextId(store.seq),
      title: clean.title,
      body: clean.body,
      kind: clean.kind,
      accept: clean.accept,
      status: DEFAULT_STATUS,
      stepIds: [],
      createdAt: new Date().toISOString(),
    };
    if (effortValue !== undefined) item.effort = effortValue;
    if (isText(client)) item.client = client.trim();
    if (appliesToValue !== undefined) item.appliesTo = appliesToValue;
    if (ext !== undefined && ext !== null) {
      if (typeof ext !== 'object' || Array.isArray(ext)) fail('ext must be an object when given');
      item.ext = ext;
    }

    if (link) item.ext = { ...item.ext, todo: link };
    store.items.push(item);
    return item;
  }).then(async item => {
    await record(root, 'demand.status', { state: item.status, client: item.client, effort: item.effort });
    return todoHook(root, item, 'register');
  });
}


/**
 * Lists items, newest first. Every filter is optional and they combine.
 * `appliesTo` narrows the list to one project: its own demands plus the global
 * ones; `global` lists the shared demands alone.
 */
export async function inboxList(root, { status, client, appliesTo, limit } = {}) {
  if (status !== undefined && !STATUSES.includes(status)) {
    fail(`status must be one of ${STATUSES.join('|')} when given`);
  }
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 0)) {
    fail('limit must be a non-negative integer when given');
  }
  const wanted = validateAppliesToFilter(appliesTo);

  const store = await loadStore(paths(root).inbox);
  let items = store.items.slice();
  if (status !== undefined) items = items.filter((item) => item.status === status);
  if (client !== undefined) items = items.filter((item) => item.client === client);
  if (wanted !== undefined) items = items.filter((item) => inScope(item, wanted));
  items.reverse();
  return limit === undefined ? items : items.slice(0, limit);
}


/**
 * Merges `values` into the `ext` of one item, so a stored caller can correct a
 * tag it owns without touching the demand itself. Keys left out keep their
 * value, and an item with no `ext` gains one.
 */
export async function inboxSetExt(root, id, values) {
  if (!isText(id)) fail('id must be a non-empty string');
  if (values === undefined || values === null || typeof values !== 'object' || Array.isArray(values)) {
    fail('ext values must be an object when given');
  }
  const wanted = id.trim();

  return mutate(root, (store) => {
    const item = store.items.find((candidate) => candidate.id === wanted);
    if (!item) fail(`unknown inbox item ${wanted}`);

    item.ext = { ...item.ext, ...values };
    item.updatedAt = new Date().toISOString();
    return item;
  });
}


/**
 * Moves one item to a new status. Unknown ids and moves outside the sequence
 * pending -> delegated -> criticised -> consolidated are refused.
 */
export async function inboxSetStatus(root, id, status, { holder } = {}) {
  if (!isText(id)) fail('id must be a non-empty string');
  if (!STATUSES.includes(status)) fail(`status must be one of ${STATUSES.join('|')}`);
  const wanted = id.trim();

  return mutate(root, (store) => {
    const item = store.items.find((candidate) => candidate.id === wanted);
    if (!item) fail(`unknown inbox item ${wanted}`);

    const allowed = MOVES.get(item.status);
    if (!allowed || !allowed.has(status)) {
      fail(`cannot move ${wanted} from ${item.status} to ${status}`);
    }

    if (status === 'delegated' && holder && item.hold && !sameHolder(item.hold, holder)) fail(heldMessage(item));
    if (['consolidated', 'failed'].includes(status)) clearHold(item, status);
    item.status = status;
    item.updatedAt = new Date().toISOString();
    return item;
  }).then(async item => {
    await record(root, 'demand.status', { state: item.status, client: item.client, effort: item.effort,
      durationMs: Date.parse(item.updatedAt) - Date.parse(item.createdAt) });
    return todoHook(root, item, 'status');
  });
}
