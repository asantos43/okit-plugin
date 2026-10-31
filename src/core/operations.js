// The registry of the operations: one entry per core function. An entry has a
// name, a description in both languages, the schema of its arguments and the
// handler that does the work. The handler takes the state root, the arguments
// (which arrive as `unknown` and are checked inside) and the dependencies of
// the caller; it returns data and never prints.
//
// An entry may also name the keys only the command line takes (`cliOnly`): the
// MCP tool built from the entry does not publish them and refuses them.
//
// The command line and the MCP server are two callers of the same operations:
// this registry is what they share, so a function exists once.

import { EFFORT_CLASSES } from '../classify.js';
import { STATUSES } from '../inbox.js';
import { SCOPES } from '../orders.js';
import { DEFAULT_CONFIG } from '../profiles.js';
import { CLIENTS } from '../spawn-process.js';
import { configGet, configSet } from './config.js';
import { daemonOperation, DAEMON_ACTIONS } from './daemon.js';
import {
  inboxAddOperation, inboxClaimOperation, inboxListOperation, inboxReleaseOperation, inboxSetStatusOperation,
} from './inbox-operations.js';
import { kitDetect } from './kit.js';
import { acquireSlotOperation, limitsStatusOperation, releaseSlotOperation } from './limits-operations.js';
import { orderAddOperation, orderListOperation, orderRemoveOperation } from './orders-operations.js';
import { classifyOperation, profilePickOperation } from './profile-operations.js';
import { quotaSet, quotaShow } from './quota.js';
import {
  actorsListOperation, envReportOperation, quotaNoticeOperation, SIZES, statusOperation,
} from './status-operations.js';
import { LOCALE_SCHEMA } from './tool-arguments.js';
import { todoCheck } from './todo.js';

export const OPERATIONS = [
  {
    name: 'config_get',
    description: {
      en: 'Reads the settings of a root: every entry of the schema, or one of them when a key is given.',
      'pt-BR': 'Lê os ajustes de uma raiz: todas as entradas do esquema, ou uma delas quando a chave é informada.',
    },
    schema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'The key of one entry; every entry when it is absent.' },
      },
      required: [],
      additionalProperties: false,
    },
    handler: (root, args, deps) => configGet(root, args, deps),
  },
  {
    name: 'config_set',
    description: {
      en: 'Writes one setting of a root and says what it was and what it is now; without a value the setting is removed.',
      'pt-BR': 'Grava um ajuste de uma raiz e diz o que era e o que passou a ser; sem valor o ajuste é removido.',
    },
    schema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'The key of the entry to write.' },
        value: { type: 'string', description: 'The new value; the entry is removed when it is absent.' },
      },
      required: ['key'],
      additionalProperties: false,
    },
    handler: (root, args, deps) => configSet(root, args, deps),
  },
  {
    name: 'quota_show',
    description: {
      en: 'Shows the recorded quota of the clients of a root, or of one client when it is named.',
      'pt-BR': 'Mostra a cota registrada dos clientes de uma raiz, ou de um cliente quando ele é nomeado.',
    },
    schema: {
      type: 'object',
      properties: {
        client: { type: 'string', description: 'One client of the root; every client when it is absent.' },
      },
      required: [],
      additionalProperties: false,
    },
    handler: (root, args, deps) => quotaShow(root, args, deps),
  },
  {
    name: 'quota_set',
    description: {
      en: 'Records the quota of one client: the percentage that is left, and the window it belongs to when it is given.',
      'pt-BR': 'Registra a cota de um cliente: a porcentagem que resta, e a janela a que ela pertence quando é informada.',
    },
    schema: {
      type: 'object',
      properties: {
        client: { type: 'string', description: 'The client the reading belongs to.' },
        pct: { type: 'number', minimum: 0, maximum: 100, description: 'The percentage of the quota that is left.' },
        windowMinutes: { type: 'number', description: 'The length of the window the reading belongs to, in minutes.' },
      },
      required: ['client', 'pct'],
      additionalProperties: false,
    },
    handler: (root, args, deps) => quotaSet(root, args, deps),
  },
  {
    name: 'daemon',
    description: {
      en: 'The state of the daemon of a root: whether it runs, whether it is paused, the last pass it made, or one pass now.',
      'pt-BR': 'O estado do daemon de uma raiz: se roda, se está pausado, a última passagem que fez, ou uma passagem agora.',
    },
    schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: DAEMON_ACTIONS, description: 'What to do with the daemon.' },
        table: { type: 'boolean', description: 'The table of the quota under the lines of the status; the caller supplies the dependencies of the table.' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    // The table needs the dependencies of the caller, and only the command line
    // has them: the key stays in the registry for the command and the tool that
    // reads the registry does not publish it.
    cliOnly: ['table'],
    handler: (root, args, deps) => daemonOperation(root, args, deps),
  },
  {
    name: 'kit_detect',
    description: {
      en: 'Probes the orchestration kit of a root: whether it is installed, which version it is, and why it is broken.',
      'pt-BR': 'Investiga o kit de orquestração de uma raiz: se está instalado, qual versão tem e por que está com defeito.',
    },
    schema: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
    handler: (root, args, deps) => kitDetect(root, args, deps),
  },
  {
    name: 'todo_check',
    description: {
      en: 'Compares the task lists of a project with the work a root holds: the work without a task and the tasks without work.',
      'pt-BR': 'Compara as listas de tarefas de um projeto com o trabalho de uma raiz: o trabalho sem tarefa e as tarefas sem trabalho.',
    },
    schema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'The absolute folder of the project; every project of the root when it is absent.' },
      },
      required: [],
      additionalProperties: false,
    },
    handler: (root, args, deps) => todoCheck(root, args, deps),
  },
  // The operations of the inbox and of the standing orders: they were tools
  // of the table of the server before, with the validation they always had.
  // Their description is in English only, the way the tool published it.
  {
    name: 'inbox_add',
    description: {
      en: 'Adds a demand to the shared inbox and returns the stored item, id included.',
    },
    schema: {
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
    handler: (root, args, deps) => inboxAddOperation(root, args, deps),
  },
  {
    name: 'inbox_list',
    description: {
      en: 'Lists inbox items newest first, optionally filtered by status, client or project.',
    },
    schema: {
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
    handler: (root, args, deps) => inboxListOperation(root, args, deps),
  },
  {
    name: 'inbox_claim',
    description: {
      en: 'Claims an inbox item atomically; refuses another active holder.',
    },
    schema: {
      type: 'object',
      properties: {
        id: { type: 'string' }, client: { type: 'string' }, session: { type: 'string' }, worktree: { type: 'string' },
      },
      required: ['id', 'client'],
      additionalProperties: false,
    },
    handler: (root, args, deps) => inboxClaimOperation(root, args, deps),
  },
  {
    name: 'inbox_release',
    description: {
      en: 'Releases an owned or stale hold.',
    },
    schema: {
      type: 'object',
      properties: {
        id: { type: 'string' }, client: { type: 'string' }, session: { type: 'string' },
      },
      required: ['id', 'client'],
      additionalProperties: false,
    },
    handler: (root, args, deps) => inboxReleaseOperation(root, args, deps),
  },
  {
    name: 'inbox_set_status',
    description: {
      en: 'Moves one inbox item along pending, delegated, criticised, consolidated or failed.',
    },
    schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Inbox item id, as returned by inbox_add.' },
        status: { type: 'string', enum: STATUSES, description: 'Status to move the item to.' },
        holder: { type: 'object', properties: { client: { type: 'string' }, session: { type: 'string' } }, required: ['client'], additionalProperties: false },
      },
      required: ['id', 'status'],
      additionalProperties: false,
    },
    handler: (root, args, deps) => inboxSetStatusOperation(root, args, deps),
  },
  {
    name: 'order_add',
    description: {
      en: 'Adds a standing order: one instruction the Director reads with every demand until it is revoked.',
    },
    schema: {
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
    handler: (root, args, deps) => orderAddOperation(root, args, deps),
  },
  {
    name: 'order_list',
    description: {
      en: 'Lists the standing orders that are active now, optionally for one project.',
    },
    schema: {
      type: 'object',
      properties: {
        appliesTo: { type: 'string', description: 'Project name, or "global" for the shared orders alone.' },
      },
      required: [],
      additionalProperties: false,
    },
    handler: (root, args, deps) => orderListOperation(root, args, deps),
  },
  {
    name: 'order_remove',
    description: {
      en: 'Revokes a standing order by id. Nothing is deleted, so the history survives.',
    },
    schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Standing order id, as returned by order_add.' },
        reason: { type: 'string', description: 'Why the order is revoked.' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    handler: (root, args, deps) => orderRemoveOperation(root, args, deps),
  },
  // The operations of the limits, of the view of the machine and of the choice
  // of the work: they were tools of the table of the server before, with the
  // validation they always had. Their description is the one the tool
  // published, in the language it published it.
  {
    name: 'acquire_slot',
    description: {
      en: 'Reserves one concurrency slot for a run, or reports the cap that refuses it. Take it before the work starts and call release_slot when it ends.',
    },
    schema: {
      type: 'object',
      properties: {
        runId: { type: 'string', description: 'Identifier of the run that owns the slot.' },
        client: { type: 'string', description: 'Client the run belongs to.' },
        waitMs: { type: 'number', description: 'Milliseconds to wait for a free slot; 0 reports busy at once.' },
      },
      required: ['runId', 'client'],
      additionalProperties: false,
    },
    handler: (root, args, deps) => acquireSlotOperation(root, args, deps),
  },
  {
    name: 'release_slot',
    description: {
      en: 'Frees the slot of a run, so the next one fits under the cap.',
    },
    schema: {
      type: 'object',
      properties: { runId: { type: 'string', description: 'Identifier of the run to free.' } },
      required: ['runId'],
      additionalProperties: false,
    },
    handler: (root, args, deps) => releaseSlotOperation(root, args, deps),
  },
  {
    name: 'limits_status',
    description: {
      en: 'Reports the concurrency caps and the live runs per client.',
    },
    schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    handler: (root, args, deps) => limitsStatusOperation(root, args, deps),
  },
  {
    name: 'status',
    description: {
      en: 'Shows recorded quota, its age and available executors for the detected client. Use all for every client or client to choose one. If no value is recorded, shows the command to record it. Send size, slices and executors to also receive showBefore.',
    },
    schema: {
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
    handler: (root, args, deps) => statusOperation(root, args, deps),
  },
  {
    name: 'quota_notice',
    description: {
      en: 'Turns the kit\'s quota-back event into a plain sentence for the user, in their language. Without that event, says the notice is not available.',
      'pt-BR': 'Transforma o evento de cota liberada do kit em uma frase simples para o usuário, no idioma dele. Sem esse evento, diz que o aviso não está disponível.',
    },
    schema: {
      type: 'object',
      properties: {
        locale: LOCALE_SCHEMA,
        event: { type: 'object', description: 'The quota-back event the kit delivered. / O evento de cota liberada entregue pelo kit.' },
      },
      required: [],
      additionalProperties: false,
    },
    handler: (root, args, deps) => quotaNoticeOperation(root, args, deps),
  },
  {
    name: 'actors_list',
    description: {
      en: DEFAULT_CONFIG.actors.messages.en.description,
    },
    schema: {
      type: 'object', properties: {
        locale: LOCALE_SCHEMA,
        all: { type: 'boolean' }, client: { type: 'string', enum: CLIENTS },
      }, required: [], additionalProperties: false,
    },
    handler: (root, args, deps) => actorsListOperation(root, args, deps),
  },
  {
    name: 'env_report',
    description: {
      en: 'Shows which environment is in use, installed clients, active models, quota, folders and what is missing with commands to fix it.',
      'pt-BR': 'Mostra o ambiente em uso e o que falta com comandos para corrigir.',
    },
    schema: {
      type: 'object', properties: {
        client: { type: 'string' }, locale: LOCALE_SCHEMA,
      }, required: [], additionalProperties: false,
    },
    handler: (root, args, deps) => envReportOperation(root, args, deps),
  },
  {
    name: 'classify',
    description: {
      en: 'Classifies a demand as simple, normal or hard and says why.',
    },
    schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'What the demand is about.' },
        body: { type: 'string', description: 'The demand in full.' },
        kind: { type: 'string', description: 'Free text: research, writing, code, data, ...' },
      },
      required: ['title'],
      additionalProperties: false,
    },
    handler: (root, args, deps) => classifyOperation(root, args, deps),
  },
  {
    name: 'profile_pick',
    description: {
      en: 'Chooses an assistant for the work, using built-in choices before setup. Low allowance selects a lighter choice.',
      'pt-BR': 'Escolhe um assistente para o trabalho, usando as escolhas incluídas antes da configuração. Com pouca cota, usa uma escolha mais leve.',
    },
    schema: {
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
    handler: (root, args, deps) => profilePickOperation(root, args, deps),
  },
];

/**
 * The entry of one operation, or undefined when the name is not one of them.
 *
 * @param {string} name the name of the operation
 * @returns {object|undefined} the entry
 */
export function operation(name) {
  return OPERATIONS.find((entry) => entry.name === name);
}

/**
 * Runs one operation: it finds the entry and calls its handler.
 *
 * @param {string} name the name of the operation
 * @param {string} root the state root
 * @param {unknown} args the arguments, checked by the handler
 * @param {object} [deps] the dependencies of the caller
 * @returns {Promise<object>} the data of the operation
 * @throws {TypeError} when the name is not the one of an operation
 */
export async function run(name, root, args, deps = {}) {
  const entry = operation(name);
  if (entry === undefined) throw new TypeError(`unknown operation: ${name}`);
  return entry.handler(root, args, deps);
}
