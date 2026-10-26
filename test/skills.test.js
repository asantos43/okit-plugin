import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { installSkillFiles } from '../src/skills.js';
import { installSkill } from '../adapters/claude-code/index.js';

const SKILLS_DIR = fileURLToPath(new URL('../skills/', import.meta.url));
const EXPECTED_SKILLS = ['okit-critic', 'okit-director', 'okit-environment', 'okit-executor', 'okit-setup', 'okit-smoke'];
const MAX_DESCRIPTION = 300;
const MAX_BODY_LINES = 80;
const FENCE = '---';

// The tools the MCP server exposes. A skill names them by name, so a name that
// is not here is a stale reference to the old kit CLI.
const TOOLS = new Set([
  'acquire_slot',
  'release_slot',
  'limits_status',
  'actors_list',
  'env_report',
  'smoke_demo',
  'classify',
  'profile_pick',
  'inbox_add',
  'inbox_list',
  'inbox_claim',
  'inbox_release',
  'inbox_set_status',
  'order_add',
  'order_list',
  'order_remove',
]);

const SNAKE_CASE = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g;
const OLD_CLI = /\bkit\s+(?:daemon|autostart|status|inbox|smoke|client-smoke|hook)\b/;

// | Input | Must pass | Must refuse |
// | bilingual demo requests | smoke skill, preview and bound consent | automatic spending |
test('demonstration requests route to the smoke skill in both languages', async () => {
  const smoke = await readSkill('okit-smoke'), director = await readSkill('okit-director');
  for (const phrase of ['show a demonstration', 'run a real test', 'mostre uma demonstração', 'faça um teste de verdade']) {
    assert.ok(smoke.fields.description.includes(phrase), phrase);
    assert.ok(director.body.toLowerCase().includes(phrase), phrase);
  }
  for (const term of ['smoke_demo', 'planHash', 'Never approve automatically', 'measured usage']) assert.ok(smoke.body.includes(term));
});

test('all six skills share bilingual routing, glossary and read-only boundaries', async () => {
  for (const name of EXPECTED_SKILLS) {
    const { body } = await readSkill(name);
    for (const phrase of ['Where are you?', 'Onde você está?', 'Which actors/helpers?',
      'Quais atores/ajudantes?', 'How much quota?', 'Quanta cota?', 'What is missing?',
      'O que falta?', 'What is your role?', 'Qual o seu papel?', 'Run smoke/demonstration',
      'Rodar smoke/demonstração', 'with its own confirmation', 'com sua própria confirmação',
      'never save configuration, launch work or spend quota', 'somente leitura',
      'Actor / ator', 'executor', 'class / classe', 'size / tamanho', 'slot / vaga',
      'profile / perfil', 'quota / cota', 'source / fonte', 'worker', 'ajudante',
      'remaining limit', 'limite restante', 'sample', 'amostra']) assert.ok(body.includes(phrase), `${name}: ${phrase}`);
    for (const [question, routes] of [
      ['Where are you?', ['okit-environment', 'env_report', 'okit-plugin env report']],
      ['Which actors/helpers?', ['okit-director', 'actors_list', 'okit-plugin actors', 'status']],
      ['How much quota?', ['okit-environment', 'env_report', 'okit-plugin quota show', 'status']],
      ['What is missing?', ['env_report', 'okit-setup', 'okit-plugin setup']],
      ['What is your role?', ['okit-director', 'okit-executor', 'okit-critic', 'order_list', 'inbox_list', 'actors_list', 'limits_status', 'env_report']],
      ['Run smoke/demonstration', ['okit-smoke', 'okit-plugin client-smoke --client claude-code --demo', '--dry-run']],
    ]) {
      const row = body.split('\n').find((line) => line.startsWith(`| ${question}`));
      assert.ok(row, `${name}: ${question}`);
      for (const route of routes) assert.ok(row.includes(route), `${name}: ${question} → ${route}`);
    }
    assert.doesNotMatch(body.replace(/`[^`]*`/g, ''), /\b(?:D\d+|G\d+|demand[-_]id|order[-_]id)\b/i);
  }
});

test('actor routing preserves skill triggers and executor boundaries', async () => {
  const triggers = {
    'okit-director': "Use when you are the okit Director, orchestrating a demand over the client's own subagents through the okit MCP tools, in any session where work is delegated.",
    'okit-executor': 'Use when you were spawned by the okit Director as the executor of one step, to do exactly the briefing you received and report back.',
  };
  for (const [name, trigger] of Object.entries(triggers)) {
    const { fields } = await readSkill(name);
    assert.ok(fields.description.startsWith(`${trigger} `));
    assert.ok(fields.description.includes('atores, executores, actors, executors, modelos, quem pode rodar, lista de executores.'));
    assert.ok(fields.description.endsWith('An actor is a model + effort available in a client.'));
  }
  const { body } = await readSkill('okit-executor');
  const executionBody = body.split('## Before you start')[1];
  assert.doesNotMatch(executionBody, /actors_list|before sizing|choosing a profile/);
  assert.match(body, /actors_list.*limits_status.*env_report/);
  assert.match(body, /Environment and role questions are read-only/);
  const source = await readFile(join(SKILLS_DIR, 'okit-executor', 'SKILL.md'), 'utf8');
  assert.ok(source.trimEnd().endsWith('- Stop at the edge of the step. Merging, pushing, opening a pull request or editing an order happens only when the briefing says so.'));
});

test('Director requires readable work titles and internal-only identifiers in both languages', async () => {
  const { body } = await readSkill('okit-director');
  assert.match(body, /readable work titles with the Producer/);
  assert.match(body, /títulos legíveis com o Produtor/);
  assert.match(body, /identifiers only in tool\/command arguments/);
  assert.match(body, /identificadores somente nos argumentos de ferramentas\/comandos/);
});

function fail(message) {
  throw new TypeError(message);
}

/**
 * The front matter of a SKILL.md: the fenced block of `key: value` lines that
 * opens the file, and the body under it. Written here instead of pulled from a
 * parser package, so the plugin keeps zero dependencies. Only what a skill
 * needs is accepted, and anything else is refused by name.
 */
function parseFrontMatter(text) {
  if (typeof text !== 'string') fail('a skill file must be text');
  const source = text.replace(/\r\n/g, '\n');
  const open = `${FENCE}\n`;
  if (!source.startsWith(open)) fail('a skill must open with a --- fence');

  const close = source.indexOf(`\n${FENCE}`, open.length - 1);
  if (close === -1) fail('the front matter is not closed by a --- fence');

  const block = source.slice(open.length, close);
  const fields = {};
  for (const line of block.split('\n')) {
    if (line.trim() === '') continue;
    const at = line.indexOf(':');
    const key = at === -1 ? '' : line.slice(0, at).trim();
    if (key === '') fail(`front matter line is not "key: value": ${line}`);
    if (fields[key] !== undefined) fail(`duplicate front matter key: ${key}`);
    fields[key] = stripQuotes(line.slice(at + 1).trim());
  }

  return { fields, body: source.slice(close + 1 + FENCE.length).replace(/^\n+/, '') };
}

const stripQuotes = (value) => value.replace(/^(['"])([\s\S]*)\1$/, '$2');

const bodyLines = (body) => body.replace(/\n+$/, '').split('\n');

async function skillFolders() {
  const entries = await readdir(SKILLS_DIR, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

async function readSkill(folder) {
  const text = await readFile(join(SKILLS_DIR, folder, 'SKILL.md'), 'utf8');
  return parseFrontMatter(text);
}

// Must pass / must refuse table, front matter:
// | case                | must pass                            | must refuse                  |
// | one pair            | 'name: a'                           | -                            |
// | pair with colon     | 'description: use a: b'              | -                            |
// | quoted value        | 'a' from '"a"' and "'a'"            | -                            |
// | blank and last CRLF | skipped                             | -                            |
// | CRLF line endings   | read as LF                           | -                            |
// | value with : in it  | keeps the rest after the first colon | -                            |
// | no opening fence    | -                                    | 'a skill must open'          |
// | unclosed block      | -                                    | 'not closed'                 |
// | line without colon  | -                                    | 'not "key: value"'           |
// | leading colon       | -                                    | 'not "key: value"'           |
// | empty key           | -                                    | 'not "key: value"'           |
// | repeated key        | -                                    | 'duplicate front matter key' |
// | not a string        | -                                    | 'must be text'               |

test('parseFrontMatter reads the pairs and hands back the body', () => {
  const parsed = parseFrontMatter([
    '---',
    'name: okit-director',
    'description: "Use when you are: the director."',
    '---',
    '',
    '# Director',
    '',
    'Body line.',
    '',
  ].join('\n'));

  assert.deepEqual(parsed.fields, {
    name: 'okit-director',
    description: 'Use when you are: the director.',
  });
  assert.deepEqual(bodyLines(parsed.body), ['# Director', '', 'Body line.']);
});

test('parseFrontMatter reads CRLF line endings as LF', () => {
  const parsed = parseFrontMatter('---\r\nname: a\r\n---\r\n\r\nBody.\r\n');

  assert.deepEqual(parsed.fields, { name: 'a' });
  assert.deepEqual(bodyLines(parsed.body), ['Body.']);
});

test('parseFrontMatter refuses a file it cannot trust', () => {
  assert.throws(() => parseFrontMatter('# No fence'), /must open with a --- fence/);
  assert.throws(() => parseFrontMatter('---\nname: a\n'), /not closed by a --- fence/);
  assert.throws(() => parseFrontMatter('---\nname\n---\n'), /not "key: value"/);
  assert.throws(() => parseFrontMatter('---\n: a\n---\n'), /not "key: value"/);
  assert.throws(() => parseFrontMatter('---\n  : a\n---\n'), /not "key: value"/);
  assert.throws(() => parseFrontMatter('---\nname: a\nname: b\n---\n'), /duplicate front matter key/);
  assert.throws(() => parseFrontMatter(null), /must be text/);
});

test('the plugin ships director, executor, critic, smoke and setup skills', async () => {
  assert.deepEqual(await skillFolders(), EXPECTED_SKILLS);
});

test('every skill names itself after its folder and describes when to use it', async () => {
  for (const folder of await skillFolders()) {
    const { fields } = await readSkill(folder);

    assert.equal(fields.name, folder, `${folder}/SKILL.md must carry name: ${folder}`);
    assert.ok(fields.description, `${folder} needs a description`);
    assert.ok(
      fields.description.length < MAX_DESCRIPTION,
      `${folder} description is ${fields.description.length} chars, under ${MAX_DESCRIPTION} wanted`,
    );
  }
});

test('every skill body is short enough to be read whole', async () => {
  for (const folder of await skillFolders()) {
    const { body } = await readSkill(folder);

    assert.ok(body.trim() !== '', `${folder} needs a body`);
    assert.ok(
      bodyLines(body).length < MAX_BODY_LINES,
      `${folder} body is ${bodyLines(body).length} lines, under ${MAX_BODY_LINES} wanted`,
    );
  }
});

test('every snake_case name in a body is an MCP tool the server exposes', async () => {
  for (const folder of await skillFolders()) {
    const { body } = await readSkill(folder);
    const named = [...new Set(body.match(SNAKE_CASE) ?? [])];

    for (const name of named) {
      assert.ok(TOOLS.has(name), `${folder} names ${name}, which is not an MCP tool`);
    }
  }
});

test('every skill names the tools it needs and reaches for the inbox', async () => {
  const director = (await readSkill('okit-director')).body;

  for (const tool of ['order_list', 'classify', 'profile_pick', 'acquire_slot', 'release_slot', 'inbox_add', 'inbox_set_status']) {
    assert.ok(director.includes(tool), `the director must call ${tool}`);
  }

  const critic = (await readSkill('okit-critic')).body;
  assert.match(critic, /diff/, 'the critic judges by reading the diff');
  assert.match(critic, /inbox_set_status/, 'the critic records its verdict');
});

test('skills allow naming the kit but never use it for plugin commands', async () => {
  for (const folder of await skillFolders()) {
    const { fields, body } = await readSkill(folder);
    const text = `${fields.description ?? ''}\n${body}`;

    assert.doesNotMatch(text, OLD_CLI, `${folder} mentions kit`);
  }
});

// Must pass / must refuse table, the smoke skill:
// | case                          | must pass                                                     | must refuse         |
// | a body that masks the code    | -                                                            | '|| true' anywhere  |
// | a body that captures the code | 'echo "exit=$?"', the end line of the runner, the artifacts | -                   |
test('the smoke skill captures the exit code and never masks it', async () => {
  const { body } = await readSkill('okit-smoke');
  assert.doesNotMatch(body, /\|\|\s*true/, 'the smoke skill must never mask the exit code');
  assert.match(body, /echo "exit=\$\?"/, 'the skill must capture the exit code of the run');
  assert.match(body, /smoke: end/, 'the skill must read the end line of the runner');
  assert.match(body, /newest artifact/, 'the skill must read the newest artifact when the output is empty');
  assert.match(body, /artifact paths/, 'the skill must report the artifact paths');
  assert.match(body, /actual process exit code/, 'the skill must report the real exit code');
});

// Must pass / must refuse table, the setup skill:
// | case                                  | must pass                                      | must refuse                    |
// | a skill that shows the plan first     | the questions before the save                  | -                              |
// | a skill that saves the user's choice  | the answer to the setup's own model question   | a configuration write command  |
test('the setup skill shows what will be written before it saves anything', async () => {
  const { fields, body } = await readSkill('okit-setup');
  assert.equal(fields.name, 'okit-setup');
  assert.match(body, /okit-plugin setup/);
  assert.match(body, /answer to the setup's own model question/);
  assert.doesNotMatch(body, /okit-plugin config set/);
  assert.doesNotMatch(body, /okit-plugin setup --defaults/);
  assert.doesNotMatch(body, /config\.json`?\s*(=|:)/, 'the skill must not write the configuration file');
  const ask = body.indexOf('Ask only what was not detected');
  const save = body.indexOf("Save only through the setup's final confirmation");
  assert.ok(ask !== -1 && save > ask, 'the questions come before the save');
});

// Must pass / must refuse table, installSkillFiles:
// | case                          | must pass                                | must refuse                |
// | empty destination             | every file written, paths with '/'       | -                          |
// | nested file                  | 'refs/a.md' written, 'refs' created      | -                          |
// | identical file already there  | skipped, reason 'identical'              | -                          |
// | differing file already there | skipped, reason 'differs', file untouched | -                         |
// | one folder, mixed state      | written and skipped reported apart        | -                          |
// | missing source folder        | -                                        | ENOENT from readdir        |
// | empty or non-string argument | -                                        | TypeError naming the arg   |

async function fixture(t, files) {
  const root = await mkdtemp(join(tmpdir(), 'skills-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const src = join(root, 'src');
  for (const [name, content] of Object.entries(files)) {
    const file = join(src, ...name.split('/'));
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content, 'utf8');
  }
  return { root, src, dest: join(root, 'dest') };
}

test('installSkillFiles writes every file of a skill folder', async (t) => {
  const { src, dest } = await fixture(t, { 'SKILL.md': 'body\n', 'refs/extra.md': 'extra\n' });

  const result = await installSkillFiles(src, dest);

  assert.equal(result.path, dest);
  assert.deepEqual(result.written, ['SKILL.md', 'refs/extra.md']);
  assert.deepEqual(result.skipped, []);
  assert.equal(await readFile(join(dest, 'SKILL.md'), 'utf8'), 'body\n');
  assert.equal(await readFile(join(dest, 'refs', 'extra.md'), 'utf8'), 'extra\n');
});

test('installSkillFiles leaves an identical file alone', async (t) => {
  const { src, dest } = await fixture(t, { 'SKILL.md': 'same\n' });
  await mkdir(dest, { recursive: true });
  await writeFile(join(dest, 'SKILL.md'), 'same\n', 'utf8');

  const result = await installSkillFiles(src, dest);

  assert.deepEqual(result.written, []);
  assert.deepEqual(result.skipped, [{ path: 'SKILL.md', reason: 'identical' }]);
});

test('installSkillFiles never overwrites a file the user changed', async (t) => {
  const { src, dest } = await fixture(t, { 'SKILL.md': 'ours\n', 'refs/extra.md': 'extra\n' });
  await mkdir(dest, { recursive: true });
  await writeFile(join(dest, 'SKILL.md'), 'theirs\n', 'utf8');

  const result = await installSkillFiles(src, dest);

  assert.equal(await readFile(join(dest, 'SKILL.md'), 'utf8'), 'theirs\n');
  assert.deepEqual(result.skipped, [{ path: 'SKILL.md', reason: 'differs' }]);
  assert.deepEqual(result.written, ['refs/extra.md']);
});

test('environment skill routes bilingual questions to the report and explains remedies', async () => {
  const { fields, body } = await readSkill('okit-environment');
  for (const trigger of ['where you are', 'what you have here', 'which environment',
    'onde você está', 'o que você tem aqui', 'qual ambiente']) assert.ok(fields.description.includes(trigger));
  assert.match(body, /okit-plugin env report/);
  assert.match(body, /env_report/);
  assert.match(body, /--locale en/);
  assert.match(body, /--locale pt-BR/);
  assert.match(body, /each missing item/);
  assert.match(body, /cada item que falta/);
  assert.match(body, /comando informado para corrigir/);
  assert.match(body, /CLAUDE_PLUGIN_ROOT/);
});

test('installSkillFiles installs the real skills of the plugin', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'skills-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  for (const folder of EXPECTED_SKILLS) {
    const result = await installSkill(folder, join(SKILLS_DIR, folder), { root });
    assert.deepEqual(result.written, ['SKILL.md']);
    assert.deepEqual(result.skipped, []);
    assert.equal(
      await readFile(join(result.path, 'SKILL.md'), 'utf8'),
      await readFile(join(SKILLS_DIR, folder, 'SKILL.md'), 'utf8'),
    );
    const second = await installSkill(folder, join(SKILLS_DIR, folder), { root });
    assert.deepEqual(second.written, []);
    assert.deepEqual(second.skipped, [{ path: 'SKILL.md', reason: 'identical' }]);
    await writeFile(join(result.path, 'SKILL.md'), 'user copy\n');
    const changed = await installSkill(folder, join(SKILLS_DIR, folder), { root });
    assert.deepEqual(changed.written, []);
    assert.deepEqual(changed.skipped, [{ path: 'SKILL.md', reason: 'differs' }]);
    assert.equal(await readFile(join(result.path, 'SKILL.md'), 'utf8'), 'user copy\n');
  }
});

test('installSkillFiles refuses folders it cannot read', async (t) => {
  const { root, src } = await fixture(t, { 'SKILL.md': 'body\n' });

  await assert.rejects(installSkillFiles(join(root, 'absent'), join(root, 'dest')), { code: 'ENOENT' });
  await assert.rejects(installSkillFiles('', join(root, 'dest')), /srcDir must be a non-empty string/);
  await assert.rejects(installSkillFiles(src, 42), /destDir must be a non-empty string/);
});
