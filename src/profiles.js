// Actor profile choice: the maintainer owns the model names, the core only
// picks which configured profile to use and may lower it on low quota.
import { EFFORT_CLASSES } from './classify.js';

export const DEFAULT_CONFIG = {
  lowQuotaPct: 15,
  limits: { global: 4, perClient: 3 },
  staleMinutes: 30,
  // profiles: { <client>: { simple: { model, effort, maxTurns }, ... } }
  profiles: {},
  smoke: {
    quotaFloorPct: 20,
    maxUsd: 1,
    // null means the full scenario length (resolved by the runner).
    maxTurns: null,
    maxMinutes: 15,
    checkTimeoutMs: 60_000,
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
