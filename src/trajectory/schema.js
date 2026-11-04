import { statSync } from 'node:fs';
import { resolve } from 'node:path';
export const SCHEMA_VERSION = 'ATIF-v1.4';
export const unavailable = null;
export const MAX_DEPTH = 100;
const depthMarker = '[truncated: too deep]';
// Walk JSON iteratively: neither cloning nor the depth check uses the JS stack.
export function boundedClone(value, limit = MAX_DEPTH) {
  if (value === null || typeof value !== 'object') return value;
  const root = Array.isArray(value) ? [] : {};
  const pending = [{ value, copy: root, depth: 0 }];
  while (pending.length) {
    const { value: source, copy, depth } = pending.pop();
    for (const [key, child] of Object.entries(source)) {
      let next = child;
      if (child !== null && typeof child === 'object') {
        next = depth + 1 > limit ? depthMarker : Array.isArray(child) ? [] : {};
        if (next !== depthMarker) pending.push({ value: child, copy: next, depth: depth + 1 });
      }
      Object.defineProperty(copy, key, { value: next, enumerable: true, writable: true, configurable: true });
    }
  }
  return root;
}
function bounded(value) {
  const pending = [[value, 0]];
  while (pending.length) {
    const [item, depth] = pending.pop();
    if (item === null || typeof item !== 'object') continue;
    if (depth > MAX_DEPTH) return false;
    for (const child of Object.values(item)) pending.push([child, depth + 1]);
  }
  return true;
}
const numeric = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const usageKeys = ['prompt_tokens', 'completion_tokens', 'cached_tokens', 'cost_usd'];
// Harbor: token counters are non-negative integers; only the cost may be fractional.
const amount = (key, value) => numeric(value) !== null && (key === 'cost_usd' || Number.isSafeInteger(value)) ? value : null;
export function metrics(values = {}) {
  return Object.fromEntries(usageKeys.map(key => [key, amount(key, values?.[key])]));
}
export function step(value = {}) {
  return { step_id: value.step_id, timestamp: value.timestamp ?? null,
    source: value.source ?? 'agent', message: value.message ?? null,
    model_name: value.model_name ?? null, ...value, metrics: { ...(object(value.metrics) ? value.metrics : {}), ...metrics(value.metrics) } };
}
export function trajectory(context = {}, steps = []) {
  return normalize({ schema_version: SCHEMA_VERSION, session_id: context.session_id ?? null,
    agent: { name: 'okit-plugin', version: context.version ?? 'unknown', model_name: context.model ?? null,
      extra: { role: context.role ?? 'executor', client: context.client ?? null,
        effort: context.effort ?? null, demand: context.demand ?? null, step: context.step ?? null,
        ...(context.role === 'critic' ? { critic_of: context.critic_of ?? null } : {}) } },
    steps: steps.map((value, index) => step({ ...value, model_name: value.model_name ?? context.model ?? null, step_id: index + 1 })) }, { producer: true });
}
export function totals(steps) {
  const result = { total_steps: steps.length };
  for (const key of usageKeys) {
    const values = steps.map(item => amount(key, item?.metrics?.[key]));
    result[`total_${key}`] = values.some(value => value !== null)
      ? amount(key, values.reduce((sum, value) => sum + (value ?? 0), 0)) : null;
  }
  return result;
}
const agentFields = ['model_name', 'reasoning_effort', 'reasoning_content', 'tool_calls', 'metrics'];
const stepFields = ['step_id', 'timestamp', 'source', 'message', 'extra', 'observation', 'is_copied_context', 'llm_call_count', ...agentFields];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
// Harbor forbids unknown fields in each of these objects; the ones that have `extra` keep strays there.
const topFields = ['schema_version', 'session_id', 'trajectory_id', 'agent', 'steps', 'notes', 'final_metrics', 'extra', 'continued_trajectory_ref', 'subagent_trajectories'];
const agentKeys = ['name', 'version', 'model_name', 'tool_definitions', 'extra'];
const finalFields = ['total_steps', ...usageKeys.map(key => `total_${key}`), 'extra'];
const callFields = ['tool_call_id', 'function_name', 'arguments', 'extra'];
const resultFields = ['source_call_id', 'content', 'subagent_trajectory_ref', 'extra'];
const tokenArrays = ['prompt_token_ids', 'completion_token_ids', 'logprobs'];
const hasOnly = (value, allowed) => object(value) && Object.keys(value).every(key => allowed.includes(key));
function confine(value, allowed) {
  const entries = Object.entries(object(value) ? value : {}), strays = entries.filter(([key]) => !allowed.includes(key));
  const kept = Object.fromEntries(entries.filter(([key]) => allowed.includes(key)));
  if (!optional(kept.extra, object)) delete kept.extra;
  if (strays.length) kept.extra = { ...kept.extra, ...Object.fromEntries(strays) };
  return kept;
}
function usageOf(value) {
  const kept = confine(value, [...usageKeys, ...tokenArrays, 'extra']);
  for (const key of usageKeys) if (kept[key] == null || !(key === 'cost_usd' ? real : integer)(kept[key])) delete kept[key];
  for (const key of tokenArrays) if (!numberList(kept[key], key !== 'logprobs')) delete kept[key];
  return kept;
}
// Harbor wants ISO 8601: a real calendar date and clock time, with an optional offset.
function isoTime(value) {
  const parts = typeof value === 'string'
    && /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:Z|[+-](\d{2}):(\d{2}))?$/.exec(value);
  if (!parts) return false;
  const [year, month, day, hour, minute, second, zoneHour = 0, zoneMinute = 0] = parts.slice(1).map(part => (part === undefined ? undefined : Number(part)));
  const date = new Date(0); date.setUTCFullYear(year, month - 1, day);
  return year > 0 && date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    && hour < 24 && minute < 60 && second < 60 && zoneHour < 24 && zoneMinute < 60;
}
function argumentsObject(value) {
  if (value == null) return {};
  if (typeof value === 'string') {
    try { const parsed = JSON.parse(value); if (object(parsed)) return boundedClone(parsed, 80); } catch { /* Plain input. */ }
  }
  return object(value) ? value : { input: value };
}
function normalizeStep(value) {
  const input = boundedClone(object(value) ? value : { message: value });
  const item = { source: 'agent', message: '', ...input };
  item.metrics = usageOf(input.metrics);
  if (!['agent', 'user', 'system'].includes(item.source)) item.source = 'agent';
  if (!optional(item.extra, object)) delete item.extra;
  if (!harborTime(item.timestamp) && item.timestamp != null) {
    if (typeof item.timestamp === 'string' && item.timestamp) item.extra = { ...item.extra, original_timestamp: item.timestamp };
    item.timestamp = null;
  }
  if (item.model_name != null && typeof item.model_name !== 'string') delete item.model_name;
  if (!optional(item.reasoning_effort, v => text(v) || real(v))) delete item.reasoning_effort;
  if (!optional(item.is_copied_context, boolean)) delete item.is_copied_context;
  if (!optional(item.llm_call_count, n => integer(n) && n >= 0)) delete item.llm_call_count;
  if (item.llm_call_count === 0
    && (Object.keys(item.metrics).length || item.reasoning_content != null)) delete item.llm_call_count;
  if (!optional(item.reasoning_content, text)) delete item.reasoning_content;
  item.message = item.message == null ? '' : content(item.message) ? item.message : JSON.stringify(item.message);
  for (const key of Object.keys(item).filter(key => !stepFields.includes(key))) {
    item.extra = { ...item.extra, [key]: item[key] }; delete item[key];
  }
  item.tool_calls = (Array.isArray(item.tool_calls) ? item.tool_calls : []).map(call => ({
    ...(Object.hasOwn(call ?? {}, 'extra') && optional(call.extra, object) ? { extra: call.extra } : {}),
    tool_call_id: call?.tool_call_id, function_name: text(call?.function_name) ? call.function_name : 'unknown',
    arguments: argumentsObject(call?.arguments) }));
  const results = Array.isArray(item.observation?.results) ? item.observation.results : [];
  item.observation = { results: results.map(result => ({
    ...(Object.hasOwn(result ?? {}, 'extra') && optional(result.extra, object) ? { extra: result.extra } : {}),
    ...(Array.isArray(result?.subagent_trajectory_ref) ? { subagent_trajectory_ref: result.subagent_trajectory_ref.filter(validRef) } : {}),
    ...(Object.hasOwn(result ?? {}, 'source_call_id') ? { source_call_id: result.source_call_id } : {}),
    ...(Object.hasOwn(result ?? {}, 'content') ? { content: result.content } : {}) })) };
  for (const [index, result] of item.observation.results.entries()) {
    if (result.content?.is_error) item.extra = { ...item.extra,
      failed_results: [...new Set([...(Array.isArray(item.extra?.failed_results) ? item.extra.failed_results : []), index])] };
    if (Object.hasOwn(result, 'content') && result.content !== null && !content(result.content)) result.content = JSON.stringify(result.content ?? null);
  }
  return item;
}
function moveResults(item, preceding) {
  const results = item.observation?.results ?? [];
  const failed = new Set(Array.isArray(item.extra?.failed_calls) ? item.extra.failed_calls.filter(id => typeof id === 'string' && !!id.trim()) : []);
  const failedResults = new Set(Array.isArray(item.extra?.failed_results) ? item.extra.failed_results : []);
  if (item.extra) {
    item.extra.failed_calls = [...failed].filter(id => item.tool_calls.some(call => call.tool_call_id === id)
      && !results.some(result => result.source_call_id === id));
    delete item.extra.failed_results;
  }
  delete item.observation;
  for (const [index, result] of results.entries()) {
    const id = result.source_call_id;
    const matches = candidate => typeof id === 'string' && !!id.trim() && candidate.tool_calls?.some(call => call.tool_call_id === id);
    const target = matches(item) ? item : preceding.findLast(matches);
    const destination = target ?? item;
    if (!target && result.source_call_id != null) result.source_call_id = null;
    destination.observation ??= { results: [] };
    const resultIndex = destination.observation.results.length;
    destination.observation.results.push(result);
    if (failed.has(id) || failedResults.has(index)) {
      const key = result.source_call_id == null ? 'failed_results' : 'failed_calls';
      destination.extra = { ...destination.extra,
        [key]: [...new Set([...(Array.isArray(destination.extra?.[key]) ? destination.extra[key] : []), key === 'failed_results' ? resultIndex : result.source_call_id])] };
    }
  }
  if (item.extra?.failed_calls?.length === 0) delete item.extra.failed_calls;
  if (item.extra && Object.keys(item.extra).length === 0) delete item.extra;
}
// Every call ends with a unique non-blank ID; a repeated ID is renamed together with its same-step references.
function assignCallIds(steps) {
  const validId = id => typeof id === 'string' && !!id.trim();
  const used = new Set(steps.flatMap(item => item.tool_calls ?? []).map(call => call.tool_call_id).filter(validId));
  const seen = new Set();
  for (const item of steps) {
    const kept = new Set();
    for (const [index, call] of (item.tool_calls ?? []).entries()) {
      const old = call.tool_call_id;
      if (validId(old) && !seen.has(old)) { seen.add(old); kept.add(old); continue; }
      const base = `call-${item.step_id}-${index + 1}`;
      let id = base, suffix = 2;
      while (used.has(id)) id = `${base}-${suffix++}`;
      call.tool_call_id = id; used.add(id); seen.add(id);
      if (!validId(old) || kept.has(old)) continue;
      kept.add(old);
      for (const result of item.observation?.results ?? []) if (result.source_call_id === old) result.source_call_id = id;
      if (Array.isArray(item.extra?.failed_calls)) item.extra.failed_calls = item.extra.failed_calls.map(failed => failed === old ? id : failed);
    }
  }
}
// Stored totals outlive capped steps; only restructuring permits recomputation.
function finalMetrics(steps, stored, oldLength, restructured) {
  if (stored === undefined) return totals(steps);
  if (stored === null) return null;
  const kept = confine(stored, finalFields), computed = totals(steps);
  for (const key of finalFields.filter(key => key !== 'extra')) {
    const check = key === 'total_cost_usd' ? real : integer;
    if (Object.hasOwn(kept, key) && !optional(kept[key], check)) kept[key] = computed[key];
    if (restructured && key !== 'total_steps' && computed[key] != null
      && (kept[key] ?? 0) < computed[key]) kept[key] = computed[key];
    if (restructured && computed[key] === null && steps.some(item => amount(key.slice(6), item.metrics?.[key.slice(6)]) !== null)) kept[key] = null;
  }
  const delta = steps.length - oldLength;
  if (delta && integer(stored?.total_steps)) {
    const value = kept.total_steps;
    kept.total_steps = integer(value + delta) ? value + delta : steps.length;
  }
  if (kept.total_steps != null && kept.total_steps < 0) kept.total_steps = steps.length;
  return kept;
}
export function normalize(data = {}, { producer = false, dir } = {}) {
  const alreadyValid = validate(data);
  // Leave room for wrappers introduced while repairing malformed schema fields.
  data = boundedClone(data, alreadyValid ? MAX_DEPTH : 80);
  if (dir !== undefined) repairImages(data, dir);
  // Harbor-valid input is already canonical for storage; never rewrite its optional fields.
  if (!producer && validate(data)) return data;
  data = object(data) ? data : {};
  const steps = [], result = confine(data, topFields);
  let restructured = false;
  result.schema_version = knownVersion(data.schema_version) ? data.schema_version : SCHEMA_VERSION;
  result.agent = confine(result.agent, agentKeys);
  if (!text(result.agent.name)) result.agent.name = 'okit-plugin';
  if (typeof result.agent.version === 'number') result.agent.version = String(result.agent.version);
  if (typeof result.agent.version !== 'string' || !result.agent.version) result.agent.version = 'unknown';
  if (!optional(result.agent.model_name, text)) delete result.agent.model_name;
  if (result.agent.tool_definitions != null) {
    if (!Array.isArray(result.agent.tool_definitions)) delete result.agent.tool_definitions;
    else result.agent.tool_definitions = result.agent.tool_definitions.filter(object);
  }
  for (const key of ['session_id', 'trajectory_id', 'continued_trajectory_ref']) {
    if (!optional(result[key], text)) delete result[key];
  }
  if (result.subagent_trajectories != null && !Array.isArray(result.subagent_trajectories)) delete result.subagent_trajectories;
  else if (Array.isArray(result.subagent_trajectories)) {
    const ids = new Set();
    result.subagent_trajectories = result.subagent_trajectories.map(child => normalize(child, { dir }))
      .filter(child => child.trajectory_id != null && !ids.has(child.trajectory_id) && !!ids.add(child.trajectory_id));
  }
  if (!optional(result.notes, text)) delete result.notes;
  for (const value of Array.isArray(data?.steps) ? data.steps : []) {
    if (!producer && integer(value?.step_id) && validStep(value, value.step_id - 1)) {
      steps.push(boundedClone(value)); continue;
    }
    const item = normalizeStep(value);
    const resultCount = item.observation?.results?.length ?? 0;
    moveResults(item, steps);
    if ((item.observation?.results?.length ?? 0) !== resultCount) restructured = true;
    let { extra: usageExtra, ...usage } = item.metrics;
    let movedUsage = false;
    const previous = steps.findLast(candidate => candidate.source === 'agent' && candidate.llm_call_count !== 0);
    const empty = !item.message && !item.tool_calls.length && !item.observation?.results?.length && !item.reasoning_content;
    const keepExtra = Object.keys(item.extra ?? {}).some(key => !['failed_calls', 'failed_results'].includes(key));
    if (item.source !== 'agent' && Object.keys(usage).length) {
      const canFold = previous && Object.entries(usage).every(([key, n]) => tokenArrays.includes(key)
        || amount(key, (previous.metrics?.[key] ?? 0) + n) !== null);
      if (canFold) {
        for (const [key, n] of Object.entries(usage)) previous.metrics = { ...previous.metrics,
          [key]: tokenArrays.includes(key) ? [...(previous.metrics?.[key] ?? []), ...n] : (previous.metrics?.[key] ?? 0) + n };
        if (usageExtra) previous.metrics = { ...previous.metrics, extra: { ...previous.metrics?.extra, ...usageExtra } };
        previous.metrics = usageOf(previous.metrics);
        usage = {}; usageExtra = undefined;
        restructured = true; movedUsage = true;
      }
      else item.source = 'agent';
    }
    if (item.tool_calls.length || item.observation?.results?.length || item.reasoning_content || (empty && keepExtra)) item.source = 'agent';
    if (item.source !== 'agent') for (const key of agentFields) {
      if (value?.[key] === null) item[key] = null; else delete item[key];
    }
    else {
      const kept = { ...usage, ...(usageExtra ? { extra: usageExtra } : {}) };
      if (Object.keys(kept).length) item.metrics = kept; else delete item.metrics;
      if (!producer && (item.observation?.results?.length ?? 0) === resultCount
        && Object.hasOwn(value ?? {}, 'metrics') && optional(value.metrics, validUsage)) item.metrics = boundedClone(value.metrics);
      if (!item.tool_calls.length) {
        if (!producer && (value?.tool_calls === null || Array.isArray(value?.tool_calls) && !value.tool_calls.length)) item.tool_calls = value.tool_calls;
        else delete item.tool_calls;
      }
    }
    if (!item.observation?.results?.length) {
      if (value?.observation === null) item.observation = null;
      else if (!producer && hasOnly(value?.observation, ['results']) && Array.isArray(value.observation.results) && !value.observation.results.length) item.observation = { results: [] };
      else delete item.observation;
    }
    if (item.source !== value?.source) restructured = true;
    const moved = (value?.tool_calls?.length || value?.observation?.results?.length || movedUsage)
      && !item.tool_calls?.length && !item.observation;
    if (moved && !item.message && !item.reasoning_content && !item.metrics && !keepExtra) continue;
    steps.push(item);
  }
  if (!steps.length) steps.push({ timestamp: null, source: 'system', message: '' });
  result.steps = steps.map((item, index) => ({ ...item, step_id: index + 1 }));
  assignCallIds(result.steps);
  if (Object.hasOwn(data, 'final_metrics') || producer || restructured) {
    result.final_metrics = finalMetrics(result.steps, data?.final_metrics, Array.isArray(data.steps) ? data.steps.length : 0, restructured);
  }
  const output = boundedClone(result);
  if (!validate(output)) throw new Error('Invalid saved run / Execução salva inválida');
  return output;
}
// Harbor's _is_url deliberately checks only for ://, without parsing a URL.
function repairImages(data, dir) {
  const repair = parts => !Array.isArray(parts) ? parts : parts.map(part => {
    const path = part?.source?.path;
    if (part?.type !== 'image' || typeof path !== 'string' || !path || path.includes('://')) return part;
    try { statSync(resolve(dir, path)); return part; }
    catch { return { type: 'text', text: `[image: ${path}]` }; }
  });
  for (const item of Array.isArray(data?.steps) ? data.steps : []) {
    if (!object(item)) continue;
    if (Object.hasOwn(item, 'message')) item.message = repair(item.message);
    for (const result of Array.isArray(item.observation?.results) ? item.observation.results : []) {
      if (object(result) && Object.hasOwn(result, 'content')) result.content = repair(result.content);
    }
  }
  for (const child of Array.isArray(data?.subagent_trajectories) ? data.subagent_trajectories : []) repairImages(child, dir);
}
// Deliberately accept JSON types only; Harbor's lax coercions are not our contract.
const integer = value => Number.isSafeInteger(value);
const real = value => typeof value === 'number' && Number.isFinite(value);
const boolean = value => typeof value === 'boolean';
const numberList = (value, integers = false) => Array.isArray(value)
  && value.every(integers ? integer : real);
const optional = (value, check) => value == null || check(value);
const text = value => typeof value === 'string';
const knownVersion = value => text(value) && /^ATIF-v1\.[0-7]$/.test(value);
const metadata = value => optional(value.extra, object);
function content(value) {
  return text(value) || (Array.isArray(value) && value.every(part => hasOnly(part, ['type', 'text', 'source'])
    && (part.type === 'text' ? text(part.text) && part.source == null
      : part.type === 'image' && part.text == null && hasOnly(part.source, ['media_type', 'path'])
        && ['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(part.source.media_type) && text(part.source.path))));
}
function validRef(value) {
  return hasOnly(value, ['trajectory_id', 'session_id', 'trajectory_path', 'extra']) && metadata(value)
    && ['trajectory_id', 'session_id', 'trajectory_path'].every(key => optional(value[key], text))
    && (value.trajectory_id != null || value.trajectory_path != null);
}
function validUsage(value, final = false) {
  return hasOnly(value, final ? finalFields : [...usageKeys, ...tokenArrays, 'extra']) && metadata(value)
    && usageKeys.every(key => optional(value[final ? `total_${key}` : key], key === 'cost_usd' ? real : integer))
    && (final ? optional(value.total_steps, n => integer(n) && n >= 0)
      : tokenArrays.every(key => optional(value[key], list => numberList(list, key !== 'logprobs'))));
}
function validStep(item, index) {
  return hasOnly(item, stepFields) && integer(item.step_id) && item.step_id === index + 1 && metadata(item)
    && ['agent', 'user', 'system'].includes(item.source) && content(item.message)
    && optional(item.timestamp, harborTime) && optional(item.model_name, text)
    && optional(item.reasoning_effort, v => text(v) || real(v)) && optional(item.reasoning_content, text)
    && optional(item.is_copied_context, boolean)
    && optional(item.llm_call_count, n => integer(n) && n >= 0)
    && (item.source === 'agent' || agentFields.every(key => item[key] == null))
    && (item.source !== 'agent' || item.llm_call_count == null || item.llm_call_count !== 0
      || (item.metrics == null && item.reasoning_content == null))
    && optional(item.metrics, validUsage)
    && optional(item.tool_calls, calls => Array.isArray(calls) && calls.every(call => hasOnly(call, callFields)
      && text(call.tool_call_id) && text(call.function_name) && object(call.arguments) && metadata(call)))
    && optional(item.observation, obs => hasOnly(obs, ['results']) && Array.isArray(obs.results)
      && obs.results.every(result => hasOnly(result, resultFields) && metadata(result)
        && optional(result.content, content) && optional(result.source_call_id, text)
        && (result.source_call_id == null || item.tool_calls?.some(call => call.tool_call_id === result.source_call_id))
        && optional(result.subagent_trajectory_ref, refs => Array.isArray(refs) && refs.every(validRef))));
}
export function validate(data) {
  if (!bounded(data) || !hasOnly(data, topFields) || !knownVersion(data.schema_version === undefined ? 'ATIF-v1.7' : data.schema_version)
    || !metadata(data) || !['session_id', 'trajectory_id', 'notes', 'continued_trajectory_ref'].every(key => optional(data[key], text))
    || !hasOnly(data.agent, agentKeys) || !text(data.agent.name) || !text(data.agent.version) || !metadata(data.agent)
    || !optional(data.agent.model_name, text)
    || !optional(data.agent.tool_definitions, defs => Array.isArray(defs) && defs.every(object))
    || !Array.isArray(data.steps) || !data.steps.length || !data.steps.every(validStep)
    || !optional(data.final_metrics, value => validUsage(value, true))) return false;
  if (data.subagent_trajectories == null) return true;
  if (!Array.isArray(data.subagent_trajectories)) return false;
  const ids = new Set();
  return data.subagent_trajectories.every(child => validate(child) && child.trajectory_id != null
    && !ids.has(child.trajectory_id) && !!ids.add(child.trajectory_id));
}
// datetime.fromisoformat accepts calendar/basic/week dates and fractional clocks/offsets.
function harborTime(value) {
  if (!text(value)) return false;
  // Harbor replaces every Z before datetime.fromisoformat, including date/time separators.
  value = value.replaceAll('Z', '+00:00');
  const week = /^(\d{4})(-?)W(\d{2})(?:\2([1-7]))?/.exec(value);
  if (week) {
    const [, year, , number, day = '1'] = week;
    if (+number < 1 || +number > 53 || +year < 1) return false;
    const jan = new Date(0); jan.setUTCFullYear(+year, 0, 4);
    jan.setUTCDate(jan.getUTCDate() - (jan.getUTCDay() || 7) + 1 + (+number - 1) * 7);
    const thursday = new Date(jan); thursday.setUTCDate(jan.getUTCDate() + 3);
    if (thursday.getUTCFullYear() !== +year) return false;
    jan.setUTCDate(jan.getUTCDate() + +day - 1);
    return harborTime(jan.toISOString().slice(0, 10) + value.slice(week[0].length));
  }
  const date = /^(\d{4})(-?)(\d{2})\2(\d{2})/.exec(value);
  if (!date || !isoTime(`${date[1]}-${date[3]}-${date[4]}T00:00:00`)) return false;
  const rest = value.slice(date[0].length);
  if (!rest) return true;
  const clock = Array.from(rest).slice(1).join('');
  const parts = /^(.*?)(Z|[+-].*)?$/.exec(clock);
  const readClock = input => /^(\d{2})(?:(:?)(\d{2})(?:\2(\d{2}))?)?(?:[.,](\d+))?$/.exec(input);
  const time = readClock(parts[1]);
  if (!time || +time[1] > 23 || +(time[3] ?? 0) > 59 || +(time[4] ?? 0) > 59) return false;
  if (!parts[2] || parts[2] === 'Z') return true;
  const offset = readClock(parts[2].slice(1));
  return !!offset && +offset[1] * 3600 + +(offset[3] ?? 0) * 60 + +(offset[4] ?? 0)
    + Number(`0.${offset[5] ?? 0}`) < 86400;
}
export function readable(data) {
  return validate(data) || (knownVersion(data?.schema_version)
    && validateLegacy({ ...data,
      final_metrics: { ...totals(Array.isArray(data.steps) ? data.steps : []), ...data.final_metrics } }));
}
function validEnvelope(data) {
  if (!knownVersion(data?.schema_version) || typeof data.session_id !== 'string'
    || !data.session_id || !['executor', 'critic'].includes(data.agent?.extra?.role)
    || !Object.hasOwn(data.agent ?? {}, 'model_name')
    || !Object.hasOwn(data.agent?.extra ?? {}, 'effort') || !Array.isArray(data.steps)
    || !data.final_metrics || data.final_metrics.total_steps !== data.steps.length
    || !Object.hasOwn(data.agent, 'name') || !Object.hasOwn(data.agent, 'version')
    || ['client', 'demand', 'step'].some(key => !Object.hasOwn(data.agent.extra, key))
    || (data.agent.extra.role === 'critic' && !Object.hasOwn(data.agent.extra, 'critic_of'))
    || usageKeys.some(key => {
      const value = data.final_metrics[`total_${key}`];
      return value !== null && numeric(value) === null;
    })) return false;
  return true;
}
export function validateLegacy(data) {
  if (!validEnvelope(data)) return false;
  return data.steps.every((item, index) => item && typeof item === 'object' && item.step_id === index + 1
    && ['system', 'user', 'agent'].includes(item.source)
    && (item.timestamp === null || Number.isFinite(Date.parse(item.timestamp)))
    && Object.hasOwn(item, 'message')
    && item.metrics && Object.keys(metrics()).every(key => item.metrics[key] === null || numeric(item.metrics[key]) !== null)
    && (!item.tool_calls || Array.isArray(item.tool_calls))
    && (item.tool_calls ?? []).every(call => call && typeof call.function_name === 'string'
      && Object.hasOwn(call, 'arguments') && Object.hasOwn(call, 'tool_call_id'))
    && (!item.observation || (Array.isArray(item.observation.results)
      && item.observation.results.every(result => result && Object.hasOwn(result, 'source_call_id')
        && Object.hasOwn(result, 'content')))));
}
