import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { installSkillFiles } from '../src/skills.js';

const SKILLS_DIR = fileURLToPath(new URL('../skills/', import.meta.url));
const EXPECTED_SKILLS = ['okit-critic', 'okit-director', 'okit-executor'];
const MAX_DESCRIPTION = 300;
const MAX_BODY_LINES = 60;
const FENCE = '---';

// The tools the MCP server exposes. A skill names them by name, so a name that
// is not here is a stale reference to the old kit CLI.
const TOOLS = new Set([
  'acquire_slot',
  'release_slot',
  'limits_status',
  'classify',
  'profile_pick',
  'inbox_add',
  'inbox_list',
  'inbox_set_status',
  'order_add',
  'order_list',
  'order_remove',
]);

const SNAKE_CASE = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g;
const OLD_CLI = /\bkit\b/;

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

test('the plugin ships a skill for the director, the executor and the critic', async () => {
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

test('no skill mentions the old kit CLI', async () => {
  for (const folder of await skillFolders()) {
    const { fields, body } = await readSkill(folder);
    const text = `${fields.description ?? ''}\n${body}`;

    assert.doesNotMatch(text, OLD_CLI, `${folder} mentions kit`);
  }
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

test('installSkillFiles installs the real skills of the plugin', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'skills-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  for (const folder of EXPECTED_SKILLS) {
    const result = await installSkillFiles(join(SKILLS_DIR, folder), join(root, folder));
    assert.deepEqual(result.written, ['SKILL.md']);
    assert.deepEqual(result.skipped, []);
    assert.equal(
      await readFile(join(result.path, 'SKILL.md'), 'utf8'),
      await readFile(join(SKILLS_DIR, folder, 'SKILL.md'), 'utf8'),
    );
  }
});

test('installSkillFiles refuses folders it cannot read', async (t) => {
  const { root, src } = await fixture(t, { 'SKILL.md': 'body\n' });

  await assert.rejects(installSkillFiles(join(root, 'absent'), join(root, 'dest')), { code: 'ENOENT' });
  await assert.rejects(installSkillFiles('', join(root, 'dest')), /srcDir must be a non-empty string/);
  await assert.rejects(installSkillFiles(src, 42), /destDir must be a non-empty string/);
});