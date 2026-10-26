import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { TOOLS, TOOL_NAMES } from '../src/mcp/tools.js';
import { main } from '../src/cli.js';
import { CONFIG_SCHEMA, configCommand } from '../src/config.js';
import { DEFAULT_CONFIG } from '../src/profiles.js';

const root = fileURLToPath(new URL('../', import.meta.url));
// The override lets a reviewer mutate disposable copies, without editing live docs.
const directory = process.env.OKIT_DOCS_COMPONENTS_DIR ?? resolve(root, 'docs/components');
const source = name => readFile(resolve(root, name), 'utf8');
const read = name => readFile(resolve(directory, name), 'utf8');
export const COMPONENT_LINE_BUDGETS = Object.freeze({
  README: 40, skills: 70, 'mcp-tools': 50, hooks: 45, adapters: 50,
  cli: 65, daemon: 50, configuration: 150, state: 55,
});
const pages = Object.keys(COMPONENT_LINE_BUDGETS);
const names = pages.flatMap(p => [`${p}.md`, `${p}.pt-BR.md`]);
const headings = text => [...text.matchAll(/^(#{1,6}) .+$/gm)].map(m => m[1].length);
const anchors = text => [...text.matchAll(/<a id="([^"]+)"><\/a>/g)].map(m => m[1]);
const tableNames = text => [...text.matchAll(/^\| `([^`]+)` \|/gm)].map(m => m[1]);

function equalInventory(text, expected, label) {
  const actual = tableNames(text);
  assert.equal(new Set(actual).size, actual.length, `${label}: duplicate rows`);
  assert.deepEqual(actual.toSorted(), [...expected].toSorted(), `${label}: exact source coverage`);
}

function checkPage(text, budget) {
  assert.ok(text.trimEnd().split('\n').length <= budget, `line budget ${budget}`);
  assert.match(text, /^# [^\n]+\n\n[^#\s<\d][^\n]*[.!?]\n\n/, 'one-line summary after title');
  assert.doesNotMatch(text, /\b[DO]\d+\b|\b(?:passo|step)\s+\d+\b/i);
  assert.doesNotMatch(text, /\n{3,}/, 'no surplus blank lines');
}

const cliSource = await source('src/cli.js');
const quoted = text => [...text.matchAll(/'([a-z][a-z-]*)'/g)].map(m => m[1]);
function actionsOf(body) {
  const actions = [...body.matchAll(/action (?:===|!==) '([a-z][a-z-]*)'/g)].map(m => m[1]);
  for (const m of body.matchAll(/\[([^\]]+)\]\.includes\(action\)/g)) actions.push(...quoted(m[1]));
  for (const m of body.matchAll(/(\w+_ACTIONS)\.includes\(action\)/g)) {
    const declaration = cliSource.match(new RegExp(`const ${m[1]} = \\[([^\\]]+)\\]`));
    assert.ok(declaration, `action declaration ${m[1]}`);
    actions.push(...quoted(declaration[1]));
  }
  return [...new Set(actions)];
}

function dispatchCommands(dispatch) {
  const groups = [...dispatch.matchAll(/(?:group|argv\[0\]) === '([a-z][a-z-]*)'/g)].map(m => m[1]);
  for (const m of dispatch.matchAll(/\[([^\]]+)\]\.includes\(group\)/g)) groups.push(...quoted(m[1]));
  const commands = [];
  for (const group of new Set(groups)) {
    const direct = [...dispatch.matchAll(/group === '([^']+)' && action === '([^']+)'/g)]
      .filter(m => m[1] === group).map(m => m[2]);
    const handler = dispatch.match(new RegExp(`if \\(group === '${group}'\\) return await (\\w+)\\(ctx, action, args`));
    let actions = direct;
    if (group === 'config') actions = actionsOf(configCommand.toString());
    else if (handler) {
      const start = cliSource.indexOf(`async function ${handler[1]}(`);
      assert.ok(start >= 0, `handler ${handler[1]}`);
      const rest = cliSource.slice(start + 1);
      const end = rest.search(/\n(?:export )?(?:async )?function /);
      actions = actionsOf(end < 0 ? rest : rest.slice(0, end));
    }
    commands.push(...(actions.length ? actions.map(a => `okit-plugin ${group} ${a}`) : [`okit-plugin ${group}`]));
  }
  assert.ok(commands.length > 0, 'dispatch inventory is nonempty');
  return [...new Set(commands)];
}

const commands = dispatchCommands(main.toString());
const skillFolders = (await readdir(resolve(root, 'skills'), { withFileTypes: true }))
  .filter(entry => entry.isDirectory()).map(entry => entry.name);
const skills = await Promise.all(skillFolders.map(async folder => {
  const text = await source(`skills/${folder}/SKILL.md`);
  const name = text.match(/^name: (\S+)$/m)?.[1];
  assert.equal(name, folder, 'skill frontmatter matches its directory');
  return name;
}));
const hookFiles = (await readdir(resolve(root, 'src'))).filter(name => /^hook-.*\.js$/.test(name));
const collector = `${DEFAULT_CONFIG.statuslineRegistration.subcommand}.js`;
const hooks = [...hookFiles, collector];
for (const name of hooks) {
  const module = await import(new URL(`../src/${name === collector ? 'quota/' : ''}${name}`, import.meta.url));
  assert.ok(Object.values(module).some(value => typeof value === 'function'), name);
}

test('reference has exactly the required files and matching language structure', async () => {
  assert.deepEqual((await readdir(directory)).sort(), names.toSorted());
  for (const page of pages) {
    const en = await read(`${page}.md`), pt = await read(`${page}.pt-BR.md`);
    for (const text of [en, pt]) {
      checkPage(text, COMPONENT_LINE_BUDGETS[page]);
      assert.ok(anchors(text).length > 0, `${page}: explicit anchors`);
      assert.equal(new Set(anchors(text)).size, anchors(text).length, `${page}: unique anchors`);
    }
    assert.deepEqual(headings(en), headings(pt), `${page}: heading levels/count`);
    assert.deepEqual(anchors(en), anchors(pt), `${page}: anchors`);
  }
});

for (const suffix of ['', '.pt-BR']) {
  test(`MCP tools have exact bidirectional coverage ${suffix || 'en'}`, async () => {
    const text = await read(`mcp-tools${suffix}.md`);
    equalInventory(text, TOOL_NAMES, 'MCP tools');
    for (const tool of TOOLS) {
      const row = text.split('\n').find(line => line.startsWith(`| \`${tool.name}\` |`));
      assert.equal(row.split('|').length, 6, `${tool.name}: four complete columns`);
      for (const key of Object.keys(tool.inputSchema.properties)) assert.ok(row.includes(key), key);
    }
  });

  test(`skills and their quoted resources exist ${suffix || 'en'}`, async () => {
    const text = await read(`skills${suffix}.md`);
    equalInventory(text, skills, 'skills');
    for (const line of text.split('\n').filter(line => line.startsWith('| `'))) {
      for (const [, name] of line.matchAll(/`([^`]+)`/g)) {
        assert.ok(skills.includes(name) || TOOL_NAMES.includes(name) || commands.includes(name),
          `unknown skill resource: ${name}`);
      }
    }
  });

  test(`CLI dispatch has exact bidirectional coverage ${suffix || 'en'}`, async () => {
    const text = await read(`cli${suffix}.md`);
    equalInventory(text, commands, 'CLI commands');
    for (const line of text.split('\n').filter(line => line.startsWith('| `'))) {
      const cells = [...line.matchAll(/`([^`]+)`/g)].map(m => m[1]);
      assert.equal(cells.length, 2, 'command and example');
      assert.ok(cells[1] === cells[0] || cells[1].startsWith(cells[0] + ' '), 'matching example');
    }
  });

  test(`hooks have exact bidirectional coverage ${suffix || 'en'}`, async () => {
    equalInventory(await read(`hooks${suffix}.md`), hooks, 'hooks');
  });

  test(`configuration covers all exported defaults and schema keys ${suffix || 'en'}`, async () => {
    const text = await read(`configuration${suffix}.md`);
    function checkKeys(object, prefix = '') {
      for (const [key, value] of Object.entries(object)) {
        const path = prefix ? `${prefix}.${key}` : key;
        if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length) {
          checkKeys(value, path);
        } else assert.ok(text.includes(`\`${path}\``), `configuration key ${path}`);
      }
    }
    checkKeys(DEFAULT_CONFIG);
    for (const { path } of CONFIG_SCHEMA.entries) assert.ok(text.includes(`\`${path}\``), path);
  });
}
