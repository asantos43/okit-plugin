// Actor profile choice: the maintainer owns the model names, the core only
// picks which configured profile to use and may lower it on low quota.
import process from 'node:process';

import { EFFORT_CLASSES } from './classify.js';

export const DEFAULT_CONFIG = {
  lowQuotaPct: 15,
  limits: { global: 4, perClient: 3 },
  staleMinutes: 30,
  // profiles: { <client>: { simple: { model, effort, maxTurns }, ... } }
  profiles: {},
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
      'claude-code': {
        file: 'INSTALL.md',
        title: 'Install {name} with Claude Code',
        steps: [
          'Node {engines} is required: check it with `node --version`.',
          'Extract this archive where the client can read it.',
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
    // The release notes: the name model of the notes file, the root change
    // history they come from and the texts they carry. The name, the version
    // and the engines come from `package.json`.
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

function configOf(config) {
  const merged = { ...DEFAULT_CONFIG, ...(config ?? {}) };
  return {
    ...merged,
    limits: { ...DEFAULT_CONFIG.limits, ...(merged.limits ?? {}) },
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
