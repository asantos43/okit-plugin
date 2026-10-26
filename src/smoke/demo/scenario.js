import { mkdtemp, mkdir, readFile, writeFile, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, isAbsolute } from 'node:path';
import { classify } from '../../classify.js';

export const loadScenario = async () => JSON.parse(await readFile(new URL('./scenario.json', import.meta.url), 'utf8'));
export function relativePath(path) {
  if (typeof path !== 'string' || !path || isAbsolute(path) || /[\\:\0]/.test(path)
    || path.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error('unsafe path');
  return path;
}
export function validateScenario(scenario) {
  if (scenario.version !== 1 || !Array.isArray(scenario.demands) || !scenario.demands.length) throw new Error('invalid scenario');
  const keys = new Set();
  for (const demand of scenario.demands) {
    relativePath(demand.key);
    if (demand.key.includes('/') || keys.has(demand.key)) throw new Error('duplicate or unsafe key');
    keys.add(demand.key);
    for (const locale of ['en', 'pt-BR']) {
      const result = classify({ title: demand.title[locale], body: demand.body[locale], kind: demand.kind });
      if ({ simple: 'S', normal: 'M', hard: 'L' }[result.effort] !== demand.expectedSize) throw new Error('unexpected class');
    }
  }
  const visited = new Set(), visiting = new Set();
  const visit = (key) => {
    if (!keys.has(key) || visiting.has(key)) throw new Error('missing or cyclic dependency');
    if (visited.has(key)) return;
    visiting.add(key);
    const demand = scenario.demands.find((row) => row.key === key);
    demand.dependsOn.forEach(visit);
    const allowed = new Set(demand.files.map((file) => relativePath(file.path)));
    if (allowed.size !== demand.files.length || demand.files.some((file) => typeof file.content !== 'string')
      || !demand.acceptance.length) throw new Error('invalid files or acceptance');
    for (const check of demand.acceptance) {
      if (check.type !== 'fileEquals' || !allowed.has(relativePath(check.path))
        || typeof check.text !== 'string') throw new Error('unsafe acceptance');
    }
    if (demand.fault && !allowed.has(relativePath(demand.fault.path))) throw new Error('unsafe fault');
    visiting.delete(key); visited.add(key);
  };
  keys.forEach(visit);
  return scenario;
}

export async function safeFile(root, path) {
  relativePath(path);
  let current = root;
  for (const part of path.split('/')) {
    current = join(current, part);
    const stat = await lstat(current).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    if (stat?.isSymbolicLink()) throw new Error('unsafe symlink');
  }
  return current;
}

export async function createScratch(scenario, config) {
  validateScenario(scenario);
  const root = await mkdtemp(join(tmpdir(), 'okit-demo-'));
  const cleanup = () => rm(root, { recursive: true, force: true });
  try {
    for (const folder of ['home', 'home/.claude', 'home/.codex', 'home/.config/opencode', 'state', 'work']) {
      await mkdir(join(root, folder), { recursive: true });
    }
    await writeFile(join(root, 'scenario.json'), JSON.stringify(scenario));
    await writeFile(join(root, 'state/config.json'), JSON.stringify(config));
    for (const demand of scenario.demands) {
      for (const file of demand.files) {
        const target = await safeFile(root, `work/${demand.key}/${file.path}`);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, '');
      }
    }
    return { root, state: join(root, 'state'), cleanup,
      env: { HOME: join(root, 'home'), OKWORK_HOME: join(root, 'state'),
        CLAUDE_CONFIG_DIR: join(root, 'home/.claude'), CODEX_HOME: join(root, 'home/.codex'),
        XDG_CONFIG_HOME: join(root, 'home/.config') } };
  } catch (error) { await cleanup(); throw error; }
}
