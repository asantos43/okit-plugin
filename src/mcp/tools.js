// The MCP tool table: one tool per core function, snake_case on the wire.
// The inputSchema is documentation; every handler checks its own arguments
// again, because a client is free to send whatever it likes.
import { classify, EFFORT_CLASSES } from '../classify.js';
import { configOf, loadConfig } from '../core/context.js';
import { OPERATIONS } from '../core/operations.js';
import {
  argsOf,
  fail,
  LOCALE_SCHEMA,
  optionalChoice,
  optionalCount,
  optionalMs,
  optionalQuota,
  optionalText,
  requiredText,
} from '../core/tool-arguments.js';
import { acquireSlot, limitsStatus, releaseSlot } from '../limits.js';
import { orderList } from '../orders.js';
import { DEFAULT_CONFIG, LOCALES, profilePick } from '../profiles.js';
import { listActors } from '../actors.js';
import { environmentReport, formatEnvironmentReport } from '../env/report.js';
import { adapterQuotaReader, clientsOf, shouldShowStatus, statusTable } from '../status.js';
import { quotaReleasedNotice } from '../quota/released.js';
import { CLIENTS } from '../spawn-process.js';
import { stateRoot } from '../store.js';
import { todoRun } from '../todo/index.js';
import { status as telemetryStatus, exportTelemetry, record } from '../telemetry/index.js';
import { toolsFromRegistry } from './registry-tools.js';

const HOME_ENV = 'OKWORK_HOME';
const SIZES = ['S', 'M', 'L'];

// The settings of a root live in the core now; the table of the tools keeps
// publishing them, because other parts of the plugin read them from here.
export { loadConfig };

/**
 * The context every handler gets. `config` is optional: without it the
 * handler reads `config.json`, so tests only have to point `root` at a
 * temporary folder.
 */
export function makeContext(root) {
  return { root: root === undefined ? stateRoot() : stateRoot({ [HOME_ENV]: root }) };
}

// A tool answers with the JSON of what the core returned, so a refusal
// (`ok: false`) and a result (`ok: true`) read the same way.
const reply = (value) => JSON.stringify(value);

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
        config: await configOf(ctx, ctx.root),
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
    return reply(await limitsStatus(ctx.root, await configOf(ctx, ctx.root)));
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
    const config = await configOf(ctx, ctx.root);
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
    const config = await configOf(ctx, ctx.root);
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
    const config = await configOf(ctx, ctx.root);
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
    const config = await configOf(ctx, ctx.root);
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
      config: await configOf(ctx, ctx.root),
    });
    await record(ctx.root, 'profile.choice', { client: a.client, ...profile });
    return reply(profile);
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
    const config = await configOf(ctx, ctx.root);
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
  // The tools of the operations of the registry: the last ones of the table,
  // in the order of the registry.
  ...toolsFromRegistry(OPERATIONS),
];

export const TOOL_NAMES = TOOLS.map((tool) => tool.name);
