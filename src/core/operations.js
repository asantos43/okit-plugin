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

import { configGet, configSet } from './config.js';
import { daemonOperation, DAEMON_ACTIONS } from './daemon.js';
import { kitDetect } from './kit.js';
import { quotaSet, quotaShow } from './quota.js';
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
