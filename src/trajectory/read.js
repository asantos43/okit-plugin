// Shared syntax helpers only. Client field interpretation stays in adapters.
const emptyObject = /^\{\s*\}$/;
export function records(input) {
  if (Array.isArray(input)) return input.filter(record);
  if (input && typeof input === 'object') return record(input) ? [input] : [];
  if (typeof input !== 'string') return [];
  if (input.charCodeAt(0) === 0xfeff) input = input.slice(1);
  const lines = input.split('\n'), first = lines.find(line => line.trim())?.trim() ?? '';
  // Complete object lines are JSONL; avoid parsing the whole transcript first.
  try {
    if (!(first.startsWith('{') && first.endsWith('}'))) {
      const parsed = JSON.parse(input); return records(parsed);
    }
  }
  catch { /* JSONL or a truncated transcript. */ }
  const rows = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (line[0] !== '{' || emptyObject.test(line)) continue;
    try { const row = JSON.parse(line); if (record(row)) rows.push(row); } catch { /* Partial line. */ }
  }
  return rows;
}
function record(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  for (const key in value) if (Object.hasOwn(value, key)) return true;
  return false;
}
export function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const texts = content.filter(part => typeof part.text === 'string').map(part => part.text);
  return texts.length ? texts.join('\n') : null;
}
export function sourceOf(role) {
  return ['system', 'user'].includes(role) ? role : 'agent';
}
