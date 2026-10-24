#!/bin/sh
# Generated from src/install/bootstrap.js; inspect before executing.
command -v node >/dev/null 2>&1 || { echo 'Node required: https://nodejs.org/' >&2; exit 2; }
node -e "$(cat <<'OKIT_BOOTSTRAP'
// BEGIN OKIT CONFIG (each key overridden by OKIT_<KEY>)
const defaults = {"REPO":"asantos43/okit-plugin","API":"https://api.github.com","CLIENTS":"{\"claude-code\":\"claude\",\"codex\":\"codex\",\"opencode\":\"opencode\"}","NAME":"{package}-{version}-{client}-{system}-{arch}.{ext}","COMMAND":"okit-plugin","MIN_NODE":"20","PACKAGE":"okit-plugin","MANIFEST":"{package}-{version}-checksums.sha256","TAG_PREFIX":"v","DIRECTORY":"okit-plugin","DEST":"","DATA_ROOTS":"{\"linux\":[\"XDG_DATA_HOME\",\".local\",\"share\"],\"darwin\":[null,\"Library\",\"Application Support\"],\"win32\":[\"LOCALAPPDATA\",\"AppData\",\"Local\"]}","FORMATS":"{\"linux\":\"tar.gz\",\"windows\":\"zip\",\"macos\":\"tar.gz\"}","SYSTEMS":"{\"Linux\":\"linux\",\"Darwin\":\"macos\",\"Windows_NT\":\"windows\"}","ARCHITECTURES":"{\"x86_64\":\"x64\",\"aarch64\":\"arm64\",\"arm64\":\"arm64\",\"x64\":\"x64\"}"};
// END OKIT CONFIG
// Embedded into the standalone release scripts by the build; no repo imports.
async function bootstrap(defaults) {
  const fs = await import('node:fs/promises');
  const { join, resolve } = await import('node:path');
  const { homedir, tmpdir } = await import('node:os');
  const { spawnSync } = await import('node:child_process');
  const env = process.env;
  const config = Object.fromEntries(Object.entries(defaults).map(([key, value]) => [key, env[`OKIT_${key}`] ?? value]));
  const fail = (message, code = 2) => { throw Object.assign(new Error(message), { code }); };
  const run = (command, args) => {
    const result = spawnSync(command, args, { encoding: 'utf8' });
    if (result.error || result.status !== 0) fail(result.stderr || result.error?.message || `${command} failed`, 1);
    return result.stdout;
  };
  const exists = async (path) => Boolean(await fs.stat(path).catch(() => null));
  if (Number(process.versions.node.split('.')[0]) < Number(config.MIN_NODE)) fail(`Node >=${config.MIN_NODE} required; obtain Node from https://nodejs.org/`);
  const args = process.argv.slice(1);
  const action = ['install', 'update', 'uninstall'].includes(args[0]) ? args.shift() : 'install';
  const flags = {}, forwarded = [];
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (['--client', '--dest'].includes(key)) {
      if (!args[i + 1] || args[i + 1].startsWith('--')) fail(`Missing value for ${key}`);
      flags[key] = args[++i];
    } else if (['--dry-run', '--yes', '--no-link', '--no-path', '--autostart', '--prerelease', '--check', '--rollback', '--purge'].includes(key)) flags[key] = true;
    else fail(`Unknown flag: ${key}`);
  }
  const platform = process.platform;
  const systems = JSON.parse(config.SYSTEMS), architectures = JSON.parse(config.ARCHITECTURES);
  const rawSystem = platform === 'win32' ? 'Windows_NT' : run('uname', ['-s']).trim();
  const system = systems[rawSystem];
  const rawArch = platform === 'win32' ? process.arch : run('uname', ['-m']).trim();
  const arch = architectures[rawArch];
  if (!system || !arch) fail(`No package for system/architecture: ${rawSystem}/${rawArch}`);
  const roots = JSON.parse(config.DATA_ROOTS)[platform];
  const destination = resolve(flags['--dest'] || config.DEST || join(env[roots[0]] || join(env.HOME || env.USERPROFILE || homedir(), ...roots.slice(1)), config.DIRECTORY));
  const recordFile = join(destination, 'install.json');
  const records = [];
  for (const client of Object.keys(JSON.parse(config.CLIENTS))) {
    const path = join(destination, `install.${client}.json`);
    if (await exists(path)) records.push(JSON.parse(await fs.readFile(path, 'utf8')));
  }
  if (!records.length && await exists(recordFile)) records.push(JSON.parse(await fs.readFile(recordFile, 'utf8')));
  const record = flags['--client'] ? records.find((item) => item.client === flags['--client']) : records[0];
  const invoke = (cli, command, values) => {
    const result = spawnSync(process.execPath, [cli, command, ...values], { stdio: 'inherit' });
    process.exitCode = result.status ?? 1;
  };
  if (action !== 'install') {
    if (!record) fail(`No installation record found at ${recordFile}`);
    for (const key of Object.keys(flags)) {
      if (key === '--dest') continue;
      if (key === '--client') { forwarded.push(key, flags[key]); continue; }
      if (!['--check', '--rollback', '--dry-run', '--yes', '--purge', '--no-path'].includes(key)) fail(`Unsupported ${action} flag: ${key}`);
      forwarded.push(key);
    }
    invoke(join(record.path, 'src/cli.js'), action, forwarded);
    return;
  }
  if (flags['--check'] || flags['--rollback'] || flags['--purge']) fail('Use update --check|--rollback or uninstall --purge');
  const clients = JSON.parse(config.CLIENTS);
  let client = flags['--client'] || env.OKIT_CLIENT || record?.client;
  if (!client) {
    const entries = Object.entries(clients);
    entries.forEach(([name, executable], i) => {
      const detected = platform === 'win32' ? spawnSync('where.exe', [executable]).status === 0
        : spawnSync('sh', ['-c', 'command -v "$1"', 'sh', executable]).status === 0;
      console.log(`${i + 1}. ${name}${detected ? ' (detected)' : ''}`);
    });
    if (!process.stdin.isTTY && !process.stdout.isTTY) fail('Without TTY select --client: ' + entries.map(([name]) => name).join(', '));
    const { createInterface } = await import('node:readline/promises');
    const stream = process.stdin.isTTY || platform === 'win32' ? process.stdin : (await import('node:fs')).createReadStream('/dev/tty');
    const input = createInterface({ input: stream, output: process.stdout });
    try { client = entries[Number(await input.question('Client number: ')) - 1]?.[0]; }
    finally { input.close(); if (stream !== process.stdin) stream.destroy(); }
  }
  if (!Object.hasOwn(clients, client)) fail(`Invalid client; choose: ${Object.keys(clients).join(', ')}`);
  const temporary = await fs.mkdtemp(join(tmpdir(), 'okit-bootstrap-'));
  const ps = (code, values) => {
    const literal = (value) => "'" + String(value).replace(/'/g, "''") + "'";
    const encoded = Buffer.from(`${code} ${values.map(literal).join(' ')}`, 'utf16le').toString('base64');
    return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded]);
  };
  const download = (url, file) => {
    if (platform === 'win32') return ps('& { param($url,$file) $ErrorActionPreference="Stop"; Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $file }', [url, file]);
    if (spawnSync('sh', ['-c', 'command -v curl']).status === 0) return run('curl', ['-fLsS', '--connect-timeout', '15', '--max-time', '120', '-o', file, url]);
    return run('wget', ['-q', '-T', '120', '-O', file, url]);
  };
  try {
    const metadata = join(temporary, 'release.json');
    const base = `${config.API}/repos/${config.REPO}/releases`;
    let selected;
    if (!flags['--prerelease']) {
      // Only a missing stable release triggers the pre-release fallback.
      if (platform === 'win32') {
        const status = ps('& { param($url,$file) try { Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $file; "200" } catch { if ($_.Exception.Response.StatusCode.value__ -eq 404) { "404" } else { throw } } }', [`${base}/latest`, metadata]).trim();
        if (status === '200') selected = JSON.parse(await fs.readFile(metadata, 'utf8'));
      } else {
        let status;
        if (spawnSync('sh', ['-c', 'command -v curl']).status === 0) {
          status = run('curl', ['-LsS', '--connect-timeout', '15', '--max-time', '120', '-w', '%{http_code}', '-o', metadata, `${base}/latest`]).trim();
        } else {
          const result = spawnSync('wget', ['-T', '120', '-O', metadata, `${base}/latest`], { encoding: 'utf8' });
          status = result.status === 0 ? '200' : /404/.test(result.stderr) ? '404' : 'error';
        }
        if (status === '200') selected = JSON.parse(await fs.readFile(metadata, 'utf8'));
        else if (status !== '404') fail(`Release API returned ${status}`, 1);
      }
    }
    if (!selected) {
      download(base, metadata);
      selected = JSON.parse(await fs.readFile(metadata, 'utf8')).filter((item) => !item.draft)
        .sort((a, b) => Date.parse(b.published_at || b.created_at) - Date.parse(a.published_at || a.created_at))[0];
    }
    if (!selected) fail('No published releases found');
    const version = selected.tag_name.startsWith(config.TAG_PREFIX) ? selected.tag_name.slice(config.TAG_PREFIX.length) : selected.tag_name;
    if (!/^[A-Za-z0-9][A-Za-z0-9.+_-]*$/.test(version) || version.includes('..')) fail('Unsafe release version');
    const render = (template) => template.replace(/\{(package|version|client|system|arch|ext)\}/g, (_, key) => ({ package: config.PACKAGE, version, client, system, arch, ext: JSON.parse(config.FORMATS)[system] })[key]);
    const name = render(config.NAME), manifestName = render(config.MANIFEST);
    if (/[\\/]/.test(name) || /[\\/]/.test(manifestName)) fail('Unsafe asset name');
    const asset = selected.assets?.find((item) => item.name === name);
    const manifest = selected.assets?.find((item) => item.name === manifestName);
    if (!asset || !manifest) fail(`Missing release asset: ${!asset ? name : manifestName}`);
    console.log(`Release: ${version}${selected.prerelease ? ' (pre-release fallback)' : ''}\nAsset: ${name}\nDestination: ${destination}`);
    console.log('SHA-256 detects altered bytes; it does not authenticate the source.');
    if (record?.version === version && record.client === client) {
      invoke(join(record.path, 'src/cli.js'), 'install', ['--client', client, '--from', record.path, '--dest', destination,
        ...['--dry-run', '--no-link', '--no-path'].filter((key) => flags[key])]); return;
    }
    if (flags['--dry-run']) { console.log('Would download, verify, extract and install; no destination writes.'); return; }
    const archive = join(temporary, name), hashes = join(temporary, manifestName);
    download(manifest.browser_download_url, hashes);
    const entries = (await fs.readFile(hashes, 'utf8')).trimEnd().split('\n').map((line) => /^([a-f0-9]{64})  (.+)$/.exec(line.replace(/\r$/, '')));
    const matches = entries.filter((entry) => entry?.[2] === name);
    if (entries.some((entry) => !entry) || matches.length !== 1) fail('Checksum manifest missing unique package line or malformed', 1);
    download(asset.browser_download_url, archive);
    let hash;
    if (platform === 'win32') hash = ps('& { param($file) (Get-FileHash -Algorithm SHA256 -LiteralPath $file).Hash }', [archive]).trim().toLowerCase();
    else if (spawnSync('sh', ['-c', 'command -v sha256sum']).status === 0) hash = run('sha256sum', [archive]).split(/\s/)[0];
    else if (spawnSync('sh', ['-c', 'command -v shasum']).status === 0) hash = run('shasum', ['-a', '256', archive]).split(/\s/)[0];
    else hash = run('openssl', ['dgst', '-sha256', archive]).trim().split(/\s/).at(-1);
    if (hash !== matches[0][1]) fail('SHA-256 mismatch: package refused', 1);
    const extracted = join(temporary, 'extracted');
    await fs.mkdir(extracted);
    if (platform === 'win32') ps('& { param($file,$dest) $ErrorActionPreference="Stop"; Expand-Archive -LiteralPath $file -DestinationPath $dest }', [archive, extracted]);
    else run('tar', ['-xzf', archive, '-C', extracted]);
    for (const key of ['--dry-run', '--yes', '--no-link', '--no-path', '--autostart', '--prerelease']) if (flags[key]) forwarded.push(key);
    invoke(join(extracted, 'src/cli.js'), 'install', ['--client', client, '--from', extracted, '--dest', destination, '--repo', config.REPO, ...forwarded]);
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
}

bootstrap(defaults).catch(error => { console.error(error.message); process.exitCode = Number.isInteger(error.code) ? error.code : 1; });
OKIT_BOOTSTRAP
)" -- "$@"
