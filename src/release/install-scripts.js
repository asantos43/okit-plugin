import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CONFIG_MESSAGES, DEFAULT_CONFIG, LOCALES } from '../profiles.js';
import { HOME_ENV, ROOT_FOLDER } from '../store.js';

export function scriptDefaults(pkg, install = DEFAULT_CONFIG.install, release = DEFAULT_CONFIG.release, quotaClient = DEFAULT_CONFIG.statuslineRegistration.client) {
  return {
    REPO: install.repository, API: install.api,
    CLIENTS: JSON.stringify(Object.fromEntries(Object.entries(install.clients).map(([key, value]) => [key, value.executable]))),
    NAME: install.name ?? release.name, COMMAND: install.command,
    MIN_NODE: pkg.engines.node.match(/\d+/)[0], PACKAGE: pkg.name,
    // Where the saved configuration (and so the saved language) lives: the Node part of the script reads it before it analyses a flag.
    STATE_ENV: HOME_ENV, STATE_FOLDER: ROOT_FOLDER,
    QUOTA_CLIENT: quotaClient, MANIFEST: install.manifest, TAG_PREFIX: release.publish.tagPrefix,
    DIRECTORY: install.directory, DEST: install.destination ?? '',
    DATA_ROOTS: JSON.stringify(install.dataRoots),
    FORMATS: JSON.stringify(release.formats),
    SYSTEMS: JSON.stringify({ Linux: install.systems.linux, Darwin: install.systems.darwin, Windows_NT: install.systems.win32 }),
    ARCHITECTURES: JSON.stringify({ x86_64: install.architectures.x64, aarch64: install.architectures.arm64, arm64: install.architectures.arm64, x64: install.architectures.x64 }),
  };
}

/** The installer's presenter as a value the standalone script can hold: its source, without the import and exports. */
export async function embeddedPresenter(root) {
  const source = await readFile(join(root, 'src/install/present.js'), 'utf8');
  const policy = await readFile(join(root, 'src/install/exit.js'), 'utf8');
  const rules = (await readFile(join(root, 'src/install/rules.js'), 'utf8')).replace(/^export /gm, '');
  const link = /^import \{ LOCALES, CONFIG_MESSAGES \} from '\.\.\/profiles\.js';\nimport \{ RULE_REASONS \} from '\.\/rules\.js';\n/m;
  const reexport = /^export \{ exitCodeFor, kindOf \} from '\.\/exit\.js';\n/m;
  if (!link.test(source) || !reexport.test(source)) throw new Error('src/install/present.js: unexpected imports');
  const body = source.replace(link, () => `const LOCALES = ${JSON.stringify(LOCALES)};\nconst CONFIG_MESSAGES = ${JSON.stringify(CONFIG_MESSAGES)};\n${rules}\n`).replace(reexport, '').replace(/^export /gm, '');
  if (/^(import|export) /m.test(body) || /^import /m.test(rules) || /^(import|export) /m.test(policy.replace(/^export /gm, ''))) throw new Error('src/install/present.js: unexpected imports');
  return `const present = (() => {\n${body}\n${policy.replace(/^export /gm, '')}\nreturn { createPresenter, clientLabel, systemLabel, redact, redactingWriter, redactingStream, resolveLocale, localizeReason, planSteps, exitCodeFor, kindOf };\n})();`;
}

// Node may be missing, so the wrappers pick the language of their one refusal themselves: a valid --locale (the last
// one), then a valid OKIT_LANGUAGE, then the language of the system, then English. This is the one documented exception
// to the installer's precedence (resolveLocale: ... then the saved language): there is no Node yet, so the wrappers read
// no configuration and no other file, and never parse JSON. Only exactly `en` or `pt-BR` count for the flag and the
// environment. The language of the system is the first non-empty of LC_ALL, LC_MESSAGES, LANG (the UI culture on
// Windows): `pt` followed by the end, `_`, `-` or `.` is pt-BR, anything else is English.
const NODE_MISSING = 'Node required: https://nodejs.org/';
const NODE_MISSING_PT = 'Node.js é necessário: https://nodejs.org/';
// Windows PowerShell 5.1 reads a script without a BOM as ANSI, so the accents are code points there.
const NODE_MISSING_PT_PS = `'Node.js '+[char]0xE9+' necess'+[char]0xE1+'rio: https://nodejs.org/'`;
const SH_NODE_CHECK = [
  'command -v node >/dev/null 2>&1 || {',
  ' okit_lang=${OKIT_LANGUAGE-}; okit_flag=; okit_prev=;',
  ' for okit_arg in "$@"; do',
  '  if [ "$okit_prev" = --locale ]; then okit_flag=$okit_arg; fi;',
  '  okit_prev=$okit_arg;',
  ' done;',
  // The language of the system, with shell built-ins only (a computer without Node may have a PATH without more).
  " okit_sys=${LC_ALL-}; [ -n \"$okit_sys\" ] || okit_sys=${LC_MESSAGES-}; [ -n \"$okit_sys\" ] || okit_sys=${LANG-};",
  ' case $okit_sys in pt|pt_*|pt-*|pt.*) okit_sys=pt-BR ;; *) okit_sys=en ;; esac;',
  ' case $okit_flag in en|pt-BR) okit_lang=$okit_flag ;; *) case $okit_lang in en|pt-BR) ;; *) okit_lang=$okit_sys ;; esac ;; esac;',
  ` if [ "$okit_lang" = pt-BR ]; then echo '${NODE_MISSING_PT}' >&2; else echo '${NODE_MISSING}' >&2; fi;`,
  ' exit 2;',
  '}',
].join('\n');
const PS_NODE_CHECK = [
  'if (-not (Get-Command node -ErrorAction SilentlyContinue)) {',
  '  $okitLang = $env:OKIT_LANGUAGE; $okitFlag = $null; $okitSystem = $null',
  "  for ($i = 0; $i -lt $args.Count - 1; $i++) { if ($args[$i] -ceq '--locale') { $okitFlag = $args[$i + 1] } }",
  "  try { if ([Globalization.CultureInfo]::CurrentUICulture.Name -cmatch '^pt([-_.]|$)') { $okitSystem = 'pt-BR' } } catch { $okitSystem = $null }",
  "  if (@('en', 'pt-BR') -ccontains $okitFlag) { $okitLang = $okitFlag } elseif (@('en', 'pt-BR') -cnotcontains $okitLang) { $okitLang = $okitSystem }",
  `  if ($okitLang -ceq 'pt-BR') { Write-Error (${NODE_MISSING_PT_PS}) } else { Write-Error '${NODE_MISSING}' }`,
  '  exit 2',
  '}',
].join('\n');

export async function renderInstallScripts(root, pkg, install, release) {
  const source = await readFile(join(root, 'src/install/bootstrap.js'), 'utf8');
  const presenter = await embeddedPresenter(root);
  const defaults = JSON.stringify(scriptDefaults(pkg, install, release));
  const js = `// BEGIN OKIT CONFIG (each key overridden by OKIT_<KEY>)\nconst defaults = ${defaults};\n// END OKIT CONFIG\n${presenter}\n${source}\nbootstrap(defaults, present).catch(error => { present.redactingWriter((line) => console.error(line))(error.message); process.exitCode = present.exitCodeFor(present.kindOf(error)); });`;
  return {
    'install.sh': `#!/bin/sh\n# Generated from src/install/bootstrap.js; inspect before executing.\n${SH_NODE_CHECK}\nnode -e "$(cat <<'OKIT_BOOTSTRAP'\n${js}\nOKIT_BOOTSTRAP\n)" -- "$@"\n`,
    'install.ps1': `# Generated from src/install/bootstrap.js; inspect before executing.\n${PS_NODE_CHECK}\n$okitBootstrap = @'\n${js}\n'@\n$okitEncoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($okitBootstrap))\n& node -e "eval(Buffer.from(process.argv.splice(1,1)[0],'base64').toString())" -- $okitEncoded @args\nif ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }\n`,
  };
}

export async function writeInstallScripts(root, out, pkg, install, release) {
  const scripts = await renderInstallScripts(root, pkg, install, release);
  for (const [file, source] of Object.entries(scripts)) await writeFile(join(out, file), source);
  return Object.keys(scripts);
}
