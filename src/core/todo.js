// The task lists of a project: the work that has no task and the tasks that
// have no work. The check reads the project and its list; it changes nothing.
// Nothing here prints.

import { todoRun } from '../todo/index.js';
import { argsOf, optionalText } from './arguments.js';

/**
 * The task lists of a root, checked against the work it holds.
 *
 * @param {string} root state root
 * @param {{project?: string}} [args] the project to check, or every project of the root
 * @returns {Promise<{reports: object[]}>}
 */
export async function todoCheck(root, args = {}) {
  const given = argsOf('todo_check', args, ['project']);
  const project = optionalText('todo_check', given, 'project');
  const result = await todoRun(root, { project, check: true });
  return { reports: result.reports };
}
