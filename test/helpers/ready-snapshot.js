// A snapshot of the environment made by hand, with only what the readiness reads: the size classes, one row per client
// (installed or not, the models, the quota and the actors with their restrictions) and the status bar collector.
// `candidates` is `[sizes, restrictions]` per actor; the actor can launch when it has no restriction.

const SIZES = { S: 'simple', M: 'normal', L: 'hard' };

export function readySnapshot({ clients = [{}], collector = { active: true, received: true } } = {}) {
  return {
    config: { actors: { sizeClasses: SIZES } },
    clients: clients.map(({ client = 'claude-code', installed = true, models = ['model-a'], quota = 'green',
      candidates = [[['S', 'M', 'L'], []]] }) => ({
      client, installed, models, quota: { status: quota },
      candidates: candidates.map(([sizes, restrictions]) => ({ sizes, restrictions, canLaunch: restrictions.length === 0 })),
    })),
    plugin: { statusline: { ...collector, command: 'okit-plugin install --client claude-code --statusline' } },
  };
}
