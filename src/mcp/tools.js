// The MCP tool table: one tool per core function, snake_case on the wire.
// The inputSchema is documentation; every handler checks its own arguments
// again, because a client is free to send whatever it likes.
import { configOf, loadConfig } from '../core/context.js';
import { OPERATIONS } from '../core/operations.js';
import {
  argsOf,
  fail,
  LOCALE_SCHEMA,
  optionalChoice,
  optionalText,
  requiredText,
} from '../core/tool-arguments.js';
import { LOCALES } from '../profiles.js';
import { CLIENTS } from '../spawn-process.js';
import { stateRoot } from '../store.js';
import { todoRun } from '../todo/index.js';
import { status as telemetryStatus, exportTelemetry } from '../telemetry/index.js';
import { toolsFromRegistry } from './registry-tools.js';

const HOME_ENV = 'OKWORK_HOME';

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
  smokeDemoTool,
  // The tools of the operations of the registry: the last ones of the table,
  // in the order of the registry.
  ...toolsFromRegistry(OPERATIONS),
];

export const TOOL_NAMES = TOOLS.map((tool) => tool.name);
