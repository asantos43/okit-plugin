import { status, configure, exportTelemetry, check } from './index.js';
import { exitCodeFor, kindOf } from '../install/exit.js';

export async function telemetryCommand(ctx, action, args) {
  try {
  let result;
  if (action === 'status' && !args.length) result = await status(ctx.root);
  else if (['on', 'off'].includes(action) && !args.length) result = await configure(ctx.root, 'enabled', action === 'on');
  else if (action === 'rede' && args.length === 1 && ['on', 'off'].includes(args[0])) {
    result = await configure(ctx.root, 'network', args[0] === 'on');
  } else if (action === 'check' && !args.length) result = await check(ctx.root);
  else if (action === 'export' && (!args.length || (args.length === 2 && args[0] === '--since'))) {
    result = await exportTelemetry(ctx.root, { since: args[1] });
  } else {
    ctx.err('Use telemetry status|on|off|rede on|off|export [--since ISO]|check / Use telemetry status|on|off|rede on|off|export [--since ISO]|check');
    return 2;
  }
  if (action === 'status') {
    const enabled = value => value ? 'on / ligado' : 'off / desligado';
    ctx.out(`${result.what}\nRecording / Gravação: ${enabled(result.enabled)}\nSending / Envio: ${enabled(result.network)}\nFolder / Pasta: ${result.where}\nSize in bytes / Tamanho em bytes: ${result.sizeBytes}\nLast export / Última exportação: ${result.lastExport?.at ?? 'none / nenhuma'}`);
  } else ctx.out(typeof result === 'string' ? result : JSON.stringify(result));
  return result.ok === false ? 1 : 0;
  } catch (error) {
    // A flag that is not valid is a refusal of usage, told as it is; any other failure is the work's.
    if (kindOf(error) === 'usage') { ctx.err(error.message); return exitCodeFor('usage'); }
    ctx.err('Could not save, export or check measurements / Não foi possível salvar, exportar ou conferir as medições');
    return 1;
  }
}
