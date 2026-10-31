// The MCP tool table: one tool per core function, snake_case on the wire.
// The inputSchema is documentation; every handler checks its own arguments
// again, because a client is free to send whatever it likes.
import { classify, EFFORT_CLASSES } from '../classify.js';
import { OPERATIONS } from '../core/operations.js';
import { projectName, withDemandRef } from '../demand-ref.js';
import { inboxAdd, inboxClaim, inboxRelease, inboxList, inboxSetStatus, holdText, STATUSES } from '../inbox.js';
import { acquireSlot, limitsStatus, releaseSlot } from '../limits.js';
import { orderAdd, orderList, orderRemove, SCOPES } from '../orders.js';
import { configOf as normalizeConfig, DEFAULT_CONFIG, LOCALES, localeOf, profilePick } from '../profiles.js';
import { listActors } from '../actors.js';
import { environmentReport, formatEnvironmentReport } from '../env/report.js';
import { adapterQuotaReader, clientsOf, shouldShowStatus, statusTable } from '../status.js';
import { quotaReleasedNotice } from '../quota/released.js';
import { CLIENTS } from '../spawn-process.js';
import { readJson } from '../state.js';
import { paths, stateRoot } from '../store.js';
import { todoRun } from '../todo/index.js';
import { status as telemetryStatus, exportTelemetry, record } from '../telemetry/index.js';
import { toolsFromRegistry } from './registry-tools.js';

const HOME_ENV = 'OKWORK_HOME';
const DEFAULT_REASON = 'revoked by the mcp tool order_remove';
const LOCALE_SCHEMA = { type: 'string', enum: LOCALES, default: DEFAULT_CONFIG.language,
  description: `Language / Idioma; language (${DEFAULT_CONFIG.language}) when omitted / quando omitido.` };
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

function optionalChoice(tool, args, name, allowed, config) {
  const value = args[name];
  if (value === undefined || value === null) return name === 'locale' ? localeOf(value, config) : undefined;
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

// Actors lists configured model + effort pairs and their availability without changing state.
const envReportTool = {
  name: 'env_report',
  description: 'Shows which environment is in use, installed clients, active models, quota, folders and what is missing with commands to fix it. / Mostra o ambiente em uso e o que falta com comandos para corrigir.',
  inputSchema: {
    type: 'object', properties: {
      client: { type: 'string' }, locale: LOCALE_SCHEMA,
    }, required: [], additionalProperties: false,
  },
  async handler(args, ctx) {
    const a = argsOf('env_report', args, ['client', 'locale']);
    const client = optionalText('env_report', a, 'client');
    const env = ctx.env ?? process.env;
    const config = await configOf(ctx);
    const locale = optionalChoice('env_report', a, 'locale', LOCALES, config);
    if (client !== undefined && !Object.hasOwn(DEFAULT_CONFIG.install.clients, client)) {
      return reply({ unknownClient: true, text: formatEnvironmentReport({ unknownClient: true }, locale) });
    }
    const report = await environmentReport({ ...ctx, config, env, client, locale,
      readQuota: ctx.readQuota ?? adapterQuotaReader({ stateRoot: ctx.root, env }),
      cache: ctx.quotaCache, limits: ctx.limits ?? (ctx.snapshot ? undefined : await limitsStatus(ctx.root, config)) });
    return reply({ ...report, text: formatEnvironmentReport(report, locale) });
  },
};

const actorsTool = {
  name: 'actors_list',
  description: DEFAULT_CONFIG.actors.messages.en.description,
  inputSchema: {
    type: 'object', properties: {
      locale: LOCALE_SCHEMA,
      all: { type: 'boolean' }, client: { type: 'string', enum: CLIENTS },
    }, required: [], additionalProperties: false,
  },
  async handler(args, ctx) {
    const a = argsOf('actors_list', args, ['locale', 'all', 'client']);
    const config = await configOf(ctx);
    const env = ctx.env ?? process.env;
    return reply(await listActors({ ...ctx, root: ctx.root, config, env, all: a.all,
      client: optionalChoice('actors_list', a, 'client', CLIENTS),
      locale: optionalChoice('actors_list', a, 'locale', LOCALES, config),
      readQuota: ctx.readQuota ?? adapterQuotaReader({ stateRoot: ctx.root, env }),
      now: ctx.now, cache: ctx.quotaCache, orders: ctx.orders ?? await orderList(ctx.root),
      limits: ctx.limits ?? (ctx.snapshot ? undefined : await limitsStatus(ctx.root, config)) }));
  },
};

// The quota table is the view a Director shows before a big task and whenever
// it is asked for; the three arguments say whether this task is big enough.
const statusTool = {
  name: 'status',
  description: 'Shows recorded quota, its age and available executors for the detected client. Use all for every client or client to choose one. If no value is recorded, shows the command to record it. Send size, slices and executors to also receive showBefore.',
  inputSchema: {
    type: 'object',
    properties: {
      locale: LOCALE_SCHEMA,
      all: { type: 'boolean', description: 'Show every client.' },
      client: { type: 'string', enum: CLIENTS, description: 'Choose a client; overrides all and detection.' },
      size: { type: 'string', enum: SIZES, description: 'Size of the task about to start.' },
      slices: { type: 'integer', minimum: 0, description: 'How many steps the demand was split into.' },
      executors: { type: 'integer', minimum: 0, description: 'How many executors would run at once.' },
    },
    required: [],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const a = argsOf('status', args, ['locale', 'size', 'slices', 'executors', 'all', 'client']);
    if (a.all !== undefined && typeof a.all !== 'boolean') fail('status: all must be a boolean');
    const size = optionalChoice('status', a, 'size', SIZES);
    const slices = optionalCount('status', a, 'slices');
    const executors = optionalCount('status', a, 'executors');
    const config = await configOf(ctx);
    const env = ctx.env ?? process.env;
    const table = await statusTable(ctx.root, {
      ...ctx,
      config,
      env,
      all: a.all,
      client: optionalChoice('status', a, 'client', CLIENTS),
      clients: clientsOf(config),
      readQuota: ctx.readQuota ?? adapterQuotaReader({ stateRoot: ctx.root, env }),
      now: ctx.now,
      orders: ctx.orders ?? await orderList(ctx.root),
      limits: ctx.limits ?? (ctx.snapshot ? undefined : await limitsStatus(ctx.root, config)),
      locale: optionalChoice('status', a, 'locale', LOCALES, config),
      cache: ctx.quotaCache,
    });

    // The three facts of a task are optional, so `showBefore` appears only when
    // the caller sent at least one of them.
    const asked = [size, slices, executors].some((value) => value !== undefined);
    return reply(asked ? { ...table, showBefore: shouldShowStatus({ size, slices, executors }) } : table);
  },
};

// The notice for the kit's quota-released event, in plain words and in the
// user's language. It reads nothing and changes nothing; without a recognised
// event it says the notice is not available.
const quotaNoticeTool = {
  name: 'quota_notice',
  description: 'Turns the kit\'s quota-back event into a plain sentence for the user, in their language. Without that event, says the notice is not available. / Transforma o evento de cota liberada do kit em uma frase simples para o usuário, no idioma dele. Sem esse evento, diz que o aviso não está disponível.',
  inputSchema: {
    type: 'object',
    properties: {
      locale: LOCALE_SCHEMA,
      event: { type: 'object', description: 'The quota-back event the kit delivered. / O evento de cota liberada entregue pelo kit.' },
    },
    required: [],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const a = argsOf('quota_notice', args, ['locale', 'event']);
    const config = await configOf(ctx);
    const locale = optionalChoice('quota_notice', a, 'locale', LOCALES, config);
    const event = a.event === null ? undefined : a.event;
    if (event !== undefined && (typeof event !== 'object' || Array.isArray(event))) {
      fail(locale === 'pt-BR'
        ? 'quota_notice: o evento deve ser um objeto quando informado'
        : 'quota_notice: event must be an object when given');
    }
    return reply(quotaReleasedNotice(event, locale));
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
  description: 'Chooses an assistant for the work, using built-in choices before setup. Low allowance selects a lighter choice. / Escolhe um assistente para o trabalho, usando as escolhas incluídas antes da configuração. Com pouca cota, usa uma escolha mais leve.',
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
    const profile = profilePick({
      client: requiredText('profile_pick', a, 'client'),
      effort: requiredText('profile_pick', a, 'effort'),
      quota: optionalQuota('profile_pick', a, 'quota'),
      config: await configOf(ctx),
    });
    await record(ctx.root, 'profile.choice', { client: a.client, ...profile });
    return reply(profile);
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
      todoLink: { type: 'object', description: 'Confirmed task link: project (absolute root), item (text or anchor), optional file.' },
    },
    required: ['title'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const a = argsOf('inbox_add', args, ['title', 'body', 'kind', 'accept', 'effort', 'client', 'appliesTo', 'todoLink']);
    return reply(await inboxAdd(ctx.root, {
      title: requiredText('inbox_add', a, 'title'),
      body: optionalText('inbox_add', a, 'body'),
      kind: optionalText('inbox_add', a, 'kind'),
      accept: optionalTextList('inbox_add', a, 'accept'),
      effort: optionalChoice('inbox_add', a, 'effort', EFFORT_CLASSES),
      client: optionalText('inbox_add', a, 'client'),
      appliesTo: optionalAppliesTo('inbox_add', a, 'appliesTo'),
      todoLink: a.todoLink,
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
      locale: LOCALE_SCHEMA,
    },
    required: [],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const a = argsOf('inbox_list', args, ['status', 'client', 'appliesTo', 'limit', 'locale']);
    const config = await configOf(ctx);
    const locale = optionalChoice('inbox_list', a, 'locale', LOCALES, config);
    const items = await inboxList(ctx.root, {
      status: optionalChoice('inbox_list', a, 'status', STATUSES),
      client: optionalText('inbox_list', a, 'client'),
      appliesTo: optionalText('inbox_list', a, 'appliesTo'),
      limit: optionalCount('inbox_list', a, 'limit'),
    });
    const name = await projectName(ctx.root);
    return reply(items.map((item) => ({ ...withDemandRef(item, name), owner: holdText(item, config, locale) })));
  },
};

function holdTool(name, operation) {
  const keys = name === 'inbox_claim' ? ['id', 'client', 'session', 'worktree'] : ['id', 'client', 'session'];
  return {
    name,
    description: name === 'inbox_claim' ? 'Claims an inbox item atomically; refuses another active holder.' : 'Releases an owned or stale hold.',
    inputSchema: { type: 'object', properties: Object.fromEntries(keys.map((key) => [key, { type: 'string' }])), required: ['id', 'client'], additionalProperties: false },
    handler: async (args, ctx) => {
      const a = argsOf(name, args, keys);
      const owner = { client: requiredText(name, a, 'client') };
      for (const key of keys.slice(2)) {
        const value = optionalText(name, a, key);
        if (value !== undefined) owner[key] = value;
      }
      return reply(await operation(ctx.root, requiredText(name, a, 'id'), owner));
    },
  };
}

const inboxSetStatusTool = {
  name: 'inbox_set_status',
  description: 'Moves one inbox item along pending, delegated, criticised, consolidated or failed.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Inbox item id, as returned by inbox_add.' },
      status: { type: 'string', enum: STATUSES, description: 'Status to move the item to.' },
      holder: { type: 'object', properties: { client: { type: 'string' }, session: { type: 'string' } }, required: ['client'], additionalProperties: false },
    },
    required: ['id', 'status'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const a = argsOf('inbox_set_status', args, ['id', 'status', 'holder']);
    if (a.holder !== undefined) {
      argsOf('holder', a.holder, ['client', 'session']);
      requiredText('holder', a.holder, 'client');
      optionalText('holder', a.holder, 'session');
    }
    return reply(await inboxSetStatus(
      ctx.root,
      requiredText('inbox_set_status', a, 'id'),
      optionalChoice('inbox_set_status', a, 'status', STATUSES),
      { holder: a.holder },
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
const smokeDemoTool = {
  name: 'smoke_demo',
  description: 'Preview practice work and confirm its allowance ceiling. / Veja os trabalhos de exemplo e confirme o teto de cota.',
  inputSchema: { type: 'object', properties: {
    dryRun: { type: 'boolean' }, client: { type: 'string', enum: CLIENTS },
    locale: LOCALE_SCHEMA, confirm: { type: 'string' },
  }, additionalProperties: false },
  async handler(args, ctx) {
    const a = argsOf('smoke_demo', args, ['dryRun', 'client', 'locale', 'confirm']);
    if (a.dryRun !== undefined && typeof a.dryRun !== 'boolean') fail('smoke_demo: dryRun must be boolean');
    const { smokeDemo } = await import('../smoke/demo/entry.js');
    const config = await configOf(ctx);
    return reply(await smokeDemo({ dryRun: a.dryRun,
      client: optionalChoice('smoke_demo', a, 'client', CLIENTS),
      locale: optionalChoice('smoke_demo', a, 'locale', LOCALES, config),
      confirm: optionalText('smoke_demo', a, 'confirm') }, { ...ctx, config, env: ctx.env ?? process.env }));
  },
};

function todoTool(name) {
  return { name, description: 'Synchronize project tasks; preview with dryRun. Confirm suggested links explicitly. / Sincronize tarefas; veja antes com dryRun. Confirme vínculos sugeridos.',
  inputSchema: { type: 'object', properties: { project: { type: 'string' },
    dryRun: { type: 'boolean' }, id: { type: 'string' }, link: { type: 'object' }, confirm: { type: 'boolean' } },
  required: [], additionalProperties: false },
  handler: async (args, ctx) => {
    const a = argsOf(name, args, ['project', 'dryRun', 'id', 'link', 'confirm']);
    for (const key of ['dryRun', 'confirm']) {
      if (a[key] !== undefined && typeof a[key] !== 'boolean') fail(`${name}: ${key} must be boolean`);
    }
    return reply(await todoRun(ctx.root, { ...a, project: optionalText(name, a, 'project'), check: false }));
  } };
}

export const TOOLS = [
  {
    name: 'trajectory_show',
    description: 'Read a saved run step by step on this computer. / Leia uma execução salva passo a passo neste computador.',
    inputSchema: { type: 'object', properties: { run: { type: 'string' } }, required: ['run'], additionalProperties: false },
    handler: async (args, ctx) => {
      const a = argsOf('trajectory_show', args, ['run']);
      const { show } = await import('../trajectory/index.js');
      return reply(await show(ctx.root, requiredText('trajectory_show', a, 'run')));
    },
  },
  ...[['telemetry_status', telemetryStatus], ['telemetry_export', exportTelemetry]].map(([name, handler]) => ({
    name, description: name === 'telemetry_status'
      ? 'See what measurements are saved and where. / Veja quais medições são salvas e onde.'
      : 'Export saved measurements, optionally from a date. / Exporte medições salvas, opcionalmente a partir de uma data.',
    inputSchema: { type: 'object', properties: name === 'telemetry_export' ? { since: { type: 'string' } } : {}, additionalProperties: false },
    handler: async (args, ctx) => {
      const a = argsOf(name, args, name === 'telemetry_export' ? ['since'] : []);
      return reply(await handler(ctx.root, { since: optionalText(name, a, 'since') }));
    },
  })),
  todoTool('todo_sync'),
  acquireSlotTool,
  releaseSlotTool,
  limitsStatusTool,
  statusTool,
  quotaNoticeTool,
  actorsTool,
  envReportTool,
  smokeDemoTool,
  classifyTool,
  profilePickTool,
  inboxAddTool,
  inboxListTool,
  holdTool('inbox_claim', inboxClaim),
  holdTool('inbox_release', inboxRelease),
  inboxSetStatusTool,
  orderAddTool,
  orderListTool,
  orderRemoveTool,
  // The tools of the operations of the registry: the last ones of the table,
  // in the order of the registry.
  ...toolsFromRegistry(OPERATIONS),
];

export const TOOL_NAMES = TOOLS.map((tool) => tool.name);
