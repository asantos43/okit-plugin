// Actor profile choice: the maintainer owns the model names, the core only
// picks which configured profile to use and may lower it on low quota.
import process from 'node:process';

import { EFFORT_CLASSES } from './classify.js';

export const DEFAULT_CONFIG = {
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
  limits: { global: 3, clients: {} },
  staleMinutes: 30,
  inbox: { holdStaleMinutes: 120, gitTimeoutMs: 5000 },
  // profiles: { <client>: { simple: { model, effort, maxTurns }, ... } }
  profiles: {},
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
        empty: 'No models are set up for {client} yet. Setting them up from a guided command is coming; until then ask the person who maintains okit.',
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
        empty: 'Ainda não há modelos configurados para {client}. Um comando guiado para configurá-los está a caminho; até lá, peça à pessoa que mantém o okit.',
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

// One step down the effort scale. Nothing goes back up.
const LOWER = { hard: 'normal', normal: 'simple', simple: 'simple' };

function lowQuota(quota, lowQuotaPct) {
  if (!quota || quota.source === 'off') return false;
  const remaining = quota.remainingPct;
  return typeof remaining === 'number' && remaining < lowQuotaPct;
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
  const inbox = { ...DEFAULT_CONFIG.inbox, ...config?.inbox };
  for (const key of ['holdStaleMinutes', 'gitTimeoutMs']) {
    if (!Number.isInteger(inbox[key]) || inbox[key] < 1) {
      throw new TypeError(`inbox.${key} must be an integer >= 1`);
    }
  }
  return {
    ...merged,
    inbox,
    actors: {
      ...DEFAULT_CONFIG.actors, ...config?.actors,
      sizeClasses: config?.actors?.sizeClasses ?? DEFAULT_CONFIG.actors.sizeClasses,
      messages: Object.fromEntries(Object.entries(DEFAULT_CONFIG.actors.messages).map(([locale, messages]) => (
        [locale, { ...messages, ...config?.actors?.messages?.[locale] }]
      ))),
    },
    limits: normalizeLimits(config?.limits),
    limitWarnings: [
      ...(config?.limitWarnings ?? []),
      ...(Object.hasOwn(config?.limits ?? {}, 'perClient') ? ['deprecated perClient'] : []),
      ...Object.keys(config?.limits?.clients ?? {}).filter(
        (client) => !Object.hasOwn(DEFAULT_CONFIG.release.adapters, client),
      ).map((client) => `unknown client: ${client}`),
    ].filter((value, index, all) => all.indexOf(value) === index),
    profiles: { ...(merged.profiles ?? {}) },
  };
}

/**
 * Picks the actor profile for a client and effort class.
 *
 * @param {{client: string, effort: string, quota?: {source?: string, remainingPct?: number}, config?: object}} input
 * @returns {{model: string, effort: string, maxTurns: number}}
 * @throws when the class is unknown or the config has no profile for it.
 */
export function profilePick({ client, effort, quota, config } = {}) {
  const { lowQuotaPct, profiles } = configOf(config);
  if (!EFFORT_CLASSES.includes(effort)) {
    throw new Error(`Unknown effort "${effort}": expected ${EFFORT_CLASSES.join(', ')}`);
  }

  const chosen = lowQuota(quota, lowQuotaPct) ? LOWER[effort] : effort;
  const profile = profiles[client]?.[chosen];
  if (!profile || typeof profile.model !== 'string' || profile.model === '') {
    throw new Error(
      `No profile for client "${client}" and class "${chosen}": fill config.profiles.${client}.${chosen}`,
    );
  }

  return { model: profile.model, effort: profile.effort, maxTurns: profile.maxTurns };
}
