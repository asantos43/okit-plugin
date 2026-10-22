import { appendFile, mkdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { inScope, validateAppliesTo, validateAppliesToFilter } from './applies.js';
import { readJson, withLock, writeJsonAtomic } from './state.js';
import { paths, projectOrdersPath } from './store.js';

export const LAYERS = ['global', 'project'];
export const SCOPES = ['all', 'effort:simple', 'effort:normal', 'effort:hard'];

const DEFAULT_SCOPE = 'all';
const DEFAULT_LAYER = 'global';
const DEFAULT_ORIGIN = 'maintainer';
const DEFAULT_RETENTION_DAYS = 90;
const ID_WIDTH = 6;
const ID_PREFIX = { global: 'G', project: 'O' };
const DAY_MS = 86_400_000;

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

/** Whole days of retention or the default, so a broken config never stops a reader. */
function retentionDaysOf(config) {
  const days = config?.orders?.retentionDays;
  return Number.isInteger(days) && days >= 0 ? days : DEFAULT_RETENTION_DAYS;
}

async function readRetentionDays(root) {
  return retentionDaysOf(await readJson(paths(root).config, {}));
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

// A caller holds the clock as an ISO string or as a timestamp: both are read,
// and anything else is refused like any other date.
function nowMs(now) {
  if (typeof now === 'number') {
    if (!Number.isFinite(now)) fail('now must be a timestamp when given');
    return now;
  }
  return clockNow(now);
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
 * the reason, so the history survives. A second revoke is refused, so the first
 * `revokedAt` and `revokedReason` are never overwritten.
 */
export async function orderRemove(root, id, { reason } = {}, { projectRoot } = {}) {
  if (!isText(id)) fail('id must be a non-empty string');
  if (!isText(reason)) fail('reason must be a non-empty string');
  const wanted = id.trim();
  const at = new Date().toISOString();
  const refused = `standing order ${wanted} is already revoked`;

  const files = [paths(root).orders];
  if (isText(projectRoot)) files.push(projectOrdersPath(projectRoot));

  let revoked = false;
  for (const file of files) {
    try {
      return await mutate(file, (store) => {
        const order = store.orders.find((candidate) => candidate.id === wanted);
        if (!order) fail(`unknown standing order ${wanted}`);
        // Marking twice has nothing left to mark and would erase the first
        // reason, which is the only record of why the order went away.
        if (order.active !== true) fail(refused);
        order.active = false;
        order.revokedAt = at;
        order.revokedReason = reason.trim();
        return order;
      });
    } catch (error) {
      // Both layers are searched: the id alone does not say which one holds it.
      if (!(error instanceof TypeError)) throw error;
      if (error.message === refused) revoked = true;
    }
  }
  if (revoked) fail(refused);
  fail(`unknown standing order ${wanted}`);
}


// An order is active when it was never revoked and its until is not past.
function isActiveNow(order, now) {
  if (order.active !== true) return false;
  if (typeof order.until !== 'string') return true;
  const until = Date.parse(order.until);
  return Number.isNaN(until) ? true : until > now;
}

/**
 * The status of an order, derived from the row and never written to the file: an
 * order is `revoked` once it was revoked, `expired` once its `until` is a past
 * date and `active` otherwise. At the exact instant of `until` the order is
 * already expired.
 *
 * @param {object} order a stored or listed standing order
 * @param {string|number} [now] the clock, an ISO string or a timestamp
 * @returns {'active'|'revoked'|'expired'}
 */
export function orderStatus(order, now) {
  const current = nowMs(now);
  if (order?.active !== true) return 'revoked';
  if (typeof order.until !== 'string') return 'active';
  const until = Date.parse(order.until);
  return Number.isNaN(until) || until > current ? 'active' : 'expired';
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
 *
 * Every order comes back with the derived `status` and, when it is inactive, the
 * `purgeAfter` date it may be removed at. Both are added to a copy: the stored
 * row keeps only what was written to it.
 */
export async function orderList(root, { activeOnly = true, appliesTo, now, retentionDays } = {}, { projectRoot } = {}) {
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
  const selected = wanted === undefined ? live : live.filter((order) => inScope(order, wanted));

  const retention = retentionDays === undefined ? await readRetentionDays(root) : retentionDays;
  return selected.map((order) => {
    const copy = { ...order, status: orderStatus(order, current) };
    const due = purgeAfter(order, retention, current);
    if (due !== undefined) copy.purgeAfter = due;
    return copy;
  });
}


/**
 * The instant an inactive order may be purged: a revoked one counts from its
 * revocation, an expired one from its own `until`, and both add the retention.
 * An active order has nothing to purge, and an inactive row with no readable
 * date is never purgeable, so a hand-edited row cannot vanish on a guess.
 *
 * @param {object} order a stored or listed standing order
 * @param {number} [retentionDays] whole days kept, from `orders.retentionDays`
 * @param {string|number} [now] the clock, an ISO string or a timestamp
 * @returns {string|undefined} the ISO instant the order may be purged at
 */
export function purgeAfter(order, retentionDays = DEFAULT_RETENTION_DAYS, now) {
  const status = orderStatus(order, now);
  if (status === 'active') return undefined;
  const base = status === 'revoked' ? order?.revokedAt : order?.until;
  if (typeof base !== 'string') return undefined;
  const time = Date.parse(base);
  if (Number.isNaN(time)) return undefined;
  const days = Number.isInteger(retentionDays) && retentionDays >= 0 ? retentionDays : DEFAULT_RETENTION_DAYS;
  return new Date(time + days * DAY_MS).toISOString();
}

async function existsFile(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

async function appendPurgeLog(root, at, ids) {
  const day = new Date(at).toISOString().slice(0, 10);
  const file = join(paths(root).logs, `${day}.jsonl`);
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify({ at: new Date(at).toISOString(), purged: ids })}\n`, 'utf8');
  return file;
}

/**
 * Removes for good every inactive order whose retention has run out, in both
 * layers: the row is dropped from the file and returned, so the caller can say
 * what went away. An order inside its retention window and an active order are
 * never touched. Every purge appends `{ at, purged: [ids] }` to
 * `logs/<date>.jsonl`, so the trail of what was removed survives the removal.
 *
 * @param {string} root state root
 * @param {{now?: string|number, retentionDays?: number}} [options] `retentionDays`
 *   defaults to `orders.retentionDays` in `config.json`, itself 90 when absent
 *   or broken
 * @param {{projectRoot?: string}} [context] the project layer to purge too
 * @returns {Promise<Array<{id: string, text: string, status: string, purgedAt: string}>>}
 */
export async function orderPurge(root, { now, retentionDays } = {}, { projectRoot } = {}) {
  const current = nowMs(now);
  const retention = retentionDays === undefined ? await readRetentionDays(root) : retentionDays;

  const files = [paths(root).orders];
  if (isText(projectRoot)) files.push(projectOrdersPath(projectRoot));

  const removed = [];
  for (const file of files) {
    // A layer without its file is not created here: nothing to purge, nothing
    // to write.
    if (!await existsFile(file)) continue;
    await mutate(file, (store) => {
      const kept = [];
      for (const order of store.orders) {
        const due = purgeAfter(order, retention, current);
        // The purge date arrived: the retention after it is over. A row with no
        // purge date is kept, never guessed at.
        if (due === undefined || Date.parse(due) > current) kept.push(order);
        else removed.push({ id: order.id, text: order.text, status: orderStatus(order, current), purgedAt: new Date(current).toISOString() });
      }
      store.orders = kept;
    });
  }

  if (removed.length > 0) await appendPurgeLog(root, current, removed.map((order) => order.id));
  return removed;
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
 * this is only a view the caller may write as orders.md. An order that is not
 * active says why: the reason it was revoked or the date it expired.
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
    // A listed order brings its own status; a raw row is read as written, so
    // the clock only decides an expiry.
    const status = ['active', 'revoked', 'expired'].includes(order?.status)
      ? order.status
      : orderStatus(order);
    if (status === 'revoked') {
      parts.push(isText(order?.revokedReason) ? `— revoked: ${order.revokedReason}` : '— revoked');
    } else if (status === 'expired') {
      parts.push(`— expired ${order?.until ?? ''}`.trimEnd());
    }
    lines.push(`${parts.join(' ')}`);
  }
  lines.push('');
  return `${lines.join('\n')}`;
}