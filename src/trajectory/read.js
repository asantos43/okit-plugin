// Shared syntax helpers only. Client field interpretation stays in adapters.
export function records(input) {
  if (Array.isArray(input)) return input;
  if (input && typeof input === 'object') return [input];
  if (typeof input !== 'string' || !input.trim()) return [];
  try { const parsed = JSON.parse(input); return Array.isArray(parsed) ? parsed : [parsed]; }
  catch {
    return input.split(/\r?\n/).flatMap(line => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
  }
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
