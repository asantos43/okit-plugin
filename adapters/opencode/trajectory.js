import { trajectory, metrics } from '../../src/trajectory/schema.js';
import { records, textOf, sourceOf } from '../../src/trajectory/read.js';

export function readTrajectory(input, context = {}) {
  const rows = records(input).flatMap(row => row.messages ?? [row]), steps = [];
  let firstModel, firstEffort;
  for (const row of rows) {
    const info = row.info ?? row, parts = row.parts ?? (row.part ? [row.part] : []);
    let finish;
    const reasoning = [], calls = [], results = [];
    for (const part of parts) {
      if (!finish && part.type === 'step-finish') finish = part;
      if (part.type === 'reasoning') reasoning.push(part.text);
      if (part.type !== 'tool') continue;
      calls.push({ tool_call_id: part.callID ?? null, function_name: part.tool, arguments: part.state?.input ?? null });
      if (['completed', 'error'].includes(part.state?.status)) results.push({ source_call_id: part.callID ?? null,
        content: { output: part.state.output ?? part.state.error ?? null, is_error: part.state.status === 'error' } });
    }
    const tokens = info.tokens ?? finish?.tokens ?? {};
    const model = info.modelID ?? info.model?.modelID;
    if (!firstModel && (model ?? context.model)) firstModel = model ?? context.model;
    if (!firstEffort && info.variant) firstEffort = info.variant;
    const instant = info.time?.created ?? row.timestamp;
    steps.push({ timestamp: typeof instant === 'number' ? new Date(instant).toISOString() : instant ?? null,
      source: sourceOf(info.role), message: textOf(parts), model_name: model ?? context.model ?? null,
      reasoning_content: reasoning.join('\n') || null, tool_calls: calls, observation: { results },
      metrics: metrics({ prompt_tokens: tokens.input, completion_tokens: tokens.output,
        cached_tokens: tokens.cache?.read, cost_usd: info.cost ?? finish?.cost }) });
  }
  return trajectory({ ...context, client: 'opencode', model: firstModel ?? context.model,
    effort: firstEffort ?? context.effort }, steps);
}
