// The MCP tool table: one tool per core function, snake_case on the wire.
// The inputSchema is documentation; every handler checks its own arguments
// again, because a client is free to send whatever it likes.
import { classify, EFFORT_CLASSES } from '../classify.js';
import { projectName, withDemandRef } from '../demand-ref.js';
import { inboxAdd, inboxList, inboxSetStatus, STATUSES } from '../inbox.js';
import { acquireSlot, limitsStatus, releaseSlot } from '../limits.js';
import { orderAdd, orderList, orderRemove, SCOPES } from '../orders.js';
import { configOf as normalizeConfig, profilePick } from '../profiles.js';
import { adapterQuotaReader, clientsOf, LABELS, shouldShowStatus, statusTable } from '../status.js';
import { readJson } from '../state.js';
import { paths, stateRoot } from '../store.js';

const HOME_ENV = 'OKWORK_HOME';
const DEFAULT_REASON = 'revoked by the mcp tool order_remove';
const LOCALES = Object.keys(LABELS);
const SIZES = ['S', 'M', 'L'];

function fail(message) {
  throw new TypeError(message);
}

function isText(value) {
  return typeof value === 'string' && value.trim() !== '';
}

// Arguments arrive as `unknown`, so the object and its keys are checked here.
function argsOf(tool, args, allowed) {
  const value = args === undefined || args === null ? {} : args;
  if (typeof value !== 'object' || Array.isArray(value)) fail(`${tool}: arguments must be an object`);
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    fail(`${tool}: unknown argument ${unknown.join(', ')}; expected ${allowed.join('|')}`);
  }
  return value;
}

function requiredText(tool, args, name) {
  if (!isText(args[name])) fail(`${tool}: ${name} must be a non-empty string`);
  return args[name].trim();
}

function optionalText(tool, args, name) {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') fail(`${tool}: ${name} must be a string when given`);
  return value;
}

function optionalTextList(tool, args, name) {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
    fail(`${tool}: ${name} must be an array of strings when given`);
  }
  return value;
}

function optionalCount(tool, args, name) {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (!Number.isInteger(value) || value < 0) {
    fail(`${tool}: ${name} must be a non-negative integer when given`);
  }
  return value;
}

function optionalChoice(tool, args, name, allowed) {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (!allowed.includes(value)) fail(`${tool}: ${name} must be one of ${allowed.join('|')} when given`);
  return value;
}

function optionalMs(tool, args, name) {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    fail(`${tool}: ${name} must be a number of milliseconds when given`);
  }
  return value;
}

// A quota reading is the percent left as a number, or the whole reading the
// daemon stores: `{source, remainingPct}` and nothing else.
function optionalQuota(tool, args, name) {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'number') return { source: 'api', remainingPct: value };
  const allowed = ['source', 'remainingPct'];
  if (typeof value !== 'object' || Array.isArray(value)) {
    fail(`${tool}: ${name} must be a percentage or a quota reading {source, remainingPct}`);
  }
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    fail(`${tool}: ${name} has unknown field ${unknown.join(', ')}; expected ${allowed.join('|')}`);
  }
  if (value.source !== undefined && typeof value.source !== 'string') {
    fail(`${tool}: ${name}.source must be a string when given`);
  }
  if (value.remainingPct !== undefined && typeof value.remainingPct !== 'number') {
    fail(`${tool}: ${name}.remainingPct must be a number when given`);
  }
  return { source: value.source, remainingPct: value.remainingPct };
}

/**
 * The settings the daemon would use for this root: `config.json` over
 * `DEFAULT_CONFIG`, read on every call so a change to the file is picked up
 * without restarting the server.
 */
export async function loadConfig(root) {
  const stored = await readJson(paths(root).config, {});
  return normalizeConfig(stored);
}

/**
 * The context every handler gets. `config` is optional: without it the
 * handler reads `config.json`, so tests only have to point `root` at a
 * temporary folder.
 */
export function makeContext(root) {
  return { root: root === undefined ? stateRoot() : stateRoot({ [HOME_ENV]: root }) };
}

async function configOf(ctx) {
  return ctx.config === undefined ? loadConfig(ctx.root) : ctx.config;
}

// A tool answers with the JSON of what the core returned, so a refusal
// (`ok: false`) and a result (`ok: true`) read the same way.
const reply = (value) => JSON.stringify(value);

// The shape is checked here so the message names the tool; the core still
// decides what the value means and normalises it.
function optionalAppliesTo(tool, args, name) {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) && typeof value !== 'string') {
    fail(`${tool}: ${name} must be a non-empty string or an array of them`);
  }
  if (Array.isArray(value) && !value.every((entry) => typeof entry === 'string')) {
    fail(`${tool}: ${name} must hold only strings`);
  }
  return value;
}

// The cap is the one bound a subagent cannot be trusted to hold alone, so the
// slot is taken before the work starts and given back when it ends.
const acquireSlotTool = {
  name: 'acquire_slot',
  description: 'Reserves one concurrency slot for a run, or reports the cap that refuses it. Take it before the work starts and call release_slot when it ends.',
  inputSchema: {
    type: 'object',
    properties: {
      runId: { type: 'string', description: 'Identifier of the run that owns the slot.' },
      client: { type: 'string', description: 'Client the run belongs to.' },
      waitMs: { type: 'number', description: 'Milliseconds to wait for a free slot; 0 reports busy at once.' },
    },
    required: ['runId', 'client'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const a = argsOf('acquire_slot', args, ['runId', 'client', 'waitMs']);
    return reply(await acquireSlot(
      ctx.root,
      requiredText('acquire_slot', a, 'runId'),
      {
        client: requiredText('acquire_slot', a, 'client'),
        config: await configOf(ctx),
        waitMs: optionalMs('acquire_slot', a, 'waitMs'),
      },
    ));
  },
};

const releaseSlotTool = {
  name: 'release_slot',
  description: 'Frees the slot of a run, so the next one fits under the cap.',
  inputSchema: {
    type: 'object',
    properties: { runId: { type: 'string', description: 'Identifier of the run to free.' } },
    required: ['runId'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const a = argsOf('release_slot', args, ['runId']);
    return reply(await releaseSlot(ctx.root, requiredText('release_slot', a, 'runId')));
  },
};

const limitsStatusTool = {
  name: 'limits_status',
  description: 'Reports the concurrency caps and the live runs per client.',
  inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  handler: async (args, ctx) => {
    argsOf('limits_status', args, []);
    return reply(await limitsStatus(ctx.root, await configOf(ctx)));
  },
};

// The quota table is the view a Director shows before a big task and whenever
// it is asked for; the three arguments say whether this task is big enough.
const statusTool = {
  name: 'status',
  description: 'Shows the quota table of every client: remaining per window, resets in, the status word, the source with its age, and how many executors can launch now. Send size, slices and executors and it also says showBefore, whether to show this table before the task starts.',
  inputSchema: {
    type: 'object',
    properties: {
      locale: { type: 'string', enum: LOCALES, description: 'Language of the table; "en" by default.' },
      size: { type: 'string', enum: SIZES, description: 'Size of the task about to start.' },
      slices: { type: 'integer', minimum: 0, description: 'How many steps the demand was split into.' },
      executors: { type: 'integer', minimum: 0, description: 'How many executors would run at once.' },
    },
    required: [],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const a = argsOf('status', args, ['locale', 'size', 'slices', 'executors']);
    const size = optionalChoice('status', a, 'size', SIZES);
    const slices = optionalCount('status', a, 'slices');
    const executors = optionalCount('status', a, 'executors');
    const config = await configOf(ctx);
    const table = await statusTable(ctx.root, {
      config,
      clients: clientsOf(config),
      readQuota: ctx.readQuota ?? adapterQuotaReader({ stateRoot: ctx.root }),
      now: ctx.now,
      orders: ctx.orders ?? await orderList(ctx.root),
      limits: await limitsStatus(ctx.root, config),
      locale: optionalChoice('status', a, 'locale', LOCALES),
      cache: ctx.quotaCache,
    });

    // The three facts of a task are optional, so `showBefore` appears only when
    // the caller sent at least one of them.
    const asked = [size, slices, executors].some((value) => value !== undefined);
    return reply(asked ? { ...table, showBefore: shouldShowStatus({ size, slices, executors }) } : table);
  },
};

const classifyTool = {
  name: 'classify',
  description: 'Classifies a demand as simple, normal or hard and says why.',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'What the demand is about.' },
      body: { type: 'string', description: 'The demand in full.' },
      kind: { type: 'string', description: 'Free text: research, writing, code, data, ...' },
    },
    required: ['title'],
    additionalProperties: false,
  },
  handler: async (args) => {
    const a = argsOf('classify', args, ['title', 'body', 'kind']);
    return reply(classify({
      title: requiredText('classify', a, 'title'),
      body: optionalText('classify', a, 'body'),
      kind: optionalText('classify', a, 'kind'),
    }));
  },
};

const profilePickTool = {
  name: 'profile_pick',
  description: 'Chooses the model, reasoning effort and maxTurns configured for a client and effort class, lowered one step on low quota.',
  inputSchema: {
    type: 'object',
    properties: {
      client: { type: 'string', description: 'Client the work runs on.' },
      effort: { type: 'string', enum: [...EFFORT_CLASSES], description: 'Effort class to pick the profile for.' },
      quota: {
        description: 'Quota reading: the percent left, or {source, remainingPct}.',
        anyOf: [
          { type: 'number' },
          {
            type: 'object',
            properties: {
              source: { type: 'string' },
              remainingPct: { type: 'number' },
            },
            required: [],
            additionalProperties: false,
          },
        ],
      },
    },
    required: ['client', 'effort'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const a = argsOf('profile_pick', args, ['client', 'effort', 'quota']);
    return reply(profilePick({
      client: requiredText('profile_pick', a, 'client'),
      effort: optionalChoice('profile_pick', a, 'effort', EFFORT_CLASSES),
      quota: optionalQuota('profile_pick', a, 'quota'),
      config: await configOf(ctx),
    }));
  },
};

const inboxAddTool = {
  name: 'inbox_add',
  description: 'Adds a demand to the shared inbox and returns the stored item, id included.',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'What the demand is about.' },
      body: { type: 'string', description: 'The demand in full.' },
      kind: { type: 'string', description: 'Free text: research, writing, code, data, ...' },
      accept: { type: 'array', items: { type: 'string' }, description: 'Checks the demand must pass.' },
      effort: { type: 'string', enum: EFFORT_CLASSES, description: 'Effort class; call classify when it is absent.' },
      client: { type: 'string', description: 'Client the demand belongs to.' },
      appliesTo: { description: 'Project the demand is about; absent or "global" means every project.' },
    },
    required: ['title'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const a = argsOf('inbox_add', args, ['title', 'body', 'kind', 'accept', 'effort', 'client', 'appliesTo']);
    return reply(await inboxAdd(ctx.root, {
      title: requiredText('inbox_add', a, 'title'),
      body: optionalText('inbox_add', a, 'body'),
      kind: optionalText('inbox_add', a, 'kind'),
      accept: optionalTextList('inbox_add', a, 'accept'),
      effort: optionalChoice('inbox_add', a, 'effort', EFFORT_CLASSES),
      client: optionalText('inbox_add', a, 'client'),
      appliesTo: optionalAppliesTo('inbox_add', a, 'appliesTo'),
    }));
  },
};

const inboxListTool = {
  name: 'inbox_list',
  description: 'Lists inbox items newest first, optionally filtered by status, client or project.',
  inputSchema: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: STATUSES, description: 'Only items in this status.' },
      client: { type: 'string', description: 'Only items of this client.' },
      appliesTo: { type: 'string', description: 'Project name, or "global" for the shared items alone.' },
      limit: { type: 'integer', minimum: 0, description: 'How many items at most.' },
    },
    required: [],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const a = argsOf('inbox_list', args, ['status', 'client', 'appliesTo', 'limit']);
    const items = await inboxList(ctx.root, {
      status: optionalChoice('inbox_list', a, 'status', STATUSES),
      client: optionalText('inbox_list', a, 'client'),
      appliesTo: optionalText('inbox_list', a, 'appliesTo'),
      limit: optionalCount('inbox_list', a, 'limit'),
    });
    const name = await projectName(ctx.root);
    return reply(items.map((item) => withDemandRef(item, name)));
  },
};

const inboxSetStatusTool = {
  name: 'inbox_set_status',
  description: 'Moves one inbox item along pending, delegated, criticised, consolidated or failed.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Inbox item id, as returned by inbox_add.' },
      status: { type: 'string', enum: STATUSES, description: 'Status to move the item to.' },
    },
    required: ['id', 'status'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const a = argsOf('inbox_set_status', args, ['id', 'status']);
    return reply(await inboxSetStatus(
      ctx.root,
      requiredText('inbox_set_status', a, 'id'),
      optionalChoice('inbox_set_status', a, 'status', STATUSES),
    ));
  },
};

const orderAddTool = {
  name: 'order_add',
  description: 'Adds a standing order: one instruction the Director reads with every demand until it is revoked.',
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'The instruction, in plain words.' },
      scope: { type: 'string', enum: SCOPES, description: 'Effort class the order applies to; "all" by default.' },
      until: { type: 'string', description: 'ISO date-time after which the order stops being active.' },
      appliesTo: { description: 'Project the order binds; absent or "global" means every project.' },
    },
    required: ['text'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const a = argsOf('order_add', args, ['text', 'scope', 'until', 'appliesTo']);
    return reply(await orderAdd(ctx.root, {
      text: requiredText('order_add', a, 'text'),
      scope: optionalChoice('order_add', a, 'scope', SCOPES),
      until: optionalText('order_add', a, 'until'),
      appliesTo: optionalAppliesTo('order_add', a, 'appliesTo'),
    }));
  },
};

const orderListTool = {
  name: 'order_list',
  description: 'Lists the standing orders that are active now, optionally for one project.',
  inputSchema: {
    type: 'object',
    properties: {
      appliesTo: { type: 'string', description: 'Project name, or "global" for the shared orders alone.' },
    },
    required: [],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const a = argsOf('order_list', args, ['appliesTo']);
    return reply(await orderList(ctx.root, { appliesTo: optionalText('order_list', a, 'appliesTo') }));
  },
};

const orderRemoveTool = {
  name: 'order_remove',
  description: 'Revokes a standing order by id. Nothing is deleted, so the history survives.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Standing order id, as returned by order_add.' },
      reason: { type: 'string', description: 'Why the order is revoked.' },
    },
    required: ['id'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const a = argsOf('order_remove', args, ['id', 'reason']);
    // The core wants a reason on every revoke, so the tool supplies its own.
    return reply(await orderRemove(
      ctx.root,
      requiredText('order_remove', a, 'id'),
      { reason: optionalText('order_remove', a, 'reason') ?? DEFAULT_REASON },
    ));
  },
};

// The order of the table is the order `tools/list` reports, and the names are
// what the rest of the plugin calls.
export const TOOLS = [
  acquireSlotTool,
  releaseSlotTool,
  limitsStatusTool,
  statusTool,
  classifyTool,
  profilePickTool,
  inboxAddTool,
  inboxListTool,
  inboxSetStatusTool,
  orderAddTool,
  orderListTool,
  orderRemoveTool,
];

export const TOOL_NAMES = TOOLS.map((tool) => tool.name);
