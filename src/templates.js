// Recurring templates: a stored demand that its own schedule opens once per
// period in the inbox. The core owns the record and the decisions; a caller
// passes the clock, the quota reading and the idleness it knows.

import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import { inboxAdd, inboxList, inboxSetExt } from './inbox.js';
import { orderAdd, orderList, orderRemove } from './orders.js';
import { evaluateDue, parseSchedule } from './schedule.js';
import { readJson, withLock, writeJsonAtomic } from './state.js';
import { paths } from './store.js';

const emptyStore = () => ({ version: 1, seq: 0, templates: [] });

const OPEN_STATUSES = ['pending', 'delegated', 'criticised'];
const ORDER_PREFIX = 'template:';
// `name` and `schedule` are the identity of the record; `lastRun` belongs to a
// run, never to an edit.
const EDITABLE = ['name', 'schedule', 'paused', 'demand', 'window', 'timeZone', 'minQuotaPct',
  'onlyWhenIdle', 'skipIfOpen', 'catchup', 'maxRunsPerPeriod'];

function fail(message) {
  throw new TypeError(message);
}

function isText(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function validateName(name) {
  if (!isText(name)) fail('name must be a non-empty string');
  return name.trim();
}

function validateSchedule(schedule) {
  parseSchedule(schedule);
  return schedule.trim();
}

function validateWindow(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) fail('window must be an object with from and to');
  const clean = { from: value.from, to: value.to };
  for (const key of ['from', 'to']) {
    if (!isText(clean[key])) fail(`window.${key} must be a HH:MM time`);
  }
  return clean;
}

function validateNumber(value, field, { min = 0, integer = false } = {}) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min
    || (integer && !Number.isInteger(value))) {
    fail(`${field} must be a number of at least ${min} when given`);
  }
  return value;
}

function validateFlag(value, field) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') fail(`${field} must be a boolean when given`);
  return value;
}

function validateTimeZone(value) {
  if (value === undefined || value === null) return 'UTC';
  if (!isText(value)) fail('timeZone must be a non-empty string when given');
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value.trim() });
  } catch {
    return fail(`timeZone is unknown: ${value}`);
  }
  return value.trim();
}

function validateCatchup(value) {
  if (value === undefined || value === null) return 'run';
  if (value !== 'run' && value !== 'skip') fail('catchup must be "run" or "skip" when given');
  return value;
}

/** The inbox demand a child copies: `title`, `body`, `kind`, `accept`, `ext`. */
function validateDemand(demand) {
  if (demand === undefined || demand === null || typeof demand !== 'object' || Array.isArray(demand)) {
    fail('demand must be an object with title and optional kind, body, accept and ext');
  }
  if (!isText(demand.title)) fail('demand.title must be a non-empty string');
  const clean = { title: demand.title.trim() };
  if (demand.body !== undefined) clean.body = demand.body;
  if (demand.kind !== undefined) {
    if (!isText(demand.kind)) fail('demand.kind must be a non-empty string when given');
    clean.kind = demand.kind.trim();
  }
  if (demand.accept !== undefined) clean.accept = demand.accept;
  if (demand.ext !== undefined) {
    if (typeof demand.ext !== 'object' || demand.ext === null || Array.isArray(demand.ext)) {
      fail('demand.ext must be an object when given');
    }
    clean.ext = demand.ext;
  }
  return clean;
}

async function loadStore(root) {
  const file = paths(root).templates;
  const store = await readJson(file, emptyStore());
  if (!Array.isArray(store.templates)) fail(`${file} has no templates array`);
  return {
    version: 1,
    seq: Number.isInteger(store.seq) ? store.seq : store.templates.length,
    templates: store.templates,
  };
}

// One writer per file, like the inbox and the orders: the lock sits beside the
// file and mkdir is not recursive, so the root exists before the first add.
async function mutate(root, fn) {
  const file = paths(root).templates;
  await mkdir(dirname(file), { recursive: true });
  return withLock(file, async () => {
    const store = await loadStore(root);
    const value = await fn(store);
    await writeJsonAtomic(file, store);
    return value;
  });
}

function findRecord(store, name) {
  return store.templates.find((template) => template.name === name);
}

function requireRecord(store, name) {
  const template = findRecord(store, name);
  if (!template) fail(`unknown template ${name}`);
  return template;
}

// The record keeps exactly what evaluateDue reads, so a stored template is the
// same object the pure engine already knows how to decide.
function buildRecord(input, now) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    fail('a template needs an object of fields');
  }
  const record = {
    name: validateName(input.name),
    schedule: validateSchedule(input.schedule),
    demand: validateDemand(input.demand),
    timeZone: validateTimeZone(input.timeZone),
    catchup: validateCatchup(input.catchup),
    skipIfOpen: validateFlag(input.skipIfOpen, 'skipIfOpen') ?? true,
    onlyWhenIdle: validateFlag(input.onlyWhenIdle, 'onlyWhenIdle') ?? false,
    paused: validateFlag(input.paused, 'paused') ?? false,
    createdAt: new Date(now).toISOString(),
  };
  const optional = {
    window: validateWindow(input.window),
    minQuotaPct: validateNumber(input.minQuotaPct, 'minQuotaPct'),
    maxRunsPerPeriod: validateNumber(input.maxRunsPerPeriod, 'maxRunsPerPeriod', { integer: true }),
  };
  for (const [field, value] of Object.entries(optional)) {
    if (value !== undefined) record[field] = value;
  }
  return record;
}

const clockNow = (now) => (typeof now === 'number' ? now : Date.now());

const orderOrigin = (name) => `${ORDER_PREFIX}${name}`;

// The text is keyed by the template name, so two templates stay two orders even
// when one changes its schedule.
function orderText(record) {
  return `template "${record.name}" may run unattended on its own schedule ${record.schedule}`;
}

// The children already in the inbox carry `ext.template`, so they follow the
// name too: left behind they would read as runs of a template that no longer
// exists, and the open-child guard would stop seeing them.
async function retagChildren(root, from, to) {
  const items = await inboxList(root);
  const moved = [];
  for (const child of childrenOf(items, from)) {
    await inboxSetExt(root, child.id, { template: to });
    moved.push(child.id);
  }
  return moved;
}

// The order outlives the record, so a rename needs the pair together.
async function revokeOrder(root, record, reason) {
  const origin = orderOrigin(record.name);
  const orders = await orderList(root);
  const live = orders.filter((order) => order.origin === origin);
  for (const order of live) {
    await orderRemove(root, order.id, { reason });
  }
  return live.map((order) => order.id);
}

/**
 * Adds a template and the standing order that lets it run unattended. The
 * schedule is validated by the schedule engine and the name must be free.
 */
export async function templateAdd(root, input = {}, { now } = {}) {
  const at = clockNow(now);
  const record = buildRecord(input, at);

  return mutate(root, async (store) => {
    if (findRecord(store, record.name)) fail(`a template named ${record.name} already exists`);
    store.templates.push(record);
    store.seq += 1;
    const order = await orderAdd(root, {
      text: orderText(record),
      origin: orderOrigin(record.name),
    });
    return { template: record, order };
  });
}

/**
 * Lists the stored templates in creation order. `name` returns just that one
 * and throws when it is unknown.
 */
export async function templateList(root, { name } = {}) {
  const store = await loadStore(root);
  if (name === undefined) return store.templates;
  const wanted = validateName(name);
  return requireRecord(store, wanted);
}

/**
 * Edits a template. `paused` pauses or resumes it, `name` renames it, and the
 * other fields are the guards `templateAdd` takes. Unknown fields and an
 * unknown template are refused; the standing order follows a rename.
 */
export async function templateSet(root, name, patch = {}) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    fail('a change must be an object of fields');
  }
  const wanted = validateName(name);
  for (const field of Object.keys(patch)) {
    if (!EDITABLE.includes(field)) fail(`unknown template field ${field}`);
  }

  return mutate(root, async (store) => {
    const record = requireRecord(store, wanted);
    const previous = { name: record.name };
    if (patch.name !== undefined) record.name = validateName(patch.name);
    if (patch.schedule !== undefined) record.schedule = validateSchedule(patch.schedule);
    record.demand = patch.demand === undefined ? record.demand : validateDemand(patch.demand);
    record.timeZone = patch.timeZone === undefined ? record.timeZone : validateTimeZone(patch.timeZone);
    record.catchup = patch.catchup === undefined ? record.catchup : validateCatchup(patch.catchup);
    if (patch.window !== undefined) record.window = validateWindow(patch.window);
    if (patch.onlyWhenIdle !== undefined) record.onlyWhenIdle = validateFlag(patch.onlyWhenIdle, 'onlyWhenIdle');
    if (patch.skipIfOpen !== undefined) record.skipIfOpen = validateFlag(patch.skipIfOpen, 'skipIfOpen');
    if (patch.paused !== undefined) record.paused = validateFlag(patch.paused, 'paused');
    if (patch.minQuotaPct !== undefined) record.minQuotaPct = validateNumber(patch.minQuotaPct, 'minQuotaPct');
    if (patch.maxRunsPerPeriod !== undefined) {
      record.maxRunsPerPeriod = validateNumber(patch.maxRunsPerPeriod, 'maxRunsPerPeriod', { integer: true });
    }
    if (findRecord(store, record.name) !== record) fail(`a template named ${record.name} already exists`);

    let order = null;
    let children = [];
    if (record.name !== previous.name) {
      children = await retagChildren(root, previous.name, record.name);
      await revokeOrder(root, previous, `template ${previous.name} was renamed to ${record.name}`);
      order = await orderAdd(root, { text: orderText(record), origin: orderOrigin(record.name) });
    }
    record.updatedAt = new Date(clockNow()).toISOString();
    return { template: record, order, children };
  });
}

/**
 * Removes a template and revokes its standing order with a reason, so the
 * record stops opening demands and the order that allowed it stops too.
 */
export async function templateRemove(root, name) {
  const wanted = validateName(name);

  const record = await mutate(root, (store) => {
    const found = requireRecord(store, wanted);
    store.templates = store.templates.filter((candidate) => candidate !== found);
    return found;
  });
  const revoked = await revokeOrder(root, record, `template ${record.name} was removed`);
  return { template: record, revoked };
}

/** One inbox child of one template. */
function childrenOf(items, name) {
  return items.filter((item) => item.ext?.template === name);
}

/**
 * Reads the inbox and describes the runs of one template at one period: how
 * many carry that period, and whether any run is still open. The open run is
 * looked for across every period, so a template that skips when open never
 * stacks demands; a failed run is not open, so it never blocks the next period.
 */
function childState(children, period) {
  return {
    runsThisPeriod: children.filter((item) => item.ext?.period === period).length,
    openChild: children.some((item) => OPEN_STATUSES.includes(item.status)),
  };
}

/**
 * The schedule context of one template: what the caller knows about this
 * instant plus what the inbox says about the template itself.
 */
function templateContext(template, items, ctx, period) {
  return {
    quotaPct: ctx.quotaPct,
    idle: ctx.idle,
    eventName: ctx.eventName,
    eventId: ctx.eventId,
    ...childState(childrenOf(items, template.name), period),
  };
}

// The period needs the slot instant, which the engine only names mid-decision.
// It does not depend on the inbox state, so one pass with the caller's own
// context is enough to learn it.
function candidatePeriod(template, nowMs, ctx) {
  const attempt = evaluateDue(
    { ...template, schedule: parseSchedule(template.schedule) },
    nowMs,
    ctx,
  );
  return attempt.period ?? null;
}

/**
 * An event fires again and again, so only its id tells one run from the next.
 * Without one the period would be the bare event name forever and the template
 * would serve a single child in its whole life, so the run is refused instead.
 */
function needsEventId(schedule, ctx, decided) {
  if (schedule.kind !== 'event' || !decided.due || ctx.eventId !== undefined) return decided;
  return {
    due: false,
    action: 'skip',
    reason: 'an event needs an id to open one child per event',
    period: null,
  };
}

/**
 * Decides every template at `nowMs` and writes nothing. Each record carries
 * the name, whether it is due, the action, the reason and the period the run
 * belongs to. The inbox supplies the per-template context; `quotaPct`, `idle`
 * and `eventName` come from the caller.
 */
export async function due(root, nowMs, ctx = {}) {
  const [store, items] = await Promise.all([loadStore(root), inboxList(root)]);
  const records = [];
  for (const template of store.templates) {
    const schedule = parseSchedule(template.schedule);
    const period = candidatePeriod(template, nowMs, ctx);
    const context = templateContext(template, items, ctx, period);
    const decided = needsEventId(schedule, ctx, evaluateDue(template, nowMs, context));
    records.push({ name: template.name, ...decided });
  }
  return records;
}

/** The inbox demand a child of this template would carry, period included. */
function childDemand(template, period) {
  return { ...template.demand, ext: { ...template.demand.ext, template: template.name, period } };
}

/**
 * The dry run of `openDue`: the decisions plus the demands that would be
 * created. Nothing is written, so two calls always agree.
 */
export async function plan(root, nowMs, ctx = {}) {
  const records = await due(root, nowMs, ctx);
  const store = await loadStore(root);
  const demands = [];
  for (const decision of records) {
    if (!decision.due) continue;
    const template = store.templates.find((candidate) => candidate.name === decision.name);
    demands.push(childDemand(template, decision.period));
  }
  return { decisions: records, demands };
}

/** The `lastRun` a decision implies: the slot instant, in ms. */
function slotInstant(decision) {
  const time = Date.parse(decision.period);
  return Number.isNaN(time) ? null : time;
}

/**
 * Opens one child demand in the inbox for every template that is due, once per
 * period. The check and the write sit under one lock, so a second call in the
 * same period and two callers racing each other both create nothing more.
 *
 * Returns the created inbox ids and the decisions that produced them.
 */
export async function openDue(root, nowMs, ctx = {}) {
  const decisions = await due(root, nowMs, ctx);
  const targets = decisions.filter((decision) => decision.due);
  if (targets.length === 0) return { ids: [], decisions };

  const ids = await mutate(root, async (store) => {
    const opened = [];
    const items = await inboxList(root);
    for (const decision of targets) {
      const template = requireRecord(store, decision.name);
      const taken = childrenOf(items, template.name)
        .some((item) => item.ext?.period === decision.period);
      if (taken) continue;
      const item = await inboxAdd(root, childDemand(template, decision.period));
      const slot = slotInstant(decision);
      if (slot !== null) template.lastRun = slot;
      template.updatedAt = new Date(clockNow()).toISOString();
      opened.push(item.id);
    }
    return opened;
  });

  return { ids, decisions };
}