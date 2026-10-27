import { configure, status, list, show, exportTrajectory, prune } from './index.js';

export async function trajectoryCommand(ctx, action, args) {
  try {
    let result;
    if (['on', 'off'].includes(action) && !args.length) result = await configure(ctx.root, action === 'on');
    else if (action === 'status' && !args.length) {
      const saved = await status(ctx.root);
      result = `${saved.what}\nRecording / Gravação: ${saved.enabled ? 'on / ligada' : 'off / desligada'}\nFolder / Pasta: ${saved.where}`;
    } else if (action === 'list' && !args.length) result = await list(ctx.root);
    else if (action === 'prune' && !args.length) result = await prune(ctx.root);
    else if (action === 'show' && args.length === 1) result = await show(ctx.root, args[0]);
    else if (action === 'export' && args.length === 1) result = await exportTrajectory(ctx.root, args[0]);
    else {
      ctx.err('Use trajectory list|show <run>|export <run>|prune|on|off|status / Use trajectory list|show <execução>|export <execução>|prune|on|off|status');
      return 2;
    }
    ctx.out(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
    return 0;
  } catch {
    ctx.err('Could not read or save recordings / Não foi possível ler ou salvar gravações');
    return 1;
  }
}
