// Embedded into the standalone release scripts by the build; no repo imports.
// `present` is the installer's presenter (src/install/present.js), embedded by the same build.
// Whatever fails is told without the query, fragment or credentials of an address and without the temporary folder.
async function bootstrap(defaults, present) {
  const hide = [];
  try { await install(defaults, present, hide); }
  catch (error) { error.message = present.redact(error.message, hide); throw error; }
}

async function install(defaults, present, hide) {
  const fs = await import('node:fs/promises');
  const { basename, join, resolve } = await import('node:path');
  const { homedir, tmpdir } = await import('node:os');
  const { spawnSync } = await import('node:child_process');
  hide.push(tmpdir());
  // The one door of the script's output: every line is redacted on its way out.
  const say = present.redactingWriter((line) => console.log(line), hide);
  const env = process.env;
  const config = Object.fromEntries(Object.entries(defaults).map(([key, value]) => [key, env[`OKIT_${key}`] ?? value]));
  // What kind of failure it is (`error.kind`, read by present.kindOf) decides the exit code (present.exitCodeFor); an error
  // that says no kind is a failure of the work. A refusal
  // (usage, language) is told the way the installed command tells it, in the language of the run: `Refused: ...` and
  // what to do next; a failure of the work is the text of what failed.
  let language = 'en';
  const fail = (message, kind = 'usage') => {
    const refusing = ['usage', 'language'].includes(kind);
    const ui = present.createPresenter({ locale: language, write: () => {} });
    const text = refusing ? ui.failure({ reason: message, next: ui.text('nextCheck') }).join('\n') : message;
    throw Object.assign(new Error(text), { kind, code: present.exitCodeFor(kind) });
  };
  const run = (command, args) => {
    const result = spawnSync(command, args, { encoding: 'utf8' });
    if (result.error || result.status !== 0) fail(result.stderr || result.error?.message || `${command} failed`, 'operational');
    return result.stdout;
  };
  const exists = async (path) => Boolean(await fs.stat(path).catch(() => null));
  // One language per run, chosen by the presenter's own function and in the installed command's order: a valid
  // --locale, then OKIT_LANGUAGE, then the saved language (the configuration is read here, before any flag is
  // analysed, so that every refusal of this script is said in the language of the run), then English. A language that
  // is not one, from the flag or from the file, is refused first, in the language the rest gives.
  const args = process.argv.slice(1);
  const stateRoot = resolve(env[config.STATE_ENV]?.trim() || join(homedir(), config.STATE_FOLDER));
  const saved = await fs.readFile(join(stateRoot, 'config.json'), 'utf8').then((text) => JSON.parse(text)).catch(() => null);
  const chosen = present.resolveLocale({ args, env, saved: saved?.language });
  language = chosen.locale;
  const t = (en, pt) => (language === 'pt-BR' ? pt : en);
  if (Number(process.versions.node.split('.')[0]) < Number(config.MIN_NODE)) fail(t(`Node >=${config.MIN_NODE} required; obtain Node from https://nodejs.org/`, `É preciso Node >=${config.MIN_NODE}; obtenha em https://nodejs.org/`));
  if (chosen.invalid) fail(t('Choose a language: en, pt-BR.', 'Escolha um idioma: en, pt-BR.'), 'language');
  // The OKIT_<KEY> overrides are the script's settings, read here once, before the system, the network or a flag is
  // touched. One that is not valid is a refusal of usage (exit 2) in the language of the run, and it never shows the value
  // (an address may carry a secret). JSON is parsed only here.
  const domains = {
    SYSTEMS: 'map', ARCHITECTURES: 'map', FORMATS: 'map', CLIENTS: 'map', DATA_ROOTS: 'roots', MIN_NODE: 'count', API: 'address',
    REPO: 'repository', STATE_ENV: 'variable', NAME: 'text', MANIFEST: 'text', COMMAND: 'text', PACKAGE: 'text', DIRECTORY: 'text',
    QUOTA_CLIENT: 'text', STATE_FOLDER: 'text', DEST: 'line', TAG_PREFIX: 'line',
  };
  const expected = {
    map: ['a JSON object whose values are text', 'um objeto JSON cujos valores são textos'],
    roots: ['a JSON object whose values are lists of folder names', 'um objeto JSON cujos valores são listas de nomes de pastas'],
    count: ['a whole number from 1', 'um número inteiro a partir de 1'],
    address: ['an address that starts with http:// or https:// and has no user name or password', 'um endereço que começa com http:// ou https:// e não tem usuário nem senha'],
    repository: ['owner/repository', 'dono/repositório'],
    variable: ['an environment variable name', 'um nome de variável de ambiente'],
    text: ['non-empty text', 'texto não vazio'],
    line: ['text on one line', 'texto em uma só linha'],
  };
  const isText = (value) => typeof value === 'string' && value.trim() !== '';
  const isMap = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  const valid = {
    map: (value) => isMap(value) && Object.keys(value).length > 0 && Object.entries(value).every(([key, item]) => key !== '' && isText(item)),
    roots: (value) => isMap(value) && Object.values(value).every((item) => Array.isArray(item) && item.length > 0
      && (item[0] === null || isText(item[0])) && item.slice(1).every(isText)),
    count: (value) => /^[1-9]\d{0,5}$/.test(value),
    address: (value) => { try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; } catch { return false; } },
    repository: (value) => /^[\w.-]+\/[\w.-]+$/.test(value),
    variable: (value) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(value),
    text: (value) => isText(value) && !/[\r\n\0]/.test(value),
    line: (value) => !/[\r\n\0]/.test(value),
  };
  const settings = {};
  for (const [key, domain] of Object.entries(domains)) {
    let value = config[key];
    if (['map', 'roots'].includes(domain)) { try { value = JSON.parse(value); } catch { value = undefined; } }
    if (!valid[domain](value)) fail(t(`Invalid OKIT_${key}: expected ${expected[domain][0]}`, `OKIT_${key} inválida: esperado ${expected[domain][1]}`));
    settings[key] = value;
  }
  const action = ['install', 'update', 'uninstall'].includes(args[0]) ? args.shift() : 'install';
  const flags = {}, forwarded = [];
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (['--client', '--dest', '--locale'].includes(key)) {
      if (!args[i + 1] || args[i + 1].startsWith('--')) fail(t(`Missing value for ${key}`, `Falta o valor de ${key}`));
      flags[key] = args[++i];
    } else if (['--dry-run', '--yes', '--no-link', '--no-path', '--autostart', '--prerelease', '--check', '--rollback', '--purge', '--verbose', '--set-execution-policy', '--no-execution-policy'].includes(key)) flags[key] = true;
    else fail(t(`Unknown flag: ${key}`, `Opção desconhecida: ${key}`));
  }
  const shared = [...(['flag', 'environment'].includes(chosen.source) ? ['--locale', language] : []), ...(flags['--verbose'] ? ['--verbose'] : [])];
  // The installed command's own presenter: the same lines, whichever program prints them.
  const ui = present.createPresenter({ locale: language, verbose: Boolean(flags['--verbose']), write: say });
  const platform = process.platform;
  const systems = settings.SYSTEMS, architectures = settings.ARCHITECTURES;
  const rawSystem = platform === 'win32' ? 'Windows_NT' : run('uname', ['-s']).trim();
  const system = systems[rawSystem];
  const rawArch = platform === 'win32' ? process.arch : run('uname', ['-m']).trim();
  const arch = architectures[rawArch];
  if (!system || !arch) fail(t(`No package for system/architecture: ${rawSystem}/${rawArch}`, `Não há pacote para este sistema/arquitetura: ${rawSystem}/${rawArch}`));
  const roots = settings.DATA_ROOTS[platform];
  if (!roots) fail(t(`Unsupported platform: ${platform}`, `Sistema sem suporte: ${platform}`));
  const destination = resolve(flags['--dest'] || config.DEST || join(env[roots[0]] || join(env.HOME || env.USERPROFILE || homedir(), ...roots.slice(1)), config.DIRECTORY));
  const recordFile = join(destination, 'install.json');
  const records = [];
  // A record that is not JSON cannot be read (exit 1); one whose client or path is not text is a refusal of usage (exit 2).
  const readRecord = async (path) => {
    const value = JSON.parse(await fs.readFile(path, 'utf8'));
    const text = (field) => typeof field === 'string' && field !== '';
    if (value === null || typeof value !== 'object' || Array.isArray(value) || !text(value.client) || (value.path !== undefined && !text(value.path))) {
      fail(t(`Invalid installation record: ${basename(path)} (record); remove it and run ${config.COMMAND} install`,
        `Registro de instalação inválido: ${basename(path)} (record); remova-o e rode ${config.COMMAND} install`));
    }
    return value;
  };
  for (const client of Object.keys(settings.CLIENTS)) {
    const path = join(destination, `install.${client}.json`);
    if (await exists(path)) records.push(await readRecord(path));
  }
  if (!records.length && await exists(recordFile)) records.push(await readRecord(recordFile));
  const record = flags['--client'] ? records.find((item) => item.client === flags['--client']) : records[0];
  const invoke = (cli, command, values) => {
    const result = spawnSync(process.execPath, [cli, command, ...values], { stdio: 'inherit' });
    process.exitCode = result.status ?? present.exitCodeFor('operational');
  };
  if (action !== 'install') {
    if (!record) fail(t(`No installation record found at ${recordFile}`, `Nenhuma instalação encontrada em ${recordFile}`));
    for (const key of Object.keys(flags)) {
      if (['--dest', '--locale', '--verbose'].includes(key)) continue;
      if (key === '--client') { forwarded.push(key, flags[key]); continue; }
      const supported = ['--check', '--rollback', '--dry-run', '--yes', '--purge', '--no-path'];
      if (action === 'update') supported.push('--set-execution-policy', '--no-execution-policy');
      if (!supported.includes(key)) fail(t(`Unsupported ${action} flag: ${key}`, `Opção sem suporte em ${action}: ${key}`));
      forwarded.push(key);
    }
    invoke(join(record.path, 'src/cli.js'), action, [...forwarded, ...shared]);
    return;
  }
  if (flags['--check'] || flags['--rollback'] || flags['--purge']) fail(t('Use update --check|--rollback or uninstall --purge', 'Use update --check|--rollback ou uninstall --purge'));
  const clients = settings.CLIENTS;
  let client = flags['--client'] || env.OKIT_CLIENT || record?.client;
  if (!client) {
    const entries = Object.entries(clients);
    say(t('Which client do you want to install for?', 'Para qual cliente você quer instalar?'));
    entries.forEach(([name, executable], i) => {
      const detected = platform === 'win32' ? spawnSync('where.exe', [executable]).status === 0
        : spawnSync('sh', ['-c', 'command -v "$1"', 'sh', executable]).status === 0;
      say(`  ${i + 1}. ${name}${detected ? ` (${t('found', 'encontrado')})` : ''}`);
    });
    if (!process.stdin.isTTY && !process.stdout.isTTY) fail(t('Without a terminal to ask in, choose a client with --client: ', 'Sem terminal para perguntar, escolha o cliente com --client: ') + entries.map(([name]) => name).join(', '));
    const { createInterface } = await import('node:readline/promises');
    const stream = process.stdin.isTTY || platform === 'win32' ? process.stdin : (await import('node:fs')).createReadStream('/dev/tty');
    const input = createInterface({ input: stream, output: present.redactingStream(process.stdout, hide) });
    try { client = entries[Number(await input.question(t('Number: ', 'Número: '))) - 1]?.[0]; }
    finally { input.close(); if (stream !== process.stdin) stream.destroy(); }
  }
  if (!Object.hasOwn(clients, client)) fail(t(`Invalid client; choose: ${Object.keys(clients).join(', ')}`, `Cliente inválido; escolha: ${Object.keys(clients).join(', ')}`));
  const temporary = await fs.mkdtemp(join(tmpdir(), 'okit-bootstrap-'));
  const ps = (code, values) => {
    const literal = (value) => "'" + String(value).replace(/'/g, "''") + "'";
    const encoded = Buffer.from(`${code} ${values.map(literal).join(' ')}`, 'utf16le').toString('base64');
    return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded]);
  };
  const download = (url, file) => {
    ui.detail(`GET ${present.redact(url, hide)}`);
    if (platform === 'win32') return ps('& { param($url,$file) $ErrorActionPreference="Stop"; Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $file }', [url, file]);
    if (spawnSync('sh', ['-c', 'command -v curl']).status === 0) return run('curl', ['-fLsS', '--connect-timeout', '15', '--max-time', '120', '-o', file, url]);
    return run('wget', ['-q', '-T', '120', '-O', file, url]);
  };
  try {
    const metadata = join(temporary, 'release.json');
    const base = `${config.API}/repos/${config.REPO}/releases`;
    let selected;
    if (!flags['--prerelease']) {
      ui.detail(`GET ${present.redact(`${base}/latest`, hide)}`);
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
        else if (status !== '404') fail(t(`Release API returned ${status}`, `A API de releases respondeu ${status}`), 'operational');
      }
    }
    if (!selected) {
      download(base, metadata);
      selected = JSON.parse(await fs.readFile(metadata, 'utf8')).filter((item) => !item.draft)
        .sort((a, b) => Date.parse(b.published_at || b.created_at) - Date.parse(a.published_at || a.created_at))[0];
    }
    if (!selected) fail(t('No published releases found', 'Nenhuma versão publicada encontrada'), 'operational');
    const version = selected.tag_name.startsWith(config.TAG_PREFIX) ? selected.tag_name.slice(config.TAG_PREFIX.length) : selected.tag_name;
    if (!/^[A-Za-z0-9][A-Za-z0-9.+_-]*$/.test(version) || version.includes('..')) fail(t('Unsafe release version', 'Versão com nome inseguro'), 'operational');
    const render = (template) => template.replace(/\{(package|version|client|system|arch|ext)\}/g, (_, key) => ({ package: config.PACKAGE, version, client, system, arch, ext: settings.FORMATS[system] })[key]);
    const name = render(config.NAME), manifestName = render(config.MANIFEST);
    if (/[\\/]/.test(name) || /[\\/]/.test(manifestName)) fail(t('Unsafe asset name', 'Nome de arquivo inseguro'), 'operational');
    const asset = selected.assets?.find((item) => item.name === name);
    const manifest = selected.assets?.find((item) => item.name === manifestName);
    if (!asset || !manifest) fail(t(`Missing release asset: ${!asset ? name : manifestName}`, `Arquivo ausente na versão: ${!asset ? name : manifestName}`), 'operational');
    // The release, asset and checksum note are printed by the installed command, once, inside its steps.
    const passed = ['--asset', name, ...(selected.prerelease ? ['--fallback'] : []), ...shared];
    if (record?.version === version && record.client === client) {
      invoke(join(record.path, 'src/cli.js'), 'install', ['--client', client, '--from', record.path, '--dest', destination, ...passed,
        ...['--dry-run', '--no-link', '--no-path', '--set-execution-policy', '--no-execution-policy'].filter((key) => flags[key])]); return;
    }
    if (flags['--dry-run']) {
      // The steps that need no package, as the installed command's dry run numbers them.
      const label = present.clientLabel(client);
      ui.header({ package: config.PACKAGE, version, client: label, system: present.systemLabel(platform), arch });
      const next = ui.sequence(present.planSteps({ quota: client === config.QUOTA_CLIENT }), { client: label });
      next('get').plan(ui.text('plain', { asset: name }), [ui.text('shaNote'), ...(selected.prerelease ? [ui.text('fallback', { version })] : [])]);
      next('files').plan(join(destination, `${version}-${client}`));
      next('register').plan();
      if (flags['--no-link']) next('link').skip(ui.text('linkOff'));
      else next('link').plan(config.COMMAND);
      if (client === config.QUOTA_CLIENT) next('quota').plan();
      ui.explain([ui.text('dryRunDone')]);
      return;
    }
    const archive = join(temporary, name), hashes = join(temporary, manifestName);
    download(manifest.browser_download_url, hashes);
    const entries = (await fs.readFile(hashes, 'utf8')).trimEnd().split('\n').map((line) => /^([a-f0-9]{64})  (.+)$/.exec(line.replace(/\r$/, '')));
    const matches = entries.filter((entry) => entry?.[2] === name);
    if (entries.some((entry) => !entry) || matches.length !== 1) fail(t('Checksum manifest missing unique package line or malformed', 'A lista de checksums está malformada ou não tem uma linha única para o pacote'), 'operational');
    download(asset.browser_download_url, archive);
    let hash;
    if (platform === 'win32') hash = ps('& { param($file) (Get-FileHash -Algorithm SHA256 -LiteralPath $file).Hash }', [archive]).trim().toLowerCase();
    else if (spawnSync('sh', ['-c', 'command -v sha256sum']).status === 0) hash = run('sha256sum', [archive]).split(/\s/)[0];
    else if (spawnSync('sh', ['-c', 'command -v shasum']).status === 0) hash = run('shasum', ['-a', '256', archive]).split(/\s/)[0];
    else hash = run('openssl', ['dgst', '-sha256', archive]).trim().split(/\s/).at(-1);
    if (hash !== matches[0][1]) fail(t('SHA-256 mismatch: package refused', 'SHA-256 diferente do esperado: pacote recusado'), 'operational');
    const extracted = join(temporary, 'extracted');
    await fs.mkdir(extracted);
    if (platform === 'win32') ps('& { param($file,$dest) $ErrorActionPreference="Stop"; Expand-Archive -LiteralPath $file -DestinationPath $dest }', [archive, extracted]);
    else run('tar', ['-xzf', archive, '-C', extracted]);
    for (const key of ['--dry-run', '--yes', '--no-link', '--no-path', '--autostart', '--prerelease', '--set-execution-policy', '--no-execution-policy']) if (flags[key]) forwarded.push(key);
    invoke(join(extracted, 'src/cli.js'), 'install', ['--client', client, '--from', extracted, '--dest', destination, '--repo', config.REPO, ...passed, ...forwarded]);
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
}
