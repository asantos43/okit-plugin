export function resolveLimits(smoke, count) {
  for (const key of ['maxUsd', 'maxMinutes', 'checkTimeoutMs']) {
    if (!Number.isFinite(smoke[key]) || smoke[key] <= 0) throw new Error(`invalid ${key}`);
  }
  for (const key of ['quotaFloorPct', 'quotaMaxAgeMinutes', 'quotaExpireMinutes']) {
    if (!Number.isFinite(smoke[key]) || smoke[key] < 0) throw new Error(`invalid ${key}`);
  }
  if (smoke.quotaFloorPct > 100 || smoke.quotaExpireMinutes < smoke.quotaMaxAgeMinutes) throw new Error('invalid quota limits');
  const maxTurns = smoke.maxTurns ?? count * (1 + smoke.demoMaxReworkRounds) * 2;
  if (!Number.isInteger(maxTurns) || maxTurns < 1) throw new Error('invalid maxTurns');
  if (smoke.maxTokens !== null && (!Number.isSafeInteger(smoke.maxTokens) || smoke.maxTokens < 1)) {
    throw new Error('invalid maxTokens');
  }
  return { ...smoke, maxTurns, demoDemandMaxUsd: Math.min(smoke.maxUsd,
    smoke.demoDemandMaxUsd ?? smoke.maxUsd / count) };
}

// Synchronous reservation/settlement makes parallel promises share one ledger.
export function ledger(limits) {
  let spent = 0, reserved = 0, turns = 0, tokens = 0, unknown = false;
  const reportsCost = limits.reportsCost !== false;
  const accounts = new Map();
  return {
    remaining(key) {
      const account = accounts.get(key) ?? { spent: 0, reserved: 0 };
      return { total: limits.maxUsd - spent - reserved,
        demand: limits.demoDemandMaxUsd - account.spent - account.reserved };
    },
    reserve(key, cap) {
      const room = this.remaining(key);
      if (!Number.isFinite(cap) || cap < 0 || (reportsCost && (cap > room.total || cap > room.demand))
        || turns >= limits.maxTurns || (limits.maxTokens != null && tokens >= limits.maxTokens)
        || unknown) throw new Error('budget or turn ceiling');
      const account = accounts.get(key) ?? { spent: 0, reserved: 0 };
      accounts.set(key, account); account.reserved += cap; reserved += cap; turns += 1;
      return { key, cap, account, settled: false };
    },
    settle(ticket, usage, launched = true) {
      if (ticket.settled) throw new Error('double settlement');
      ticket.settled = true;
      if (!launched) turns -= 1;
      const cost = launched && reportsCost ? usage?.costUsd : 0;
      if (!Number.isFinite(cost) || cost < 0 || cost > ticket.cap) {
        unknown = true; throw new Error('unresolved usage or unenforced ceiling');
      }
      ticket.account.reserved -= ticket.cap; reserved -= ticket.cap;
      ticket.account.spent += cost; spent += cost;
      if (launched) {
        if (Number.isSafeInteger(usage?.tokens) && usage.tokens >= 0) tokens += usage.tokens;
        else if (limits.maxTokens != null) {
          unknown = true; throw new Error('unresolved usage or unenforced ceiling');
        }
      }
      if (launched && (!Number.isInteger(usage?.turns) || usage.turns < 0)) {
        unknown = true; throw new Error('unknown turns');
      }
      turns += launched ? Math.max(0, usage.turns - 1) : 0;
      if (turns > limits.maxTurns) throw new Error('turn ceiling');
      return reportsCost ? cost : null;
    },
    snapshot() { return { costUsd: unknown || !reportsCost ? null : spent,
      reservedUsd: reserved, turns, tokens, reportsCost }; },
  };
}
