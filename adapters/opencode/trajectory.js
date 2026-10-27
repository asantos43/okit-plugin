import { trajectory, metrics } from '../../src/trajectory/schema.js';
import { records, textOf, sourceOf } from '../../src/trajectory/read.js';

export function readTrajectory(input, context = {}) {
  const rows = records(input).flatMap(row => row.messages ?? [row]), steps = [];
  for (const row of rows) {
    const info = row.info ?? row, parts = row.parts ?? (row.part ? [row.part] : []);
    const finish = parts.find(part => part.type === 'step-finish');
    const tokens = info.tokens ?? finish?.tokens ?? {};
    const model = info.modelID ?? info.model?.modelID;
    const instant = info.time?.created ?? row.timestamp;
    steps.push({ timestamp: typeof instant === 'number' ? new Date(instant).toISOString() : instant ?? null,
      source: sourceOf(info.role), message: textOf(parts), model_name: model ?? context.model ?? null,
      reasoning_content: parts.filter(part => part.type === 'reasoning').map(part => part.text).join('\n') || null,
      tool_calls: parts.filter(part => part.type === 'tool').map(part => ({ tool_call_id: part.callID ?? null,
        function_name: part.tool, arguments: part.state?.input ?? null })),
      observation: { results: parts.filter(part => part.type === 'tool' && ['completed', 'error'].includes(part.state?.status))
        .map(part => ({ source_call_id: part.callID ?? null, content: {
          output: part.state.output ?? part.state.error ?? null, is_error: part.state.status === 'error' } })) },
      metrics: metrics({ prompt_tokens: tokens.input, completion_tokens: tokens.output,
        cached_tokens: tokens.cache?.read, cost_usd: info.cost ?? finish?.cost }) });
  }
  return trajectory({ ...context, client: 'opencode', model: steps.find(item => item.model_name)?.model_name ?? context.model,
    effort: rows.map(row => row.info ?? row).find(info => info.variant)?.variant ?? context.effort }, steps);
}
