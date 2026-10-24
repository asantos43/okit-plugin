import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_CONFIG } from '../profiles.js';

export function scriptDefaults(pkg, install = DEFAULT_CONFIG.install, release = DEFAULT_CONFIG.release) {
  return {
    REPO: install.repository, API: install.api,
    CLIENTS: JSON.stringify(Object.fromEntries(Object.entries(install.clients).map(([key, value]) => [key, value.executable]))),
    NAME: install.name ?? release.name, COMMAND: install.command,
    MIN_NODE: pkg.engines.node.match(/\d+/)[0], PACKAGE: pkg.name,
    MANIFEST: install.manifest, TAG_PREFIX: release.publish.tagPrefix,
    DIRECTORY: install.directory, DEST: install.destination ?? '',
    DATA_ROOTS: JSON.stringify(install.dataRoots),
    FORMATS: JSON.stringify(release.formats),
    SYSTEMS: JSON.stringify({ Linux: install.systems.linux, Darwin: install.systems.darwin, Windows_NT: install.systems.win32 }),
    ARCHITECTURES: JSON.stringify({ x86_64: install.architectures.x64, aarch64: install.architectures.arm64, arm64: install.architectures.arm64, x64: install.architectures.x64 }),
  };
}

export async function renderInstallScripts(root, pkg, install, release) {
  const source = await readFile(join(root, 'src/install/bootstrap.js'), 'utf8');
  const defaults = JSON.stringify(scriptDefaults(pkg, install, release));
  const js = `// BEGIN OKIT CONFIG (each key overridden by OKIT_<KEY>)\nconst defaults = ${defaults};\n// END OKIT CONFIG\n${source}\nbootstrap(defaults).catch(error => { console.error(error.message); process.exitCode = Number.isInteger(error.code) ? error.code : 1; });`;
  return {
    'install.sh': `#!/bin/sh\n# Generated from src/install/bootstrap.js; inspect before executing.\ncommand -v node >/dev/null 2>&1 || { echo 'Node required: https://nodejs.org/' >&2; exit 2; }\nnode -e "$(cat <<'OKIT_BOOTSTRAP'\n${js}\nOKIT_BOOTSTRAP\n)" -- "$@"\n`,
    'install.ps1': `# Generated from src/install/bootstrap.js; inspect before executing.\nif (-not (Get-Command node -ErrorAction SilentlyContinue)) { Write-Error 'Node required: https://nodejs.org/'; exit 2 }\n$okitBootstrap = @'\n${js}\n'@\n$okitEncoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($okitBootstrap))\n& node -e "eval(Buffer.from(process.argv.splice(1,1)[0],'base64').toString())" -- $okitEncoded @args\nif ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }\n`,
  };
}

export async function writeInstallScripts(root, out, pkg, install, release) {
  const scripts = await renderInstallScripts(root, pkg, install, release);
  for (const [file, source] of Object.entries(scripts)) await writeFile(join(out, file), source);
  return Object.keys(scripts);
}
