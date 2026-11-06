// D99: product prose, comments and instructions must not revive removed commands.
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const ROOTS = ['src', 'scripts', 'skills', 'adapters', 'docs', 'README.md', 'README.pt-BR.md',
  'INSTALL.md', 'INSTALL.pt-BR.md', 'package.json', 'install.sh', 'install.ps1'];
const SKIP = new Set(['node_modules', 'test', 'CHANGELOG.md', 'changelog.d']);
const REMOVED = 'status|env|actors|config|quota|telemetry|trajectory|inbox|todo|kit|autostart|smoke-demo|client-smoke|smoke';
const PATTERN = new RegExp(
  String.raw`(?:okit-plugin|\{bin\}|\{command\}|\$\{[^}\n]*(?:bin|command)[^}\n]*\}|node\s+(?:\./)?src/cli\.js)\s+(?!config\s+ui(?![\w-]))(?:${REMOVED})(?![\w-])`
  + String.raw`|\[\s*['"](?:${REMOVED})['"]\s*[,\]]`, 'g');

// Exact matches with occurrence counts: another instruction in the same file still fails.
// These are operation names, never instructions for invoking the plugin.
const ALLOWED = new Map([
  ['src/core/daemon.js', [["['status',", 1, 'daemon MCP action names']]],
  ['src/core/inbox-operations.js', [["['status',", 1, 'inbox_list MCP argument names']]],
  ['src/install/index.js', [["['quota']", 1, 'installer presentation step']]],
  ['src/install/present.js', [["['quota']", 2, 'installer presentation steps'], ["['smoke']", 1, 'installer presentation step']]],
  ['install.sh', [["['quota']", 2, 'embedded installer presentation steps'], ["['smoke']", 1, 'embedded installer presentation step']]],
  ['install.ps1', [["['quota']", 2, 'embedded installer presentation steps'], ["['smoke']", 1, 'embedded installer presentation step']]],
  ['src/smoke/report.js', [["['smoke',", 1, 'plain report label, not command arguments']]],
  ['src/release/publish.js', [["['status',", 1, 'Git working tree operation, not the plugin']]],
  ['src/smoke/checks-features.js', [["['config',", 1, 'external kit configuration probe'], ["['quota',", 1, 'external kit quota probe']]],
  ['src/telemetry/config.js', [["['telemetry',", 1, 'external kit telemetry probe']]],
]);

async function walk(name, files) {
  for (const entry of await readdir(join(ROOT, name), { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const child = `${name}/${entry.name}`;
    if (entry.isDirectory()) await walk(child, files);
    else if (entry.isFile()) files.push(child);
  }
}

test('removed command guard allows only the config ui subcommand', () => {
  for (const command of ['okit-plugin', '{command}', '{bin}', 'node src/cli.js']) {
    for (const [suffix, refused] of [['config ui', false], ['config ui --no-open', false],
      ['config set', true], ['config', true], ['config uix', true], ['config ui-other', true]]) {
      assert.equal([...`${command} ${suffix}`.matchAll(PATTERN)].length > 0, refused, suffix);
    }
  }
});

test('product files contain no removed plugin command instructions', async () => {
  const files = [];
  for (const name of ROOTS) {
    if (name.includes('.') || name.startsWith('README') || name.startsWith('INSTALL')) files.push(name);
    else await walk(name, files);
  }
  assert.ok(files.length > 100, 'scan the whole product');
  const failures = [];
  for (const name of files) {
    const source = await readFile(join(ROOT, name), 'utf8');
    const allowed = new Map((ALLOWED.get(name) ?? []).map(([text, count, reason]) => {
      assert.ok(reason, `${name}: exemption needs a reason`);
      return [text, count];
    }));
    for (const match of source.matchAll(PATTERN)) {
      if ((allowed.get(match[0]) ?? 0) > 0) {
        allowed.set(match[0], allowed.get(match[0]) - 1);
      } else {
        const line = source.slice(0, match.index).split('\n').length;
        failures.push(`${name}:${line}: ${match[0]}`);
      }
    }
    for (const [text, remaining] of allowed) {
      assert.equal(remaining, 0, `${name}: stale exemption for ${text}`);
    }
  }
  assert.deepEqual(failures, [], `Removed command references:\n${failures.join('\n')}`);
});
