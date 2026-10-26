// Group C of `docs/SMOKE.md`: uninstall and idempotence. The checks here ask for
// roots nothing has written to, so they build a scratch of their own under the
// run's `tmp` folder and take it away again. The last two run whole groups twice
// through `deps.runChecks`, the helper the runner of step 3 supplies.

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { installSkill } from '../../adapters/claude-code/index.js';
import { applyAutostart, autostartPlan } from '../autostart.js';
import { inboxAdd, inboxList } from '../inbox.js';
import { orderAdd, orderList } from '../orders.js';
import { FEATURE_CHECKS } from './checks-features.js';
import { INSTALL_CHECKS } from './checks-install.js';

function need(ok, message) {
  if (!ok) throw new Error(message);
}

async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

// The scratch home rule of one more root: a home, a state root, a config root, a
// project and a tmp folder under `deps.tmp`, and an environment that names them.
async function freshScratch(deps, name) {
  const base = join(deps.tmp, `${name}-${randomBytes(4).toString('hex')}`);
  const home = join(base, 'home');
  const scope = {
    home,
    stateRoot: join(home, '.okwork'),
    configRoot: join(home, '.claude'),
    projectRoot: join(base, 'project'),
    tmp: join(base, 'tmp'),
  };
  for (const folder of Object.values(scope)) await mkdir(folder, { recursive: true });
  return {
    ...deps,
    ...scope,
    env: {
      ...deps.env,
      HOME: home,
      USERPROFILE: home,
      OKWORK_HOME: scope.stateRoot,
      CLAUDE_CONFIG_DIR: scope.configRoot,
      XDG_CONFIG_HOME: home,
      TMPDIR: scope.tmp,
      TEMP: scope.tmp,
      TMP: scope.tmp,
    },
    scratch: base,
  };
}

// Every file under `dir` as `relative path: its bytes`, so two runs can be
// compared on the tree and not only on the names.
async function treeOf(dir, base = dir, lines = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await treeOf(full, base, lines);
    else if (entry.isFile()) {
      lines.push(`${relative(base, full).split('\\').join('/')}:${await readFile(full, 'utf8')}`);
    }
  }
  // Sorted, since `readdir` order is the filesystem's and the comparison must be
  // the tree's.
  return lines.sort();
}

// U1: the folder an install wrote is gone, and a second uninstall of a folder
// that is not there is absent, not an error.
async function uninstallSkills(deps) {
  for (const name of ['okit-director', 'okit-executor', 'okit-critic', 'okit-smoke', 'okit-setup']) {
    await uninstallSkill(deps, name);
  }
}

async function uninstallSkill(deps, name) {
  const source = join(deps.root, 'skills', name);
  await installSkill(name, source, { root: deps.configRoot });
  const folder = join(deps.configRoot, 'skills', name);
  need(await exists(folder), 'installSkill must have written the folder');

  await rm(folder, { recursive: true, force: true });
  need(await exists(folder) === false, 'the uninstall must take the folder away');

  const again = await rm(folder, { recursive: true, force: true }).then(() => null, (error) => error);
  need(again === null, `a second uninstall of a missing folder must not error, got ${again}`);
  need(await exists(folder) === false, 'a missing folder stays missing');
}

// U2: an uninstall runs the commands of the plan, writes no file, and says the
// same thing the second time.
async function uninstallAutostart(deps) {
  const plan = autostartPlan('cron', { root: deps.stateRoot, home: deps.home });
  const wrote = [];
  const write = async (path) => {
    wrote.push(path);
    return path;
  };

  const first = await applyAutostart(plan, { action: 'uninstall', run: deps.run, write });
  const second = await applyAutostart(plan, { action: 'uninstall', run: deps.run, write });
  need(wrote.length === 0, `an uninstall writes no file, wrote ${wrote.join(',')}`);
  need(first.wrote === null && second.wrote === null, 'an uninstall reports no file');
  need(first.ran.length === plan.uninstall.length && second.ran.length === plan.uninstall.length,
    'every command of the plan must run');
  need(JSON.stringify(first.ran) === JSON.stringify(second.ran), 'the second uninstall must say the same thing');
  need(await exists(plan.path) === false, 'nothing may be left where the plan wrote its file');
}

// U3: taking the scratch root away takes the state with it, and a rebuilt root
// starts empty.
async function uninstallState(deps) {
  const scope = await freshScratch(deps, 'u3');
  const root = scope.stateRoot;
  try {
    await inboxAdd(root, { title: 'the smoke demand' });
    await orderAdd(root, { text: 'the smoke order' });
    await mkdir(join(root, 'logs'), { recursive: true });
    await mkdir(join(root, 'locks'), { recursive: true });

    await rm(scope.scratch, { recursive: true, force: true });
    for (const name of ['inbox.json', 'orders.json', 'logs', 'locks']) {
      need(await exists(join(root, name)) === false, `${name} must go with the scratch root`);
    }

    await mkdir(root, { recursive: true });
    need((await inboxList(root)).length === 0, 'a rebuilt root must start with an empty inbox');
    need((await orderList(root)).length === 0, 'a rebuilt root must start with no orders');
  } finally {
    await rm(scope.scratch, { recursive: true, force: true });
  }
}

// U4: the install group run twice leaves the same tree with the same bytes, and
// the second copy of a skill is reported as `identical`.
async function idempotenceInstall(deps) {
  const scope = await freshScratch(deps, 'u4');
  try {
    const first = await deps.runChecks(INSTALL_CHECKS, scope);
    need(first.every((record) => record.status === 'pass'),
      `the install group must pass on the first run, got ${first.filter((r) => r.status !== 'pass').map((r) => r.id).join(',')}`);
    const tree = await treeOf(scope.configRoot);

    const second = await deps.runChecks(INSTALL_CHECKS, scope);
    need(second.every((record) => record.status === 'pass'), 'the install group must pass on the second run');
    const after = await treeOf(scope.configRoot);
    need(after.length === tree.length && after.every((line, index) => line === tree[index]),
      'a second install must leave the same tree with the same bytes');

    const again = await installSkill('okit-director', join(deps.root, 'skills', 'okit-director'), { root: scope.configRoot });
    need(again.written.length === 0 && again.skipped.every((file) => file.reason === 'identical'),
      `the second run must report skipped: identical, got ${again.skipped.map((file) => file.reason).join(',')}`);
  } finally {
    await rm(scope.scratch, { recursive: true, force: true });
  }
}

// U5: two runs on roots nothing has written to report the same ids in the same
// order, and both pass. The artifact names are the run id of each run, which is
// the only thing the runner of step 3 lets differ.
async function idempotenceRun(deps) {
  const runs = [];
  for (const name of ['u5-a', 'u5-b']) {
    const scope = await freshScratch(deps, name);
    try {
      runs.push(await deps.runChecks(FEATURE_CHECKS, scope));
    } finally {
      await rm(scope.scratch, { recursive: true, force: true });
    }
  }

  const [first, second] = runs;
  for (const records of runs) {
    const failed = records.filter((record) => record.status !== 'pass');
    need(failed.length === 0, `every check must pass on a fresh root, got ${failed.map((r) => `${r.id} ${r.error}`).join(' / ')}`);
  }
  need(first.length === second.length, `two runs must report the same number of checks, ${first.length} and ${second.length}`);
  for (let index = 0; index < first.length; index += 1) {
    need(first[index].id === second[index].id,
      `check ${index} must be the same id in both runs: ${first[index].id} and ${second[index].id}`);
  }
}

/**
 * The uninstall group, in the order of the table in `docs/SMOKE.md`.
 */
export const UNINSTALL_CHECKS = [
  { id: 'U1', name: 'uninstall.skills', group: 'U', timeoutMs: 10000, run: uninstallSkills },
  { id: 'U2', name: 'uninstall.autostart', group: 'U', timeoutMs: 15000, run: uninstallAutostart },
  { id: 'U3', name: 'uninstall.state', group: 'U', timeoutMs: 15000, run: uninstallState },
  { id: 'U4', name: 'idempotence.install', group: 'U', timeoutMs: 30000, run: idempotenceInstall },
  { id: 'U5', name: 'idempotence.run', group: 'U', timeoutMs: 30000, run: idempotenceRun },
];

export default UNINSTALL_CHECKS;
