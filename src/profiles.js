// Actor profile choice: the maintainer owns the model names, the core only
// picks which configured profile to use and may lower it on low quota.
import process from 'node:process';

import { EFFORT_CLASSES } from './classify.js';

export const PROFILE_EFFORTS = Object.freeze({
  simple: 'low',
  normal: 'medium',
  hard: 'high',
});

const PROFILE_MAX_TURNS = Object.freeze({
  simple: 20,
  normal: 40,
  hard: 80,
});

export const DEFAULT_CONFIG = {
  opencodeQuota: {
    sources: {}, timeoutMs: 3000, maxOutputBytes: 1048576, maxAgeMinutes: 120,
    version: 1, fields: { version: 'version', company: 'company', source: 'source',
      readAt: 'read_at', remainingPercent: 'remaining_percent', resetAt: 'reset_at', error: 'error' },
    windows: { five_hour: 300, weekly: 10080 },
  },
  statuslineRegistration: {
    client: 'claude-code',
    settingsFile: 'settings.json', backupFile: 'claude-statusline.original',
    subcommand: 'statusline-collector',
    shell: { linux: ['/bin/sh', '-c'], darwin: ['/bin/sh', '-c'], win32: ['cmd.exe', '/d', '/s', '/c'] },
  },
  statuslineCollector: {
    previous: [], timeoutMs: 500, maxInputBytes: 1048576, maxOutputBytes: 1048576,
    fields: { rateLimits: 'rate_limits', usedPercentage: 'used_percentage', resetsAt: 'resets_at' },
    windows: { five_hour: 300, seven_day: 10080 },
  },
  codexQuota: {
    sessionsDirectory: '~/.codex/sessions', sessionsEnv: 'CODEX_SESSIONS_DIR',
    recentFiles: 3, tailBytes: 16384, maxTailBytes: 1048576, maxAgeMinutes: 120,
    filePrefix: 'rollout-', fileSuffix: '.jsonl',
    fields: { timestamp: 'timestamp', type: 'type', event: 'event_msg',
      payload: 'payload', tokenCount: 'token_count', rateLimits: 'rate_limits',
      primary: 'primary', secondary: 'secondary', usedPercent: 'used_percent',
      windowMinutes: 'window_minutes', resetsAt: 'resets_at' },
  },
  install: {
    kit: {
      executables: ['okit', 'kit'], path: null, versionArgs: ['--version'],
      timeoutMs: 3000, require: false,
      hint: 'See INSTALL.md#orchestration-kit for kit installation instructions.',
      overlap: 'See docs/ARCHITECTURE.md#kit-and-plugin-overlap-d1 for overlap rules.',
    },
    repository: 'asantos43/okit-plugin', api: 'https://api.github.com',
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'okit-installer' },
    timeoutMs: 15000, maxDownloadBytes: 128 * 1024 * 1024, maxExtractBytes: 512 * 1024 * 1024,
    directory: 'okit-plugin', destination: null, linkDirectory: null,
    recordName: 'install.{client}.json',
    dataRoots: { linux: ['XDG_DATA_HOME', '.local', 'share'], darwin: [null, 'Library', 'Application Support'], win32: ['LOCALAPPDATA', 'AppData', 'Local'] },
    linkParts: ['.local', 'bin'], windowsLinkParts: ['AppData', 'Local', 'bin'],
    path: {
      enabled: true, candidates: [['.local', 'bin'], ['bin']], stateFile: 'managed-path.json',
      begin: '# >>> okit-plugin PATH >>>', end: '# <<< okit-plugin PATH <<<',
      shells: { bash: { files: ['.bashrc', '.profile'], login: '.profile' }, zsh: { files: ['.zshrc', '.zprofile'], login: '.zprofile' }, fish: { files: ['.config/fish/config.fish'], login: '.config/fish/config.fish' } },
      fallbackShell: 'bash', windowsShell: 'powershell', windowsExecutable: 'powershell.exe', windowsVariable: 'Path',
      // The environment variable that names the shell of the current terminal.
      shellVariable: 'SHELL',
      // The command that makes the managed PATH block effective in the current
      // shell, per shell. `{file}` is the managed profile; `{bin}` is the link directory.
      activate: {
        sh: '. {file}',
        bash: '. {file}',
        zsh: '. {file}',
        fish: 'source {file}',
        powershell: "$env:Path = {bin} + ';' + $env:Path",
      },
      messages: {
        link: 'Command link / Link do comando: {value}',
        existing: 'Already in PATH / Já estava no PATH: {value}',
        changed: 'PATH updated / PATH atualizado: {value}',
        manual: 'Add to PATH / Adicione ao PATH: {value}',
        restart: 'Open a new terminal and restart your AI client. / Abra um terminal novo e reinicie o cliente de IA.',
        activate: 'To use the command in this terminal, run {value} / Para usar o comando neste terminal, rode {value}',
        activateTerminal: 'Open a new terminal and the command will work there / Abra um terminal novo e o comando funcionará lá',
        resolved: 'PATH verification / Verificação do PATH: {value}',
        missing: 'Command not found / Comando não encontrado', user: 'User environment / Ambiente do usuário',
        edited: 'Managed PATH block was edited / Bloco de PATH gerenciado foi editado: {value}',
      },
    },
    systems: { linux: 'linux', darwin: 'macos', win32: 'windows' },
    architectures: { x64: 'x64', arm64: 'arm64' }, windowsPlatform: 'win32',
    command: 'okit-plugin', legacyCommands: ['okit'], node: process.execPath, marketplace: 'okit-plugin', entry: 'okit-plugin',
    pluginsDirectory: 'plugins', daemonPollMs: 100,
    // null inherits the existing release.name model without duplicating it.
    name: null,
    manifest: '{package}-{version}-checksums.sha256',
    clients: {
      'claude-code': { executable: 'claude', strategy: 'marketplace', install: true, update: true, configEnv: 'CLAUDE_CONFIG_DIR', rootParts: ['.claude'] },
      codex: { executable: 'codex', strategy: 'marketplace', install: false, update: false, configEnv: 'CODEX_HOME', rootParts: ['.codex'] },
      opencode: { executable: 'opencode', strategy: 'module', module: 'src/install/client-plugin.js', configEnv: 'OPENCODE_CONFIG_DIR', rootParts: ['.config', 'opencode'], xdgEnv: 'XDG_CONFIG_HOME', xdgParts: ['opencode'] },
    },
    pathExtensions: ['', '.exe', '.cmd', '.bat'],
  },
  lowQuotaPct: 15,
  daemon: { minQuotaPct: 10 },
  limits: { global: 3, clients: {} },
  staleMinutes: 30,
  inbox: { holdStaleMinutes: 120, gitTimeoutMs: 5000 },
  // Editable in config.json; model names change as client catalogues change.
  profiles: {
    'claude-code': {
      simple: { model: 'haiku', effort: PROFILE_EFFORTS.simple, maxTurns: PROFILE_MAX_TURNS.simple },
      normal: { model: 'sonnet', effort: PROFILE_EFFORTS.normal, maxTurns: PROFILE_MAX_TURNS.normal },
      hard: { model: 'opus', effort: PROFILE_EFFORTS.hard, maxTurns: PROFILE_MAX_TURNS.hard },
    },
    codex: {
      simple: { model: 'gpt-5-codex', effort: PROFILE_EFFORTS.simple, maxTurns: PROFILE_MAX_TURNS.simple },
      normal: { model: 'gpt-5-codex', effort: PROFILE_EFFORTS.normal, maxTurns: PROFILE_MAX_TURNS.normal },
      hard: { model: 'gpt-5-codex', effort: PROFILE_EFFORTS.hard, maxTurns: PROFILE_MAX_TURNS.hard },
    },
    opencode: {
      simple: { model: 'minimax/MiniMax-M3', effort: PROFILE_EFFORTS.simple, maxTurns: PROFILE_MAX_TURNS.simple },
      normal: { model: 'minimax/MiniMax-M3', effort: PROFILE_EFFORTS.normal, maxTurns: PROFILE_MAX_TURNS.normal },
      hard: { model: 'minimax/MiniMax-M3', effort: PROFILE_EFFORTS.hard, maxTurns: PROFILE_MAX_TURNS.hard },
    },
  },
  profileMessages: {
    unknownClient: 'Client "{client}" has no default profile. Define the profile in the plugin configuration or use one of the known clients: {clients}. / O cliente "{client}" não tem perfil padrão. Defina o perfil na configuração do plugin ou use um dos clientes conhecidos: {clients}.',
    unknownClass: 'Unknown profile class "{class}". Use one of: {classes}. / Classe de perfil desconhecida "{class}". Use uma das classes: {classes}.',
    missingProfile: 'Client "{client}" has no profile for class "{class}". Define it in the plugin configuration. / O cliente "{client}" não tem perfil para a classe "{class}". Defina-o na configuração do plugin.',
  },
  // D61: how each client lists the models it offers. The command, its
  // arguments, the deadline, the interpreter of the output and the message of
  // a missing executable are configuration, never code: the user replaces them
  // in `config.json` and the logic only reads them.
  setup: {
    maxAttempts: 3,
    detect: {
      'claude-code': {
        // No listing command of this client was verified, so the catalog answers.
        command: null,
        args: [],
        timeoutMs: 5000,
        parse: 'lines',
        activeField: null,
        activeValues: null,
        candidates: [],
        // The family rule of this client: `separator` divides the provider
        // from the rest of the model name, and `minimumPrefix` is the length
        // the common prefix of the rest must reach for two names to be of the
        // same family. A different provider is never of the same family.
        family: { separator: '/', minimumPrefix: 5 },
        notFoundMessage: 'Claude Code was not found on this machine, so the built-in catalog is used. / O Claude Code não foi encontrado nesta máquina, então o catálogo interno é usado.',
      },
      codex: {
        // `codex debug models` prints the raw catalog as JSON; `--bundled`
        // answers from the binary itself, with no network refresh.
        command: 'codex',
        args: ['debug', 'models', '--bundled'],
        timeoutMs: 5000,
        parse: 'json-array',
        activeField: 'visibility',
        activeValues: ['list'],
        candidates: [],
        family: { separator: '/', minimumPrefix: 5 },
        notFoundMessage: 'Codex was not found on this machine, so the built-in catalog is used. / O Codex não foi encontrado nesta máquina, então o catálogo interno é usado.',
      },
      opencode: {
        // `opencode models` prints one `provider/model` per line.
        command: 'opencode',
        args: ['models'],
        timeoutMs: 5000,
        parse: 'lines',
        activeField: null,
        activeValues: null,
        candidates: [],
        family: { separator: '/', minimumPrefix: 5 },
        notFoundMessage: 'opencode was not found on this machine, so the built-in catalog is used. / O opencode não foi encontrado nesta máquina, então o catálogo interno é usado.',
      },
    },
  },
  actors: {
    sizeClasses: { S: 'simple', M: 'normal', L: 'hard' },
    criticClass: 'critic',
    messages: {
      en: {
        columns: ['Client', 'Model', 'Effort', 'Sizes / role', 'Free slots', 'Quota', 'Can launch', 'Reason / remedy'],
        critic: 'critic', yes: 'yes', no: 'no', missing: '-',
        quota: '{state}; {percentage}; age {age}',
        quotaGreen: 'green', quotaYellow: 'yellow', quotaRed: 'red', quotaOff: 'off',
        percentage: '{value}%', age: '{seconds}s',
        empty: 'No actor profile is available for {client}. Check the profiles in the plugin configuration.',
        low: 'Quota is below the floor. Wait for quota reset or ask the person who maintains okit to review the quota floor.',
        busy: 'All slots are occupied. Wait for a running executor to finish.',
        gap: '{client}: no actor available for {size}; nearest alternative: {alternative}.',
        none: 'none available now; follow the launch remedies or ask the person who maintains okit to set up models',
        description: 'Read-only actors (model + effort available in a client), sizes, slots, quota and remedies. atores, executores, actors, executors, modelos, quem pode rodar, lista de executores. Somente leitura: ator = modelo + esforço disponível em um cliente; tamanhos, vagas, cota e soluções.',
      },
      'pt-BR': {
        columns: ['Cliente', 'Modelo', 'Esforço', 'Tamanhos / papel', 'Vagas livres', 'Cota', 'Pode iniciar', 'Motivo / solução'],
        critic: 'crítico', yes: 'sim', no: 'não', missing: '-',
        quota: '{state}; {percentage}; idade {age}',
        quotaGreen: 'verde', quotaYellow: 'amarelo', quotaRed: 'vermelho', quotaOff: 'desligado',
        percentage: '{value}%', age: '{seconds}s',
        empty: 'Nenhum perfil de ator está disponível para {client}. Confira os perfis na configuração do plugin.',
        low: 'Cota abaixo do piso. Aguarde a renovação da cota ou peça à pessoa que mantém o okit para revisar o piso de cota.',
        busy: 'Todas as vagas estão ocupadas. Aguarde um executor em execução terminar.',
        gap: '{client}: nenhum ator disponível para {size}; alternativa mais próxima: {alternative}.',
        none: 'nenhuma disponível agora; siga as soluções para iniciar ou peça à pessoa que mantém o okit para configurar modelos',
        description: 'Somente leitura: atores (modelo + esforço disponível em um cliente), tamanhos, vagas, cota e soluções. Atores, executores, modelos, quem pode rodar, lista de executores.',
      },
    },
  },
  postCompact: {
    enabled: true,
    timeoutSec: 5,
    maxLines: 20,
    sections: { inbox: true, orders: true, status: true },
    inboxStatuses: ['delegated', 'criticised', 'pending'],
    text: {
      heading: 'okit: context after compaction',
      inbox: 'Inbox',
      orders: 'Standing orders',
      status: 'Status: {open} open inbox items; {orders} active standing orders',
    },
  },
  smoke: {
    quotaFloorPct: 20,
    quotaMaxAgeMinutes: 30,
    quotaExpireMinutes: 120,
    maxUsd: 1,
    // null means the full scenario length (resolved by the runner).
    maxTurns: null,
    maxMinutes: 15,
    checkTimeoutMs: 60_000,
  },
  // The release build of `docs/RELEASING.md` PR 1: the pairs, the archive
  // format per system, the output folder, the files that enter a payload, the
  // client-required file names and the name model. Every value here is a
  // default the user configuration and the build flags may replace.
  release: {
    publish: {
      executable: 'gh',
      gitExecutable: 'git',
      remote: 'origin',
      branch: 'main',
      safeName: '^(?!-)[A-Za-z0-9_./:@+\\\\-]+$',
      prerelease: 'never',
      latest: true,
      requiredPairs: 9,
      tagPrefix: 'v',
      title: '{package} {version}',
      outputDir: 'dist/publish',
      attachments: ['payloads', 'notes', 'checklist', 'checksums'],
      // Included in the existing payloads attachment group, outside pair archives.
      bootstrapAttachments: ['install.sh', 'install.ps1', 'INSTALL.md', 'INSTALL.pt-BR.md'],
      bodyDir: 'body',
      bodyFile: '{package}-{version}-release-body.md',
      unprovenNotice: 'Some client/system pairs are not yet proven. See the proof table in the release notes.',
    },
    outputDir: 'dist/release',
    clients: ['claude-code', 'codex', 'opencode'],
    systems: ['linux', 'windows', 'macos'],
    // One payload per architecture; the architecture is part of the name.
    architectures: [process.arch],
    formats: { linux: 'tar.gz', windows: 'zip', macos: 'tar.gz' },
    // The name model. `{package}`, `{version}`, `{client}`, `{system}`,
    // `{arch}` and `{ext}` are the values of the pair.
    name: '{package}-{version}-{client}-{system}-{arch}.{ext}',
    // What enters a payload, besides the client files below.
    include: ['package.json', 'LICENSE', 'src', 'skills'],
    // What never enters a payload, even inside an included folder.
    exclude: ['.git', '.delegate', '.github', 'node_modules', 'dist', 'coverage',
      'test', 'src/release', '.gitkeep', '.env', '.DS_Store', '*.log', '*.tmp'],
    // The adapter folder of each client, and the file that says it is built.
    adapters: {
      'claude-code': 'adapters/claude-code',
      codex: 'adapters/codex',
      opencode: 'adapters/opencode',
    },
    // Shared runtime adapters in every payload; null inherits all adapters above.
    // An explicit list overrides the shared paths; the client's adapter stays required.
    sharedAdapters: null,
    adapterEntry: 'index.js',
    // The file names each client requires, and the wiring it needs.
    clientFiles: {
      'claude-code': {
        plugin: '.claude-plugin/plugin.json',
        marketplace: '.claude-plugin/marketplace.json',
        hooks: 'hooks/hooks.json',
        hookCommand: 'node ${CLAUDE_PLUGIN_ROOT}/{bin} hook post-compact',
        mcp: { server: 'src/mcp/server.js', command: 'node', root: '${CLAUDE_PLUGIN_ROOT}' },
      },
    },
    // The installation instructions, per client.
    instructions: {
      codex: {
        file: 'INSTALL.md', title: 'Install {name} with Codex',
        steps: [
          'Node {engines} is required: check it with `node --version`.',
          'To install/update use `{command} install|update` from this folder or `install.sh`/`install.ps1` from the release page.',
        ],
      },
      opencode: {
        file: 'INSTALL.md', title: 'Install {name} with opencode',
        steps: [
          'Node {engines} is required: check it with `node --version`.',
          'To install/update use `{command} install|update` from this folder or `install.sh`/`install.ps1` from the release page.',
        ],
      },
      'claude-code': {
        file: 'INSTALL.md',
        title: 'Install {name} with Claude Code',
        steps: [
          'Node {engines} is required: check it with `node --version`.',
          'Extract this archive where the client can read it.',
          'To install/update use `{command} install|update` from this folder or `install.sh`/`install.ps1` from the release page.',
          'Register the marketplace: `claude plugin marketplace add {dir}`.',
          'Install the plugin: `claude plugin install {name}@{marketplace}`.',
          'Update it later with `claude plugin update {name}@{marketplace}`.',
        ],
      },
    },
    // The marketplace identity. `null` means "take it from package.json".
    marketplace: { name: null, owner: { name: null, url: null } },
    // The modes of the entries: the CLI is executable, the rest is not.
    modes: { executable: '0755', file: '0644' },
    // Proof templates reuse notes' status labels and system owners below.
    checklist: {
      // Empty overrides inherit release.notes.proofBy; no duplicate owners.
      proofBy: {},
      fileName: '{package}-{version}-release-checklist.md',
      title: 'Release checklist — {package} {version}',
      instructions: [
        'Collect both layers for each installed candidate; see docs/RELEASING.md, Proof per pair and D-Q7. This command only prepares records; it runs no smoke and publishes nothing.',
        'Run `{bin} smoke` with the full check set (in-process, scratch home): exit 0 and every check passing are required.',
        'Run `{bin} client-smoke` for the D25 scenario inside the actual named client with its real installation, login and state. Record the exact command/driver; rehearsal, dry-run and mocked spawns are not proof.',
        'D25 requires C1–C5 passing, no failures and accounting for every later check. Exit 0 can still mean {partial}; missing hook proof blocks installation acceptance. Missing configuration means incomplete installation.',
        'Keep unresolved skips, absent drivers and {partial} records unchecked until written acceptance by the responsible Producer. Attach durable logs, never credentials; preserve user configuration/state across install, update and client restart.',
        'Payload SHA-256 comes only from `{manifest}` when available. Hash notes and checklist only after their records are final.',
      ],
      headings: { field: 'Field', value: 'Evidence / value' },
      labels: {
        tester: 'Tester / date', revision: 'Source revision', version: 'Package version',
        file: 'Payload filename', sha256: 'Payload SHA-256', environment: 'OS / version / architecture',
        node: 'Node version', client: 'Client version', scope: 'Install scope',
        paths: 'Resolved plugin / config / state / bin paths',
        install: 'Fresh installation steps / result', update: 'Update from prior candidate / restart / preserved state',
        permissions: 'PATH / permissions', autostart: 'Autostart show / install / restart',
        logs: 'JSONL / log locations', scenario: 'D25 scenario revision', acceptance: 'Written acceptance of skips / partial proof',
      },
      layers: { process: 'In-process smoke', client: 'D25 real-client scenario' },
      layerLabels: { command: 'Command / driver', exit: 'Exit code', totals: 'Totals (pass / fail / skip)', reasons: 'Reasons', missing: 'Skip / absent driver', logs: 'JSONL / logs' },
      producerSignature: 'Producer signature for Windows/macOS: ____________________',
    },
    // The release notes: naming, root history, proof states and shared owners.
    notes: {
      fileName: '{package}-{version}-release-notes.md',
      // The change history of the repository root and the section of it that
      // holds the changes of the version.
      history: 'CHANGELOG.md',
      section: 'Unreleased',
      // The record of the proof of the pairs, as a JSON object of
      // `<client>:<system>` to a state; `null` means "no proof yet".
      proofFile: null,
      // Who signs the proof of each system.
      proofBy: { linux: 'Director', windows: 'Producer', macos: 'Producer' },
      // The signer of a system the map above does not name.
      proofByOther: 'Producer',
      // The labels of the proof state.
      status: { unproven: 'not proven', proven: 'proven', partial: 'PARCIAL' },
      // The title of the notes.
      title: 'Release notes — {package} {version}',
      // The headings of the notes.
      headings: {
        version: 'Version',
        prerequisites: 'Prerequisites',
        artifacts: 'Artifacts',
        install: 'Installation and update',
        update: 'Update',
        proof: 'Proof per pair',
        gaps: 'Known gaps',
        changes: 'Changes in this version',
      },
      // The labels of the fields.
      labels: {
        package: 'Package',
        version: 'Version',
        manifest: 'Digest manifest',
        pair: 'Pair',
        state: 'Proof',
        signer: 'Proof owner',
      },
      // The prerequisite of the version: the Node version of the package.
      prerequisites: 'Node {engines} is required (from `package.json.engines.node`).',
      // The prerequisite of a package that asks for no Node version.
      prerequisitesNone: 'The package asks for no particular Node version.',
      // The line about the manifest of the checksums.
      manifest: 'The manifest of the SHA-256 digests is `{manifest}`; verify it before extracting anything.',
      // The line about where the changes come from.
      source: 'The changes below come from the `{section}` section of `{history}`.',
      // The line that opens the known gaps.
      gapsIntro: 'Every pair without proof is listed here; a partial proof is never hidden:',
      // The line of one known gap.
      gapLine: '- {pair}: {state}.',
      // The steps of the installation and of the update.
      install: [
        'Download the payload of your pair and the digest manifest from the GitHub releases page.',
        'Verify the SHA-256 of every file against the manifest before extracting anything.',
        'Check the Node version against the engines of the package.',
        'Extract the payload to the configured destination and follow the instructions of that pair.',
        'Configure the bin link or shim, the MCP server, the skills and the autostart, then prove the installation.',
      ],
      update: [
        'Stop the old daemon and keep a backup of the configured state and of the skills and hooks you edited.',
        'Verify the new payload, change the client references and the PATH registration, and regenerate the moved autostart paths.',
        'Restart the daemon and the client, and repeat the proof of the installation.',
      ],
    },
  },
};

// D61: the reasons a model listing answers with. Every one of them says in
// plain words what happened, in English and in Portuguese, and none of them
// carries a demand or an order id.
export const LIST_MESSAGES = Object.freeze({
  listed: 'The model list came from the client command: {listed} models listed, {active} active, {hidden} hidden. / A lista de modelos veio do comando do cliente: {listed} modelos listados, {active} ativos, {hidden} ocultos.',
  noCommand: 'No model-listing command is configured for {client}, so the built-in catalog is used. / Nenhum comando de listagem de modelos está configurado para {client}, então o catálogo interno é usado.',
  notFound: '{client} was not found on this machine, so the built-in catalog is used. / O {client} não foi encontrado nesta máquina, então o catálogo interno é usado.',
  timeout: 'The model list did not answer in time, so the built-in catalog is used. / A lista de modelos não respondeu a tempo, então o catálogo interno é usado.',
  failed: 'The model list could not be read, so the built-in catalog is used. / A lista de modelos não pôde ser lida, então o catálogo interno é usado.',
  unknownOutput: 'The model list output was not understood, so the built-in catalog is used. / A saída da lista de modelos não foi entendida, então o catálogo interno é usado.',
  emptyList: 'The client answered and listed no model. / O cliente respondeu e não listou nenhum modelo.',
  noneActive: 'The client answered and listed {listed} models, but none of them is active. / O cliente respondeu e listou {listed} modelos, mas nenhum deles está ativo.',
  unknownParser: 'The configured output interpreter "{parse}" is unknown, so the built-in catalog is used. / O interpretador de saída "{parse}" configurado é desconhecido, então o catálogo interno é usado.',
  badTimeout: 'The configured deadline for the model list of {client} is not a valid number, so the built-in catalog is used. / O prazo configurado para a lista de modelos de {client} não é um número válido, então o catálogo interno é usado.',
  error: 'The model list could not be read, so the built-in catalog is used. / A lista de modelos não pôde ser lida, então o catálogo interno é usado.',
});

// One step down the effort scale. Nothing goes back up.
const LOWER = { hard: 'normal', normal: 'simple', simple: 'simple' };

function lowQuota(quota, lowQuotaPct) {
  if (!quota || quota.source === 'off') return false;
  const remaining = quota.remainingPct;
  return typeof remaining === 'number' && remaining < lowQuotaPct;
}

// The default catalog first, the user profiles over it: a root without
// `config.profiles` keeps every default profile, and a user profile replaces
// the class it names without erasing the rest of the catalog.
function mergeProfiles(userProfiles) {
  const profiles = {};
  for (const [client, classes] of Object.entries(DEFAULT_CONFIG.profiles)) {
    profiles[client] = Object.fromEntries(
      Object.entries(classes).map(([name, profile]) => [name, { ...profile }]),
    );
  }
  if (!userProfiles || typeof userProfiles !== 'object' || Array.isArray(userProfiles)) return profiles;
  for (const [client, classes] of Object.entries(userProfiles ?? {})) {
    if (!classes || typeof classes !== 'object' || Array.isArray(classes)) continue;
    const merged = { ...(profiles[client] ?? {}) };
    for (const [name, profile] of Object.entries(classes)) {
      const base = merged[name];
      merged[name] = base && profile && typeof base === 'object' && typeof profile === 'object'
        ? { ...base, ...profile } : profile;
    }
    profiles[client] = merged;
  }
  return profiles;
}

// D61: the family rule of a client is merged key by key, like the rest of the
// detection settings: changing the minimum prefix never erases the separator,
// and changing the separator never erases the minimum prefix. `null` is the
// user's own answer: no family rule, so no automatic replacement at all.
function mergeFamily(base, given) {
  if (given === null) return null;
  const own = given && typeof given === 'object' && !Array.isArray(given) ? given : {};
  const defaults = base && typeof base === 'object' && !Array.isArray(base) ? base : {};
  return { ...defaults, ...own };
}

// D61: the detection settings of every client. The user's `config.json`
// replaces the default of the client it names, key by key, and the other
// clients keep their own defaults: one override never erases the rest.
function mergeSetup(userSetup) {
  const defaults = DEFAULT_CONFIG.setup?.detect ?? {};
  const given = userSetup?.detect;
  const own = given && typeof given === 'object' && !Array.isArray(given) ? given : {};
  const rest = userSetup && typeof userSetup === 'object' && !Array.isArray(userSetup) ? userSetup : {};
  const detect = {};
  for (const [client, settings] of Object.entries(defaults)) {
    const given = own[client];
    const settingsOfClient = given && typeof given === 'object' && !Array.isArray(given) ? given : null;
    detect[client] = {
      ...settings,
      ...(settingsOfClient ?? {}),
      family: mergeFamily(settings.family, settingsOfClient?.family),
    };
  }
  // A client the defaults do not name keeps the user's own settings.
  for (const [client, settings] of Object.entries(own)) {
    if (!Object.hasOwn(detect, client)) detect[client] = { ...settings };
  }
  return { ...DEFAULT_CONFIG.setup, ...rest, detect };
}

function knownClients(profiles) {
  return Object.keys(profiles).sort();
}

/**
 * The clients the root's own configuration names. The catalog is a fallback
 * for the profiles, not a list of subscriptions: a root that names no client
 * has the known clients, and a root that names one keeps that one, so the
 * quota command never records a client the root does not have.
 *
 * @param {object} config
 * @returns {string[]}
 */
export function configuredClientsOf(config) {
  if (Array.isArray(config?.configuredClients)) return [...config.configuredClients];
  const stored = config?.profiles;
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return [];
  // A client counts as configured only when its entry names a class of its
  // own: an empty object is the absence of a client, not a subscription of
  // one. The removal of an empty group therefore never changes what the root
  // has, whatever the file looked like before the value was set.
  return Object.keys(stored)
    .filter((client) => {
      const classes = stored[client];
      return classes !== null && typeof classes === 'object' && !Array.isArray(classes)
        && Object.keys(classes).length > 0;
    })
    .sort();
}

function fill(text, values) {
  return text.replace(/\{(\w+)\}/g, (_, key) => values[key]);
}

export function normalizeLimits(limits = {}) {
  if (!limits || typeof limits !== 'object' || Array.isArray(limits)) {
    throw new Error('limits must be an object');
  }
  const global = Object.hasOwn(limits, 'perClient') ? limits.perClient
    : Object.hasOwn(limits, 'global') ? limits.global : DEFAULT_CONFIG.limits.global;
  const clients = limits.clients === undefined ? {} : limits.clients;
  if (!clients || typeof clients !== 'object' || Array.isArray(clients)) {
    throw new Error('limits.clients must be an object');
  }
  const configured = Object.fromEntries(['global', 'perClient'].filter(
    (name) => Object.hasOwn(limits, name),
  ).map((name) => [name, limits[name]]));
  for (const [name, value] of [
    ...Object.entries(configured), ['global', global],
    ...Object.entries(clients).map(([client, cap]) => [`clients.${client}`, cap]),
  ]) {
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`limits.${name} must be an integer >= 1`);
    }
  }
  return { global, clients: { ...clients } };
}

export function configOf(config) {
  const merged = { ...DEFAULT_CONFIG, ...(config ?? {}) };
  const statuslineRegistration = { ...DEFAULT_CONFIG.statuslineRegistration, ...config?.statuslineRegistration,
    shell: { ...DEFAULT_CONFIG.statuslineRegistration.shell, ...config?.statuslineRegistration?.shell } };
  for (const key of ['client', 'settingsFile', 'backupFile', 'subcommand']) {
    if (typeof statuslineRegistration[key] !== 'string' || !statuslineRegistration[key].trim()
      || /[\\/\r\n\0]/.test(statuslineRegistration[key]) || ['.', '..'].includes(statuslineRegistration[key])) {
      throw new TypeError('Invalid status bar setting / Ajuste da barra de status inválido');
    }
  }
  const statuslineClient = { ...DEFAULT_CONFIG.install.clients[statuslineRegistration.client], ...config?.install?.clients?.[statuslineRegistration.client] };
  if (typeof statuslineClient.configEnv !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(statuslineClient.configEnv)
    || !Array.isArray(statuslineClient.rootParts) || !statuslineClient.rootParts.length
    || statuslineClient.rootParts.some((part) => typeof part !== 'string' || !part.trim() || /[\\/\r\n\0]/.test(part) || part === '..')) {
    throw new TypeError('Invalid Claude folder setting / Ajuste da pasta do Claude inválido');
  }
  for (const words of Object.values(statuslineRegistration.shell)) {
    if (!Array.isArray(words) || !words.length || words.some((word) => typeof word !== 'string' || !word.trim() || /[\r\n\0]/.test(word))) {
      throw new TypeError('Invalid status bar shell / Shell da barra de status inválida');
    }
  }
  const inbox = { ...DEFAULT_CONFIG.inbox, ...config?.inbox };
  const daemon = { ...DEFAULT_CONFIG.daemon, ...config?.daemon };
  const smoke = { ...DEFAULT_CONFIG.smoke, ...config?.smoke };
  const statuslineCollector = { ...DEFAULT_CONFIG.statuslineCollector, ...config?.statuslineCollector,
    fields: { ...DEFAULT_CONFIG.statuslineCollector.fields, ...config?.statuslineCollector?.fields },
    windows: config?.statuslineCollector?.windows ?? DEFAULT_CONFIG.statuslineCollector.windows };
  for (const key of ['timeoutMs', 'maxInputBytes', 'maxOutputBytes']) {
    if (!Number.isSafeInteger(statuslineCollector[key]) || statuslineCollector[key] < 1) {
      throw new TypeError('Reading limits: use positive integers / Limites da leitura: use inteiros positivos');
    }
  }
  if (!Array.isArray(statuslineCollector.previous)
    || statuslineCollector.previous.some((part) => typeof part !== 'string')
    || (statuslineCollector.previous.length && !statuslineCollector.previous[0].trim())) {
    throw new TypeError('Previous command: use a list of words / Comando anterior: use uma lista de palavras');
  }
  if (Object.values(statuslineCollector.fields).some((value) => typeof value !== 'string' || !value.trim())
    || !statuslineCollector.windows || Array.isArray(statuslineCollector.windows)
    || !Object.keys(statuslineCollector.windows).length
    || Object.entries(statuslineCollector.windows).some(([key, minutes]) => !key.trim()
      || !Number.isSafeInteger(minutes) || minutes < 1)) {
    throw new TypeError('Quota fields and windows are invalid / Campos e períodos de cota inválidos');
  }
  const opencodeQuota = { ...DEFAULT_CONFIG.opencodeQuota, ...config?.opencodeQuota,
    fields: { ...DEFAULT_CONFIG.opencodeQuota.fields, ...config?.opencodeQuota?.fields } };
  const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
  const word = (value) => typeof value === 'string' && value.trim() && !value.includes('\0');
  if (['timeoutMs', 'maxOutputBytes', 'maxAgeMinutes', 'version'].some((key) =>
    !Number.isSafeInteger(opencodeQuota[key]) || opencodeQuota[key] < 1)
    || !object(opencodeQuota.sources) || !object(opencodeQuota.windows)
    || !Object.keys(opencodeQuota.windows).length
    || Object.entries(opencodeQuota.windows).some(([key, value]) => !word(key)
      || !Number.isSafeInteger(value) || value < 1)
    || Object.values(opencodeQuota.fields).some((value) => !word(value))) {
    throw new TypeError('Invalid quota reading settings / Ajustes de leitura de cota inválidos');
  }
  for (const [provider, source] of Object.entries(opencodeQuota.sources)) {
    if (!word(provider) || !object(source) || Object.keys(source).length !== 1
      || !(word(source.file) || (Array.isArray(source.command) && source.command.length
        && source.command.every(word)))) {
      throw new TypeError('Quota source: use a file or command words / Fonte de cota: use arquivo ou palavras do comando');
    }
  }
  const codexQuota = { ...DEFAULT_CONFIG.codexQuota, ...config?.codexQuota,
    fields: { ...DEFAULT_CONFIG.codexQuota.fields, ...config?.codexQuota?.fields } };
  for (const key of ['recentFiles', 'tailBytes', 'maxTailBytes', 'maxAgeMinutes']) {
    if (!Number.isSafeInteger(codexQuota[key]) || codexQuota[key] < 1) {
      throw new TypeError(`codexQuota.${key} must be an integer >= 1`);
    }
  }
  if (codexQuota.tailBytes > codexQuota.maxTailBytes) {
    throw new TypeError('codexQuota.tailBytes must not exceed maxTailBytes');
  }
  for (const [key, value] of Object.entries({ ...codexQuota, ...codexQuota.fields })) {
    if (['fields', 'recentFiles', 'tailBytes', 'maxTailBytes', 'maxAgeMinutes'].includes(key)) continue;
    if (typeof value !== 'string' || !value.trim()) throw new TypeError(`codexQuota.${key} must be non-empty text`);
  }
  for (const key of ['holdStaleMinutes', 'gitTimeoutMs']) {
    if (!Number.isInteger(inbox[key]) || inbox[key] < 1) {
      throw new TypeError(`inbox.${key} must be an integer >= 1`);
    }
  }
  return {
    ...merged,
    statuslineRegistration,
    inbox,
    daemon,
    smoke,
    statuslineCollector,
    codexQuota,
    opencodeQuota,
    setup: mergeSetup(config?.setup),
    actors: {
      ...DEFAULT_CONFIG.actors, ...config?.actors,
      sizeClasses: config?.actors?.sizeClasses ?? DEFAULT_CONFIG.actors.sizeClasses,
      messages: Object.fromEntries(Object.entries(DEFAULT_CONFIG.actors.messages).map(([locale, messages]) => (
        [locale, { ...messages, ...config?.actors?.messages?.[locale] }]
      ))),
    },
    limits: normalizeLimits(config?.limits),
    profileMessages: {
      ...DEFAULT_CONFIG.profileMessages,
      ...(config?.profileMessages ?? {}),
    },
    limitWarnings: [
      ...(config?.limitWarnings ?? []),
      ...(Object.hasOwn(config?.limits ?? {}, 'perClient') ? ['deprecated perClient'] : []),
      ...Object.keys(config?.limits?.clients ?? {}).filter(
        (client) => !Object.hasOwn(DEFAULT_CONFIG.release.adapters, client),
      ).map((client) => `unknown client: ${client}`),
    ].filter((value, index, all) => all.indexOf(value) === index),
    profiles: mergeProfiles(config?.profiles),
    configuredClients: configuredClientsOf(config),
  };
}

/**
 * Whether the setup is still pending: `setup.done` is the record the setup
 * leaves in the settings, and an absent record means nobody chose the models
 * yet.
 *
 * @param {object} config
 * @returns {boolean}
 */
export function setupPending(config) {
  const done = configOf(config).setup?.done;
  return done === undefined || done === null || done === false;
}

/**
 * Picks the actor profile for a client and effort class.
 *
 * @param {{client: string, effort: string, quota?: {source?: string, remainingPct?: number}, config?: object}} input
 * @returns {{model: string, effort: string, maxTurns: number}}
 * @throws when the class is unknown or the config has no profile for it.
 */
export function profilePick({ client, effort, quota, config } = {}) {
  const { lowQuotaPct, profiles, profileMessages } = configOf(config);
  if (!EFFORT_CLASSES.includes(effort)) {
    throw new Error(fill(profileMessages.unknownClass, {
      class: effort,
      classes: EFFORT_CLASSES.join(', '),
    }));
  }

  const chosen = lowQuota(quota, lowQuotaPct) ? LOWER[effort] : effort;
  if (!Object.hasOwn(profiles, client)) {
    throw new Error(fill(profileMessages.unknownClient, {
      client,
      clients: knownClients(profiles).join(', '),
    }));
  }
  const profile = profiles[client][chosen];
  if (!profile || typeof profile.model !== 'string' || profile.model === '') {
    throw new Error(fill(profileMessages.missingProfile, {
      client,
      class: chosen,
    }));
  }

  return { model: profile.model, effort: profile.effort, maxTurns: profile.maxTurns };
}
