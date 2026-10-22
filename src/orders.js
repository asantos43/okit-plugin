import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import { inScope, validateAppliesTo, validateAppliesToFilter } from './applies.js';
import { readJson, withLock, writeJsonAtomic } from './state.js';
import { paths, projectOrdersPath } from './store.js';

export const LAYERS = ['global', 'project'];
export const SCOPES = ['all', 'effort:simple', 'effort:normal', 'effort:hard'];

const DEFAULT_SCOPE = 'all';
const DEFAULT_LAYER = 'global';
const DEFAULT_ORIGIN = 'maintainer';
const ID_WIDTH = 6;
const ID_PREFIX = { global: 'G', project: 'O' };

const emptyStore = () => ({ version: 1, seq: 0, orders: [] });

function fail(message) {
  throw new TypeError(message);
}

function isText(value) {
  return typeof value === 'string' && value.trim() !== '';
}


function parseDate(value, field) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') fail(`${field} must be an ISO date-time string when given`);
  const time = Date.parse(value);
  if (Number.isNaN(time)) fail(`${field} must be a date: ${value}`);
  return time;
}

function validateUntil(until, now) {
  const time = parseDate(until, 'until');
  if (time === undefined) return undefined;
  if (time <= now) fail(`until must be in the future: ${until}`);
  return new Date(time).toISOString();
}

function validateScope(scope) {
  const value = scope === undefined ? DEFAULT_SCOPE : scope;
  if (!SCOPES.includes(value)) fail(`scope must be one of ${SCOPES.join('|')}`);
  return value;
}

function validateOrigin(origin) {
  const value = origin === undefined ? DEFAULT_ORIGIN : origin;
  if (!isText(value)) fail('origin must be a non-empty string when given');
  return value.trim();
}

// The layer decides the file: global orders share the root, project orders sit
// in <projectRoot>/.okwork/orders.json and are optional.
function targetOf(root, layer, projectRoot) {
  if (layer === 'project') {
    if (!isText(projectRoot)) fail('layer "project" needs projectRoot');
    return { layer, file: projectOrdersPath(projectRoot) };
  }
  return { layer: 'global', file: paths(root).orders };
}

// A project root alone selects the project layer; without one every order is
// global, which is the default store.
function validateLayer(layer, projectRoot) {
  if (layer === undefined) return isText(projectRoot) ? 'project' : DEFAULT_LAYER;
  if (!LAYERS.includes(layer)) fail(`layer must be one of ${LAYERS.join('|')}`);
  if (layer === 'project' && !isText(projectRoot)) fail('layer "project" needs projectRoot');
  return layer;
}

async function loadStore(file) {
  const store = await readJson(file, emptyStore());
  if (!Array.isArray(store.orders)) fail(`${file} has no orders array`);
  return { version: 1, seq: Number.isInteger(store.seq) ? store.seq : 0, orders: store.orders };
}

async function mutate(file, fn) {
  // The lock sits beside the file and mkdir is not recursive, so the folder is
  // made first: a project may have no .okwork folder yet.
  await mkdir(dirname(file), { recursive: true });
  // One writer per file, so two steps never touch the same orders.
  return withLock(file, async () => {
    const store = await loadStore(file);
    const value = await fn(store);
    await writeJsonAtomic(file, store);
    return value;
  });
}

const nextId = (layer, seq) => `${ID_PREFIX[layer]}${String(seq).padStart(ID_WIDTH, '0')}`;


function clockNow(now) {
  const time = parseDate(now, 'now');
  return time === undefined ? Date.now() : time;
}

/**
 * Adds a standing order. `until` must be a date in the future and the order
 * stops being active after it. `appliesTo` names the projects it binds; absent
 * or `global`, it binds every project and the field is left out.
 */
export async function orderAdd(root, { text, scope, layer, until, origin, appliesTo } = {}, { projectRoot } = {}) {
  const current = clockNow();
  const order = {
    text: isText(text) ? text.trim() : fail('text must be a non-empty string'),
    scope: validateScope(scope),
    layer: validateLayer(layer, projectRoot),
    origin: validateOrigin(origin),
  };
  const expiry = validateUntil(until, current);
  if (expiry !== undefined) order.until = expiry;
  const appliesToValue = validateAppliesTo(appliesTo);
  if (appliesToValue !== undefined) order.appliesTo = appliesToValue;

  const { layer: resolvedLayer, file } = targetOf(root, order.layer, projectRoot);
  order.layer = resolvedLayer;

  return mutate(file, (store) => {
    store.seq += 1;
    order.id = nextId(order.layer, store.seq);
    order.createdAt = new Date(current).toISOString();
    order.active = true;
    store.orders.push(order);
    return order;
  });
}


/**
 * Revokes an order. Nothing is deleted: the row stays with `active: false` and
 * the reason, so the history survives.
 */
export async function orderRemove(root, id, { reason } = {}, { projectRoot } = {}) {
  if (!isText(id)) fail('id must be a non-empty string');
  if (!isText(reason)) fail('reason must be a non-empty string');
  const wanted = id.trim();
  const at = new Date().toISOString();

  const files = [paths(root).orders];
  if (isText(projectRoot)) files.push(projectOrdersPath(projectRoot));

  for (const file of files) {
    try {
      return await mutate(file, (store) => {
        const order = store.orders.find((candidate) => candidate.id === wanted);
        if (!order) fail(`unknown standing order ${wanted}`);
        order.active = false;
        order.revokedAt = at;
        order.revokedReason = reason.trim();
        return order;
      });
    } catch (error) {
      // Both layers are searched: the id alone does not say which one holds it.
      if (!(error instanceof TypeError)) throw error;
    }
  }
  fail(`unknown standing order ${wanted}`);
}


// An order is active when it was never revoked and its until is not past.
function isActiveNow(order, now) {
  if (order.active !== true) return false;
  if (typeof order.until !== 'string') return true;
  const until = Date.parse(order.until);
  return Number.isNaN(until) ? true : until > now;
}

// Case and spacing never make two orders different: the same words in both
// layers are one order, so the key is the trimmed lowercase text.
function textKey(order) {
  return typeof order?.text === 'string' ? order.text.trim().toLowerCase() : '';
}

async function readLayer(root, layer, projectRoot) {
  if (layer === 'global') return (await loadStore(paths(root).orders)).orders;
  if (!isText(projectRoot)) return [];
  return (await loadStore(projectOrdersPath(projectRoot))).orders;
}

/**
 * Lists standing orders from both layers: global first, project after. When
 * the same text exists in both, the project one wins and the global one is
 * dropped. `now` is injectable so expiry can be tested. `appliesTo` narrows the
 * result to one project plus the global orders; `global` lists the global ones
 * alone.
 */
export async function orderList(root, { activeOnly = true, appliesTo, now } = {}, { projectRoot } = {}) {
  if (typeof activeOnly !== 'boolean') fail('activeOnly must be a boolean when given');
  const wanted = validateAppliesToFilter(appliesTo);
  const current = clockNow(now);

  const globalOrders = await readLayer(root, 'global');
  const projectOrders = await readLayer(root, 'project', projectRoot);

  // The project layer is read after the global one, so setting the same key
  // again replaces the global order with the project one in place.
  const winner = new Map();
  for (const order of [...globalOrders, ...projectOrders]) {
    winner.set(textKey(order), order);
  }

  const merged = [...winner.values()];
  const live = activeOnly ? merged.filter((order) => isActiveNow(order, current)) : merged;
  return wanted === undefined ? live : live.filter((order) => inScope(order, wanted));
}


/**
 * Reports what a reader of the files would trip on: unknown scopes, empty
 * text, bad dates, repeated ids, an active order past its until and two live
 * orders with the same text.
 */
export async function orderLint(root, { projectRoot, now } = {}) {
  const current = clockNow(now);
  const problems = [];
  const add = (layer, code, message, id) => problems.push({ layer, code, message, id: id ?? null });

  const layers = await Promise.all([
    readLayer(root, 'global'),
    readLayer(root, 'project', projectRoot),
  ]);

  const seenIds = new Map();
  const liveTexts = new Map();
  for (const [index, orders] of layers.entries()) {
    const layer = index === 0 ? 'global' : 'project';
    for (const order of orders) {
      const id = typeof order.id === 'string' ? order.id : '(no id)';
      if (!isText(order.text)) add(layer, 'empty-text', `${id} has no text`, order.id);
      if (!SCOPES.includes(order.scope)) add(layer, 'unknown-scope', `${id} has an unknown scope: ${order.scope}`, order.id);
      if (order.until !== undefined && Number.isNaN(Date.parse(order.until))) {
        add(layer, 'bad-date', `${id} has an unreadable until: ${order.until}`, order.id);
      }
      if (typeof order.createdAt === 'string' && Number.isNaN(Date.parse(order.createdAt))) {
        add(layer, 'bad-date', `${id} has an unreadable createdAt: ${order.createdAt}`, order.id);
      }
      if (seenIds.has(order.id)) {
        add(layer, 'duplicate-id', `id ${order.id} appears in both layers`, order.id);
      } else {
        seenIds.set(order.id, layer);
      }
      if (order.active === true && !isActiveNow(order, current)) {
        add(layer, 'expired-active', `${id} is active but its until has passed`, order.id);
      }
      if (isActiveNow(order, current) && isText(order.text)) {
        const key = textKey(order);
        if (liveTexts.has(key)) add(layer, 'duplicate-active-text', `${id} repeats a live order: ${order.text}`, order.id);
        else liveTexts.set(key, id);
      }
    }
  }

  return problems;
}


/**
 * Renders orders as Markdown for a human to read. The JSON stays the source;
 * this is only a view the caller may write as orders.md.
 */
export function orderRender(orders) {
  if (!Array.isArray(orders)) fail('orders must be an array');

  const lines = ['# Standing orders', ''];
  if (orders.length === 0) {
    lines.push('None.', '');
    return `${lines.join('\n')}`;
  }

  for (const order of orders) {
    const id = order?.id ?? '(no id)';
    const parts = [`- **${id}**`];
    if (order?.createdAt) parts.push(`(${order.createdAt})`);
    parts.push(order?.text ?? '');
    if (order?.scope && order.scope !== DEFAULT_SCOPE) parts.push(`— scope \`${order.scope}\``);
    if (order?.appliesTo !== undefined && order.appliesTo !== null) {
      const targets = Array.isArray(order.appliesTo) ? order.appliesTo.join(', ') : order.appliesTo;
      parts.push(`— applies to: ${targets}`);
    }
    if (order?.until) parts.push(`— until ${order.until}`);
    if (order?.active === false) parts.push('— revoked');
    lines.push(`${parts.join(' ')}`);
  }
  lines.push('');
  return `${lines.join('\n')}`;
}